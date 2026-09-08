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
