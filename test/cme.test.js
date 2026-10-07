import test from 'node:test';
import assert from 'node:assert/strict';
import {
  businessDays, cmeDryRunIntent, cmeFee, cmeSymbol, floatingPrice, resolveCmeContract, sizeCmeHedge
} from '../src/cme.js';
import { venueStatus } from '../src/venues.js';

test('contracts resolve to the filed Globex codes', () => {
  assert.equal(resolveCmeContract('h100').globex, 'GPU1');
  assert.equal(resolveCmeContract('B200').globex, 'GPU2');
  assert.throws(() => resolveCmeContract('A100'), /No CME compute future/);
  assert.equal(cmeSymbol('H100', '2026-12'), 'GPU1Z6');
  assert.throws(() => cmeSymbol('H100', '2026-13'), /YYYY-MM/);
});

test('business days exclude weekends', () => {
  assert.equal(businessDays('2026-10').length, 22);
  assert.equal(businessDays('2026-10')[0], '2026-10-01');
});

test('settled days are locked into the average and only the rest carries forecast risk', () => {
  const observed = { '2026-10-01': 2, '2026-10-02': 2 };
  const result = floatingPrice({ month: '2026-10', observed, forecast: 3 });
  assert.equal(result.lockedDays, 2);
  assert.ok(Math.abs(result.expected - (4 + 20 * 3) / 22) < 1e-12);
  assert.ok(Math.abs(result.unlockedShare - 20 / 22) < 1e-12);
});

test('sizing is whole contracts and reports the residual and the unmeasured basis', () => {
  const sizing = sizeCmeHedge({ chip: 'H100', month: '2026-12', gpuHours: 7_300, entryPrice: 2.5 });
  assert.equal(sizing.contracts, 10);
  assert.equal(sizing.unhedged_gpu_hours, 0);
  assert.equal(sizing.pnl_per_tick, 73);
  assert.equal(sizing.exchange_fees, 68.5);
  assert.equal(sizing.basis.measured, false);
  assert.equal(sizing.can_send, false);
  const partial = sizeCmeHedge({ chip: 'H100', month: '2026-12', gpuHours: 1_000, entryPrice: 2.5 });
  assert.equal(partial.contracts, 1);
  assert.equal(partial.unhedged_gpu_hours, 270);
  assert.throws(() => sizeCmeHedge({ chip: 'H100', month: '2026-12', gpuHours: 100, entryPrice: 2, hedgeRatio: 2 }), /hedgeRatio/);
});

test('fees use the filing\'s per-contract schedule', () => {
  assert.equal(cmeFee(1), 6.85);
  assert.equal(cmeFee(2, { member: true }), 9.1);
  assert.throws(() => cmeFee(0), /positive integer/);
});

test('a CME intent is a dry run, off-tick prices are refused, and nothing can arm', () => {
  const sizing = sizeCmeHedge({ chip: 'B200', month: '2026-12', gpuHours: 730, entryPrice: 4 });
  const intent = cmeDryRunIntent({ sizing, limitPrice: 4.01, at: '2026-10-06T00:00:00Z' });
  assert.equal(intent.dry_run, true);
  assert.equal(intent.armed, false);
  assert.equal(intent.symbol, 'GPU2Z6');
  assert.throws(() => cmeDryRunIntent({ sizing, limitPrice: 4.005 }), /off the/);
});

test('no venue claims to be tradable while its blocker stands', () => {
  const status = venueStatus();
  assert.deepEqual(status.tradable_now, []);
  for (const venue of status.venues) assert.ok(venue.blocker);
});
