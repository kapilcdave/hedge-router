import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function maybeListen(t, server) {
  try { return await listen(server); }
  catch (error) {
    if (error.code === 'EPERM') {
      t.skip('environment forbids loopback sockets');
      return null;
    }
    throw error;
  }
}

function baseConfig(baseUrl) {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    routing: { defaultModel: 'mock/good', controlPercent: 0, maxAttempts: 2, requestTimeoutMs: 5000, qualityBias: 'balanced' },
    models: [
      { id: 'mock/bad', provider: 'openai', upstreamModel: 'bad-model', apiKeyEnv: 'MOCK_API_KEY', baseUrl, inputPerMillion: 0.1, outputPerMillion: 0.2, contextWindow: 10000, qualityTier: 2 },
      { id: 'mock/good', provider: 'openai', upstreamModel: 'good-model', apiKeyEnv: 'MOCK_API_KEY', baseUrl, inputPerMillion: 1, outputPerMillion: 2, contextWindow: 10000, qualityTier: 3 }
    ],
    telemetry: { enabled: false, remoteUrl: null, remoteTokenEnv: null, rawRetentionDays: 30, minimumCohort: 20 },
    collector: { host: '127.0.0.1', port: 8790, tokenEnv: 'COMP_COLLECTOR_TOKEN', rawRetentionDays: 30, minimumCohort: 2 },
    quality: { commands: [] }
  };
}

test('real proxy HTTP path retries, streams, serves Responses, and reports usage', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'comp-http-'));
  process.env.COMP_DATA_DIR = dataDir;
  process.env.MOCK_API_KEY = 'mock-secret';
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(request.headers.authorization, 'Bearer mock-secret');
    if (body.model === 'bad-model') {
      response.writeHead(429, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: { message: 'try another route' } }));
    }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"id":"chunk","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');
      response.write('data: {"id":"chunk","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n');
      return response.end('data: [DONE]\n\n');
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url.endsWith('/responses')) {
      return response.end(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', model: body.model, output: [], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } }));
    }
    return response.end(JSON.stringify({
      id: 'chat_test', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    }));
  });
  const upstreamUrl = await maybeListen(t, upstream);
  if (!upstreamUrl) return;
  t.after(() => upstream.close());

  const { createServer } = await import('../src/server.js');
  const proxy = await createServer(baseConfig(`${upstreamUrl}/v1`));
  const proxyUrl = await maybeListen(t, proxy);
  if (!proxyUrl) return;
  t.after(() => proxy.close());

  const chat = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hedge-router-session-id': 'session-one' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'implement it' }] })
  });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-hedge-router-route'), 'mock/good');
  assert.equal((await chat.json()).choices[0].message.content, 'hello');

  const streamed = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hedge-router-session-id': 'session-two' },
    body: JSON.stringify({ model: 'mock/good', stream: true, messages: [{ role: 'user', content: 'hello' }] })
  });
  assert.match(await streamed.text(), /"content":"hello"/);

  const responses = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hedge-router-session-id': 'session-three' },
    body: JSON.stringify({ model: 'mock/good', input: 'hello' })
  });
  assert.equal((await responses.json()).object, 'response');

  const report = await (await fetch(`${proxyUrl}/v1/hedge-router/report`)).json();
  assert.equal(report.requests, 3);
  assert.ok(report.actual_cost_usd > 0);
});

test('collector authenticates, deduplicates, aggregates cohorts, and deletes', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'comp-collector-'));
  process.env.COMP_DATA_DIR = dataDir;
  process.env.COMP_COLLECTOR_TOKEN = 'collector-test-secret';
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const { createCollector } = await import('../src/collector.js');
  const config = baseConfig('http://unused.local/v1');
  const collector = await createCollector(config, { file: path.join(dataDir, 'received.ndjson') });
  const collectorUrl = await maybeListen(t, collector);
  if (!collectorUrl) return;
  t.after(() => collector.close());

  const telemetryEvent = (installId, requestId) => ({
    schema_version: 1, event_type: 'request', timestamp: '2026-08-26T12:00:00.000Z',
    install_id: installId, session_id: 'c'.repeat(20), request_id: requestId,
    model: 'mock/good', baseline_model: 'mock/good', provider: 'openai', control: false,
    route_reason: 'cheapest_eligible', task_class: 'implementation', input_tokens: 10,
    cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2,
    latency_ms: 100, routing_overhead_ms: 1, provider_status: 200, error_category: null,
    actual_cost_usd: 0.01, baseline_cost_usd: 0.02, savings_usd: 0.01, attempts: 1,
    input_per_million: 1, cached_input_per_million: 0.1,
    cache_write_input_per_million: 1.25, output_per_million: 2,
    tests_pass: null, rating: null
  });
  const headers = { authorization: 'Bearer collector-test-secret', 'content-type': 'application/json' };

  const unauthorized = await fetch(`${collectorUrl}/v1/telemetry/aggregate`);
  assert.equal(unauthorized.status, 401);

  const first = telemetryEvent('a'.repeat(20), 'req_one');
  const second = telemetryEvent('b'.repeat(20), 'req_two');
  const accepted = await fetch(`${collectorUrl}/v1/telemetry/events`, {
    method: 'POST', headers, body: JSON.stringify([first, first, second])
  });
  assert.equal(accepted.status, 202);

  const rejected = await fetch(`${collectorUrl}/v1/telemetry/events`, {
    method: 'POST', headers, body: JSON.stringify({ ...first, prompt: 'must never arrive' })
  });
  assert.equal(rejected.status, 400);

  const aggregate = await (await fetch(`${collectorUrl}/v1/telemetry/aggregate`, { headers })).json();
  assert.equal(aggregate.length, 1);
  assert.equal(aggregate[0].contributors, 2);
  assert.equal(aggregate[0].request_count, 2);

  const deletion = await fetch(`${collectorUrl}/v1/telemetry/events`, {
    method: 'DELETE', headers, body: JSON.stringify({ install_ids: ['a'.repeat(20)] })
  });
  assert.equal((await deletion.json()).removed, 1);
  const afterDelete = await (await fetch(`${collectorUrl}/v1/telemetry/aggregate`, { headers })).json();
  assert.deepEqual(afterDelete, []);
});
