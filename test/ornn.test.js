import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchOrnnIndex, mergeOrnnIndex, resolveOrnnGpu } from '../src/ornn.js';

test('resolves supported Ornn GPU aliases', () => {
  assert.equal(resolveOrnnGpu('h100'), 'H100 SXM');
  assert.equal(resolveOrnnGpu('A100'), 'A100 SXM4');
  assert.equal(resolveOrnnGpu('rtx 5090'), 'RTX 5090');
  assert.throws(() => resolveOrnnGpu('V100'), /Unsupported Ornn GPU/);
});

test('downloads, normalizes, deduplicates, and sorts Ornn index history', async () => {
  let requested;
  const rows = await fetchOrnnIndex({
    gpu: 'H100', chip: 'h100', startDate: '2026-06-01', endDate: '2026-06-03',
    fetchImpl: async (url) => {
      requested = new URL(url);
      return {
        ok: true,
        async json() {
          return { success: true, data: [
            { timestamp: '2026-06-03T00:00:00.000Z', index_value: '2.75' },
            { timestamp: '2026-06-01T00:00:00.000Z', index_value: 2.5 },
            { timestamp: '2026-06-01T12:00:00.000Z', index_value: 2.6 }
          ] };
        }
      };
    }
  });
  assert.equal(decodeURIComponent(requested.pathname), '/api/gpu/H100 SXM/index-history');
  assert.equal(requested.searchParams.get('startDate'), '2026-06-01');
  assert.deepEqual(rows.map(({ date, chip, price }) => ({ date, chip, price })), [
    { date: '2026-06-01', chip: 'H100', price: 2.6 },
    { date: '2026-06-03', chip: 'H100', price: 2.75 }
  ]);
});

test('rejects invalid dates and malformed Ornn points', async () => {
  await assert.rejects(() => fetchOrnnIndex({
    gpu: 'H100', chip: 'H100', startDate: '2026-06-03', endDate: '2026-06-01'
  }), /must not be after/);
  await assert.rejects(() => fetchOrnnIndex({
    gpu: 'H100', chip: 'H100', startDate: '2026-06-01', endDate: '2026-06-03',
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, data: [{ timestamp: 'bad', index_value: 2 }] }) })
  }), /invalid index point/);
  await assert.rejects(() => fetchOrnnIndex({
    gpu: 'H100', chip: 'H100', startDate: '2026-02-31', endDate: '2026-06-03'
  }), /YYYY-MM-DD/);
});

test('merges refreshed history over existing same-day rows', () => {
  const rows = mergeOrnnIndex(
    [{ date: '2026-05-31', chip: 'H100', price: 2.4 }, { date: '2026-06-01', chip: 'H100', price: 2.5 }],
    [{ date: '2026-06-01', chip: 'H100', price: 2.6 }, { date: '2026-06-02', chip: 'H100', price: 2.7 }]
  );
  assert.deepEqual(rows.map((row) => row.price), [2.4, 2.6, 2.7]);
});
