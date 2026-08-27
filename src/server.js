import http from 'node:http';
import { Readable } from 'node:stream';
import { classifyTask, unitCost } from './catalog.js';
import { buildRoute } from './router.js';
import { providerRequest, supportsRequest } from './providers.js';
import { createTelemetry, loadEvents, observeModelStat, savingsReport, summarizeModelStats } from './telemetry.js';
import { newId } from './utils.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function jsonResponse(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body exceeds 10 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON'), { status: 400 }); }
}

function routeHeaders({ model, sessionId, requestId, control, reason }) {
  return {
    'x-hedge-router-route': model.id,
    'x-hedge-router-session-id': sessionId,
    'x-hedge-router-request-id': requestId,
    'x-hedge-router-control': String(control),
    'x-hedge-router-route-reason': reason,
    'access-control-expose-headers': 'x-hedge-router-route,x-hedge-router-session-id,x-hedge-router-request-id,x-hedge-router-control,x-hedge-router-route-reason'
  };
}

function errorCategory(status, error) {
  if (status === 429) return 'rate_limit';
  if (status === 408 || error?.name === 'TimeoutError') return 'timeout';
  if (status >= 500) return 'provider_server';
  if (status >= 400) return 'request_rejected';
  return 'network';
}

function retryable(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function upstreamMessage(response) {
  try {
    const body = await response.json();
    return body.error?.message || body.message || `Provider returned HTTP ${response.status}`;
  } catch {
    return `Provider returned HTTP ${response.status}`;
  }
}

async function handleInference(request, response, config, telemetry, modelStats, mode) {
  const body = await readBody(request);
  const requestId = newId('req');
  const sessionId = String(request.headers['x-hedge-router-session-id'] || request.headers['x-comp-session-id'] || newId('session'));
  const taskClass = String(request.headers['x-hedge-router-task-class'] || request.headers['x-comp-task-class'] || classifyTask(body));
  const quality = String(request.headers['x-hedge-router-quality'] || request.headers['x-comp-quality'] || config.routing.qualityBias);
  const started = performance.now();
  const explicitModel = body.model || 'auto';

  const routeConfig = explicitModel === 'auto'
    ? { ...config, models: config.models.filter((model) => supportsRequest(model, body, mode)) }
    : config;
  const route = buildRoute({ config: routeConfig, body, sessionId, quality, explicitModel, modelStats, taskClass });
  const routingOverhead = performance.now() - started;
  const baselineModel = config.models.find((model) => model.id === config.routing.defaultModel);
  let lastError = { status: 502, message: 'No provider attempt succeeded', category: 'network' };
  let attempts = 0;

  for (const model of route.candidates) {
    attempts += 1;
    let result;
    try {
      result = await providerRequest({
        model,
        body: { ...body, model: explicitModel },
        mode,
        signal: AbortSignal.timeout(config.routing.requestTimeoutMs)
      });
    } catch (error) {
      lastError = { status: 502, message: error.message, category: errorCategory(0, error) };
      observeModelStat(modelStats, { model: model.id, latency_ms: performance.now() - started, provider_status: 502 });
      if (attempts < route.candidates.length) continue;
      break;
    }
    if (!result.ok) {
      const status = result.response.status;
      lastError = { status, message: await upstreamMessage(result.response), category: errorCategory(status) };
      observeModelStat(modelStats, { model: model.id, latency_ms: performance.now() - started, provider_status: status });
      if (retryable(status) && attempts < route.candidates.length) continue;
      break;
    }

    const headers = routeHeaders({ model, sessionId, requestId, control: route.control, reason: route.reason });
    if (!body.stream) {
      result.json.model = model.id;
      const actualCost = unitCost(model, result.usage);
      const baselineCost = unitCost(baselineModel, result.usage);
      const event = await telemetry.record({
        event_type: 'request', session_id: sessionId, request_id: requestId, model: model.id,
        baseline_model: baselineModel.id, provider: model.provider, control: route.control,
        route_reason: route.reason, task_class: taskClass, ...result.usage,
        latency_ms: performance.now() - started, routing_overhead_ms: routingOverhead,
        provider_status: result.status,
        actual_cost_usd: actualCost, baseline_cost_usd: baselineCost,
        savings_usd: baselineCost - actualCost, attempts,
        input_per_million: model.inputPerMillion,
        cached_input_per_million: model.cachedInputPerMillion,
        cache_write_input_per_million: model.cacheWriteInputPerMillion,
        output_per_million: model.outputPerMillion
      });
      observeModelStat(modelStats, event);
      return jsonResponse(response, 200, result.json, headers);
    }

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    const completion = new Promise((resolve, reject) => {
      Readable.fromWeb(result.stream).on('error', reject).on('end', resolve).pipe(response);
    });
    const usage = await result.usage;
    await completion;
    const actualCost = unitCost(model, usage);
    const baselineCost = unitCost(baselineModel, usage);
    const event = await telemetry.record({
      event_type: 'request', session_id: sessionId, request_id: requestId, model: model.id,
      baseline_model: baselineModel.id, provider: model.provider, control: route.control,
      route_reason: route.reason, task_class: taskClass, ...usage,
      latency_ms: performance.now() - started, routing_overhead_ms: routingOverhead,
      provider_status: result.status,
      actual_cost_usd: actualCost, baseline_cost_usd: baselineCost,
      savings_usd: baselineCost - actualCost, attempts,
      input_per_million: model.inputPerMillion,
      cached_input_per_million: model.cachedInputPerMillion,
      cache_write_input_per_million: model.cacheWriteInputPerMillion,
      output_per_million: model.outputPerMillion
    });
    observeModelStat(modelStats, event);
    return;
  }

  await telemetry.record({
    event_type: 'request', session_id: sessionId, request_id: requestId,
    baseline_model: baselineModel.id, control: route.control, route_reason: route.reason,
    task_class: taskClass, latency_ms: performance.now() - started,
    provider_status: lastError.status, error_category: lastError.category, attempts
  });
  return jsonResponse(response, lastError.status, { error: { message: lastError.message, type: lastError.category } });
}

export async function createServer(config) {
  const telemetry = await createTelemetry(config);
  await telemetry.prune();
  const modelStats = summarizeModelStats(await loadEvents());
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        return jsonResponse(response, 200, { status: 'ok', telemetry_enabled: config.telemetry.enabled });
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return jsonResponse(response, 200, {
          object: 'list', data: [{ id: 'auto', object: 'model', owned_by: 'hedge-router' }, ...config.models.map((model) => ({ id: model.id, object: 'model', owned_by: model.provider }))]
        });
      }
      if (request.method === 'GET' && ['/v1/hedge-router/report', '/v1/comp/report'].includes(url.pathname)) {
        return jsonResponse(response, 200, savingsReport(await loadEvents()));
      }
      if (request.method === 'GET' && ['/v1/hedge-router/privacy', '/v1/comp/privacy'].includes(url.pathname)) {
        return jsonResponse(response, 200, {
          telemetry_enabled: config.telemetry.enabled,
          remote_url_configured: Boolean(config.telemetry.remoteUrl),
          raw_retention_days: config.telemetry.rawRetentionDays,
          excluded: ['prompts', 'code', 'paths', 'filenames', 'tool arguments', 'tool output']
        });
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await handleInference(request, response, config, telemetry, modelStats, 'chat');
      }
      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        return await handleInference(request, response, config, telemetry, modelStats, 'responses');
      }
      return jsonResponse(response, 404, { error: { message: 'Not found' } });
    } catch (error) {
      if (!response.headersSent) return jsonResponse(response, error.status || 500, { error: { message: error.message } });
      response.destroy(error);
    }
  });
}

export async function startServer(config) {
  const server = await createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });
  return server;
}
