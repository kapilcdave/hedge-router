import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendAuthorShareRows, authorOf, authorShareReport, authorShares, completeness,
  fetchAuthorShareSnapshot, isTextGeneration, loadAuthorShareLedger, mergeAuthorShareRows,
  normalizeModelRows, selectWindow
} from '../src/authorshare.js';

// The shape of a real 2026-09-21 read of /api/frontend/v1/rankings/models, trimmed to the fields this
// module reads. Every media counter is zero on every row in the live payload; that is the point.
function modelRow(overrides = {}) {
  return {
    date: '2026-09-20 00:00:00',
    model_permaslug: 'deepseek/deepseek-v4-flash-20260731',
    variant: 'free',
    total_completion_tokens: 10_227_809_568,
    total_prompt_tokens: 1_077_895_875_947,
    count: 11_063_646,
    num_media_prompt: 0,
    num_media_completion: 0,
    image_output_requests: 0,
    rerank_documents: 0,
    stt_transcript_characters: 0,
    num_audio_prompt: 0,
    video_output_seconds: 0,
    ...overrides
  };
}

// Twelve complete weeks of ~100T plus a live partial one, which is the real chart's shape.
function marketShare(latestTokens = 17_560_000_000_000) {
  const data = [];
  for (let week = 0; week < 12; week += 1) {
    const day = new Date(Date.UTC(2026, 5, 29));
    day.setUTCDate(day.getUTCDate() + week * 7);
    data.push({ x: day.toISOString().slice(0, 10), ys: { deepseek: 50e12, google: 30e12, others: 20e12 } });
  }
  data.push({ x: '2026-09-14', ys: { deepseek: 60e12, google: 40e12, others: 28.9e12 } });
  data.push({ x: '2026-09-21', ys: { deepseek: latestTokens / 2, google: latestTokens / 2 } });
  return { data };
}

function ok(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function stubFetch(models, share = marketShare()) {
  return async (url) => (String(url).includes('market-share') ? ok(share) : ok(models));
}

test('the window is the dominant date, not the latest one', () => {
  // The live payload carries 539 rows on one date and a handful of stragglers on later-looking days.
  // Taking the maximum would reduce the ledger to whichever models reported last.
  const rows = [
    ...Array.from({ length: 8 }, () => modelRow({ date: '2026-09-20 00:00:00' })),
    modelRow({ date: '2026-09-19 00:00:00' }),
    modelRow({ date: '2026-09-18 00:00:00' })
  ];
  const window = selectWindow(rows);
  assert.equal(window.windowEnd, '2026-09-20');
  assert.equal(window.windowRows, 8);
  assert.equal(window.strayRows, 2);
  assert.deepEqual(window.strayDates, ['2026-09-18', '2026-09-19']);
});

test('a media-counter filter is vacuous, so the token column does the work', () => {
  // voyageai/voyage-4-lite is 6.1M embedding requests with image_output_requests: 0 like everything
  // else. A filter written against the media counters keeps it; the completion-token test drops it.
  const embedding = modelRow({ model_permaslug: 'voyageai/voyage-4-lite-20260727', total_completion_tokens: 0, count: 6_127_311 });
  assert.equal(embedding.image_output_requests, 0);
  assert.equal(embedding.num_media_prompt, 0);
  assert.equal(isTextGeneration(embedding), false);
  assert.equal(isTextGeneration(modelRow()), true);
  const { authors } = normalizeModelRows({ data: [modelRow({ count: 100 }), embedding] }, '2026-09-20');
  const voyage = authors.find((entry) => entry.author === 'voyageai');
  assert.equal(voyage.requests, 0);
  // Dropped requests are recorded rather than discarded, so the modality call stays revisitable.
  assert.equal(voyage.excludedRequests, 6_127_311);
  assert.equal(voyage.excludedModels, 1);
});

test('author namespaces are never merged into companies', () => {
  assert.equal(authorOf('meta-llama/llama-4-scout'), 'meta-llama');
  assert.equal(authorOf('meta/llama-5'), 'meta');
  assert.throws(() => authorOf('no-slash'), /Unexpected model_permaslug/);
  const { authors } = normalizeModelRows({
    data: [
      modelRow({ model_permaslug: 'meta-llama/llama-4-scout', count: 185 }),
      modelRow({ model_permaslug: 'meta/llama-5', count: 88 })
    ]
  }, '2026-09-20');
  // Kalshi lists one "Meta" ticker; the source has two live keys differing by a factor of two. A
  // ledger that summed them would hide the ambiguity the contract actually carries.
  assert.deepEqual(authors.map((entry) => entry.author).sort(), ['meta', 'meta-llama']);
  assert.equal(authors.find((entry) => entry.author === 'meta-llama').requests, 185);
});

test('a row with no namespace is bucketed, not fatal and not attributed', () => {
  // Live payload, 2026-09-21: `text-embedding-3-large` (216 requests) and `text-embedding-3-small`
  // carry no author prefix, and one row's permaslug is the empty string. Throwing on any of them
  // voids a week that cannot be re-fetched; guessing an author invents traffic for OpenAI.
  const { authors, unattributed } = normalizeModelRows({
    data: [
      modelRow({ count: 400 }),
      modelRow({ model_permaslug: 'text-embedding-3-large', total_completion_tokens: 0, count: 216 }),
      modelRow({ model_permaslug: '', total_completion_tokens: 0, count: 0 })
    ]
  }, '2026-09-20');
  assert.deepEqual(authors.map((entry) => entry.author), ['deepseek']);
  assert.equal(unattributed.rows, 2);
  assert.equal(unattributed.requests, 216);
  assert.equal(authors.find((entry) => entry.author === 'openai'), undefined);
});

test('a still-accruing week is flagged instead of archived as a week', () => {
  // The real chart's shape, which is the whole difficulty: weekly volume grew from ~20T to ~128T over
  // the archived year. A flat fixture passes this test under any reference window and proves nothing.
  const totals = [
    20.1e12, 26.4e12, 33.8e12, 41.2e12, 52.6e12, 61.9e12, 70.4e12, 83.1e12,
    95.7e12, 104.3e12, 115.46e12, 126.76e12, 128.9e12, 17.56e12
  ];
  // 18T is a Monday-morning read of a bucket holding a few hours. Against the median of ALL archived
  // weeks (~62T) it scores 0.29 — but a half-finished 60T week scores 0.97 and passes, which is the
  // case the guard exists for. Against the trailing four (~121T) the half-week scores 0.49.
  assert.equal(completeness('2026-09-20', 18e12, totals).partial, true);
  const halfWeek = completeness('2026-09-20', 60e12, totals);
  assert.equal(halfWeek.partial, true);
  assert.ok(halfWeek.fractionOfMedianWeek < 0.6);
  const complete = completeness('2026-09-20', 127.91e12, totals);
  assert.equal(complete.partial, false);
  assert.equal(complete.calendarWeek, true);
  assert.equal(complete.weekStart, '2026-09-14');
  // A complete week must score near 1.0, not near 6.0. The live first run reported 6.2488 against a
  // 52-week median, i.e. the guard was measuring a year of growth rather than this week's progress.
  assert.ok(complete.fractionOfMedianWeek > 0.9 && complete.fractionOfMedianWeek < 1.2);
  // The chart's own newest bucket cannot be the reference: it is drawn from the same live data, so a
  // mid-week comparison against it reads ~1.0 whether the week is finished or not.
  assert.equal(complete.referenceWeeks, 4);
  assert.equal(complete.medianWeekTokens, 126.76e12);
});

test('a window that is not Monday-to-Sunday is flagged', () => {
  const wednesday = completeness('2026-09-16', 60e12, [100e12, 100e12, 100e12]);
  assert.equal(wednesday.calendarWeek, false);
  assert.equal(wednesday.weekStart, '2026-09-10');
});

test('counts are archived, never shares', async () => {
  const snapshot = await fetchAuthorShareSnapshot({
    fetchImpl: stubFetch({ data: [modelRow({ count: 300 }), modelRow({ model_permaslug: 'google/gemini-4', count: 100 })] }),
    observedAt: '2026-09-21T14:00:00.000Z'
  });
  const row = snapshot.rows.find((entry) => entry.author === 'deepseek');
  assert.equal(row.requests, 300);
  assert.equal(row.windowRequests, 400);
  // Storing 75% here would freeze one denominator into the archive; every cut from all-authors to
  // top-15 fits the five reproduced prints, so the cut is not identified.
  assert.equal(row.share, undefined);
  assert.equal(row.request_share, undefined);
  assert.equal(row.windowEnd, '2026-09-20');
  assert.equal(row.weekStart, '2026-09-14');
});

test('a network failure writes one unresolved row carrying no counts', async () => {
  const snapshot = await fetchAuthorShareSnapshot({
    fetchImpl: async () => { throw new Error('socket hang up'); },
    observedAt: '2026-09-21T14:00:00.000Z'
  });
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].status, 'unresolved');
  assert.equal(snapshot.rows[0].requests, undefined);
  assert.equal(snapshot.rows[0].windowEnd, null);
  assert.match(snapshot.rows[0].reason, /socket hang up/);
});

test('a non-200 is unresolved rather than an empty week', async () => {
  const snapshot = await fetchAuthorShareSnapshot({
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    observedAt: '2026-09-21T14:00:00.000Z'
  });
  assert.equal(snapshot.rows[0].status, 'unresolved');
  assert.equal(snapshot.rows[0].httpStatus, 429);
});

test('a non-numeric count throws rather than counting as zero', () => {
  assert.throws(
    () => normalizeModelRows({ data: [modelRow({ count: null })] }, '2026-09-20'),
    /non-numeric count/
  );
});

test('the token chart records whether an author was displayed at all', async () => {
  const snapshot = await fetchAuthorShareSnapshot({
    fetchImpl: stubFetch({
      data: [modelRow({ count: 300 }), modelRow({ model_permaslug: 'tencent/hunyuan-3', count: 100 })]
    }),
    observedAt: '2026-09-21T14:00:00.000Z'
  });
  const tencent = snapshot.rows.find((row) => row.author === 'tencent');
  // Tencent carries 556,521 contracts while being displayed in 22 of 53 weekly buckets. Absence is
  // an automatic all-NO under the `others` clause, independently of the number.
  assert.equal(tencent.displayedInTokenChart, false);
  assert.equal(snapshot.rows.find((row) => row.author === 'deepseek').displayedInTokenChart, true);
});

test('re-running inside the same window neither duplicates nor overwrites', () => {
  const first = [{ windowEnd: '2026-09-20', author: 'deepseek', status: 'resolved', requests: 300 }];
  const second = [{ windowEnd: '2026-09-20', author: 'deepseek', status: 'resolved', requests: 999 }];
  const merged = mergeAuthorShareRows(first, second);
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.duplicates, 1);
  // The endpoint's counts for a window keep moving after the window closes; the archive holds what
  // was published first, so the series cannot depend on how often the snapshot was run.
  assert.equal(merged.rows[0].requests, 300);
});

test('a retry supersedes the unresolved placeholder for that window', () => {
  const merged = mergeAuthorShareRows(
    [{ windowEnd: '2026-09-20', status: 'unresolved', httpStatus: 429 }],
    [{ windowEnd: '2026-09-20', author: 'deepseek', status: 'resolved', requests: 300 }]
  );
  assert.equal(merged.replaced, 1);
  // The placeholder carries no author, so it cannot collide with an author row on key alone; left in
  // place it would keep asserting the window was never read.
  assert.equal(merged.rows.length, 1);
  assert.equal(merged.rows[0].status, 'resolved');
});

test('an unresolved window survives when nothing has resolved it', () => {
  const merged = mergeAuthorShareRows(
    [{ windowEnd: '2026-09-20', status: 'unresolved', httpStatus: 429 }],
    [{ windowEnd: '2026-09-27', author: 'deepseek', status: 'resolved', requests: 300 }]
  );
  assert.equal(merged.rows.length, 2);
  assert.equal(merged.replaced, 0);
  assert.equal(merged.rows[0].status, 'unresolved');
});

test('the ledger is written atomically and sorted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'author-share-'));
  const file = path.join(directory, 'author-share.ndjson');
  await appendAuthorShareRows([
    { windowEnd: '2026-09-27', author: 'google', status: 'resolved', requests: 1 },
    { windowEnd: '2026-09-20', author: 'deepseek', status: 'resolved', requests: 2 }
  ], file);
  const outcome = await appendAuthorShareRows([{ windowEnd: '2026-09-20', author: 'deepseek', status: 'resolved', requests: 2 }], file);
  assert.equal(outcome.rows, 2);
  assert.equal(outcome.duplicates, 1);
  const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((row) => row.windowEnd), ['2026-09-20', '2026-09-27']);
  assert.deepEqual(await loadAuthorShareLedger(file), lines);
});

test('shares are derived at read time under every denominator', () => {
  const rows = [
    { windowEnd: '2026-09-20', author: 'a', status: 'resolved', requests: 50 },
    { windowEnd: '2026-09-20', author: 'b', status: 'resolved', requests: 30 },
    { windowEnd: '2026-09-20', author: 'c', status: 'resolved', requests: 20 }
  ];
  assert.equal(authorShares(rows).get('a'), 50);
  // A top-2 cut renormalizes within the cut, which is exactly how a top-N chart reads.
  assert.equal(authorShares(rows, 2).get('a'), 62.5);
  assert.equal(authorShares(rows, 2).get('c'), undefined);
});

test('the report names the blind spots and counts weeks to a backtest', () => {
  const report = authorShareReport([
    {
      windowEnd: '2026-09-20', weekStart: '2026-09-14', author: 'tencent', status: 'resolved',
      capturedAt: '2026-09-21T14:00:00.000Z', requests: 100, excludedRequests: 5,
      displayedInTokenChart: false, tokenChartTokens: 0, tokenChartTotal: 1000,
      partialWindow: false, calendarWeek: true
    }
  ]);
  assert.equal(report.coverage.windows, 1);
  // 12 windows is the minimum for a backtest of the author ladders and the source serves one a week.
  assert.equal(report.coverage.weeks_until_backtestable, 11);
  assert.deepEqual(report.settleable.never_displayed_in_token_chart, ['tencent']);
  assert.equal(report.windows[0].series[0].request_share.all, 100);
  assert.equal(report.windows[0].series[0].displayed_in_token_chart, false);
});
