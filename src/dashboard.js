import path from 'node:path';
import { loadEvents, savingsReport } from './telemetry.js';
import { DATA_DIR, readJson } from './utils.js';

const ANSI = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  cyan: '\u001b[36m', green: '\u001b[32m', yellow: '\u001b[33m',
  red: '\u001b[31m', magenta: '\u001b[35m', white: '\u001b[97m'
};

function paint(enabled, tone, value) {
  return enabled && ANSI[tone] ? `${ANSI[tone]}${value}${ANSI.reset}` : value;
}

function truncate(value, width) {
  const text = String(value ?? '');
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function money(value, signed = false) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount);
  const digits = absolute > 0 && absolute < 0.01 ? 4 : 2;
  const prefix = signed ? amount > 0 ? '+' : amount < 0 ? '-' : '' : amount < 0 ? '-' : '';
  return `${prefix}$${absolute.toFixed(digits)}`;
}

function percent(value, digits = 0) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function clock(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(11, 19) : '--:--:--';
}

function bar(value, maximum, width) {
  const filled = maximum > 0 ? Math.max(1, Math.round((value / maximum) * width)) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

async function optionalJson(file) {
  try { return await readJson(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function buildDashboardState(events, market = null, options = {}) {
  const requests = events.filter((event) => event.event_type === 'request');
  const report = savingsReport(events);
  const mix = new Map();
  for (const request of requests) {
    const model = request.model || 'failed request';
    mix.set(model, (mix.get(model) || 0) + 1);
  }
  const modelMix = [...mix.entries()]
    .map(([model, count]) => ({ model, count, share: requests.length ? count / requests.length : 0 }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  const results = Array.isArray(market?.results) ? market.results : [];
  const hedges = results.filter((row) => row.side && row.side !== 'hold').slice(-5).reverse();
  const latestSignal = results.at(-1) || null;
  return {
    mode: options.mode || 'live',
    frame: Number(options.frame || 0),
    report,
    recent: requests.slice(-6).reverse(),
    modelMix,
    market,
    hedges,
    latestSignal,
    source: options.source || null
  };
}

export async function loadDashboardState({ eventsFile, marketFile, frame = 0 } = {}) {
  const resolvedMarket = path.resolve(marketFile || path.join(DATA_DIR, 'evaluation.json'));
  const [events, market] = await Promise.all([loadEvents(eventsFile), optionalJson(resolvedMarket)]);
  return buildDashboardState(events, market, { frame, mode: 'live', source: resolvedMarket });
}

function demoRequest(index) {
  const routes = [
    ['implementation', 'openai/gpt-5-mini', 0.0014, 0.0068, 842, 1],
    ['refactor', 'anthropic/claude-sonnet-5', 0.0031, 0.0072, 1260, 1],
    ['debug', 'openai/gpt-5', 0.0069, 0.0074, 1840, 2],
    ['test', 'openai/gpt-5-nano', 0.0004, 0.0048, 390, 1],
    ['analysis', 'openai/gpt-5-mini', 0.0012, 0.0061, 770, 1]
  ];
  const [task, model, actual, baseline, latency, attempts] = routes[index % routes.length];
  return {
    event_type: 'request', timestamp: new Date(Date.UTC(2026, 7, 28, 19, 32, index * 2)).toISOString(),
    session_id: `demo-${Math.floor(index / 5)}`, model, task_class: task,
    actual_cost_usd: actual * (1 + (index % 3) * 0.08), baseline_cost_usd: baseline,
    savings_usd: baseline - actual * (1 + (index % 3) * 0.08),
    latency_ms: latency + (index % 4) * 37, routing_overhead_ms: 4 + (index % 5),
    provider_status: 200, attempts, input_tokens: 1800 + index * 113, output_tokens: 320 + index * 19
  };
}

function demoMarket(frame) {
  const templates = [
    ['KXH100WS-3.000', 'yes', 0.31, 0.22, 0.09],
    ['KXH100WS-3.250', 'no', 0.38, 0.49, 0.08],
    ['KXH100WS-3.500', 'yes', 0.27, 0.17, -0.20],
    ['KXH100WS-3.750', 'yes', 0.19, 0.11, 0.86]
  ];
  const visible = Math.min(templates.length, 1 + Math.floor(frame / 3));
  const results = templates.slice(0, visible).map(([id, side, probability, marketProbability, pnl], index) => ({
    id, date: `2026-08-${24 + index}`, chip: 'H100', threshold: 3 + index * 0.25,
    predicted_price: 3.18 + index * 0.16, outcome_price: 3.22 + index * 0.18,
    probability, market_probability: marketProbability, naive_probability: marketProbability - 0.02,
    outcome: pnl > 0 ? side === 'yes' ? 1 : 0 : side === 'yes' ? 0 : 1,
    side, paper_pnl: pnl, training_rows: 42 + index * 3
  }));
  const paperPnl = results.reduce((sum, row) => sum + row.paper_pnl, 0);
  return {
    observations: 38 + frame, signal_brier: 0.171, market_brier: 0.191, naive_brier: 0.204,
    relative_brier_improvement: 0.105, paper_pnl: paperPnl, trades: results.length,
    gate: frame >= 9 && paperPnl > 0, results
  };
}

export function createDemoState(frame = 0) {
  const count = Math.min(30, 7 + Math.max(0, frame));
  const events = Array.from({ length: count }, (_, index) => demoRequest(index));
  return buildDashboardState(events, demoMarket(frame), { mode: 'demo', frame });
}

export function renderDashboard(state, options = {}) {
  const width = Math.max(68, Math.min(118, Number(options.width || 100)));
  const inner = width - 2;
  const color = options.color !== false;
  const lines = [];
  const horizontal = '─'.repeat(inner);
  const add = (content = '', tone = null) => {
    const fitted = truncate(content, inner - 2).padEnd(inner - 2);
    lines.push(`│ ${tone ? paint(color, tone, fitted) : fitted} │`);
  };
  const rule = (label, tone = 'cyan') => {
    const text = ` ${label} `;
    const remainder = Math.max(0, inner - text.length);
    lines.push(`├${paint(color, tone, text)}${'─'.repeat(remainder)}┤`);
  };

  const report = state.report;
  const paperPnl = Number(state.market?.paper_pnl || 0);
  const pulse = state.frame % 2 ? '◉' : '●';
  lines.push(`╭${horizontal}╮`);
  add(`${pulse} HEDGE ROUTER  //  ${state.mode === 'demo' ? 'DEMO FEED' : 'LIVE'}  //  PAPER EXECUTION`, 'bold');
  add(`REQUESTS ${String(report.requests).padStart(4)}   SAVED ${money(report.savings_usd).padStart(9)}   SAVE RATE ${percent(report.savings_percent).padStart(4)}   PAPER P&L ${money(paperPnl, true).padStart(9)}`, paperPnl >= 0 ? 'green' : 'red');

  const leadModel = state.recent[0]?.model || 'waiting for first request';
  const travel = state.frame % 9;
  add(`REQUEST ${'·'.repeat(travel)}◆${'·'.repeat(8 - travel)}▶ [ AUTO ROUTER ] ─────▶ ${truncate(leadModel, 27)}`, 'cyan');

  rule('LIVE ROUTING');
  if (!state.recent.length) {
    add('Waiting for requests. Point your client at http://127.0.0.1:8787/v1', 'dim');
  } else {
    for (const request of state.recent.slice(0, 5)) {
      const savingRate = request.baseline_cost_usd > 0 ? (request.savings_usd / request.baseline_cost_usd) * 100 : 0;
      const status = request.provider_status >= 400 ? 'ERROR' : request.attempts > 1 ? 'FALLBACK' : 'ROUTED';
      const row = `${clock(request.timestamp)}  ${truncate(String(request.task_class || 'other').toUpperCase(), 12).padEnd(12)}  ${truncate(request.model || 'no route', 26).padEnd(26)}  ${money(request.savings_usd).padStart(8)}  ${percent(savingRate).padStart(4)}  ${String(Math.round(request.latency_ms || 0)).padStart(5)}ms  ${status}`;
      add(row, status === 'ERROR' ? 'red' : status === 'FALLBACK' ? 'yellow' : 'green');
    }
  }

  rule('MODEL FLOW');
  if (!state.modelMix.length) add('No completed routes yet.', 'dim');
  const maximum = Math.max(0, ...state.modelMix.map((row) => row.count));
  for (const row of state.modelMix.slice(0, 4)) {
    add(`${truncate(row.model, 28).padEnd(28)} ${bar(row.count, maximum, 18)} ${percent(row.share * 100).padStart(4)}  ${String(row.count).padStart(4)} req`, 'magenta');
  }

  rule('COMPUTE SIGNAL');
  if (!state.latestSignal) {
    add(`Waiting for ${state.source || '.hedge-router/evaluation.json'}`, 'dim');
  } else {
    const signal = state.latestSignal;
    const edge = (Number(signal.probability) - Number(signal.market_probability)) * 100;
    const gate = state.market?.gate ? 'GATE OPEN' : 'RESEARCHING';
    add(`${signal.chip || 'GPU'} PREDICTED ${money(signal.predicted_price)}   THRESHOLD ${money(signal.threshold)}   FAIR ${percent(signal.probability * 100, 1)}   MARKET ${percent(signal.market_probability * 100, 1)}   EDGE ${edge >= 0 ? '+' : ''}${percent(edge, 1)}   ${gate}`, state.market?.gate ? 'green' : 'yellow');
  }

  rule('KALSHI PAPER HEDGES', 'yellow');
  if (!state.hedges.length) {
    add('PAPER  No qualifying edge after fees and slippage.', 'dim');
  } else {
    for (const hedge of state.hedges.slice(0, 4)) {
      const edge = hedge.side === 'yes'
        ? hedge.probability - hedge.market_probability
        : hedge.market_probability - hedge.probability;
      const row = `PAPER  ${truncate(hedge.id, 25).padEnd(25)}  BUY ${String(hedge.side).toUpperCase().padEnd(3)} @ ${String(Math.round((hedge.side === 'yes' ? hedge.market_probability : 1 - hedge.market_probability) * 100)).padStart(2)}¢   FAIR ${percent((hedge.side === 'yes' ? hedge.probability : 1 - hedge.probability) * 100, 1).padStart(5)}   EDGE +${percent(edge * 100, 1).padStart(5)}   P&L ${money(hedge.paper_pnl, true)}`;
      add(row, hedge.paper_pnl >= 0 ? 'green' : 'red');
    }
  }

  rule('STATUS', 'dim');
  add(`privacy-safe metadata only  •  prompts and code never displayed  •  ${state.mode === 'demo' ? 'simulated data' : 'refreshing live'}  •  press q to quit`, 'dim');
  lines.push(`╰${horizontal}╯`);
  return lines.join('\n');
}

export async function runDashboard(options = {}) {
  const output = options.output || process.stdout;
  const input = options.input || process.stdin;
  const refreshMs = Math.max(100, Number(options.refreshMs || (options.demo ? 500 : 750)));
  const terminal = Boolean(output.isTTY);
  const once = Boolean(options.once || (!terminal && !options.frames));
  const frames = once ? 1 : Number(options.frames || Infinity);
  let frame = 0;
  let stopped = false;
  let raw = false;

  const stop = () => { stopped = true; };
  const onKey = (chunk) => {
    const key = String(chunk);
    if (key === 'q' || key === 'Q' || key === '\u0003') stop();
  };
  if (terminal) {
    output.write('\u001b[?1049h\u001b[?25l');
    if (input.isTTY && typeof input.setRawMode === 'function') {
      input.setRawMode(true);
      raw = true;
      input.resume();
      input.on('data', onKey);
    }
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped && frame < frames) {
      const state = options.demo
        ? createDemoState(frame)
        : await loadDashboardState({ eventsFile: options.eventsFile, marketFile: options.marketFile, frame });
      const view = renderDashboard(state, {
        width: options.width || output.columns || 100,
        color: options.color !== false && (terminal || options.forceColor)
      });
      output.write(terminal ? `\u001b[H\u001b[2J${view}` : `${view}\n`);
      frame += 1;
      if (!stopped && frame < frames) await new Promise((resolve) => setTimeout(resolve, refreshMs));
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (raw) {
      input.off('data', onKey);
      input.setRawMode(false);
      input.pause();
    }
    if (terminal) output.write('\u001b[?25h\u001b[?1049l');
  }
}
