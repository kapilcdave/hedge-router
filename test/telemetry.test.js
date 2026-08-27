import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDaily, savingsReport } from '../src/telemetry.js';

function request(install, overrides = {}) {
  return {
    event_type: 'request', timestamp: '2026-08-20T10:00:00.000Z', install_id: install,
    session_id: `s-${install}`, actual_cost_usd: 1, baseline_cost_usd: 2, savings_usd: 1,
    latency_ms: 100, input_tokens: 100, cached_input_tokens: 20, output_tokens: 30,
    provider_status: 200, attempts: 1, control: false, ...overrides
  };
}

test('daily aggregates enforce the contributor threshold', () => {
  const events = Array.from({ length: 19 }, (_, index) => request(`i-${index}`));
  assert.deepEqual(aggregateDaily(events, 20), []);
  events.push(request('i-19'));
  const [daily] = aggregateDaily(events, 20);
  assert.equal(daily.contributors, 20);
  assert.equal(daily.request_count, 20);
  assert.equal(daily.cache_ratio, 0.2);
});

test('savings report computes spend and operational measures', () => {
  const report = savingsReport([request('one'), request('two', { attempts: 2 })]);
  assert.equal(report.actual_cost_usd, 2);
  assert.equal(report.savings_percent, 50);
  assert.equal(report.fallback_rate, 0.5);
});
