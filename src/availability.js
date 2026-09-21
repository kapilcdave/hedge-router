import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './utils.js';

const DEFAULT_BASE_URL = 'https://huggingface.co';

export const AVAILABILITY_FILE = path.join(DATA_DIR, 'availability.ndjson');

// Verified unauthenticated on 2026-09-21: every id below returned HTTP 200 carrying `gated`,
// `private`, `disabled`, `sha` and `lastModified`. Two of them are the reason this module tracks
// more than one field: Qwen2.5 and Kimi-K2 are `license: "other"` with the real terms only in
// `license_name`, and DeepSeek-V3 carries no `cardData.license` at all.
export const DEFAULT_WATCHLIST = [
  'meta-llama/Llama-3.1-8B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'mistralai/Mixtral-8x7B-Instruct-v0.1',
  'Qwen/Qwen2.5-72B-Instruct',
  'deepseek-ai/DeepSeek-V3',
  'deepseek-ai/DeepSeek-R1',
  'google/gemma-2-9b-it',
  'microsoft/Phi-3-mini-4k-instruct',
  'openai/gpt-oss-120b',
  'moonshotai/Kimi-K2-Instruct',
  'zai-org/GLM-4.5'
];

// The fields a settlement rule could pay on. `licenseName` and `licenseLink` are here because
// `license: "other"` is a pointer, not a licence: the terms can change underneath it.
export const TRACKED_FIELDS = ['gated', 'private', 'disabled', 'license', 'licenseName', 'licenseLink'];

export function parseModelId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid Hugging Face model id: ${value}`);
  }
  return id;
}

export function parseWatchlist(source) {
  let supplied = source;
  if (typeof source === 'string') {
    try { supplied = JSON.parse(source); }
    catch { supplied = source.split(/[\n,]/).map((line) => line.replace(/#.*$/, '')); }
  }
  const values = Array.isArray(supplied) ? supplied : Array.isArray(supplied?.models) ? supplied.models : null;
  if (!values) throw new Error('A watchlist must be a JSON array, {"models": [...]}, or newline-separated ids');
  const models = [...new Set(values.map((value) => String(value).trim()).filter(Boolean).map(parseModelId))];
  if (!models.length) throw new Error('A watchlist must name at least one model');
  return models;
}

function licenseOf(card) {
  const value = card.license;
  if (value == null || value === '') return null;
  return Array.isArray(value) ? [...value].map(String).sort().join(',') : String(value);
}

export function normalizeModelPayload(model, payload, observedAt) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${model} returned a payload that is not an object`);
  }
  // An absent flag is not a permissive flag. Defaulting a missing `gated` to false would erase the
  // exact event this ledger exists to timestamp, so an unexpected shape becomes unresolved instead.
  if (payload.gated === undefined) throw new Error(`${model} response did not contain gated`);
  if (!Number.isFinite(Date.parse(payload.lastModified))) throw new Error(`${model} response did not contain lastModified`);
  const card = payload.cardData && typeof payload.cardData === 'object' ? payload.cardData : {};
  const downloads = Number(payload.downloads);
  return {
    model,
    date: observedAt.slice(0, 10),
    observedAt,
    status: 'resolved',
    httpStatus: 200,
    gated: payload.gated === false || payload.gated === null ? false : String(payload.gated),
    private: payload.private === true,
    disabled: payload.disabled === true,
    license: licenseOf(card),
    licenseName: card.license_name == null ? null : String(card.license_name),
    licenseLink: card.license_link == null ? null : String(card.license_link),
    sha: payload.sha == null ? null : String(payload.sha),
    lastModified: new Date(payload.lastModified).toISOString(),
    downloads: Number.isFinite(downloads) ? downloads : null,
    source: 'huggingface-public-api'
  };
}

// A non-200 carries no field values at all. Hugging Face answers 401 "Invalid username or password"
// for a repo that was deleted, a repo that was made private, and a repo that never existed — three
// different facts behind one status. Writing a value here would let a reader diff against it.
function unresolvedRow(model, observedAt, httpStatus, reason) {
  return {
    model,
    date: observedAt.slice(0, 10),
    observedAt,
    status: 'unresolved',
    httpStatus,
    reason,
    source: 'huggingface-public-api'
  };
}

export async function fetchModelAvailability(id, options = {}) {
  const model = parseModelId(id);
  const observedAt = options.observedAt || new Date().toISOString();
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(new URL(`${baseUrl}/api/models/${model}`), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    return unresolvedRow(model, observedAt, null, `request failed: ${error.message}`);
  }
  if (!response.ok) {
    return unresolvedRow(model, observedAt, response.status,
      response.status === 401
        ? 'HTTP 401: unauthenticated reads cannot separate deleted, private, and never-existed'
        : `HTTP ${response.status}`);
  }
  try { return normalizeModelPayload(model, await response.json(), observedAt); }
  catch (error) { return unresolvedRow(model, observedAt, response.status, error.message); }
}

// One capturedAt for every row in the snapshot. Stamping each model with its own clock lets a run
// that straddles midnight UTC split one observation across two settlement dates.
export async function fetchAvailabilitySnapshot(options = {}) {
  const models = options.models?.length ? options.models.map(parseModelId) : [...DEFAULT_WATCHLIST];
  const capturedAt = options.observedAt || new Date().toISOString();
  const rows = [];
  for (const model of models) {
    rows.push(await fetchModelAvailability(model, { ...options, observedAt: capturedAt }));
  }
  return {
    capturedAt,
    models: models.length,
    rows,
    unresolved: rows.filter((row) => row.status === 'unresolved').map((row) => ({ model: row.model, reason: row.reason }))
  };
}

function byDateThenModel(a, b) {
  return a.date.localeCompare(b.date) || a.observedAt.localeCompare(b.observedAt) || a.model.localeCompare(b.model);
}

export async function loadAvailabilityLedger(file = AVAILABILITY_FILE) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// The ledger is the daily series: one row per model per UTC date. A retry may upgrade an unresolved
// row to a resolved one, but a second resolved read of the same day never overwrites the first —
// otherwise the series a settlement rule reads would depend on how often the snapshot was run.
export function mergeAvailabilityRows(existing, incoming) {
  const merged = new Map();
  const outcome = { appended: 0, replaced: 0, duplicates: 0 };
  for (const row of existing) merged.set(`${row.model}:${row.date}`, row);
  for (const row of incoming) {
    const key = `${row.model}:${row.date}`;
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, row);
      outcome.appended += 1;
    } else if (previous.status === 'unresolved' && row.status === 'resolved') {
      merged.set(key, row);
      outcome.replaced += 1;
    } else {
      outcome.duplicates += 1;
    }
  }
  return { rows: [...merged.values()].sort(byDateThenModel), ...outcome };
}

export async function appendAvailabilityRows(rows, file = AVAILABILITY_FILE) {
  const merged = mergeAvailabilityRows(await loadAvailabilityLedger(file), rows);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const body = merged.rows.map((row) => JSON.stringify(row)).join('\n');
  await writeFile(temporary, merged.rows.length ? `${body}\n` : '', { mode: 0o600 });
  await rename(temporary, file);
  return { file, rows: merged.rows.length, appended: merged.appended, replaced: merged.replaced, duplicates: merged.duplicates };
}

// A change is bracketed, never timestamped: it happened after the previous resolved observation and
// at or before this one. `lastModified` narrows that window only when the commit hash also moved —
// gating is a repo setting rather than a commit, so it can flip with `sha` and `lastModified` frozen.
export function availabilityEvents(rows) {
  const previous = new Map();
  const events = [];
  for (const row of [...rows].sort(byDateThenModel)) {
    if (row.status !== 'resolved') continue;
    const before = previous.get(row.model);
    previous.set(row.model, row);
    if (!before) continue;
    for (const field of TRACKED_FIELDS) {
      if (Object.is(before[field], row[field])) continue;
      const movedCommit = before.sha !== row.sha;
      const modified = Date.parse(row.lastModified);
      const inBracket = movedCommit
        && modified > Date.parse(before.observedAt) && modified <= Date.parse(row.observedAt);
      events.push({
        model: row.model,
        field,
        from: before[field] ?? null,
        to: row[field] ?? null,
        observedBetween: { after: before.observedAt, atOrBefore: row.observedAt },
        bracketDays: Math.round((Date.parse(row.observedAt) - Date.parse(before.observedAt)) / 86_400_000),
        shaFrom: before.sha,
        shaTo: row.sha,
        narrowedTo: inBracket ? row.lastModified : null
      });
    }
  }
  return events;
}

export function availabilityReport(rows) {
  const resolved = rows.filter((row) => row.status === 'resolved');
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const latest = new Map();
  for (const row of [...resolved].sort(byDateThenModel)) latest.set(row.model, row);
  const models = [...latest.values()].map((row) => ({
    model: row.model,
    as_of: row.date,
    gated: row.gated,
    private: row.private,
    disabled: row.disabled,
    license: row.license,
    license_name: row.licenseName,
    // `license: "other"` means the licence field cannot settle this model on its own.
    terms_in_license_name: row.license === 'other'
  })).sort((a, b) => a.model.localeCompare(b.model));
  const unresolved = [...new Set(rows.filter((row) => row.status === 'unresolved').map((row) => row.model))].sort();
  return {
    generated_at: new Date().toISOString(),
    source: 'huggingface-public-api',
    coverage: {
      days: dates.length,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      models: latest.size,
      resolved_rows: resolved.length,
      unresolved_rows: rows.length - resolved.length
    },
    settleable: {
      // Naming the blind spots is the point: these are the models a `cardData.license` rule misses.
      license_is_other: models.filter((row) => row.terms_in_license_name).map((row) => row.model),
      license_absent: models.filter((row) => row.license == null).map((row) => row.model),
      unresolved
    },
    models,
    events: availabilityEvents(rows)
  };
}

export { DEFAULT_BASE_URL as HUGGINGFACE_BASE_URL };
