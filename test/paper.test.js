import assert from 'node:assert/strict';
import test from 'node:test';
import { forecastMarkets, kalshiFee } from '../src/market.js';
import { createPaperPortfolio, placePaperOrders, settlePaperPortfolio } from '../src/paper.js';

function researchData() {
  const index = [];
  const aggregates = [];
  for (let day = 20; day <= 31; day += 1) {
    const date = `2026-08-${day}`;
    index.push({ date, chip: 'H100', price: 2.5 + (day - 20) * 0.03 });
    aggregates.push({
      date, request_count: 100 + day, input_tokens: 10_000 + day * 10,
      output_tokens: 2_000 + day, cache_ratio: 0.2, mean_latency_ms: 500,
      error_rate: 0, fallback_rate: 0
    });
  }
  const markets = [{
    id: 'KXH100WS-26SEP01-2.700', eventTicker: 'KXH100WS-26SEP01',
    date: '2026-09-01', chip: 'H100', threshold: 2.7, yesPrice: 0.2,
    feePerContract: null, feeRate: 0.07, slippage: 0.01,
    observedAt: '2026-08-31T12:58:00Z', closeTime: '2026-09-01T20:00:00Z'
  }];
  return { index, aggregates, markets };
}

test('Kalshi fee model rounds the total trade fee up to cents', () => {
  assert.equal(kalshiFee(1, 0.5), 0.02);
  assert.equal(kalshiFee(100, 0.5), 1.75);
  assert.equal(kalshiFee(1, 0.5, 0.0175), 0.01);
});

test('pre-settlement signal becomes an immutable risk-limited paper order', () => {
  const data = researchData();
  const signals = forecastMarkets({ ...data, minimumTraining: 1, edge: 0.01 });
  assert.equal(signals.results.length, 1);
  assert.equal(signals.results[0].side, 'yes');
  assert.equal('outcome' in signals.results[0], false);
  const untrained = forecastMarkets({ ...data, aggregates: [], minimumTraining: 1, edge: 0.01 });
  assert.equal(untrained.results[0].signal_ready, false);
  assert.equal(untrained.results[0].side, 'hold');

  const initial = createPaperPortfolio({ bankroll: 100, now: '2026-08-31T12:30:00Z' });
  const opened = placePaperOrders({
    portfolio: initial, signals, now: '2026-08-31T13:00:00Z',
    riskPercent: 10, maxEventPercent: 20, maxContracts: 10
  });
  assert.equal(opened.placed.length, 1);
  assert.equal(opened.portfolio.paper_only, true);
  assert.equal(opened.portfolio.orders[0].status, 'open');
  assert.equal(opened.portfolio.orders[0].placed_at, '2026-08-31T13:00:00Z');
  assert.ok(opened.portfolio.orders[0].capital_at_risk <= 10);

  const duplicate = placePaperOrders({
    portfolio: opened.portfolio, signals, now: '2026-08-31T13:05:00Z',
    riskPercent: 10, maxEventPercent: 20, maxContracts: 10
  });
  assert.equal(duplicate.placed.length, 0);
  assert.equal(duplicate.skipped[0].reason, 'market already ordered');

  const stale = placePaperOrders({
    portfolio: initial, signals, now: '2026-08-31T13:10:00Z',
    riskPercent: 10, maxEventPercent: 20, maxContracts: 10
  });
  assert.equal(stale.placed.length, 0);
  assert.equal(stale.skipped[0].reason, 'snapshot is stale');
});

test('paper orders cannot be backdated and settle against resolved snapshots', () => {
  const data = researchData();
  const signals = forecastMarkets({ ...data, minimumTraining: 1, edge: 0.01 });
  const initial = createPaperPortfolio({ bankroll: 100, now: '2026-08-31T12:30:00Z' });
  const closed = placePaperOrders({
    portfolio: initial, signals, now: '2026-09-01T21:00:00Z',
    riskPercent: 10, maxEventPercent: 20, maxContracts: 10
  });
  assert.equal(closed.placed.length, 0);
  assert.equal(closed.skipped[0].reason, 'market is closed');

  const opened = placePaperOrders({
    portfolio: initial, signals, now: '2026-08-31T13:00:00Z',
    riskPercent: 10, maxEventPercent: 20, maxContracts: 10
  });
  const result = settlePaperPortfolio({
    portfolio: opened.portfolio,
    markets: { resolved: [{
      id: data.markets[0].id, threshold: 2.7, outcomePrice: 2.8,
      settlementTime: '2026-09-01T20:30:00Z'
    }] },
    now: '2026-09-01T21:00:00Z'
  });
  assert.equal(result.settled.length, 1);
  assert.equal(result.portfolio.orders[0].status, 'settled');
  assert.ok(result.portfolio.realized_pnl > 0);
  assert.equal(result.portfolio.cash, opened.portfolio.cash + opened.portfolio.orders[0].contracts);
  assert.ok(opened.portfolio.equity_at_cost < opened.portfolio.bankroll_start);
});
