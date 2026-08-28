import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboardState, createDemoState, renderDashboard } from '../src/dashboard.js';

function request(overrides = {}) {
  return {
    event_type: 'request', timestamp: '2026-08-28T19:32:10.000Z', session_id: 'safe-session',
    task_class: 'implementation', model: 'openai/gpt-5-mini', actual_cost_usd: 0.002,
    baseline_cost_usd: 0.008, savings_usd: 0.006, latency_ms: 840,
    provider_status: 200, attempts: 1, ...overrides
  };
}

test('dashboard renders routing, model mix, and explicitly paper hedges', () => {
  const market = {
    paper_pnl: 0.09, gate: false, results: [{
      id: 'KXH100WS-3.000', chip: 'H100', threshold: 3,
      predicted_price: 3.18, probability: 0.31, market_probability: 0.22,
      side: 'yes', paper_pnl: 0.09
    }]
  };
  const view = renderDashboard(buildDashboardState([request()], market), { color: false, width: 100 });
  assert.match(view, /HEDGE ROUTER/);
  assert.match(view, /LIVE ROUTING/);
  assert.match(view, /openai\/gpt-5-mini/);
  assert.match(view, /KALSHI PAPER HEDGES/);
  assert.match(view, /PAPER\s+KXH100WS-3\.000/);
  assert.doesNotMatch(view, /\u001b\[/);
  assert.ok(view.split('\n').every((line) => line.length === 100));
  const narrow = renderDashboard(buildDashboardState([request()], market), { color: false, width: 68 });
  assert.ok(narrow.split('\n').every((line) => line.length === 68));
});

test('demo feed is deterministic and becomes gate-open', () => {
  const early = createDemoState(0);
  const later = createDemoState(9);
  assert.equal(createDemoState(3).report.savings_usd, createDemoState(3).report.savings_usd);
  assert.ok(later.report.requests > early.report.requests);
  assert.equal(later.mode, 'demo');
  assert.equal(later.market.gate, true);
  assert.ok(later.hedges.length >= early.hedges.length);
});

test('failed and fallback routes have visible operational status', () => {
  const state = buildDashboardState([
    request({ attempts: 2 }),
    request({ model: null, provider_status: 502, savings_usd: 0 })
  ]);
  const view = renderDashboard(state, { color: false });
  assert.match(view, /FALLBACK/);
  assert.match(view, /ERROR/);
});

test('dashboard prefers persistent portfolio orders over backtest rows', () => {
  const paper = {
    realized_pnl: 0,
    orders: [{
      order_id: 'paper_one', market_id: 'KXH100WS-LIVE', side: 'yes', contracts: 12,
      entry_price: 0.24, probability: 0.34, market_probability: 0.24,
      predicted_price: 3.2, threshold: 3, edge: 0.1, chip: 'H100', status: 'open'
    }]
  };
  const view = renderDashboard(buildDashboardState([request()], null, { paper }), { color: false });
  assert.match(view, /KXH100WS-LIVE/);
  assert.match(view, /BUY YES x12/);
  assert.match(view, /OPEN/);
});
