import path from 'node:path';
import { loadEvents, usageReport } from './telemetry.js';
import { DATA_DIR, readJson } from './utils.js';

function money(value, signed = false) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount);
  const digits = absolute > 0 && absolute < 0.01 ? 4 : 2;
  const sign = signed ? amount > 0 ? '+' : amount < 0 ? '-' : '' : amount < 0 ? '-' : '';
  return `${sign}$${absolute.toFixed(digits)}`;
}

async function optionalJson(file) {
  try {
    return await readJson(path.resolve(file));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadPaperPnl(paperFile, marketFile) {
  const [paper, market] = await Promise.all([
    optionalJson(paperFile || path.join(DATA_DIR, 'paper.json')),
    optionalJson(marketFile || path.join(DATA_DIR, 'evaluation.json'))
  ]);
  return Number(paper?.realized_pnl ?? market?.paper_pnl ?? 0);
}

export function formatStatusLine(report, paperPnl = 0) {
  const tokens = Number(report.input_tokens || 0) + Number(report.output_tokens || 0);
  const compact = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1)}K` : String(tokens);
  return `hedge router · spend ${money(report.actual_cost_usd)} · ${compact} tokens · paper ${money(paperPnl, true)}`;
}

export async function loadStatusLine({ eventsFile, paperFile, marketFile } = {}) {
  const [events, paperPnl] = await Promise.all([
    loadEvents(eventsFile),
    loadPaperPnl(paperFile, marketFile)
  ]);
  return formatStatusLine(usageReport(events), paperPnl);
}
