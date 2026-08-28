import test from 'node:test';
import assert from 'node:assert/strict';
import { createKalshiSnapshots, resolveKalshiSnapshots, snapshotKalshiMarket, yesMidpoint } from '../src/kalshi.js';
import { validateMarketDataset } from '../src/market.js';

function openMarket(overrides = {}) {
  return {
    ticker: 'KXH100WS-26AUG28-3.000', event_ticker: 'KXH100WS-26AUG28',
    market_type: 'binary', status: 'open', strike_type: 'greater', floor_strike: 3,
    yes_bid_dollars: '0.40', yes_ask_dollars: '0.44', no_bid_dollars: '0.56',
    last_price_dollars: '0.41', close_time: '2026-08-28T20:00:00Z',
    volume_fp: '123.00', rules_primary: 'Resolves from Ornn.', ...overrides
  };
}

test('snapshot captures a pre-settlement midpoint and provenance', () => {
  const snapshot = snapshotKalshiMarket(openMarket(), {
    chip: 'H100', observedAt: '2026-08-26T18:00:00Z', feePerContract: 0.01, slippage: 0.02
  });
  assert.equal(snapshot.yesPrice, 0.42);
  assert.equal(snapshot.yesAsk, 0.44);
  assert.equal(snapshot.noAsk, 0.6);
  assert.equal(snapshot.threshold, 3);
  assert.equal(snapshot.feeRate, 0.07);
  assert.equal(snapshot.source, 'kalshi-public-api');
  assert.throws(() => snapshotKalshiMarket(openMarket(), {
    chip: 'H100', observedAt: '2026-08-29T00:00:00Z'
  }), /no longer eligible/);
});

test('midpoint can derive a Yes ask from the No bid', () => {
  assert.equal(yesMidpoint(openMarket({ yes_ask_dollars: '', yes_bid_dollars: '0.40', no_bid_dollars: '0.50' })), 0.45);
});

test('public snapshot and settlement workflow preserves the original observation', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get('status') === 'settled') {
      return new Response(JSON.stringify({
        markets: [{ ...openMarket(), status: 'settled', expiration_value: '3.12', result: 'yes', settlement_ts: '2026-08-28T20:30:00Z' }], cursor: ''
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ markets: [openMarket()], cursor: '' }), { status: 200 });
  };
  const document = await createKalshiSnapshots({
    series: 'KXH100WS', chip: 'H100', observedAt: '2026-08-26T18:00:00Z',
    feePerContract: 0.01, slippage: 0.02, fetchImpl
  });
  assert.equal(document.snapshots.length, 1);
  assert.equal(document.snapshots[0].observedAt, document.capturedAt);
  const result = await resolveKalshiSnapshots(document, { fetchImpl });
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].yesPrice, 0.42);
  assert.equal(result.resolved[0].eventTicker, 'KXH100WS-26AUG28');
  assert.equal(result.resolved[0].outcomePrice, 3.12);
  assert.equal(result.pending.length, 0);
});

test('dataset validation rejects look-ahead observations', () => {
  assert.throws(() => validateMarketDataset({
    index: [{ date: '2026-08-28', chip: 'H100', price: 3.12 }],
    aggregates: [{ date: '2026-08-27' }],
    markets: [{
      id: 'bad', date: '2026-08-28', chip: 'H100', threshold: 3, yesPrice: 0.4,
      feePerContract: 0.01, slippage: 0.01, outcomePrice: 3.12,
      observedAt: '2026-08-28T21:00:00Z', closeTime: '2026-08-28T20:00:00Z'
    }]
  }), /not pre-settlement/);
});
