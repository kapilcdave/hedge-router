import { timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { aggregateDaily } from './telemetry.js';
import { DATA_DIR } from './utils.js';

const COLLECTOR_FILE = path.join(DATA_DIR, 'collector-events.ndjson');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_FIELDS = new Set([
  'schema_version', 'event_type', 'timestamp', 'install_id', 'session_id', 'request_id',
  'model', 'baseline_model', 'provider', 'control', 'route_reason', 'task_class',
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens',
  'latency_ms', 'routing_overhead_ms', 'provider_status', 'error_category',
  'actual_cost_usd', 'baseline_cost_usd', 'savings_usd', 'attempts',
  'input_per_million', 'cached_input_per_million', 'cache_write_input_per_million',
  'output_per_million', 'tests_pass', 'rating'
]);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function authorized(request, token) {
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!supplied || !token) return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload exceeds 2 MiB'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Payload must be valid JSON'), { status: 400 }); }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateTelemetryEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Event must be an object');
  const unknown = Object.keys(event).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw new Error(`Unknown telemetry fields: ${unknown.join(', ')}`);
  if (event.schema_version !== 1) throw new Error('Unsupported schema_version');
  if (!['request', 'outcome'].includes(event.event_type)) throw new Error('Invalid event_type');
  if (!Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid timestamp');
  if (!/^[a-f0-9]{20}$/.test(event.install_id || '')) throw new Error('Invalid install_id');
  if (!/^[a-f0-9]{20}$/.test(event.session_id || '')) throw new Error('Invalid session_id');
  for (const field of [
    'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens',
    'latency_ms', 'routing_overhead_ms', 'actual_cost_usd', 'baseline_cost_usd', 'savings_usd'
  ]) {
    if (!finiteNumber(event[field]) || (field !== 'savings_usd' && event[field] < 0)) {
      throw new Error(`Invalid numeric field: ${field}`);
    }
  }
  return Object.fromEntries(Object.entries(event).filter(([key]) => ALLOWED_FIELDS.has(key)));
}

async function loadCollectorEvents(file = COLLECTOR_FILE) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function replaceEvents(file, events) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 });
  await rename(temporary, file);
}

async function prune(file, retentionDays) {
  const events = await loadCollectorEvents(file);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const retained = events.filter((event) => Date.parse(event.timestamp) >= cutoff);
  if (retained.length !== events.length) await replaceEvents(file, retained);
}

export async function createCollector(config, options = {}) {
  const token = process.env[config.collector.tokenEnv];
  if (!token || token.length < 16) {
    throw new Error(`${config.collector.tokenEnv} must contain a collector token of at least 16 characters`);
  }
  const file = options.file || COLLECTOR_FILE;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await prune(file, config.collector.rawRetentionDays);
  let writeQueue = Promise.resolve();

  function serialize(operation) {
    writeQueue = writeQueue.then(operation, operation);
    return writeQueue;
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://collector.local');
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (!authorized(request, token)) return json(response, 401, { error: { message: 'Unauthorized' } });

      if (request.method === 'POST' && url.pathname === '/v1/telemetry/events') {
        const value = await readBody(request);
        const supplied = Array.isArray(value) ? value : [value];
        if (!supplied.length || supplied.length > 1000) throw Object.assign(new Error('Batch must contain 1-1000 events'), { status: 400 });
        let events;
        try { events = supplied.map(validateTelemetryEvent); }
        catch (error) { throw Object.assign(error, { status: 400 }); }
        let accepted = 0;
        await serialize(async () => {
          const existing = await loadCollectorEvents(file);
          const keys = new Set(existing.map((event) => `${event.install_id}:${event.request_id || event.event_type + ':' + event.session_id + ':' + event.timestamp}`));
          const fresh = events.filter((event) => {
            const key = `${event.install_id}:${event.request_id || event.event_type + ':' + event.session_id + ':' + event.timestamp}`;
            if (keys.has(key)) return false;
            keys.add(key);
            return true;
          });
          accepted = fresh.length;
          if (fresh.length) await appendFile(file, fresh.map((event) => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
        });
        return json(response, 202, { accepted });
      }

      if (request.method === 'GET' && url.pathname === '/v1/telemetry/aggregate') {
        await writeQueue;
        const events = await loadCollectorEvents(file);
        return json(response, 200, aggregateDaily(events, config.collector.minimumCohort));
      }

      if (request.method === 'DELETE' && url.pathname === '/v1/telemetry/events') {
        const body = await readBody(request);
        if (!Array.isArray(body.install_ids) || body.install_ids.length > 120 || body.install_ids.some((id) => !/^[a-f0-9]{20}$/.test(id))) {
          throw Object.assign(new Error('install_ids must be an array of valid identifiers'), { status: 400 });
        }
        let removed = 0;
        await serialize(async () => {
          const events = await loadCollectorEvents(file);
          const targets = new Set(body.install_ids);
          const retained = events.filter((event) => !targets.has(event.install_id));
          removed = events.length - retained.length;
          await replaceEvents(file, retained);
        });
        return json(response, 200, { removed });
      }

      return json(response, 404, { error: { message: 'Not found' } });
    } catch (error) {
      if (!response.headersSent) return json(response, error.status || 500, { error: { message: error.message } });
      response.destroy(error);
    }
  });
}

export async function startCollector(config) {
  const server = await createCollector(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.collector.port, config.collector.host, resolve);
  });
  return server;
}
