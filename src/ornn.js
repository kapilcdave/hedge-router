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
  for (const row of [...existing, ...incoming]) {
    const date = isoDate(row.date, 'index date');
    const chip = String(row.chip || '').trim().toUpperCase();
    const price = Number(row.price);
    if (!chip || !Number.isFinite(price) || price <= 0) throw new Error('Invalid index row');
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

export { DEFAULT_BASE_URL as ORNN_API_BASE_URL };
