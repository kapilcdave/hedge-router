import { createHash } from 'node:crypto';
import { normalizeUsage } from './catalog.js';

const FORMATS = new Set(['auto', 'agentgateway', 'weave', 'otel', 'canonical', 'claude-code']);

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function sourceLabel(value, fallback) {
  const label = String(value || fallback);
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(label)) {
    throw new Error('source must contain only letters, numbers, dot, underscore, or dash (max 64 characters)');
  }
  return label;
}

function number(value, fallback = 0) {
  if (typeof value === 'string' && value.endsWith('ms')) value = value.slice(0, -2);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value) {
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

function statusCategory(status) {
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'provider_server';
  if (status >= 400) return 'request_rejected';
  return null;
}

function anyValue(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of ['stringValue', 'boolValue', 'intValue', 'doubleValue', 'bytesValue']) {
    if (key in value) return value[key];
  }
  if (value.arrayValue?.values) return value.arrayValue.values.map(anyValue);
  if (value.kvlistValue?.values) {
    return Object.fromEntries(value.kvlistValue.values.map((item) => [item.key, anyValue(item.value)]));
  }
  return value;
}

function attributes(items = []) {
  return Object.fromEntries(items.map((item) => [item.key, anyValue(item.value)]));
}

function flatten(value, prefix = '', result = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, name, result);
    else result[name] = child;
  }
  return result;
}

function lookup(flat, ...names) {
  for (const name of names) if (flat[name] != null) return flat[name];
  return undefined;
}

function timestamp(value) {
  if (value == null) return null;
  const text = String(value);
  if (/^\d{16,}$/.test(text)) {
    const milliseconds = Number(BigInt(text) / 1_000_000n);
    return new Date(milliseconds).toISOString();
  }
  if (/^\d{10}(?:\.\d+)?$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseKeyValueLine(line) {
  const row = {};
  const first = line.trim().split(/\s+/, 1)[0];
  if (timestamp(first)) row.timestamp = first;
  const pattern = /(?:^|\s)([\w.:-]+)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
  for (const match of line.matchAll(pattern)) {
    const raw = match[2];
    row[match[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return Object.keys(row).length > 1 ? row : null;
}

function parseRows(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  try {
    const value = JSON.parse(source);
    return Array.isArray(value) ? value : [value];
  } catch {
    return source.split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; }
      catch {
        const parsed = parseKeyValueLine(line);
        return parsed ? [parsed] : [];
      }
    });
  }
}

function otelRows(document) {
  const resources = document.resourceSpans || document.resource_spans;
  if (!Array.isArray(resources)) return [];
  return resources.flatMap((resourceSpan) => {
    const resource = attributes(resourceSpan.resource?.attributes);
    const scopes = resourceSpan.scopeSpans || resourceSpan.scope_spans || resourceSpan.instrumentationLibrarySpans || [];
    return scopes.flatMap((scopeSpan) => (scopeSpan.spans || []).map((span) => ({
      ...resource,
      ...attributes(span.attributes),
      name: span.name,
      trace_id: span.traceId || span.trace_id,
      span_id: span.spanId || span.span_id,
      start_time: span.startTimeUnixNano || span.start_time_unix_nano,
      end_time: span.endTimeUnixNano || span.end_time_unix_nano,
      status_code: span.status?.code
    })));
  });
}

function expandRows(rows) {
  return rows.flatMap((row) => {
    const expanded = otelRows(row);
    return expanded.length ? expanded : [row];
  });
}

function detectedFormat(row) {
  const flat = flatten(row);
  if (row.type === 'assistant' && row.message?.usage && row.message?.role === 'assistant') return 'claude-code';
  if (flat.decision_model != null || flat.actual_input_cost_usd != null) return 'weave';
  if (Object.keys(flat).some((key) => key.startsWith('gen_ai.') || key.startsWith('agw.ai.'))) return 'agentgateway';
  if (row.event_type === 'request' || row.schema_version != null) return 'canonical';
  return null;
}

function normalizeCanonical(row, source) {
  if (row.event_type && row.event_type !== 'request') return null;
  return {
    event_type: 'request',
    source,
    gateway: source,
    timestamp: row.timestamp,
    session_id: row.session_id,
    request_id: row.request_id,
    model: row.model,
    baseline_model: row.baseline_model,
    provider: row.provider,
    control: row.control,
    route_reason: row.route_reason,
    task_class: row.task_class,
    input_tokens: row.input_tokens,
    cached_input_tokens: row.cached_input_tokens,
    cache_write_input_tokens: row.cache_write_input_tokens,
    output_tokens: row.output_tokens,
    latency_ms: row.latency_ms,
    routing_overhead_ms: row.routing_overhead_ms,
    provider_status: row.provider_status,
    error_category: row.error_category,
    actual_cost_usd: row.actual_cost_usd,
    baseline_cost_usd: row.baseline_cost_usd,
    savings_usd: row.savings_usd,
    attempts: row.attempts,
    input_per_million: row.input_per_million,
    cached_input_per_million: row.cached_input_per_million,
    cache_write_input_per_million: row.cache_write_input_per_million,
    output_per_million: row.output_per_million
  };
}

// Claude Code transcripts are a local coding-agent ledger, not a gateway export. Only the
// assistant turn's model, timestamp, and token counts cross the privacy boundary: never the
// message content, cwd, git branch, or tool arguments recorded alongside them.
function normalizeClaudeCode(row, source) {
  if (row.type !== 'assistant' || !row.message?.usage) return null;
  const model = String(row.message.model || '');
  if (!model || model.startsWith('<')) return null;
  const startedAt = timestamp(row.timestamp);
  if (!startedAt) return null;
  const usage = normalizeUsage(row.message.usage);
  if (!usage.input_tokens && !usage.output_tokens) return null;
  const rawId = row.requestId || row.message.id || row.uuid || `${startedAt}:${model}`;
  return {
    event_type: 'request',
    timestamp: startedAt,
    source,
    gateway: source,
    session_id: String(row.sessionId || rawId),
    request_id: `ing_${digest(`${source}:${rawId}`)}`,
    model,
    baseline_model: null,
    provider: 'anthropic',
    control: false,
    route_reason: 'coding_agent',
    task_class: 'other',
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    cache_write_input_tokens: usage.cache_write_input_tokens,
    output_tokens: usage.output_tokens,
    latency_ms: 0,
    routing_overhead_ms: 0,
    provider_status: 200,
    error_category: null,
    actual_cost_usd: 0,
    baseline_cost_usd: 0,
    savings_usd: 0,
    attempts: 1
  };
}

function normalizeMetadata(row, source) {
  const flat = flatten(row);
  const protocol = lookup(flat, 'protocol');
  const model = lookup(flat,
    'decision_model', 'gen_ai.response.model', 'gen_ai.request.model',
    'gen_ai.response_model', 'gen_ai.request_model', 'model', 'llm.response_model', 'llm.request_model');
  if (protocol && protocol !== 'llm' && protocol !== 'gen_ai') return null;
  if (!model && !Object.keys(flat).some((key) => key.startsWith('gen_ai.'))) return null;

  const started = lookup(flat, 'requested_at', 'timestamp', 'time', 'start_time', 'startTimeUnixNano');
  const ended = lookup(flat, 'end_time', 'endTimeUnixNano');
  const startedAt = timestamp(started) || new Date().toISOString();
  const computedDuration = started && ended && /^\d+$/.test(String(started)) && /^\d+$/.test(String(ended))
    ? Number((BigInt(String(ended)) - BigInt(String(started))) / 1_000_000n)
    : 0;
  const rawId = lookup(flat, 'id', 'span_id', 'spanId', 'request_id', 'trace_id', 'traceId') || JSON.stringify([
    startedAt, model,
    lookup(flat, 'input_tokens', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'),
    lookup(flat, 'output_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'),
    lookup(flat, 'total_latency_ms', 'duration_ms', 'duration', 'upstream_latency_ms'),
    lookup(flat, 'upstream_status_code', 'http.response.status_code', 'http.status_code', 'http.status')
  ]);
  const rawSession = lookup(flat, 'session_id', 'trace_id', 'traceId', 'request_id') || rawId;
  const inputCost = number(lookup(flat, 'actual_input_cost_usd', 'agw.ai.usage.cost.input'));
  const outputCost = number(lookup(flat, 'actual_output_cost_usd', 'agw.ai.usage.cost.output'));
  const totalCost = lookup(flat, 'actual_cost_usd', 'agw.ai.usage.cost.total', 'cost_usd');
  const httpStatus = lookup(flat,
    'upstream_status_code', 'http.response.status_code', 'http.status_code', 'http.status', 'status');
  const spanStatus = number(lookup(flat, 'status_code'));
  const status = httpStatus == null ? spanStatus === 2 ? 500 : 200 : number(httpStatus, 200);
  const failed = status >= 400;
  return {
    event_type: 'request',
    timestamp: startedAt,
    source,
    gateway: source,
    session_id: String(rawSession),
    request_id: `ing_${digest(`${source}:${rawId}`)}`,
    model: String(model || 'unknown'),
    baseline_model: lookup(flat, 'requested_model', 'baseline_model') || null,
    provider: lookup(flat, 'decision_provider', 'gen_ai.provider.name', 'gen_ai.system', 'provider') || null,
    control: false,
    route_reason: boolean(lookup(flat, 'failover_used')) ? 'external_failover' : 'external_gateway',
    task_class: 'other',
    input_tokens: number(lookup(flat, 'input_tokens', 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.input_tokens')),
    cached_input_tokens: number(lookup(flat, 'cache_read_tokens', 'cached_input_tokens', 'llm.cached_input_tokens')),
    cache_write_input_tokens: number(lookup(flat, 'cache_creation_tokens', 'cache_write_input_tokens', 'llm.cache_creation_input_tokens')),
    output_tokens: number(lookup(flat, 'output_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.output_tokens')),
    latency_ms: number(lookup(flat, 'total_latency_ms', 'duration_ms', 'duration', 'upstream_latency_ms'), computedDuration),
    routing_overhead_ms: number(lookup(flat, 'route_latency_ms', 'routing_overhead_ms')),
    provider_status: status,
    error_category: failed ? statusCategory(status) : null,
    actual_cost_usd: totalCost == null ? inputCost + outputCost : number(totalCost),
    baseline_cost_usd: number(lookup(flat, 'baseline_cost_usd')),
    savings_usd: number(lookup(flat, 'savings_usd')),
    attempts: boolean(lookup(flat, 'failover_used')) ? 2 : Math.max(1, number(lookup(flat, 'attempts'), 1))
  };
}

export function normalizeGatewayExport(text, options = {}) {
  const requested = options.format || 'auto';
  if (!FORMATS.has(requested)) throw new Error(`Unsupported format: ${requested}`);
  const rows = expandRows(parseRows(text));
  const events = [];
  let skipped = 0;
  const formats = new Set();
  rows.forEach((row) => {
    const format = requested === 'auto' ? detectedFormat(row) : requested;
    if (!format) {
      skipped += 1;
      return;
    }
    formats.add(format);
    const source = sourceLabel(options.source, format);
    const event = format === 'canonical'
      ? normalizeCanonical(row, source)
      : format === 'claude-code'
        ? normalizeClaudeCode(row, source)
        : normalizeMetadata(row, source);
    if (event) events.push(event);
    else skipped += 1;
  });
  return { events, skipped, rows: rows.length, formats: [...formats].sort() };
}

export { FORMATS };
