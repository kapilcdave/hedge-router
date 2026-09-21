#!/usr/bin/env node
// Reproduce the settlement variable of Kalshi's model-author market-share family
// from a free public endpoint, and score the reproduction against settled prints.
//
// The rule names "OpenRouter text market share by model author". There are two
// public datasets behind that phrase and they disagree by more than any strike
// increment in the ladder:
//
//   /api/frontend/v1/rankings/market-share  weekly TOKEN volume per author,
//                                           53 archived weekly buckets, top-10
//                                           plus an `others` bucket
//   /api/frontend/v1/rankings/models        per-model totals for ONE trailing
//                                           week, carrying a request `count`
//
// Token share does not reproduce the prints; request share does. Ranking authors
// by tokens and by requests is not even the same ordering — for the week ending
// 2026-09-20, Google is 5.4% of tokens and 18.8% of requests, Tencent 13.4% and
// 6.5%. Kalshi settled Google at 18.6 and Tencent at 6.4.
//
//   node scripts/author-share.mjs [--series KXGOOGSHARE,...] [--output FILE]

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const OPENROUTER = 'https://openrouter.ai/api/frontend/v1/rankings';

const DEFAULT_SERIES = [
  'KXOPENSHARE',
  'KXDEEPSHARE',
  'KXGOOGSHARE',
  'KXTENCENTSHARE',
  'KXANTHSHARE',
  'KXZAISHARE',
  'KXSTEALTHSHARE',
];

// The series ticker names a company; the dataset keys on an author *namespace*,
// which is not the same thing. Meta ships under both `meta-llama` and `meta`,
// both live in the current window, and the weekly chart has never displayed the
// two in the same bucket.
const AUTHOR = {
  KXOPENSHARE: 'openai',
  KXDEEPSHARE: 'deepseek',
  KXGOOGSHARE: 'google',
  KXTENCENTSHARE: 'tencent',
  KXANTHSHARE: 'anthropic',
  KXZAISHARE: 'z-ai',
  KXSTEALTHSHARE: 'stealth',
  KXMETASHARE: 'meta',
  KXQWENSHARE: 'qwen',
  KXMISTRALSHARE: 'mistralai',
  KXMOONSHOTSHARE: 'moonshotai',
};

function parseArgs(argv) {
  const args = { series: DEFAULT_SERIES, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--series') args.series = String(argv[i + 1]).split(',');
    if (argv[i] === '--output') args.output = argv[i + 1];
  }
  return args;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${new URL(url).pathname}`);
  return response.json();
}

// Kalshi returns volumes as fixed-point strings under `*_fp`; the older
// `volume` key is undefined here, which is not zero.
const fp = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

async function listMarkets(series) {
  const markets = [];
  let cursor;
  do {
    const url = new URL(`${KALSHI}/markets`);
    url.searchParams.set('series_ticker', series);
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await getJson(url);
    markets.push(...(page.markets ?? []));
    cursor = page.cursor || undefined;
  } while (cursor);
  return markets;
}

// `expiration_value` carries the printed number on most events and the literal
// string "No" on others, so it is a display field rather than a data field. Two
// of the four all-NO events carry a number and are plainly ladders listed above
// the print; of the two carrying "No", one is provably the same thing (OpenAI at
// 17.20% of requests against a lowest strike of 18) and the other cannot be
// separated from an `others` void. Reading "No" as a void is therefore wrong at
// least half the time.
function settledPrints(markets, series) {
  const events = new Map();
  for (const market of markets) {
    if (market.status !== 'finalized') continue;
    if (!events.has(market.event_ticker)) events.set(market.event_ticker, []);
    events.get(market.event_ticker).push(market);
  }
  const prints = [];
  for (const [event, group] of events) {
    const value = Number(String(group[0].expiration_value ?? '').replace('%', '').trim());
    const strikes = group.map((m) => fp(m.floor_strike)).filter((s) => s !== null);
    prints.push({
      series,
      author: AUTHOR[series] ?? null,
      event,
      close: String(group[0].close_time ?? '').slice(0, 10),
      // The rule text names a week in prose. It is not reliable: 11 of 31
      // finalized events name a day that is not a Monday, so it is not a bucket
      // label in the source chart, and they settled to a number anyway.
      ruleWeek: (group[0].rules_primary ?? '').match(/week of ([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1] ?? null,
      print: Number.isFinite(value) ? value : null,
      expirationValue: String(group[0].expiration_value ?? ''),
      markets: group.length,
      lowestStrike: strikes.length ? Math.min(...strikes) : null,
      highestStrike: strikes.length ? Math.max(...strikes) : null,
      allNo: group.every((m) => m.result === 'no'),
      volume: group.reduce((sum, m) => sum + (fp(m.volume_fp) ?? 0), 0),
    });
  }
  return prints;
}

// Only rows that produced completion tokens are text generation. The payload
// also carries embedding, rerank, speech and video models with every media
// counter zero-filled, so filtering on those counters removes nothing — 6.3% of
// all requests in the current window are non-generation and would otherwise sit
// in the denominator.
function authorShares(rows, { topN = 15 } = {}) {
  const totals = new Map();
  for (const row of rows) {
    if (!(row.total_completion_tokens > 0)) continue;
    const author = String(row.model_permaslug).split('/')[0];
    totals.set(author, (totals.get(author) ?? 0) + row.count);
  }
  let ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  if (topN) ranked = ranked.slice(0, topN);
  const sum = ranked.reduce((acc, [, v]) => acc + v, 0);
  return new Map(ranked.map(([author, v]) => [author, (100 * v) / sum]));
}

function tokenShares(weekly, week) {
  const point = weekly.find((p) => p.x === week);
  if (!point) return null;
  const sum = Object.values(point.ys).reduce((a, b) => a + b, 0);
  return new Map(Object.entries(point.ys).map(([author, v]) => [author, (100 * v) / sum]));
}

const args = parseArgs(process.argv.slice(2));

const models = (await getJson(`${OPENROUTER}/models`)).data;
const weekly = (await getJson(`${OPENROUTER}/market-share`)).data;

// The per-model payload is a single trailing window stamped at its end date, not
// a panel: the dominant date holds nearly every row, and its token total matches
// the weekly chart's bucket to within a percent. There is no archive — a print
// can be checked on settlement day and never again.
const dates = new Map();
for (const row of models) {
  const day = String(row.date).slice(0, 10);
  dates.set(day, (dates.get(day) ?? 0) + 1);
}
const [windowEnd, windowRows] = [...dates.entries()].sort((a, b) => b[1] - a[1])[0];
const current = models.filter((row) => String(row.date).slice(0, 10) === windowEnd);
const windowTokens = current.reduce((s, r) => s + r.total_prompt_tokens + r.total_completion_tokens, 0);
const latestWeeklyTokens = Object.values(weekly.at(-2).ys).reduce((a, b) => a + b, 0);

console.log(`OpenRouter per-model window   ${windowEnd}  ${windowRows} of ${models.length} rows`);
console.log(`  window tokens               ${(windowTokens / 1e12).toFixed(2)}T`);
console.log(`  weekly bucket ${weekly.at(-2).x}     ${(latestWeeklyTokens / 1e12).toFixed(2)}T` +
  `  ratio ${(windowTokens / latestWeeklyTokens).toFixed(3)}  -> the window is a week, not a day`);
console.log(`  newest weekly bucket        ${weekly.at(-1).x}  ` +
  `${(Object.values(weekly.at(-1).ys).reduce((a, b) => a + b, 0) / 1e12).toFixed(2)}T  -> partial, still accruing`);
console.log(`  archived weekly buckets     ${weekly.length}  ${weekly[0].x} -> ${weekly.at(-1).x}`);

const requests = authorShares(current, { topN: 15 });
const tokens = tokenShares(weekly, weekly.at(-2).x);

console.log(`\nauthor shares for the trailing week ending ${windowEnd}`);
console.log('author          requests%   tokens%');
for (const [author, share] of requests) {
  const tokenShare = tokens.get(author);
  console.log(
    `${author.padEnd(15)} ${share.toFixed(2).padStart(8)}  ${(tokenShare === undefined ? 'in others' : tokenShare.toFixed(2)).padStart(9)}`,
  );
}

const prints = [];
for (const series of args.series) {
  const markets = await listMarkets(series);
  if (markets.length === 0) continue;
  prints.push(...settledPrints(markets, series));
}
prints.sort((a, b) => a.close.localeCompare(b.close) || a.series.localeCompare(b.series));

console.log(`\n${prints.length} finalized events across ${args.series.length} series`);
console.log('event                      mkts    volume  rule names week of  settled  requests%  tokens%');
const scored = [];
for (const print of prints) {
  // Only the events whose week is the one trailing window the endpoint serves
  // can be scored. Every earlier event is unverifiable from public data.
  const measurable = print.close === windowEndCloseFor(print, windowEnd);
  const requestShare = measurable ? requests.get(print.author) : undefined;
  const tokenShare = measurable ? tokens.get(print.author) : undefined;
  if (measurable && print.print !== null && requestShare !== undefined) {
    scored.push({ ...print, requestShare, tokenShare });
  }
  console.log(
    `${print.event.padEnd(26)} ${String(print.markets).padStart(4)} ${print.volume.toLocaleString().padStart(9)}` +
      `  ${String(print.ruleWeek ?? 'n/a').padEnd(16)} ${String(print.print ?? print.expirationValue).padStart(7)}` +
      `  ${(requestShare === undefined ? '—' : requestShare.toFixed(2)).padStart(9)}` +
      `  ${(tokenShare === undefined ? '—' : tokenShare.toFixed(2)).padStart(7)}`,
  );
}

// The close date of the event whose settlement week is the served window: the
// window ends on a Sunday and the ladder closes the next day.
function windowEndCloseFor(print, end) {
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

if (scored.length) {
  const mae = (key) =>
    scored.reduce((sum, s) => sum + Math.abs((s[key] ?? 0) - s.print), 0) / scored.length;
  console.log(`\nreproduction on the ${scored.length} scorable prints (week ending ${windowEnd}):`);
  console.log(`  request share   mean |error| ${mae('requestShare').toFixed(3)} share points`);
  console.log(`  token share     mean |error| ${mae('tokenShare').toFixed(3)} share points`);
  console.log('  -> the settlement variable is requests, not token volume');
}

const unscorable = prints.filter((p) => p.print !== null).length - scored.length;
console.log(
  `\n${unscorable} settled prints cannot be checked against any public data: the per-model endpoint ` +
    'serves one trailing window and keeps no archive.',
);

const laddersOffPrint = prints.filter((p) => p.allNo);
if (laddersOffPrint.length) {
  console.log('\nall-NO events (a numeric expiration_value means the ladder was listed off the print):');
  for (const p of laddersOffPrint) {
    console.log(
      `  ${p.event.padEnd(26)} strikes ${p.lowestStrike}–${p.highestStrike}  ` +
        `expiration_value ${JSON.stringify(p.expirationValue)}`,
    );
  }
}

if (args.output) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    args.output,
    `${JSON.stringify({ windowEnd, requests: [...requests], prints, scored }, null, 1)}\n`,
  );
  console.log(`\nwrote ${args.output}`);
}
