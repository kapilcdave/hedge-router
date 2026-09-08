import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineStrategies, backtestForLead, decisionCandle, fetchKalshiCandlesticks,
  historicalSnapshot, runBacktest, snapshotsForLead, strategyPnl
} from '../src/backtest.js';
import { forecastMarkets, parseSettlementValue, settlementOutcome } from '../src/market.js';

const DAY = 86_400;
const CLOSE = '2026-08-28T20:00:00Z';
const CLOSE_TS = Date.parse(CLOSE) / 1000;

function candle(dayOffset, bid, ask) {
  return {
    end_period_ts: CLOSE_TS - dayOffset * DAY,
    yes_bid: { close_dollars: bid == null ? null : bid.toFixed(4) },
    yes_ask: { close_dollars: ask == null ? null : ask.toFixed(4) },
    volume_fp: '100.00', open_interest_fp: '250.00'
  };
}

function settledMarket(overrides = {}) {
  return {
    ticker: 'KXH100WS-26AUG28-3.000', event_ticker: 'KXH100WS-26AUG28',
    market_type: 'binary', strike_type: 'greater', floor_strike: 3,
    open_time: '2026-07-17T20:40:00Z', close_time: CLOSE,
    expiration_value: '$2.93', result: 'no', settlement_ts: '2026-08-28T20:05:00Z',
    ...overrides
  };
}

test('Kalshi settlement values parse across bare, dollar-prefixed, and yes/no shapes', () => {
  assert.equal(parseSettlementValue('2.89'), 2.89);
  assert.equal(parseSettlementValue('$2.93'), 2.93);
  assert.equal(parseSettlementValue('$1,204.50'), 1204.5);
  assert.equal(parseSettlementValue('Yes'), null);
  assert.equal(parseSettlementValue(undefined), null);
  assert.equal(settlementOutcome({ outcomePrice: '$2.93' }, 2.75), 1);
  assert.equal(settlementOutcome({ outcomePrice: '$2.93' }, 3), 0);
  assert.equal(settlementOutcome({ outcomePrice: 'Yes', result: 'yes' }, 3), 1);
  assert.equal(settlementOutcome({ outcomePrice: 'Yes', result: 'no' }, 3), 0);
  assert.equal(settlementOutcome({ outcomePrice: 'Yes' }, 3), null);
});

test('a per-strike result outranks the event settlement price', () => {
  // Kalshi reports one expiration_value per event but one result per strike.
  assert.equal(settlementOutcome({ result: 'yes', outcomePrice: '2.00' }, 3), 1);
});

test('decision candle never uses a quote published after the decision time', () => {
  const candles = [candle(9, 0.2, 0.22), candle(7, 0.25, 0.27), candle(1, 0.4, 0.42)];
  const chosen = decisionCandle(candles, CLOSE_TS - 7 * DAY);
  assert.equal(chosen.end_period_ts, CLOSE_TS - 7 * DAY);
  assert.equal(decisionCandle(candles, CLOSE_TS - 30 * DAY), null);
});

test('historical snapshot reconstructs an executable two-sided quote', () => {
  const snapshot = historicalSnapshot({
    market: settledMarket(), candles: [candle(7, 0.25, 0.27)],
    chip: 'H100', leadDays: 7, feeRate: 0.07, slippage: 0.01
  });
  assert.equal(snapshot.yesAsk, 0.27);
  assert.equal(snapshot.noAsk, 0.75);
  assert.equal(snapshot.yesPrice, 0.26);
  assert.equal(snapshot.observedAt, new Date((CLOSE_TS - 7 * DAY) * 1000).toISOString());
  assert.ok(Date.parse(snapshot.observedAt) < Date.parse(snapshot.closeTime));
  assert.equal(snapshot.outcomePrice, 2.93);
  assert.equal(snapshot.source, 'kalshi-candlestick-backtest');
});

test('unexecutable and unsettled markets are skipped with a reason', () => {
  const cases = [
    [settledMarket(), [candle(7, 0, 1)], 'two-sided'],
    [settledMarket(), [candle(1, 0.2, 0.3)], 'no quote at or before'],
    [settledMarket({ strike_type: 'less' }), [candle(7, 0.2, 0.3)], 'unsupported strike type'],
    [settledMarket({ expiration_value: 'Yes', result: '' }), [candle(7, 0.2, 0.3)], 'no usable settlement']
  ];
  for (const [market, candles, expected] of cases) {
    assert.throws(
      () => historicalSnapshot({ market, candles, chip: 'H100', leadDays: 7 }),
      (error) => error.message.includes(expected),
      `expected ${expected}`
    );
  }
  const { markets, skipped } = snapshotsForLead(
    [{ market: settledMarket(), candles: [candle(7, 0, 1)] }],
    { chip: 'H100', leadDays: 7 }
  );
  assert.equal(markets.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /two-sided/);
});

test('the forecast information cutoff is the observation, not the settlement date', () => {
  // A quote taken a week before close must not see the index print from the day before close.
  const index = [
    { date: '2026-08-20', chip: 'H100', price: 2.5 },
    { date: '2026-08-21', chip: 'H100', price: 2.5 },
    { date: '2026-08-27', chip: 'H100', price: 3.9 }
  ];
  const markets = [{
    id: 'lookahead', date: '2026-08-28', chip: 'H100', threshold: 3,
    yesPrice: 0.3, yesAsk: 0.32, noAsk: 0.7, feePerContract: 0.01, slippage: 0.01,
    observedAt: '2026-08-21T20:00:00Z', closeTime: CLOSE
  }];
  const [signal] = forecastMarkets({ index, markets, aggregates: [], requireSignal: false }).results;
  assert.equal(signal.predicted_price, 2.5, 'must use the 2026-08-20 print available at observation');
  assert.ok(signal.probability < 0.5, 'a 2.5 index cannot look likely to exceed a 3.0 strike');
});

test('baseline strategies price every trade at the ask, net of fees and slippage', () => {
  const markets = snapshotsForLead(
    [{ market: settledMarket(), candles: [candle(7, 0.25, 0.27)] }],
    { chip: 'H100', leadDays: 7, feeRate: 0.07, slippage: 0.01 }
  ).markets;
  const alwaysNo = strategyPnl(markets, () => 'no', 'always-no');
  // Settles No at a 3.00 strike: payout 1, ask 0.75, fee ceil(0.07*0.75*0.25)=0.02, slippage 0.01.
  assert.equal(alwaysNo.trades, 1);
  assert.equal(alwaysNo.hit_rate, 1);
  assert.equal(alwaysNo.pnl, 0.22);
  const alwaysYes = strategyPnl(markets, () => 'yes', 'always-yes');
  assert.equal(alwaysYes.hit_rate, 0);
  assert.equal(alwaysYes.pnl, -0.3);
  assert.deepEqual(baselineStrategies(markets).map((row) => row.strategy),
    ['always-yes', 'always-no', 'cheaper-side', 'market-favorite']);
});

test('a lead report separates shared calibration from per-variant trading', () => {
  const index = Array.from({ length: 30 }, (_, day) => ({
    date: new Date(Date.UTC(2026, 6, day + 1)).toISOString().slice(0, 10),
    chip: 'H100', price: 2.5 + day * 0.01
  }));
  const history = [{ market: settledMarket(), candles: [candle(7, 0.25, 0.27)] }];
  const report = backtestForLead({
    history, index, aggregates: [], leadDays: 7, chip: 'H100',
    feeRate: 0.07, slippage: 0.01, minimumTraining: 5, edge: 0.05
  });
  assert.equal(report.tradable_markets, 1);
  assert.equal(report.signal_ready_markets, 0, 'no aggregates means no trained demand signal');
  assert.equal(report.variants.length, 2);
  const demand = report.variants.find((row) => row.variant === 'demand-signal');
  assert.equal(demand.trades, 0, 'demand variant must not trade without trained features');
  assert.ok(Number.isFinite(report.signal_brier));
  assert.ok(Number.isFinite(report.demand_brier_lift));
  assert.equal(report.variants.some((row) => 'signal_brier' in row), false);
});

test('candlestick fetch retries throttling and reports terminal failures', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return calls.length < 3
      ? { ok: false, status: 429 }
      : { ok: true, status: 200, json: async () => ({ candlesticks: [candle(7, 0.25, 0.27)] }) };
  };
  const candles = await fetchKalshiCandlesticks({
    series: 'KXH100WS', ticker: 'KXH100WS-26AUG28-3.000',
    startTs: CLOSE_TS - 40 * DAY, endTs: CLOSE_TS, fetchImpl, retryDelayMs: 1
  });
  assert.equal(candles.length, 1);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /series\/KXH100WS\/markets\/KXH100WS-26AUG28-3\.000\/candlesticks/);
  assert.match(calls[0], /period_interval=1440/);

  await assert.rejects(
    fetchKalshiCandlesticks({
      series: 'KXH100WS', ticker: 'T', startTs: 0, endTs: 1, retries: 0,
      fetchImpl: async () => ({ ok: false, status: 404 })
    }),
    /HTTP 404/
  );
});

test('runBacktest stays paper-only and requires an index history', async () => {
  const index = [{ date: '2026-08-21', chip: 'H100', price: 2.5 }];
  const history = [{ market: settledMarket(), candles: [candle(7, 0.25, 0.27)] }];
  const report = await runBacktest({ series: 'KXH100WS', chip: 'H100', index, history, leadDays: [7] });
  assert.equal(report.paper_only, true);
  assert.equal(report.settled_markets, 1);
  assert.equal(report.settlement_events, 1);
  assert.equal(report.leads.length, 1);
  await assert.rejects(
    runBacktest({ series: 'KXH100WS', chip: 'H100', index: [], history }),
    /non-empty index history/
  );
});
