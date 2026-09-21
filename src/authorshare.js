import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './utils.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai';

export const AUTHOR_SHARE_FILE = path.join(DATA_DIR, 'author-share.ndjson');

// `docs/settlement-sources.md`: Kalshi's model-author ladders settle on request share, and the only
// endpoint carrying requests serves ONE trailing week with no archive. 20 of 25 settled prints can
// no longer be checked by anyone. This module exists to stop that being true of the next 25.
const MODELS_PATH = '/api/frontend/v1/rankings/models';
const MARKET_SHARE_PATH = '/api/frontend/v1/rankings/market-share';

// A row is text generation if it produced completion tokens. Every media counter in the payload —
// image_output_requests, num_media_prompt, rerank_documents, stt_transcript_characters — is
// zero-filled on all 539 rows, so a filter written against them removes nothing while looking
// correct. Embedding, rerank, speech and video models are 6.3% of requests and are not "text".
export function isTextGeneration(row) {
  return Number(row?.total_completion_tokens) > 0;
}

// The series ticker names a company; the dataset keys on the namespace before the `/`, which is not
// the same thing. Meta ships as both `meta-llama` and `meta` in the same window and the weekly chart
// has never displayed the two together, so namespaces are never merged here — a reader that wants
// them summed can do it, but the ledger must not decide for it.
export function authorOf(permaslug) {
  const value = String(permaslug || '').trim();
  const namespace = value.split('/')[0];
  if (!namespace || namespace === value) throw new Error(`Unexpected model_permaslug: ${permaslug}`);
  return namespace;
}

const isoDay = (value) => String(value || '').slice(0, 10);
const shiftDays = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const dayOfWeek = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

// The payload is not a panel. 539 of 572 rows carry one date and the rest are stragglers, and that
// date's token total matches the weekly chart's bucket to 0.992 — the rows are a trailing WEEK
// stamped at the end of its window. Taking the maximum date instead of the dominant one would
// reduce the whole ledger to whichever handful of models reported latest.
export function selectWindow(rows) {
  const counts = new Map();
  for (const row of rows) {
    const day = isoDay(row.date);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  if (!counts.size) throw new Error('Payload carried no dated rows');
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
  const [windowEnd, windowRows] = ranked[0];
  return {
    windowEnd,
    windowRows,
    strayRows: rows.length - windowRows,
    strayDates: ranked.slice(1).map(([day]) => day).sort()
  };
}

function numeric(value) {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

export function normalizeModelRows(payload, windowEnd) {
  const rows = Array.isArray(payload?.data) ? payload.data : null;
  if (!rows) throw new Error('Model ranking response did not contain a data array');
  const authors = new Map();
  const unattributed = { rows: 0, requests: 0 };
  let windowTokens = 0;
  let excludedRequests = 0;
  for (const row of rows) {
    if (isoDay(row.date) !== windowEnd) continue;
    // `Number(null)` is 0, which is finite, so coercing first and testing afterwards accepts an
    // absent count as no traffic. A missing number is a broken payload, not a zero.
    const requests = numeric(row.count);
    const prompt = numeric(row.total_prompt_tokens);
    const completion = numeric(row.total_completion_tokens);
    if (requests === null || prompt === null || completion === null) {
      throw new Error(`${row.model_permaslug} carried a non-numeric count or token total`);
    }
    windowTokens += prompt + completion;
    // Three live rows carry no namespace at all: `text-embedding-3-small`, `text-embedding-3-large`
    // (216 requests) and one empty string. They cannot be attributed to an author, and guessing one
    // would invent traffic for OpenAI. They are bucketed and counted, never dropped and never fatal —
    // one malformed row must not void a week that cannot be re-fetched.
    let author;
    try { author = authorOf(row.model_permaslug); }
    catch { unattributed.rows += 1; unattributed.requests += requests; continue; }
    if (!authors.has(author)) {
      authors.set(author, { author, requests: 0, promptTokens: 0, completionTokens: 0, models: 0, excludedRequests: 0, excludedModels: 0 });
    }
    const entry = authors.get(author);
    // The non-generation rows are recorded per author rather than dropped, so the modality decision
    // stays revisitable from the ledger instead of being frozen at collection time.
    if (!isTextGeneration(row)) {
      entry.excludedRequests += requests;
      entry.excludedModels += 1;
      excludedRequests += requests;
      continue;
    }
    entry.requests += requests;
    entry.promptTokens += prompt;
    entry.completionTokens += completion;
    entry.models += 1;
  }
  if (!authors.size) throw new Error(`No rows were stamped ${windowEnd}`);
  return {
    authors: [...authors.values()].sort((a, b) => b.requests - a.requests || a.author.localeCompare(b.author)),
    windowTokens,
    excludedRequests,
    unattributed
  };
}

// A week that is still accruing must not be archived as a week. Two independent guards: the window
// has to be a Monday-to-Sunday span, and its token total has to be in line with the completed weeks
// the archived chart already holds. The chart's own newest bucket is useless for this — it is drawn
// from the same live data, so a mid-week comparison against it reads ~1.0 either way.
// REFERENCE_WEEKS is deliberately short. The first version took the median of all 52 archived weeks
// and scored the live window at 6.25x, because OpenRouter's weekly volume grew from ~20T to ~128T
// over the year: against a year-old median a half-finished week reads as 0.9 and passes. A trailing
// reference is the only one that measures completeness rather than growth.
const REFERENCE_WEEKS = 4;

export function completeness(windowEnd, windowTokens, weeklyTotals) {
  const weekStart = shiftDays(windowEnd, -6);
  const complete = weeklyTotals.slice(0, -1).filter((value) => Number.isFinite(value) && value > 0)
    .slice(-REFERENCE_WEEKS).sort((a, b) => a - b);
  const median = complete.length ? complete[Math.floor(complete.length / 2)] : null;
  const fraction = median ? windowTokens / median : null;
  return {
    weekStart,
    calendarWeek: dayOfWeek(weekStart) === 1 && dayOfWeek(windowEnd) === 0,
    referenceWeeks: complete.length,
    medianWeekTokens: median,
    fractionOfMedianWeek: fraction === null ? null : Number(fraction.toFixed(4)),
    partial: fraction === null ? null : fraction < 0.8
  };
}

function unresolvedRow(windowEnd, capturedAt, httpStatus, reason) {
  return { windowEnd: windowEnd ?? null, capturedAt, status: 'unresolved', httpStatus, reason, source: 'openrouter-rankings' };
}

async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${new URL(url).pathname}`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchAuthorShareSnapshot(options = {}) {
  const capturedAt = options.observedAt || new Date().toISOString();
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  let models;
  let marketShare;
  try {
    models = await getJson(`${baseUrl}${MODELS_PATH}`, fetchImpl);
    marketShare = await getJson(`${baseUrl}${MARKET_SHARE_PATH}`, fetchImpl);
  } catch (error) {
    return { capturedAt, rows: [unresolvedRow(null, capturedAt, error.httpStatus ?? null, error.message)], unresolved: [error.message] };
  }
  let window;
  let reduced;
  try {
    window = selectWindow(Array.isArray(models?.data) ? models.data : []);
    reduced = normalizeModelRows(models, window.windowEnd);
  } catch (error) {
    return { capturedAt, rows: [unresolvedRow(window?.windowEnd ?? null, capturedAt, 200, error.message)], unresolved: [error.message] };
  }
  const weekly = Array.isArray(marketShare?.data) ? marketShare.data : [];
  const weeklyTotals = weekly.map((point) => Object.values(point?.ys ?? {}).reduce((sum, value) => sum + Number(value || 0), 0));
  const state = completeness(window.windowEnd, reduced.windowTokens, weeklyTotals);
  const bucket = weekly.find((point) => point?.x === state.weekStart);
  const bucketTokens = bucket ? Object.values(bucket.ys).reduce((sum, value) => sum + Number(value || 0), 0) : null;
  const displayed = bucket ? Object.keys(bucket.ys).filter((key) => key !== 'others').sort() : null;
  const rows = reduced.authors.map((entry) => ({
    windowEnd: window.windowEnd,
    weekStart: state.weekStart,
    author: entry.author,
    capturedAt,
    status: 'resolved',
    httpStatus: 200,
    // Counts, never shares. Every denominator from all-authors to top-15 fits the five reproduced
    // prints inside 0.9 points, so the cut is not identified — storing a share would freeze a guess
    // into the archive. `author_share_report` derives shares under each cut at read time.
    requests: entry.requests,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    models: entry.models,
    excludedRequests: entry.excludedRequests,
    excludedModels: entry.excludedModels,
    windowRequests: reduced.authors.reduce((sum, row) => sum + row.requests, 0),
    windowTokens: reduced.windowTokens,
    // Whether the weekly token chart displayed this author at all: absence is an automatic all-NO
    // under the `others` clause, independently of the number.
    displayedInTokenChart: displayed ? displayed.includes(entry.author) : null,
    tokenChartTokens: bucket ? Number(bucket.ys[entry.author] ?? 0) : null,
    tokenChartTotal: bucketTokens,
    partialWindow: state.partial,
    calendarWeek: state.calendarWeek,
    source: 'openrouter-rankings'
  }));
  return {
    capturedAt,
    window: {
      ...window, ...state, authors: reduced.authors.length, excludedRequests: reduced.excludedRequests,
      unattributedRows: reduced.unattributed.rows, unattributedRequests: reduced.unattributed.requests,
      displayedInTokenChart: displayed?.length ?? null
    },
    rows,
    unresolved: []
  };
}

function byWindowThenAuthor(a, b) {
  return String(a.windowEnd).localeCompare(String(b.windowEnd))
    || String(a.author ?? '').localeCompare(String(b.author ?? ''));
}

export async function loadAuthorShareLedger(file = AUTHOR_SHARE_FILE) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// One row per author per window. Re-running inside the same trailing window must not append a second
// copy, and must not overwrite the first: the endpoint's counts for a window keep moving after the
// window closes, and the archive should hold what was published first, not whatever the last run saw.
export function mergeAuthorShareRows(existing, incoming) {
  const merged = new Map();
  const outcome = { appended: 0, replaced: 0, duplicates: 0 };
  const key = (row) => `${row.windowEnd}:${row.author ?? ''}`;
  for (const row of existing) merged.set(key(row), row);
  for (const row of incoming) {
    const previous = merged.get(key(row));
    if (!previous) {
      merged.set(key(row), row);
      outcome.appended += 1;
    } else if (previous.status === 'unresolved' && row.status === 'resolved') {
      merged.set(key(row), row);
      outcome.replaced += 1;
    } else {
      outcome.duplicates += 1;
    }
  }
  // An unresolved row is a window-level fact carrying no author. Once any author resolves for that
  // window the placeholder is superseded — left in place it would keep claiming the window was never
  // read, and `never_displayed_in_token_chart` would inherit a window that has since been archived.
  const resolvedWindows = new Set([...merged.values()]
    .filter((row) => row.status === 'resolved' && row.author)
    .map((row) => row.windowEnd));
  for (const [key, row] of merged) {
    if (row.status === 'unresolved' && !row.author && resolvedWindows.has(row.windowEnd)) {
      merged.delete(key);
      outcome.replaced += 1;
    }
  }
  return { rows: [...merged.values()].sort(byWindowThenAuthor), ...outcome };
}

export async function appendAuthorShareRows(rows, file = AUTHOR_SHARE_FILE) {
  const merged = mergeAuthorShareRows(await loadAuthorShareLedger(file), rows);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const body = merged.rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(temporary, merged.rows.length ? `${body}\n` : '', { mode: 0o600 });
  await rename(temporary, file);
  return { file, rows: merged.rows.length, appended: merged.appended, replaced: merged.replaced, duplicates: merged.duplicates };
}

// The denominator is the one part of the settlement rule that five prints could not identify, so the
// report publishes every cut rather than picking one. A reader comparing against a settled print can
// see whether the cuts agree; where they disagree by more than a strike increment, the print does not
// discriminate either.
export const DENOMINATORS = [null, 10, 15];

export function authorShares(rows, topN = null) {
  const resolved = rows.filter((row) => row.status === 'resolved' && Number.isFinite(row.requests));
  let ranked = [...resolved].sort((a, b) => b.requests - a.requests || a.author.localeCompare(b.author));
  if (topN) ranked = ranked.slice(0, topN);
  const total = ranked.reduce((sum, row) => sum + row.requests, 0);
  return new Map(ranked.map((row) => [row.author, total ? (100 * row.requests) / total : null]));
}

export function authorShareReport(rows) {
  const windows = [...new Set(rows.map((row) => row.windowEnd))].filter(Boolean).sort();
  const byWindow = windows.map((windowEnd) => {
    const group = rows.filter((row) => row.windowEnd === windowEnd);
    const shares = new Map(DENOMINATORS.map((cut) => [cut, authorShares(group, cut)]));
    const resolved = group.filter((row) => row.status === 'resolved');
    const authors = [...shares.get(null).keys()].map((author) => {
      const row = resolved.find((candidate) => candidate.author === author);
      return {
        author,
        requests: row.requests,
        // Token share is here only to keep the distinction visible: it is the wrong variable, and
        // the two metrics rank the authors differently.
        token_share: row.tokenChartTotal ? Number(((100 * row.tokenChartTokens) / row.tokenChartTotal).toFixed(2)) : null,
        displayed_in_token_chart: row.displayedInTokenChart,
        request_share: Object.fromEntries(DENOMINATORS.map((cut) => {
          const value = shares.get(cut).get(author);
          return [cut === null ? 'all' : `top${cut}`, value === undefined || value === null ? null : Number(value.toFixed(2))];
        }))
      };
    });
    const first = resolved[0] ?? group[0];
    return {
      window_end: windowEnd,
      week_start: first?.weekStart ?? null,
      captured_at: first?.capturedAt ?? null,
      authors: authors.length,
      requests: resolved.reduce((sum, row) => sum + row.requests, 0),
      excluded_requests: resolved.reduce((sum, row) => sum + (row.excludedRequests ?? 0), 0),
      partial_window: first?.partialWindow ?? null,
      calendar_week: first?.calendarWeek ?? null,
      unresolved: group.filter((row) => row.status !== 'resolved').length,
      series: authors
    };
  });
  return {
    generated_at: new Date().toISOString(),
    source: 'openrouter-rankings',
    coverage: {
      windows: windows.length,
      from: windows[0] ?? null,
      to: windows.at(-1) ?? null,
      // A backtest of the author ladders needs ~12 windows; the source publishes one at a time.
      weeks_until_backtestable: Math.max(0, 12 - windows.length)
    },
    settleable: {
      denominator_unidentified: 'request share is reported under every cut; five prints could not choose one',
      partial_windows: byWindow.filter((entry) => entry.partial_window).map((entry) => entry.window_end),
      non_calendar_windows: byWindow.filter((entry) => entry.calendar_week === false).map((entry) => entry.window_end),
      never_displayed_in_token_chart: [...new Set(rows
        .filter((row) => row.status === 'resolved' && row.displayedInTokenChart === false)
        .map((row) => row.author))].sort()
    },
    windows: byWindow
  };
}

export { DEFAULT_BASE_URL as OPENROUTER_BASE_URL, MODELS_PATH, MARKET_SHARE_PATH };
