import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendAvailabilityRows, availabilityEvents, availabilityReport, DEFAULT_WATCHLIST,
  fetchAvailabilitySnapshot, fetchModelAvailability, mergeAvailabilityRows, normalizeModelPayload,
  parseWatchlist
} from '../src/availability.js';

// The shape of a real 2026-09-21 unauthenticated read, trimmed to the fields this module keeps.
function llamaPayload(overrides = {}) {
  return {
    id: 'meta-llama/Llama-3.1-8B-Instruct',
    private: false,
    gated: 'manual',
    disabled: false,
    sha: '0e9e39f249a16976918f6564b8830bc894c89659',
    lastModified: '2024-09-25T17:00:57.000Z',
    downloads: 5992652,
    cardData: { license: 'llama3.1' },
    ...overrides
  };
}

function ok(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function resolvedRow(overrides) {
  return {
    model: 'm/one', date: '2026-09-20', observedAt: '2026-09-20T12:00:00.000Z', status: 'resolved',
    httpStatus: 200, gated: false, private: false, disabled: false, license: 'mit', licenseName: null,
    licenseLink: null, sha: 'aaaa', lastModified: '2026-09-01T00:00:00.000Z', downloads: 10,
    source: 'huggingface-public-api', ...overrides
  };
}

test('normalizes a public model read into a settlement row', () => {
  const row = normalizeModelPayload('meta-llama/Llama-3.1-8B-Instruct', llamaPayload(), '2026-09-21T09:00:00.000Z');
  assert.equal(row.date, '2026-09-21');
  assert.equal(row.status, 'resolved');
  assert.equal(row.gated, 'manual');
  assert.equal(row.license, 'llama3.1');
  assert.equal(row.private, false);
  assert.equal(row.downloads, 5992652);
});

test('an absent gated flag is unresolved, not ungated', async () => {
  // Defaulting a missing field to false would erase the event the ledger exists to record.
  assert.throws(() => normalizeModelPayload('m/one', { ...llamaPayload(), gated: undefined }, '2026-09-21T09:00:00.000Z'),
    /did not contain gated/);
  const row = await fetchModelAvailability('m/one', {
    observedAt: '2026-09-21T09:00:00.000Z',
    fetchImpl: async () => ok({ ...llamaPayload(), gated: undefined })
  });
  assert.equal(row.status, 'unresolved');
  assert.equal(row.gated, undefined);
});

test('a 401 is recorded as unresolved because it conflates deletion with privacy', async () => {
  // Verified against the live API: a model id that never existed answers 401, not 404.
  const row = await fetchModelAvailability('nonexistent-org-xyz/nope-9999', {
    observedAt: '2026-09-21T09:00:00.000Z',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'Invalid username or password.' }) })
  });
  assert.equal(row.status, 'unresolved');
  assert.equal(row.httpStatus, 401);
  assert.match(row.reason, /deleted, private, and never-existed/);
  // No field values at all, so nothing downstream can diff against a fabricated state.
  for (const field of ['gated', 'license', 'private', 'disabled']) assert.equal(row[field], undefined);
});

test('a network failure is unresolved rather than an availability event', async () => {
  const row = await fetchModelAvailability('m/one', {
    observedAt: '2026-09-21T09:00:00.000Z',
    fetchImpl: async () => { throw new Error('socket hang up'); }
  });
  assert.equal(row.status, 'unresolved');
  assert.equal(row.httpStatus, null);
  assert.match(row.reason, /socket hang up/);
});

test('one snapshot stamps every model with a single capture time', async () => {
  const snapshot = await fetchAvailabilitySnapshot({
    models: ['a/one', 'b/two'],
    observedAt: '2026-09-21T23:59:59.500Z',
    fetchImpl: async () => ok(llamaPayload())
  });
  assert.deepEqual(snapshot.rows.map((row) => row.observedAt),
    ['2026-09-21T23:59:59.500Z', '2026-09-21T23:59:59.500Z']);
  assert.deepEqual([...new Set(snapshot.rows.map((row) => row.date))], ['2026-09-21']);
  assert.equal(snapshot.unresolved.length, 0);
});

test('a snapshot reports per-model failures without losing the rest of the watchlist', async () => {
  const snapshot = await fetchAvailabilitySnapshot({
    models: ['a/one', 'b/two'],
    observedAt: '2026-09-21T09:00:00.000Z',
    fetchImpl: async (url) => String(url).endsWith('b/two')
      ? { ok: false, status: 429, json: async () => ({}) }
      : ok(llamaPayload())
  });
  assert.equal(snapshot.rows.length, 2);
  assert.deepEqual(snapshot.unresolved.map((row) => row.model), ['b/two']);
});

test('parses watchlists and rejects ids that are not owner/name', () => {
  assert.deepEqual(parseWatchlist('["a/one", "a/one", "b/two"]'), ['a/one', 'b/two']);
  assert.deepEqual(parseWatchlist('{"models":["a/one"]}'), ['a/one']);
  assert.deepEqual(parseWatchlist('a/one # comment\nb/two\n'), ['a/one', 'b/two']);
  assert.throws(() => parseWatchlist('just-a-name'), /Invalid Hugging Face model id/);
  assert.throws(() => parseWatchlist('[]'), /at least one model/);
  assert.equal(DEFAULT_WATCHLIST.length, 12);
});

test('a licence change fires even when the licence field itself never moves', () => {
  // Qwen and Kimi-K2 are `license: "other"` with the terms in `license_name`. A rule reading
  // `cardData.license` alone would see nothing happen here.
  const events = availabilityEvents([
    resolvedRow({ model: 'Qwen/Q', date: '2026-09-20', observedAt: '2026-09-20T12:00:00.000Z', license: 'other', licenseName: 'qwen', sha: 'aaaa' }),
    resolvedRow({ model: 'Qwen/Q', date: '2026-09-21', observedAt: '2026-09-21T12:00:00.000Z', license: 'other', licenseName: 'qwen-restricted', sha: 'bbbb', lastModified: '2026-09-21T03:00:00.000Z' })
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, 'licenseName');
  assert.deepEqual([events[0].from, events[0].to], ['qwen', 'qwen-restricted']);
  assert.equal(events[0].narrowedTo, '2026-09-21T03:00:00.000Z');
});

test('gating flips without a commit, so the bracket is not narrowed', () => {
  const events = availabilityEvents([
    resolvedRow({ date: '2026-09-18', observedAt: '2026-09-18T12:00:00.000Z', gated: false }),
    resolvedRow({ date: '2026-09-21', observedAt: '2026-09-21T12:00:00.000Z', gated: 'manual' })
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].field, 'gated');
  assert.equal(events[0].narrowedTo, null);
  assert.equal(events[0].bracketDays, 3);
  assert.deepEqual(events[0].observedBetween, { after: '2026-09-18T12:00:00.000Z', atOrBefore: '2026-09-21T12:00:00.000Z' });
});

test('unresolved rows never emit an event and never break the chain', () => {
  const events = availabilityEvents([
    resolvedRow({ date: '2026-09-19', observedAt: '2026-09-19T12:00:00.000Z', gated: false }),
    { model: 'm/one', date: '2026-09-20', observedAt: '2026-09-20T12:00:00.000Z', status: 'unresolved', httpStatus: 401 },
    resolvedRow({ date: '2026-09-21', observedAt: '2026-09-21T12:00:00.000Z', gated: false })
  ]);
  // A 401 in the middle is not a removal and is not a return: no event, and the bracket for any
  // later change still runs from the last read that carried values.
  assert.deepEqual(events, []);
  const withChange = availabilityEvents([
    resolvedRow({ date: '2026-09-19', observedAt: '2026-09-19T12:00:00.000Z', gated: false }),
    { model: 'm/one', date: '2026-09-20', observedAt: '2026-09-20T12:00:00.000Z', status: 'unresolved', httpStatus: 401 },
    resolvedRow({ date: '2026-09-21', observedAt: '2026-09-21T12:00:00.000Z', gated: 'auto' })
  ]);
  assert.equal(withChange.length, 1);
  assert.equal(withChange[0].observedBetween.after, '2026-09-19T12:00:00.000Z');
});

test('an absent licence is its own state, not a permissive one', () => {
  // DeepSeek-V3 carries no cardData.license. When one appears, that is a card edit, and it must not
  // read as a relicensing away from something.
  const events = availabilityEvents([
    resolvedRow({ model: 'deepseek-ai/DeepSeek-V3', date: '2026-09-20', observedAt: '2026-09-20T12:00:00.000Z', license: null, sha: 'aaaa' }),
    resolvedRow({ model: 'deepseek-ai/DeepSeek-V3', date: '2026-09-21', observedAt: '2026-09-21T12:00:00.000Z', license: 'mit', sha: 'bbbb', lastModified: '2026-09-21T01:00:00.000Z' })
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, 'mit');
});

test('the ledger is one row per model per day, and a retry upgrades an unresolved read', () => {
  const existing = [
    { model: 'm/one', date: '2026-09-21', observedAt: '2026-09-21T09:00:00.000Z', status: 'unresolved', httpStatus: 429 }
  ];
  const upgraded = mergeAvailabilityRows(existing, [resolvedRow({ date: '2026-09-21', observedAt: '2026-09-21T10:00:00.000Z' })]);
  assert.equal(upgraded.rows.length, 1);
  assert.equal(upgraded.rows[0].status, 'resolved');
  assert.equal(upgraded.replaced, 1);
  // A second resolved read of the same day is dropped: the series must not depend on run frequency.
  const again = mergeAvailabilityRows(upgraded.rows, [resolvedRow({ date: '2026-09-21', observedAt: '2026-09-21T23:00:00.000Z', gated: 'manual' })]);
  assert.equal(again.rows.length, 1);
  assert.equal(again.rows[0].gated, false);
  assert.equal(again.duplicates, 1);
  assert.equal(again.rows[0].observedAt, '2026-09-21T10:00:00.000Z');
});

test('appending rewrites the ledger atomically and sorted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hedge-availability-'));
  const file = path.join(directory, 'availability.ndjson');
  await appendAvailabilityRows([resolvedRow({ model: 'b/two', date: '2026-09-21', observedAt: '2026-09-21T09:00:00.000Z' })], file);
  const outcome = await appendAvailabilityRows([
    resolvedRow({ model: 'a/one', date: '2026-09-20', observedAt: '2026-09-20T09:00:00.000Z' })
  ], file);
  assert.equal(outcome.rows, 2);
  assert.equal(outcome.appended, 1);
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((row) => row.date), ['2026-09-20', '2026-09-21']);
});

test('the report names the models a licence rule cannot settle', () => {
  const report = availabilityReport([
    resolvedRow({ model: 'Qwen/Q', date: '2026-09-21', observedAt: '2026-09-21T09:00:00.000Z', license: 'other', licenseName: 'qwen' }),
    resolvedRow({ model: 'deepseek-ai/DeepSeek-V3', date: '2026-09-21', observedAt: '2026-09-21T09:00:00.000Z', license: null }),
    resolvedRow({ model: 'm/one', date: '2026-09-20', observedAt: '2026-09-20T09:00:00.000Z', license: 'mit' }),
    resolvedRow({ model: 'm/one', date: '2026-09-21', observedAt: '2026-09-21T09:00:00.000Z', license: 'mit' }),
    { model: 'gone/model', date: '2026-09-21', observedAt: '2026-09-21T09:00:00.000Z', status: 'unresolved', httpStatus: 401 }
  ]);
  assert.deepEqual(report.coverage, {
    days: 2, from: '2026-09-20', to: '2026-09-21', models: 3, resolved_rows: 4, unresolved_rows: 1
  });
  assert.deepEqual(report.settleable.license_is_other, ['Qwen/Q']);
  assert.deepEqual(report.settleable.license_absent, ['deepseek-ai/DeepSeek-V3']);
  assert.deepEqual(report.settleable.unresolved, ['gone/model']);
  assert.deepEqual(report.events, []);
  // The per-model state is the latest resolved read, not the latest row.
  assert.equal(report.models.find((row) => row.model === 'm/one').as_of, '2026-09-21');
});
