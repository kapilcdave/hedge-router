import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTelemetryEvent } from '../src/collector.js';

function event(overrides = {}) {
  return {
    schema_version: 1,
    event_type: 'request',
    timestamp: '2026-08-26T12:00:00.000Z',
    install_id: 'a'.repeat(20),
    session_id: 'b'.repeat(20),
    request_id: 'req_test',
    model: 'openai/test',
    input_tokens: 10,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    latency_ms: 100,
    routing_overhead_ms: 1,
    actual_cost_usd: 0.01,
    baseline_cost_usd: 0.02,
    savings_usd: 0.01,
    ...overrides
  };
}

test('collector accepts only the metadata allowlist', () => {
  assert.equal(validateTelemetryEvent(event()).request_id, 'req_test');
  assert.throws(() => validateTelemetryEvent(event({ prompt: 'secret source code' })), /Unknown telemetry fields: prompt/);
  assert.throws(() => validateTelemetryEvent(event({ input_tokens: -1 })), /Invalid numeric field/);
});

test('collector rejects malformed pseudonymous identifiers', () => {
  assert.throws(() => validateTelemetryEvent(event({ install_id: 'customer@example.com' })), /Invalid install_id/);
});
