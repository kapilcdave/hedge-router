import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMarkets, settlementOutcome, strikeFor, yesFromValue } from '../src/market.js';

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
  // The first market observes on the same day as the earliest index print, so no published
  // index row precedes its observation and it cannot be forecast.
  assert.equal(result.observations, 40);
  assert.equal(result.independent_events, 40);
  assert.ok(result.trades > 0);
  assert.ok(result.paper_pnl > 0);
  assert.ok(result.results.every((row) => ['yes', 'no', 'hold'].includes(row.side)));
  assert.equal('placeOrder' in result, false);
});

test('correlated strikes count as one independent settlement event', () => {
  const index = [
    { date: '2026-07-31', chip: 'H100', price: 2.8, observedAt: '2026-07-31T20:00:00Z' },
    { date: '2026-08-01', chip: 'H100', price: 2.8, observedAt: '2026-08-01T20:00:00Z' },
    { date: '2026-08-02', chip: 'H100', price: 2.9, observedAt: '2026-08-02T20:00:00Z' }
  ];
  const aggregates = [{
    date: '2026-07-31', request_count: 100, input_tokens: 1000,
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

test('a less_or_equal strike reads cap_strike and pays YES at or below it', () => {
  // The live token list-price ladders are "at or below" contracts. A `greater` reading of them
  // inverts every settlement, so the boundary itself is asserted in both directions.
  assert.deepEqual(strikeFor({ strike_type: 'less_or_equal', cap_strike: 15 }), {
    strikeDirection: 'less_or_equal', threshold: 15
  });
  assert.deepEqual(strikeFor({ strike_type: 'greater', floor_strike: 2.75 }), {
    strikeDirection: 'greater', threshold: 2.75
  });
  assert.throws(() => strikeFor({ strike_type: 'less_or_equal', floor_strike: 15 }), /missing cap_strike/);
  assert.throws(() => strikeFor({ strike_type: 'between', floor_strike: 1, cap_strike: 2 }), /unsupported strike type between/);

  // On the strike: `less_or_equal` pays, `greater` does not. The two must never agree here.
  assert.equal(yesFromValue(15, 15, 'less_or_equal'), 1);
  assert.equal(yesFromValue(15, 15, 'greater'), 0);
  assert.equal(yesFromValue(15.01, 15, 'less_or_equal'), 0);
  assert.equal(yesFromValue(14.99, 15, 'less_or_equal'), 1);
  assert.equal(settlementOutcome({ outcomePrice: '$4.00', strikeDirection: 'less_or_equal' }, 4), 1);
  assert.equal(settlementOutcome({ outcomePrice: '$4.00' }, 4), 0);
  // An explicit exchange result still wins over any recomputation from the settlement value.
  assert.equal(settlementOutcome({ result: 'no', outcomePrice: '$1.00', strikeDirection: 'less_or_equal' }, 4), 0);
});

test('a less_or_equal market is forecast as P(at or below), not its complement', () => {
  const index = Array.from({ length: 20 }, (_, day) => ({
    date: new Date(Date.UTC(2026, 7, day + 1)).toISOString().slice(0, 10),
    chip: 'OTPI', price: 20 - day * 0.5, observedAt: new Date(Date.UTC(2026, 7, day + 1, 20)).toISOString()
  }));
  const aggregates = index.map((row) => ({
    date: row.date, request_count: 100, input_tokens: 1000, output_tokens: 100,
    cache_ratio: 0.2, mean_latency_ms: 100, error_rate: 0, fallback_rate: 0
  }));
  // A falling price with the strike well above it: "at or below" is nearly certain, "above" is not.
  const base = {
    id: 'KXTOKEN-30', date: '2026-08-21', chip: 'OTPI', threshold: 30, yesPrice: 0.5,
    feePerContract: 0.01, slippage: 0.01, outcomePrice: 10.5,
    observedAt: '2026-08-20T21:00:00Z', closeTime: '2026-08-21T20:00:00Z'
  };
  const below = evaluateMarkets({ index, markets: [{ ...base, strikeDirection: 'less_or_equal' }], aggregates, minimumTraining: 1 });
  const above = evaluateMarkets({ index, markets: [base], aggregates, minimumTraining: 1 });
  const [belowRow] = below.results;
  const [aboveRow] = above.results;
  assert.equal(belowRow.strike_direction, 'less_or_equal');
  assert.equal(aboveRow.strike_direction, 'greater');
  assert.ok(belowRow.probability > 0.9, `expected a confident yes, got ${belowRow.probability}`);
  assert.equal(Math.round((belowRow.probability + aboveRow.probability) * 1e6) / 1e6, 1);
  assert.equal(belowRow.outcome, 1);
  assert.equal(aboveRow.outcome, 0);
  // The market is offered at 50¢ on a near-certain yes, so the signal buys YES and it pays.
  assert.equal(belowRow.side, 'yes');
  assert.ok(belowRow.paper_pnl > 0);
  assert.equal(aboveRow.side, 'no');
});
