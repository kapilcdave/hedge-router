import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchOrnnIndex, fetchOrnnTokenIndex, mergeOrnnIndex, otpiCoverage, otpiFreeLabs, resolveOrnnGpu, resolveOtpiLab
} from '../src/ornn.js';

function otpiResponse(rows, access = 'public-1mo') {
  return { ok: true, json: async () => ({ success: true, access, count: rows.length, data: rows }) };
}

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

test('resolves OTPI labs and names the free tier', () => {
  assert.equal(resolveOtpiLab('Anthropic'), 'anthropic');
  assert.equal(resolveOtpiLab('meta-llama'), 'meta-llama');
  assert.throws(() => resolveOtpiLab('acme'), /Unsupported OTPI lab/);
  // The four public labs are exactly the four Kalshi ever listed token markets on.
  assert.deepEqual(otpiFreeLabs(), ['anthropic', 'openai', 'google', 'deepseek']);
});

test('downloads and normalizes the token price index as a settlement series', async () => {
  let requested;
  let headers;
  const rows = await fetchOrnnTokenIndex({
    lab: 'anthropic', chip: 'anthropic-tok', startDate: '2026-08-08', endDate: '2026-08-10',
    fetchImpl: async (url, options) => {
      requested = new URL(url);
      headers = options.headers;
      return otpiResponse([
        { date: '2026-08-10', lab: 'anthropic', indexPerMtok: 1.679, computedAt: '2026-08-11T12:01:34.242Z' },
        { date: '2026-08-08', lab: 'anthropic', indexPerMtok: 1.6217390257174906, computedAt: '2026-08-09T12:01:50.597Z' },
        { date: '2026-08-30', lab: 'anthropic', indexPerMtok: 1.4, computedAt: '2026-08-31T12:00:00.000Z' }
      ]);
    }
  });
  assert.equal(requested.pathname, '/api/otpi');
  assert.equal(requested.searchParams.get('lab'), 'anthropic');
  assert.equal(requested.searchParams.get('startDate'), '2026-08-08');
  // No key configured means no Authorization header, not an empty one.
  assert.equal(headers.authorization, undefined);
  assert.deepEqual(rows.map(({ date, chip, price, unit }) => ({ date, chip, price, unit })), [
    { date: '2026-08-08', chip: 'ANTHROPIC-TOK', price: 1.6217390257174906, unit: 'usd_per_mtok' },
    { date: '2026-08-10', chip: 'ANTHROPIC-TOK', price: 1.679, unit: 'usd_per_mtok' }
  ]);
});

test('sends the API key only when one is configured', async () => {
  let headers;
  await fetchOrnnTokenIndex({
    lab: 'qwen', startDate: '2026-08-08', endDate: '2026-08-08', apiKey: 'sk_prem_example',
    fetchImpl: async (url, options) => {
      headers = options.headers;
      return otpiResponse([{ date: '2026-08-08', lab: 'qwen', indexPerMtok: 0.05 }], 'premium');
    }
  });
  assert.equal(headers.authorization, 'Bearer sk_prem_example');
});

test('rejects malformed, foreign-lab, and empty token index responses', async () => {
  await assert.rejects(() => fetchOrnnTokenIndex({
    lab: 'anthropic', startDate: '2026-08-08', endDate: '2026-08-10',
    fetchImpl: async () => otpiResponse([{ date: '2026-08-08', lab: 'anthropic', indexPerMtok: 0 }])
  }), /invalid token index point/);
  // A lab filter that comes back with someone else's series would forecast the wrong bill.
  await assert.rejects(() => fetchOrnnTokenIndex({
    lab: 'anthropic', startDate: '2026-08-08', endDate: '2026-08-10',
    fetchImpl: async () => otpiResponse([{ date: '2026-08-08', lab: 'openai', indexPerMtok: 0.31 }])
  }), /another lab/);
  await assert.rejects(() => fetchOrnnTokenIndex({
    lab: 'anthropic', startDate: '2026-08-08', endDate: '2026-08-10',
    fetchImpl: async () => otpiResponse([])
  }), /no OTPI rows/);
});

test('coverage reports a withheld window instead of treating it as absent history', () => {
  // The public tier narrows a wider request and still returns success, so silence here would read
  // as "the index does not go back that far" when it means "you were not shown it".
  const rows = [
    { date: '2026-08-08', access: 'public-1mo' },
    { date: '2026-09-07', access: 'public-1mo' }
  ];
  const coverage = otpiCoverage({ rows, startDate: '2026-06-01', endDate: '2026-09-08' });
  assert.equal(coverage.clamped, true);
  assert.equal(coverage.requested.days, 100);
  assert.deepEqual(coverage.covered, { from: '2026-08-08', to: '2026-09-07' });
  assert.equal(coverage.access, 'public-1mo');
  const full = otpiCoverage({ rows, startDate: '2026-08-08', endDate: '2026-09-08' });
  assert.equal(full.clamped, false);
});

test('merging refuses to mix dollars per GPU-hour with dollars per million tokens', () => {
  assert.throws(() => mergeOrnnIndex(
    [{ date: '2026-08-08', chip: 'H100', price: 2.8 }],
    [{ date: '2026-08-09', chip: 'H100', price: 1.6, unit: 'usd_per_mtok' }]
  ), /mix units/);
  const rows = mergeOrnnIndex(
    [{ date: '2026-08-08', chip: 'ANTHROPIC-TOK', price: 1.62, unit: 'usd_per_mtok' }],
    [{ date: '2026-08-09', chip: 'ANTHROPIC-TOK', price: 1.51, unit: 'usd_per_mtok' }]
  );
  assert.equal(rows.length, 2);
});
