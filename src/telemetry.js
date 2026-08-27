import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { anonymousId, DATA_DIR, mean, median, newId, nowIso, readJson, writeJsonAtomic } from './utils.js';

const EVENTS_FILE = path.join(DATA_DIR, 'events.ndjson');
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'telemetry-outbox.ndjson');
const TASK_CLASSES = new Set(['test', 'debug', 'refactor', 'analysis', 'implementation', 'other']);

async function identity() {
  try {
    return await readJson(IDENTITY_FILE);
  } catch {
    const value = { installId: newId('install'), salt: newId('salt'), createdAt: nowIso() };
    await writeJsonAtomic(IDENTITY_FILE, value);
    return value;
  }
}

function monthOf(timestamp) {
  return timestamp.slice(0, 7);
}

function safeTaskClass(value) {
  return TASK_CLASSES.has(value) ? value : 'other';
}

export async function createTelemetry(config) {
  const id = await identity();
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  let flushPromise = null;

  async function flush() {
    if (!config.telemetry.enabled || !config.telemetry.remoteUrl) {
      return { sent: 0, pending: (await loadEvents(OUTBOX_FILE)).length, enabled: false };
    }
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      const queued = await loadEvents(OUTBOX_FILE);
      if (!queued.length) return { sent: 0, pending: 0, enabled: true };
      const token = config.telemetry.remoteTokenEnv ? process.env[config.telemetry.remoteTokenEnv] : null;
      const response = await fetch(config.telemetry.remoteUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(queued.slice(0, 1000)),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) throw new Error(`Telemetry collector returned HTTP ${response.status}`);
      const sent = queued.slice(0, 1000);
      const sentKeys = new Set(sent.map(eventKey));
      const current = await loadEvents(OUTBOX_FILE);
      const retained = current.filter((event) => !sentKeys.has(eventKey(event)));
      await writeNdjsonAtomic(OUTBOX_FILE, retained);
      return { sent: sent.length, pending: retained.length, enabled: true };
    })();
    try { return await flushPromise; }
    finally { flushPromise = null; }
  }

  async function record(raw) {
    const timestamp = raw.timestamp || nowIso();
    const month = monthOf(timestamp);
    const event = {
      schema_version: 1,
      event_type: raw.event_type,
      timestamp,
      install_id: anonymousId(id.installId, `${id.salt}:${month}`),
      session_id: anonymousId(raw.session_id || 'none', `${id.salt}:${month}`),
      request_id: raw.request_id,
      model: raw.model,
      baseline_model: raw.baseline_model,
      provider: raw.provider,
      control: Boolean(raw.control),
      route_reason: raw.route_reason,
      task_class: safeTaskClass(raw.task_class),
      input_tokens: Number(raw.input_tokens || 0),
      cached_input_tokens: Number(raw.cached_input_tokens || 0),
      cache_write_input_tokens: Number(raw.cache_write_input_tokens || 0),
      output_tokens: Number(raw.output_tokens || 0),
      latency_ms: Number(raw.latency_ms || 0),
      routing_overhead_ms: Number(raw.routing_overhead_ms || 0),
      provider_status: Number(raw.provider_status || 0),
      error_category: raw.error_category || null,
      actual_cost_usd: Number(raw.actual_cost_usd || 0),
      baseline_cost_usd: Number(raw.baseline_cost_usd || 0),
      savings_usd: Number(raw.savings_usd || 0),
      attempts: Number(raw.attempts || 0),
      input_per_million: Number(raw.input_per_million || 0),
      cached_input_per_million: Number(raw.cached_input_per_million || 0),
      cache_write_input_per_million: Number(raw.cache_write_input_per_million || 0),
      output_per_million: Number(raw.output_per_million || 0),
      tests_pass: raw.tests_pass ?? null,
      rating: raw.rating ?? null
    };
    await appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (config.telemetry.enabled && config.telemetry.remoteUrl) {
      await appendFile(OUTBOX_FILE, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
      void flush().catch(() => {});
    }
    return event;
  }

  return { record, sync: flush, prune: () => pruneEvents(config.telemetry.rawRetentionDays), file: EVENTS_FILE };
}

function eventKey(event) {
  return `${event.install_id}:${event.request_id || `${event.event_type}:${event.session_id}:${event.timestamp}`}`;
}

async function writeNdjsonAtomic(file, events) {
  await writeJsonLines(file, events);
}

export async function loadEvents(file = EVENTS_FILE) {
  try {
    const source = await readFile(file, 'utf8');
    return source.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function pruneEvents(retentionDays, file = EVENTS_FILE) {
  const events = await loadEvents(file);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const retained = events.filter((event) => Date.parse(event.timestamp) >= cutoff);
  if (retained.length !== events.length) {
    await writeJsonLines(file, retained);
  }
  return events.length - retained.length;
}

async function writeJsonLines(file, events) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 });
  await rename(temporary, file);
}

export function savingsReport(events) {
  const requests = events.filter((event) => event.event_type === 'request');
  const outcomes = events.filter((event) => event.event_type === 'outcome');
  const actual = requests.reduce((sum, event) => sum + event.actual_cost_usd, 0);
  const baseline = requests.reduce((sum, event) => sum + event.baseline_cost_usd, 0);
  const successRatings = outcomes.filter((event) => event.rating != null).map((event) => Number(event.rating) > 0 ? 1 : 0);
  const tests = outcomes.filter((event) => event.tests_pass != null);
  return {
    requests: requests.length,
    sessions: new Set(requests.map((event) => event.session_id)).size,
    actual_cost_usd: actual,
    baseline_cost_usd: baseline,
    savings_usd: baseline - actual,
    savings_percent: baseline > 0 ? ((baseline - actual) / baseline) * 100 : 0,
    median_latency_ms: median(requests.map((event) => event.latency_ms)),
    p95_routing_overhead_ms: percentile(requests.map((event) => event.routing_overhead_ms || 0), 0.95),
    fallback_rate: requests.length ? requests.filter((event) => event.attempts > 1).length / requests.length : 0,
    positive_rating_rate: mean(successRatings),
    test_pass_rate: tests.length ? tests.filter((event) => event.tests_pass).length / tests.length : 0
  };
}

function percentile(values, quantile) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function experimentReport(events) {
  const base = savingsReport(events);
  const requests = events.filter((event) => event.event_type === 'request');
  const outcomes = new Map(events.filter((event) => event.event_type === 'outcome').map((event) => [event.session_id, event]));
  const sessions = new Map();
  for (const request of requests) if (!sessions.has(request.session_id)) sessions.set(request.session_id, request);
  const scored = [...sessions.values()].flatMap((request) => {
    const outcome = outcomes.get(request.session_id);
    if (!outcome) return [];
    const success = outcome.tests_pass != null ? Boolean(outcome.tests_pass) : outcome.rating != null ? outcome.rating > 0 : null;
    return success == null ? [] : [{ control: request.control, success: success ? 1 : 0 }];
  });
  const control = scored.filter((row) => row.control).map((row) => row.success);
  const treatment = scored.filter((row) => !row.control).map((row) => row.success);
  const controlSuccess = control.length ? mean(control) : null;
  const treatmentSuccess = treatment.length ? mean(treatment) : null;
  const qualityDegradation = controlSuccess == null || treatmentSuccess == null ? null : controlSuccess - treatmentSuccess;
  const contributors = new Set(requests.map((event) => event.install_id)).size;
  return {
    ...base,
    contributors,
    completed_sessions: outcomes.size,
    scored_sessions: scored.length,
    control_success_rate: controlSuccess,
    treatment_success_rate: treatmentSuccess,
    quality_degradation: qualityDegradation,
    router_gate: outcomes.size >= 500 && contributors >= 25 && base.savings_percent >= 20 &&
      qualityDegradation != null && qualityDegradation <= 0.05 && base.p95_routing_overhead_ms < 100
  };
}

export async function deleteLocalTelemetry() {
  let deleted = 0;
  for (const file of [EVENTS_FILE, IDENTITY_FILE, OUTBOX_FILE]) {
    try {
      await unlink(file);
      deleted += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return deleted;
}

export async function deleteRemoteTelemetry(config) {
  if (!config.telemetry.enabled || !config.telemetry.remoteUrl) return { configured: false, removed: 0 };
  const id = await identity();
  const start = new Date(id.createdAt);
  const end = new Date();
  const installIds = [];
  for (let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    const month = cursor.toISOString().slice(0, 7);
    installIds.push(anonymousId(id.installId, `${id.salt}:${month}`));
  }
  const token = config.telemetry.remoteTokenEnv ? process.env[config.telemetry.remoteTokenEnv] : null;
  const response = await fetch(config.telemetry.remoteUrl, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ install_ids: installIds }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Remote deletion failed with HTTP ${response.status}`);
  return { configured: true, ...(await response.json()) };
}

export function aggregateDaily(events, minimumCohort = 20) {
  const groups = new Map();
  for (const event of events.filter((item) => item.event_type === 'request')) {
    const date = event.timestamp.slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(event);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([date, rows]) => {
    const contributors = new Set(rows.map((row) => row.install_id)).size;
    if (contributors < minimumCohort) return [];
    const totalInput = rows.reduce((sum, row) => sum + row.input_tokens, 0);
    const totalCached = rows.reduce((sum, row) => sum + row.cached_input_tokens, 0);
    return [{
      date,
      contributors,
      request_count: rows.length,
      input_tokens: totalInput,
      output_tokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
      cache_ratio: totalInput ? totalCached / totalInput : 0,
      mean_latency_ms: mean(rows.map((row) => row.latency_ms)),
      error_rate: rows.filter((row) => row.provider_status >= 400).length / rows.length,
      fallback_rate: rows.filter((row) => row.attempts > 1).length / rows.length,
      control_rate: rows.filter((row) => row.control).length / rows.length
    }];
  });
}

export function summarizeModelStats(events) {
  const groups = new Map();
  for (const event of events.filter((item) => item.event_type === 'request' && item.model)) {
    if (!groups.has(event.model)) groups.set(event.model, []);
    groups.get(event.model).push(event);
  }
  return Object.fromEntries([...groups.entries()].map(([model, rows]) => [model, {
    samples: rows.length,
    mean_latency_ms: mean(rows.map((row) => row.latency_ms)),
    error_rate: rows.filter((row) => row.provider_status >= 400).length / rows.length
  }]));
}

export function observeModelStat(stats, event) {
  if (!event.model) return;
  const prior = stats[event.model] || { samples: 0, mean_latency_ms: 0, error_rate: 0 };
  const samples = prior.samples + 1;
  stats[event.model] = {
    samples,
    mean_latency_ms: prior.mean_latency_ms + (event.latency_ms - prior.mean_latency_ms) / samples,
    error_rate: prior.error_rate + (((event.provider_status >= 400 ? 1 : 0) - prior.error_rate) / samples)
  };
}

export { EVENTS_FILE, OUTBOX_FILE };
