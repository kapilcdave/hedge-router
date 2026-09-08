const DEFAULT_BASE_URL = 'https://api.ornnai.com';

const GPU_ALIASES = new Map([
  ['H100', 'H100 SXM'],
  ['H100 SXM', 'H100 SXM'],
  ['H200', 'H200'],
  ['B200', 'B200'],
  ['A100', 'A100 SXM4'],
  ['A100 SXM4', 'A100 SXM4'],
  ['RTX5090', 'RTX 5090'],
  ['RTX 5090', 'RTX 5090']
]);

function isoDate(value, name) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be YYYY-MM-DD`);
  }
  return value;
}

export function mergeOrnnIndex(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) throw new Error('Index documents must be arrays');
  const merged = new Map();
  const units = new Map();
  for (const row of [...existing, ...incoming]) {
    const date = isoDate(row.date, 'index date');
    const chip = String(row.chip || '').trim().toUpperCase();
    const price = Number(row.price);
    if (!chip || !Number.isFinite(price) || price <= 0) throw new Error('Invalid index row');
    // A GPU index is dollars per GPU-hour and a token index is dollars per million tokens. Merging
    // the two under one chip would forecast against a series that silently changes units.
    const unit = String(row.unit || 'usd_per_gpu_hour');
    const seen = units.get(chip);
    if (seen && seen !== unit) throw new Error(`Index rows for ${chip} mix units ${seen} and ${unit}`);
    units.set(chip, unit);
    merged.set(`${date}:${chip}`, { ...row, date, chip, price });
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || a.chip.localeCompare(b.chip));
}

export function resolveOrnnGpu(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const gpu = GPU_ALIASES.get(normalized);
  if (!gpu) throw new Error(`Unsupported Ornn GPU: ${value}. Use H100, H200, B200, A100, or RTX5090`);
  return gpu;
}

export async function fetchOrnnIndex({
  gpu, chip, startDate, endDate, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch
}) {
  const sourceGpu = resolveOrnnGpu(gpu);
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end) throw new Error('startDate must not be after endDate');
  const outputChip = String(chip || '').trim().toUpperCase();
  if (!outputChip) throw new Error('chip is required');

  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/gpu/${encodeURIComponent(sourceGpu)}/index-history`);
  url.searchParams.set('startDate', start);
  url.searchParams.set('endDate', end);
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Ornn API returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error('Ornn API response did not contain index history');
  }

  const byDate = new Map();
  for (const point of payload.data) {
    const timestamp = String(point.timestamp || '');
    const date = timestamp.slice(0, 10);
    const price = Number(point.index_value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(timestamp)) || !Number.isFinite(price) || price <= 0) {
      throw new Error('Ornn API returned an invalid index point');
    }
    if (date >= start && date <= end) {
      byDate.set(date, { date, chip: outputChip, price, source: 'ornn-index-api', sourceGpu, observedAt: timestamp });
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The Ornn Token Price Index. `/api/token-types` is the source of truth for lab names; these are
// the four the public tier serves, which are also the four Kalshi ever listed token markets on.
const OTPI_FREE_LABS = ['anthropic', 'openai', 'google', 'deepseek'];
const OTPI_KEYED_LABS = ['minimax', 'xiaomi', 'qwen', 'moonshotai', 'z-ai', 'mistralai', 'meta-llama'];

export function resolveOtpiLab(value) {
  const lab = String(value || '').trim().toLowerCase();
  if (OTPI_FREE_LABS.includes(lab)) return lab;
  if (OTPI_KEYED_LABS.includes(lab)) return lab;
  throw new Error(`Unsupported OTPI lab: ${value}. Use one of ${[...OTPI_FREE_LABS, ...OTPI_KEYED_LABS].join(', ')}`);
}

export function otpiFreeLabs() {
  return [...OTPI_FREE_LABS];
}

// OTPI is a daily settled blend in dollars per million tokens, so it is the settlement index for a
// bill denominated in tokens rather than GPU-hours. Rows come back shaped like the GPU index — the
// lab takes the `chip` slot — so the forecast, paper, and backtest paths consume it unchanged.
export async function fetchOrnnTokenIndex({
  lab, chip, startDate, endDate, apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch
}) {
  const sourceLab = resolveOtpiLab(lab);
  const start = isoDate(startDate, 'startDate');
  const end = isoDate(endDate, 'endDate');
  if (start > end) throw new Error('startDate must not be after endDate');
  const outputChip = String(chip || sourceLab).trim().toUpperCase();

  const url = new URL(`${baseUrl.replace(/\/$/, '')}/api/otpi`);
  url.searchParams.set('lab', sourceLab);
  url.searchParams.set('startDate', start);
  url.searchParams.set('endDate', end);
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Ornn API returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.success !== true || !Array.isArray(payload.data)) {
    throw new Error('Ornn API response did not contain token index history');
  }

  const access = String(payload.access || 'unknown');
  const byDate = new Map();
  for (const point of payload.data) {
    const date = String(point.date || '');
    const price = Number(point.indexPerMtok);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(price) || price <= 0) {
      throw new Error('Ornn API returned an invalid token index point');
    }
    if (String(point.lab || sourceLab) !== sourceLab) throw new Error('Ornn API returned a row for another lab');
    if (date >= start && date <= end) {
      byDate.set(date, {
        date, chip: outputChip, price, unit: 'usd_per_mtok', lab: sourceLab,
        source: 'ornn-otpi-api', access, observedAt: String(point.computedAt || '')
      });
    }
  }
  if (!byDate.size) throw new Error(`Ornn returned no OTPI rows for ${sourceLab} between ${start} and ${end}`);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The public tier serves only a trailing window and narrows a wider request without erroring, so a
// caller that trusts its own range silently treats withheld history as absent history.
export function otpiCoverage({ rows, startDate, endDate }) {
  const dates = rows.map((row) => row.date).sort();
  const covered = { from: dates[0] ?? null, to: dates.at(-1) ?? null };
  const day = 86_400_000;
  const requestedDays = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / day) + 1;
  return {
    requested: { from: startDate, to: endDate, days: requestedDays },
    covered,
    rows: rows.length,
    access: rows[0]?.access ?? 'unknown',
    clamped: Boolean(covered.from && covered.from > startDate)
  };
}

export { DEFAULT_BASE_URL as ORNN_API_BASE_URL };
