import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGatewayExport } from '../src/ingest.js';

test('normalizes Weave routing-decision NDJSON without retaining content', () => {
  const input = JSON.stringify({
    id: 'row-one', requested_at: '2026-08-30T12:00:00Z', request_id: 'request-one',
    session_id: 'session-one', requested_model: 'claude-sonnet', decision_model: 'gpt-mini',
    decision_provider: 'openai', decision_reason: 'lowest cost eligible', failover_used: true,
    input_tokens: 120, output_tokens: 30, cache_read_tokens: 20,
    actual_input_cost_usd: 0.001, actual_output_cost_usd: 0.002,
    route_latency_ms: 7, total_latency_ms: 400, upstream_status_code: 200,
    prompt: 'private source code must be dropped'
  });
  const result = normalizeGatewayExport(input, { format: 'weave' });
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.formats, ['weave']);
  assert.equal(result.events[0].model, 'gpt-mini');
  assert.equal(result.events[0].baseline_model, 'claude-sonnet');
  assert.equal(result.events[0].actual_cost_usd, 0.003);
  assert.equal(result.events[0].attempts, 2);
  assert.equal(result.events[0].prompt, undefined);
});

test('normalizes Agentgateway key-value access logs', () => {
  const input = '2026-08-30T12:01:00Z info request gateway=agentgateway protocol=llm http.status=200 gen_ai.provider.name=openai gen_ai.request.model=gpt-5-mini gen_ai.response.model=gpt-5-mini gen_ai.usage.input_tokens=68 gen_ai.usage.output_tokens=12 agw.ai.usage.cost.total=0.00042 duration=2488ms';
  const { events, skipped } = normalizeGatewayExport(input, { format: 'agentgateway' });
  assert.equal(skipped, 0);
  assert.equal(events[0].source, 'agentgateway');
  assert.equal(events[0].input_tokens, 68);
  assert.equal(events[0].output_tokens, 12);
  assert.equal(events[0].latency_ms, 2488);
  assert.equal(events[0].actual_cost_usd, 0.00042);
});

test('extracts GenAI spans from OTLP JSON and deterministically deduplicates IDs', () => {
  const input = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: 'trace-one', spanId: 'span-one', startTimeUnixNano: '1788091260000000000',
    endTimeUnixNano: '1788091260500000000', attributes: [
      { key: 'gen_ai.provider.name', value: { stringValue: 'anthropic' } },
      { key: 'gen_ai.response.model', value: { stringValue: 'claude-sonnet' } },
      { key: 'gen_ai.usage.input_tokens', value: { intValue: '100' } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: '20' } }
    ]
  }] }] }] });
  const first = normalizeGatewayExport(input, { format: 'otel', source: 'agentgateway-prod' });
  const second = normalizeGatewayExport(input, { format: 'otel', source: 'agentgateway-prod' });
  assert.deepEqual(first.formats, ['otel']);
  assert.equal(first.events[0].request_id, second.events[0].request_id);
  assert.equal(first.events[0].latency_ms, 500);
  assert.equal(first.events[0].source, 'agentgateway-prod');
});

test('skips non-LLM gateway records', () => {
  const input = '{"protocol":"mcp","http":{"status":200}}';
  const result = normalizeGatewayExport(input, { format: 'agentgateway' });
  assert.equal(result.events.length, 0);
  assert.equal(result.skipped, 1);
});

test('canonical imports are allowlisted and source labels cannot carry identity data', () => {
  const result = normalizeGatewayExport(JSON.stringify({
    event_type: 'request', timestamp: '2026-08-30T12:00:00Z', request_id: 'one',
    session_id: 'session', model: 'model', input_tokens: 1, prompt: 'drop me'
  }), { format: 'canonical' });
  assert.equal(result.events[0].prompt, undefined);
  assert.throws(() => normalizeGatewayExport('{}', { format: 'canonical', source: 'person@example.com' }), /source must contain/);
});

test('normalizes Cloudflare AI Gateway log envelopes and drops caller metadata', () => {
  const input = JSON.stringify({ success: true, result: [
    { id: 'cf-1', created_at: '2026-08-30T12:02:00Z', provider: 'openai', model: 'gpt-5-mini', success: true,
      status_code: 200, cached: false, tokens_in: 900, tokens_out: 120, duration: 640, cost: 0.00047,
      metadata: '{"user":"person@example.com"}', path: '/v1/chat/completions' },
    { id: 'cf-2', created_at: '2026-08-30T12:03:00Z', provider: 'openai', model: 'gpt-5-mini', success: false,
      tokens_in: 0, tokens_out: 0, duration: 90 },
    { id: 'cf-3', created_at: '2026-08-30T12:04:00Z', provider: 'openai', model: 'gpt-5-mini', success: true,
      cached: true, tokens_in: 900, tokens_out: 120, duration: 12, cost: 0 },
    { id: 'cf-4', created_at: '2026-08-30T12:05:00Z', provider: 'workers-ai', success: true, tokens_in: 0, tokens_out: 0, duration: 5 }
  ], result_info: { count: 4 } });
  const result = normalizeGatewayExport(input);
  assert.deepEqual(result.formats, ['cloudflare']);
  assert.equal(result.events.length, 3);
  assert.equal(result.skipped, 1);
  const [ok, failed, hit] = result.events;
  assert.equal(ok.latency_ms, 640);
  assert.equal(ok.actual_cost_usd, 0.00047);
  assert.equal(JSON.stringify(ok).includes('example.com'), false);
  assert.equal(failed.provider_status, 500);
  assert.equal(failed.error_category, 'provider_server');
  assert.equal(hit.route_reason, 'external_cache_hit');
  assert.equal(hit.cached_input_tokens, 900);
  assert.equal(normalizeGatewayExport(input).events[0].request_id, ok.request_id);
});

test('Vercel trace drains yield one request per root span and count provider attempts', () => {
  const attr = (key, value) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } });
  const span = (spanId, name, attributes) => ({
    traceId: 'trace-v', spanId, name, startTimeUnixNano: '1788091380000000000', endTimeUnixNano: '1788091382000000000', attributes
  });
  const input = JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [
    span('root', 'chat anthropic/claude-sonnet-5', [
      attr('gen_ai.request.model', 'anthropic/claude-sonnet-5'), attr('gen_ai.response.model', 'claude-sonnet-5'),
      attr('gen_ai.usage.input_tokens', 2000), attr('gen_ai.usage.output_tokens', 300),
      attr('gen_ai.usage.cache_read.input_tokens', 1500), attr('http.response.status_code', 200),
      attr('vercel.ai_gateway.provider', 'vertexAnthropic'), attr('vercel.ai_gateway.request.id', 'req-1'),
      attr('vercel.ai_gateway.credential.type', 'system'), attr('vercel.ai_gateway.cost.total', '0.0081'),
      attr('vercel.ai_gateway.cost.currency', 'USD'), attr('vercel.ai_gateway.user.id', 'secret-user'),
      attr('vercel.ai_gateway.tags', 'team:secret')
    ]),
    span('routing', 'vercel.ai_gateway.routing', [attr('vercel.ai_gateway.routing.custom_provider_order', 'a,b')]),
    span('a1', 'claude-sonnet-5 (anthropic)', [attr('gen_ai.request.model', 'claude-sonnet-5'), attr('vercel.ai_gateway.attempt.id', 'a1')]),
    span('a2', 'claude-sonnet-5 (vertexAnthropic)', [attr('gen_ai.request.model', 'claude-sonnet-5'), attr('vercel.ai_gateway.attempt.id', 'a2')])
  ] }] }] });
  const result = normalizeGatewayExport(input);
  assert.deepEqual(result.formats, ['vercel']);
  assert.equal(result.events.length, 1);
  assert.equal(result.skipped, 3);
  const [event] = result.events;
  assert.equal(event.model, 'claude-sonnet-5');
  assert.equal(event.provider, 'vertexAnthropic');
  assert.equal(event.attempts, 2);
  assert.equal(event.route_reason, 'external_failover');
  assert.equal(event.cached_input_tokens, 1500);
  assert.equal(event.latency_ms, 2000);
  assert.equal(event.actual_cost_usd, 0.0081);
  assert.equal(JSON.stringify(event).includes('secret'), false);
});

test('Vercel BYOK requests price at market cost and non-USD costs stay absent', () => {
  const build = (attrs) => JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: 't', spanId: 's', startTimeUnixNano: '1788091380000000000', endTimeUnixNano: '1788091381000000000',
    attributes: Object.entries({ 'gen_ai.response.model': 'm', 'vercel.ai_gateway.request.id': 'r', ...attrs })
      .map(([key, value]) => ({ key, value: { stringValue: value } }))
  }] }] }] });
  const byok = normalizeGatewayExport(build({
    'vercel.ai_gateway.credential.type': 'byok', 'vercel.ai_gateway.cost.total': '0',
    'vercel.ai_gateway.cost.market': '0.02', 'vercel.ai_gateway.cost.market_currency': 'USD'
  }), { format: 'vercel' });
  assert.equal(byok.events[0].actual_cost_usd, 0.02);
  const other = normalizeGatewayExport(build({
    'vercel.ai_gateway.cost.total': '5', 'vercel.ai_gateway.cost.currency': 'EUR'
  }), { format: 'vercel' });
  assert.equal(other.events[0].actual_cost_usd, 0);
});

test('normalizes a Vercel /v1/generation lookup and ignores aggregate spend reports', () => {
  const generation = JSON.stringify({ data: {
    id: 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV', total_cost: 0.00123, market_cost: 0.0011, created_at: '2026-05-22T00:00:00.000Z',
    model: 'anthropic/claude-opus-5', is_byok: false, provider_name: 'anthropic', generation_time: 1500,
    tokens_prompt: 100, tokens_completion: 50, native_tokens_cached: 20, native_tokens_cache_creation: 0
  } });
  const result = normalizeGatewayExport(generation);
  assert.deepEqual(result.formats, ['vercel']);
  assert.equal(result.events[0].actual_cost_usd, 0.00123);
  assert.equal(result.events[0].latency_ms, 1500);
  assert.equal(result.events[0].cached_input_tokens, 20);
  const report = normalizeGatewayExport(JSON.stringify({ results: [{ model: 'm', total_cost: 1, request_count: 5 }] }));
  assert.equal(report.events.length, 0);
});
