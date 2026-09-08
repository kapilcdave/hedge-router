import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboardState, createDemoState, demoSettledFrame, renderDashboard } from '../src/dashboard.js';
import { DEMO_RECORDING } from '../src/demo-data.js';

function request(overrides = {}) {
  return {
    event_type: 'request', timestamp: '2026-08-28T19:32:10.000Z', session_id: 'safe-session',
    task_class: 'implementation', model: 'openai/gpt-5-mini', actual_cost_usd: 0.002,
    baseline_cost_usd: 0.008, savings_usd: 0.006, latency_ms: 840,
    provider_status: 200, attempts: 1, ...overrides
  };
}

test('dashboard renders gateway exposure, model mix, and explicitly paper hedges', () => {
  const market = {
    paper_pnl: 0.09, gate: false, results: [{
      id: 'KXH100WS-3.000', chip: 'H100', threshold: 3,
      predicted_price: 3.18, probability: 0.31, market_probability: 0.22,
      side: 'yes', paper_pnl: 0.09
    }]
  };
  const view = renderDashboard(buildDashboardState([request()], market), { color: false, width: 100 });
  assert.match(view, /hedge router/);
  assert.match(view, /LIVE GATEWAY DATA/);
  assert.match(view, /openai\/gpt-5-mini/);
  assert.match(view, /KALSHI PAPER HEDGES/);
  assert.match(view, /PAPER\s+KXH100WS-3\.000/);
  assert.doesNotMatch(view, /\u001b\[/);
  assert.ok(view.split('\n').every((line) => line.length === 100));
  const narrow = renderDashboard(buildDashboardState([request()], market), { color: false, width: 68 });
  assert.ok(narrow.split('\n').every((line) => line.length === 68));
});

test('demo feed replays recorded results and never claims an open gate', () => {
  const early = createDemoState(0);
  const later = createDemoState(9);
  assert.equal(createDemoState(3).report.actual_cost_usd, createDemoState(3).report.actual_cost_usd);
  assert.ok(later.report.requests > early.report.requests);
  assert.equal(later.mode, 'demo');
  assert.ok(later.hedges.length >= early.hedges.length);
  // The recording carries the real backtest verdict: 10 settlement events against a 30-event
  // requirement, and a losing paper book. No frame may render this as a pass.
  for (const frame of [0, 3, 6, 9, 12, 30]) {
    const state = createDemoState(frame);
    assert.equal(state.market.gate, false);
    assert.equal(state.market.independent_events, DEMO_RECORDING.market.independent_events);
    const view = renderDashboard(state, { color: false, width: 100 });
    assert.doesNotMatch(view, /GATE OPEN/);
    assert.ok(view.split('\n').every((line) => line.length === 100));
  }
  assert.equal(later.market.paper_pnl, -0.78);
});

test('demo shows unreported cost and latency as n/a rather than zero', () => {
  const view = renderDashboard(createDemoState(9), { color: false, width: 100 });
  // Claude Code transcripts carry no per-call price or latency; a silent source is not a free one.
  assert.match(view, /COMPUTE SPEND\s+n\/a/);
  assert.match(view, /claude-code.+n\/a.+n\/a/);
  assert.doesNotMatch(view, /\$0\.00\s+0ms/);
});

test('a single-frame render shows the settled recording, not an empty first frame', () => {
  // A pipe or a redirect renders one frame. Frame 0 has revealed no market rows, so rendering it
  // would put an empty signal panel and $0.00 in front of anyone who pastes demo output anywhere.
  const settled = createDemoState(demoSettledFrame());
  assert.equal(settled.hedges.length, DEMO_RECORDING.market.results.length);
  assert.equal(settled.market.paper_pnl, DEMO_RECORDING.market.paper_pnl);
  const view = renderDashboard(settled, { color: false, width: 100 });
  assert.match(view, /PAPER P&L\s+-\$0\.78/);
  assert.match(view, /KXH100WS-26AUG28-2\.750/);
});

test('tables carry column headers and the layout survives every supported width', () => {
  for (const width of [68, 80, 88, 100, 118]) {
    const view = renderDashboard(createDemoState(demoSettledFrame()), { color: false, width });
    assert.ok(view.split('\n').every((line) => line.length === width), `width ${width}`);
    assert.match(view, /TIME\s+MODEL|TIME\s+SOURCE/);
    assert.match(view, /MARKET\s+SIDE/);
  }
  // The model and market probabilities are drawn on one shared axis, so the gap between the two
  // bars is the decision. A second axis would make the comparison meaningless.
  const wide = renderDashboard(createDemoState(demoSettledFrame()), { color: false, width: 100 });
  const [model, market] = wide.split('\n').filter((line) => /P\(≥/.test(line));
  assert.equal(model.indexOf('█'), market.indexOf('█'));
  assert.ok(market.split('█').length > model.split('█').length);
});

test('color never changes a rendered line width', () => {
  const plain = renderDashboard(createDemoState(6), { color: false, width: 100 });
  const painted = renderDashboard(createDemoState(6), { color: true, width: 100 });
  assert.notEqual(plain, painted);
  const stripped = painted.replace(/\u001b\[[0-9;]*m/g, '');
  assert.equal(stripped, plain);
});

test('failed and failover gateway calls have visible operational status', () => {
  const state = buildDashboardState([
    request({ attempts: 2 }),
    request({ model: null, provider_status: 502, savings_usd: 0 })
  ]);
  const view = renderDashboard(state, { color: false });
  assert.match(view, /FAILOVER/);
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
