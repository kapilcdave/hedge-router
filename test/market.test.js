import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarkets } from '../src/market.js';

test('walk-forward market evaluator remains paper-only and applies gates', () => {
  const index = [];
  const aggregates = [];
  const markets = [];
  let price = 2;
  for (let day = 1; day <= 42; day += 1) {
    const current = new Date(Date.UTC(2026, 6, day));
    const date = current.toISOString().slice(0, 10);
    const demand = 100 + day * 10;
    aggregates.push({ date, request_count: demand, input_tokens: demand * 100, output_tokens: demand * 20, cache_ratio: 0.2, mean_latency_ms: 100, error_rate: 0, fallback_rate: 0 });
    price += 0.03;
    index.push({ date, chip: 'H100', price });
    if (day > 1) {
      markets.push({
        id: `m-${day}`, date, chip: 'H100', threshold: price - 0.01,
        yesPrice: 0.2, feePerContract: 0.01, slippage: 0.01, outcomePrice: price,
        observedAt: new Date(current.getTime() - 86_400_000).toISOString(),
        closeTime: new Date(current.getTime() + 20 * 3_600_000).toISOString()
      });
    }
  }
  const result = evaluateMarkets({ index, markets, aggregates });
  assert.equal(result.observations, 41);
  assert.equal(result.independent_events, 41);
  assert.ok(result.trades > 0);
  assert.ok(result.paper_pnl > 0);
  assert.ok(result.results.every((row) => ['yes', 'no', 'hold'].includes(row.side)));
  assert.equal('placeOrder' in result, false);
});

test('correlated strikes count as one independent settlement event', () => {
  const index = [
    { date: '2026-08-01', chip: 'H100', price: 2.8 },
    { date: '2026-08-02', chip: 'H100', price: 2.9 }
  ];
  const aggregates = [{
    date: '2026-08-01', request_count: 100, input_tokens: 1000,
    output_tokens: 100, cache_ratio: 0.2, mean_latency_ms: 100,
    error_rate: 0, fallback_rate: 0
  }];
  const markets = Array.from({ length: 31 }, (_, index) => ({
    id: `strike-${index}`, eventTicker: 'ONE-EVENT', date: '2026-08-02', chip: 'H100',
    threshold: 2.7 + index / 100, yesPrice: 0.2, feePerContract: 0.01,
    slippage: 0.01, outcomePrice: 2.9,
    observedAt: '2026-08-01T12:00:00Z', closeTime: '2026-08-02T20:00:00Z'
  }));
  const result = evaluateMarkets({ index, markets, aggregates, minimumTraining: 1 });
  assert.equal(result.observations, 31);
  assert.equal(result.independent_events, 1);
  assert.equal(result.gate, false);
});
