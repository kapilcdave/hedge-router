import path from 'node:path';
import { DEMO_RECORDING } from './demo-data.js';
import { loadEvents, usageReport } from './telemetry.js';
import { DATA_DIR, readJson } from './utils.js';

const ANSI = {
  reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
  cyan: '\u001b[36m', green: '\u001b[32m', yellow: '\u001b[33m',
  red: '\u001b[31m', magenta: '\u001b[35m', white: '\u001b[97m'
};

// Tone is a space-separated list so a cell can be both bold and colored. Chrome (box, rules,
// labels, meter tracks) is dim and data is bright: the hierarchy is carried by weight, not hue.
function paint(enabled, tone, value) {
  if (!enabled || !tone) return value;
  const codes = String(tone).split(' ').map((name) => ANSI[name]).filter(Boolean);
  return codes.length ? `${codes.join('')}${value}${ANSI.reset}` : value;
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

// A gateway that never reports cost or latency is not a gateway reporting zero.
function reported(value, format, width) {
  return (Number(value) > 0 ? format(value) : 'n/a').padStart(width);
}

function percent(value, digits = 0) {
  return `${Number(value || 0).toFixed(digits)}%`;
}

function compactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(Math.round(number));
}

function clock(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(11, 19) : '--:--:--';
}

// A meter is two segments so the track can stay recessive. Zero renders as an empty track rather
// than a one-cell sliver, because a sliver reads as a small value instead of none.
function meter(value, maximum, width, tone = 'cyan') {
  const share = maximum > 0 ? Number(value) / Number(maximum) : 0;
  const filled = share > 0 ? Math.min(width, Math.max(1, Math.round(share * width))) : 0;
  return [['█'.repeat(filled), tone], ['░'.repeat(Math.max(0, width - filled)), 'dim']];
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
  const report = usageReport(events);
  const mix = new Map();
  for (const request of requests) {
    const model = request.model || 'failed request';
    mix.set(model, (mix.get(model) || 0) + 1);
  }
  const modelMix = [...mix.entries()]
    .map(([model, count]) => ({ model, count, share: requests.length ? count / requests.length : 0 }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
  const paper = options.paper || null;
  const results = Array.isArray(market?.results) ? market.results : [];
  const paperOrders = Array.isArray(paper?.orders)
    ? paper.orders.map((order) => ({
      ...order, id: order.market_id, market_probability: order.market_probability,
      paper_pnl: order.realized_pnl ?? 0
    }))
    : [];
  const hedges = (paperOrders.length ? paperOrders : results.filter((row) => row.side && row.side !== 'hold')).slice(-5).reverse();
  const newestPaperTime = paperOrders.reduce((latest, order) => order.placed_at > latest ? order.placed_at : latest, '');
  const latestSignal = paperOrders
    .filter((order) => order.placed_at === newestPaperTime)
    .sort((a, b) => Number(b.net_edge || 0) - Number(a.net_edge || 0))[0] || paperOrders.at(-1) || results.at(-1) || null;
  return {
    mode: options.mode || 'live',
    frame: Number(options.frame || 0),
    report,
    recent: requests.slice(-6).reverse(),
    modelMix,
    market,
    paper,
    hedges,
    latestSignal,
    source: options.source || null
  };
}

export async function loadDashboardState({ eventsFile, marketFile, paperFile, frame = 0 } = {}) {
  const resolvedMarket = path.resolve(marketFile || path.join(DATA_DIR, 'evaluation.json'));
  const resolvedPaper = path.resolve(paperFile || path.join(DATA_DIR, 'paper.json'));
  const [events, market, paper] = await Promise.all([
    loadEvents(eventsFile), optionalJson(resolvedMarket), optionalJson(resolvedPaper)
  ]);
  return buildDashboardState(events, market, { frame, mode: 'live', source: resolvedMarket, paper });
}

// The frame at which the recording has revealed everything it holds. A single-frame render (a pipe,
// a redirect, `--once`) shows this instead of frame 0, where the panels that carry the result are
// still empty and the dashboard reads as broken.
export function demoSettledFrame() {
  return Math.max(DEMO_RECORDING.market.results.length * 3, DEMO_RECORDING.requests.length - 3);
}

// The demo replays DEMO_RECORDING, so its gate, Brier scores, and P&L are whatever the real
// backtest produced. Nothing here can manufacture a pass the research did not earn.
export function createDemoState(frame = 0) {
  const position = Math.max(0, Number(frame) || 0);
  const recording = DEMO_RECORDING;
  const events = recording.requests.slice(0, Math.min(recording.requests.length, 3 + position));
  const revealed = recording.market.results.slice(0, Math.min(recording.market.results.length, Math.floor(position / 3)));
  const market = {
    ...recording.market,
    results: revealed,
    trades: revealed.length,
    paper_pnl: Math.round(revealed.reduce((sum, row) => sum + row.paper_pnl, 0) * 100) / 100
  };
  return buildDashboardState(events, market, { mode: 'demo', frame: position, source: recording.series });
}

// Column specs are declared once and shared by the header row and the data rows, so a width change
// can never leave the two out of alignment.
function columnist(specs) {
  return (values, tones = []) => specs.map((spec, index) => {
    const clipped = truncate(values[index], spec.width);
    const cell = spec.align === 'right' ? clipped.padStart(spec.width) : clipped.padEnd(spec.width);
    return [`${cell}${' '.repeat(spec.gap ?? 2)}`, tones[index] ?? spec.tone ?? null];
  });
}

export function renderDashboard(state, options = {}) {
  const width = Math.max(68, Math.min(118, Number(options.width || 100)));
  const inner = width - 2;
  const room = inner - 2;
  const wide = room >= 84;
  const color = options.color !== false;
  const lines = [];
  const horizontal = '─'.repeat(inner);

  // Body lines take either a string or a list of [text, tone] cells. Padding is measured on the
  // plain text, so color can never change a line's rendered width.
  const add = (body = '', tone = null) => {
    const cells = (Array.isArray(body) ? body : [[body, tone]])
      .map((cell) => (Array.isArray(cell) ? cell : [cell, tone]));
    const painted = [];
    let used = 0;
    for (const [text, cellTone] of cells) {
      if (used >= room) break;
      const fitted = truncate(text, room - used);
      used += fitted.length;
      painted.push(paint(color, cellTone, fitted));
    }
    lines.push(`│ ${painted.join('')}${' '.repeat(Math.max(0, room - used))} │`);
  };
  const rule = (label, meta = '') => {
    const name = truncate(label, Math.max(1, inner - 6));
    const tail = meta && name.length + meta.length + 7 <= inner ? ` ${meta} ─` : '';
    const fill = Math.max(0, inner - name.length - 3 - tail.length);
    lines.push([
      '├', paint(color, 'dim', '─ '), paint(color, 'cyan', name),
      paint(color, 'dim', ` ${'─'.repeat(fill)}`), paint(color, 'dim', tail), '┤'
    ].join(''));
  };
  const kpi = (label, value, tone = 'white bold') => [[label, 'dim'], [value, tone]];
  const dot = [['  ·  ', 'dim']];

  const report = state.report;
  const demo = state.mode === 'demo';
  const paperPnl = Number(state.paper?.realized_pnl ?? state.market?.paper_pnl ?? 0);
  const pulse = state.frame % 2 ? '◉' : '●';
  const tagline = demo ? 'recorded replay' : 'live';
  const title = `${pulse} hedge router`;

  lines.push(`╭${horizontal}╮`);
  add([
    [title, 'bold'],
    [' '.repeat(Math.max(1, room - title.length - tagline.length)), null],
    [tagline, 'dim']
  ]);

  // One KPI row, labels recessive and values bright. Splits in two on a narrow terminal rather
  // than truncating, because paper P&L is the headline and must never be the cell that falls off.
  const cachedShare = report.input_tokens > 0 ? (report.cached_input_tokens / report.input_tokens) * 100 : 0;
  const volume = [
    ...kpi('CALLS ', String(report.requests)), ...dot,
    ...kpi('TOKENS ', compactNumber(report.input_tokens + report.output_tokens)), ...dot,
    ...kpi('CACHED ', percent(cachedShare))
  ];
  const value = [
    ...kpi('COMPUTE SPEND ', reported(report.actual_cost_usd, money, 0)), ...dot,
    ...kpi('PAPER P&L ', money(paperPnl, true), paperPnl > 0 ? 'green bold' : paperPnl < 0 ? 'red bold' : 'white bold')
  ];
  if (wide) add([...volume, ...dot, ...value]);
  else { add(volume); add(value); }
  add([
    ['MEDIAN LATENCY ', 'dim'], [reported(report.median_latency_ms, (ms) => `${Math.round(ms)}ms`, 0), 'dim'],
    ['   ERRORS ', 'dim'], [percent(report.error_rate * 100, 1), report.error_rate > 0 ? 'red' : 'dim'],
    ['   FAILOVER ', 'dim'], [percent(report.fallback_rate * 100, 1), report.fallback_rate > 0 ? 'yellow' : 'dim'],
    ['   SESSIONS ', 'dim'], [String(report.sessions), 'dim']
  ]);

  const lead = state.recent[0];
  const travel = state.frame % 9;
  const leadSource = lead?.source || lead?.gateway || 'gateway';
  add([
    ['TELEMETRY  ', 'dim'],
    [`${'·'.repeat(travel)}◆${'·'.repeat(8 - travel)}▶ `, 'cyan'],
    [truncate(leadSource.toUpperCase(), 16), 'dim'],
    [' ───▶ ', 'dim'],
    [truncate(lead?.model || 'waiting for first request', 30), 'cyan']
  ]);

  const gatewayColumns = wide
    ? [
      { width: 8 }, { width: 13 }, { width: 24 }, { width: 9, align: 'right' },
      { width: 8, align: 'right' }, { width: 8, align: 'right' }, { width: 8, gap: 0 }
    ]
    : [{ width: 8 }, { width: 24 }, { width: 8, align: 'right' }, { width: 8, gap: 0 }];
  const gatewayRow = columnist(gatewayColumns);
  const gatewayHeader = wide
    ? ['TIME', 'SOURCE', 'MODEL', 'TOKENS', 'COST', 'LATENCY', 'STATUS']
    : ['TIME', 'MODEL', 'TOKENS', 'STATUS'];

  rule(demo ? 'RECORDED GATEWAY DATA' : 'LIVE GATEWAY DATA', `${report.requests} requests`);
  if (!state.recent.length) {
    add('Waiting for metadata. Run hedge-router ingest against a gateway export.', 'dim');
  } else {
    add(gatewayRow(gatewayHeader).map(([text]) => [text, 'dim']));
    for (const request of state.recent.slice(0, 5)) {
      const status = request.provider_status >= 400 ? 'ERROR' : request.attempts > 1 ? 'FAILOVER' : 'OBSERVED';
      // Only the exceptions spend a color. A screen where every row is green cannot show a failure.
      const tone = status === 'ERROR' ? 'red' : status === 'FAILOVER' ? 'yellow' : 'dim';
      const tokens = compactNumber(Number(request.input_tokens || 0) + Number(request.output_tokens || 0));
      const cost = reported(request.actual_cost_usd, money, 0);
      const latency = reported(request.latency_ms, (ms) => `${Math.round(ms)}ms`, 0);
      const model = truncate(request.model || 'unknown', 24);
      const cells = wide
        ? [clock(request.timestamp), request.source || request.gateway || 'unknown', model, tokens, cost, latency, status]
        : [clock(request.timestamp), model, tokens, status];
      const tones = wide
        ? ['dim', 'dim', 'white', 'cyan', null, null, tone]
        : ['dim', 'white', 'cyan', tone];
      add(gatewayRow(cells, tones));
    }
  }

  rule('MODEL EXPOSURE');
  if (!state.modelMix.length) add('No model calls ingested yet.', 'dim');
  const maximum = Math.max(0, ...state.modelMix.map((row) => row.count));
  const meterWidth = wide ? 24 : 14;
  for (const row of state.modelMix.slice(0, 4)) {
    // One accent for every model: hue is reserved for status, and the label already carries identity.
    add([
      [truncate(row.model, 30).padEnd(30), 'white'],
      ...meter(row.count, maximum, meterWidth),
      [`  ${percent(row.share * 100).padStart(4)}`, 'cyan'],
      [`  ${String(row.count).padStart(4)} req`, 'dim']
    ]);
  }

  rule('COMPUTE SIGNAL', demo ? `${state.source} · lead ${DEMO_RECORDING.lead_days}d` : '');
  if (!state.latestSignal) {
    add(state.paper
      ? 'No trained signal yet. Collect aligned gateway aggregates before opening paper orders.'
      : `Waiting for ${state.source || '.hedge-router/evaluation.json'}`, 'dim');
  } else {
    const signal = state.latestSignal;
    const open = Boolean(state.market?.gate);
    // Edge is signed from the side actually taken, net of costs where the evaluator recorded them.
    // The raw yes-minus-market difference reads as a loss on every profitable NO.
    const edge = Number.isFinite(Number(signal.net_edge ?? signal.edge))
      ? Number(signal.net_edge ?? signal.edge)
      : signal.side === 'no'
        ? Number(signal.market_probability) - Number(signal.probability)
        : Number(signal.probability) - Number(signal.market_probability);
    const taken = signal.side && signal.side !== 'hold' ? `BUY ${String(signal.side).toUpperCase()}` : 'NO TRADE';
    add([
      [`${signal.chip || 'GPU'} FORECAST `, 'dim'], [money(signal.predicted_price), 'white bold'],
      ['   THRESHOLD ', 'dim'], [money(signal.threshold), 'white'],
      ['   ', null], [taken, 'yellow'],
      [signal.entry_price == null ? '' : ` @ ${Math.round(signal.entry_price * 100)}¢`, 'yellow']
    ]);
    // Two aligned bars on one axis: the whole decision is the gap between them.
    const label = `P(≥ ${money(signal.threshold)})`;
    add([
      [`  MODEL   ${label.padEnd(14)}`, 'dim'], ...meter(signal.probability, 1, meterWidth),
      [`  ${percent(Number(signal.probability) * 100, 1).padStart(6)}`, 'cyan']
    ]);
    add([
      [`  MARKET  ${label.padEnd(14)}`, 'dim'], ...meter(signal.market_probability, 1, meterWidth, 'white'),
      [`  ${percent(Number(signal.market_probability) * 100, 1).padStart(6)}`, 'white']
    ]);
    add([
      ['  NET EDGE ', 'dim'], [`${edge >= 0 ? '+' : ''}${percent(edge * 100, 1)}`, edge >= 0 ? 'green' : 'red'],
      ['  after fees and slippage  ·  ', 'dim'], [open ? 'GATE OPEN' : 'RESEARCHING', open ? 'green bold' : 'yellow']
    ]);
  }

  // A backtest row has no position size, so the column only exists when something fills it. A
  // column of em-dashes spends width to say nothing.
  const sized = state.hedges.some((hedge) => hedge.contracts);
  const hedgeColumns = [
    { width: 5 }, { width: wide ? 30 : 24, gap: wide ? 2 : 1 }, { width: 7, gap: 1 },
    ...(sized ? [{ width: 4, gap: 1 }] : []),
    { width: 5, align: 'right', gap: wide ? 2 : 1 },
    ...(wide ? [{ width: 6, align: 'right' }, { width: 8, align: 'right' }] : []),
    { width: 9, align: 'right', gap: 0 }
  ];
  const hedgeRow = columnist(hedgeColumns);
  const hedgeHeader = [
    '', 'MARKET', 'SIDE', ...(sized ? ['SIZE'] : []), 'ENTRY',
    ...(wide ? ['FAIR', 'NET EDGE'] : []), 'P&L'
  ];

  rule('KALSHI PAPER HEDGES', state.market ? `${state.market.trades ?? state.hedges.length} settled` : '');
  if (!state.hedges.length) {
    add('PAPER  No qualifying edge after fees and slippage.', 'dim');
  } else {
    add(hedgeRow(hedgeHeader).map(([text]) => [text, 'dim']));
    for (const hedge of state.hedges.slice(0, 4)) {
      const status = hedge.order_id ? String(hedge.status || 'open').toUpperCase() : 'SETTLED';
      const settled = status !== 'OPEN';
      // Show what the trade actually cost: the recorded ask and the edge after fees and slippage.
      // A midpoint-derived price flatters every entry by half the spread.
      const rawEdge = hedge.side === 'yes'
        ? hedge.probability - hedge.market_probability
        : hedge.market_probability - hedge.probability;
      const entry = Number.isFinite(Number(hedge.entry_price))
        ? Number(hedge.entry_price)
        : hedge.side === 'yes' ? hedge.market_probability : 1 - hedge.market_probability;
      const edge = Number.isFinite(Number(hedge.net_edge ?? hedge.edge)) ? Number(hedge.net_edge ?? hedge.edge) : rawEdge;
      const fair = (hedge.side === 'yes' ? hedge.probability : 1 - hedge.probability) * 100;
      const pnl = settled ? money(hedge.paper_pnl, true) : status;
      const tone = !settled ? 'yellow' : hedge.paper_pnl >= 0 ? 'green' : 'red';
      const cells = [
        'PAPER', hedge.id, `BUY ${String(hedge.side).toUpperCase()}`,
        ...(sized ? [hedge.contracts ? `x${hedge.contracts}` : '—'] : []),
        `${Math.round(entry * 100)}¢`,
        ...(wide ? [percent(fair, 1), `${edge >= 0 ? '+' : ''}${percent(edge * 100, 1)}`] : []),
        pnl
      ];
      const tones = [
        'dim', 'white', 'white', ...(sized ? ['dim'] : []), 'white',
        ...(wide ? ['cyan', edge >= 0 ? 'cyan' : 'red'] : []), tone
      ];
      add(hedgeRow(cells, tones));
    }
  }

  rule('STATUS');
  if (demo) {
    // The demo's job is to show the pipeline, not to imply a result. Lead with the shortfall.
    const [from, to] = DEMO_RECORDING.settlement_window;
    const events = DEMO_RECORDING.market.independent_events;
    add([
      ['RECORDED REPLAY  ', 'yellow'], ...meter(events, 30, 12, 'yellow'),
      [`  ${events}/30 events`, 'yellow'],
      [`  ·  ${from}→${to}  ·  no measured edge yet`, 'dim']
    ]);
  }
  add(`metadata only · no prompts or code · ${demo ? 'no live orders, ever' : 'refreshing live'} · q to quit`, 'dim');
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
        ? createDemoState(once ? demoSettledFrame() : frame)
        : await loadDashboardState({ eventsFile: options.eventsFile, marketFile: options.marketFile, paperFile: options.paperFile, frame });
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
