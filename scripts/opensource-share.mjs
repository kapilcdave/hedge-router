#!/usr/bin/env node
// Measure the listed open-weights-share market and recover its settlement
// variable from settled strikes.
//
// The settlement source (a vendor chart) publishes no API and no archive, so the
// only reproducible history of the index is the one the exchange's own
// resolutions imply: for a `greater` ladder, a YES at strike k means the print
// was above k, a NO means it was not. The highest YES and the lowest NO bracket
// the print.
//
//   node scripts/opensource-share.mjs [--series KXOPENSOURCESHARE] [--output FILE]

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

function parseArgs(argv) {
  const args = { series: 'KXOPENSOURCESHARE', output: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--series') args.series = argv[i + 1];
    if (argv[i] === '--output') args.output = argv[i + 1];
  }
  return args;
}

async function getJson(path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${url.pathname}`);
  return response.json();
}

// Kalshi returns sizes, volumes and open interest as fixed-point strings under
// `*_fp` names on this endpoint. Reading the older `volume`/`liquidity` keys
// yields undefined, which is not zero.
function fp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function listMarkets(series) {
  const markets = [];
  for (const status of ['open', 'settled']) {
    let cursor;
    do {
      const page = await getJson('/markets', { series_ticker: series, status, limit: 200, cursor });
      markets.push(...(page.markets ?? []));
      cursor = page.cursor || undefined;
    } while (cursor);
  }
  return markets;
}

function byCloseDate(markets) {
  const days = new Map();
  for (const market of markets) {
    const day = (market.close_time ?? '').slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(market);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// A `greater` ladder resolves YES when the print exceeds the strike, so the
// print sits in (max YES strike, min NO strike]. An all-YES or all-NO day means
// the ladder was listed off the print and brackets nothing on that side.
function bracket(markets) {
  const settled = markets.filter((m) => m.result === 'yes' || m.result === 'no');
  if (settled.length === 0) return null;
  const yes = settled.filter((m) => m.result === 'yes').map((m) => fp(m.floor_strike));
  const no = settled.filter((m) => m.result === 'no').map((m) => fp(m.floor_strike));
  return {
    strikes: settled.length,
    lower: yes.length ? Math.max(...yes) : null,
    upper: no.length ? Math.min(...no) : null,
    uncentred: yes.length === 0 || no.length === 0,
  };
}

const args = parseArgs(process.argv.slice(2));
const markets = await listMarkets(args.series);
if (markets.length === 0) {
  console.log(`${args.series}: no markets listed (series shell, or delisted)`);
  process.exit(0);
}

const total = (key) => markets.reduce((sum, m) => sum + (fp(m[key]) ?? 0), 0);
const traded = markets.filter((m) => (fp(m.volume_fp) ?? 0) > 0).length;

console.log(`${args.series}  ${markets.length} markets`);
console.log(`  lifetime volume   ${total('volume_fp').toLocaleString()} contracts`);
console.log(`  open interest     ${total('open_interest_fp').toLocaleString()} contracts`);
console.log(`  traded at all     ${traded} of ${markets.length}`);
console.log(`  settlement source ${(markets[0].rules_secondary ?? '').split('\n')[0]}`);

const series = [];
console.log('\nclose_date   mkts   volume  strikes  implied share');
for (const [day, dayMarkets] of byCloseDate(markets)) {
  const volume = dayMarkets.reduce((sum, m) => sum + (fp(m.volume_fp) ?? 0), 0);
  const b = bracket(dayMarkets);
  let implied = 'unsettled';
  if (b && b.uncentred) {
    implied = b.lower !== null ? `> ${b.lower}% (ladder low)` : `<= ${b.upper}% (ladder high)`;
  } else if (b) {
    implied = `(${b.lower}%, ${b.upper}%]`;
  }
  if (b) series.push({ date: day, ...b });
  console.log(
    `${day}  ${String(dayMarkets.length).padStart(4)} ${volume.toLocaleString().padStart(8)}` +
      `  ${String(b?.strikes ?? 0).padStart(7)}  ${implied}`,
  );
}

if (args.output) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(args.output, `${JSON.stringify({ series: args.series, recovered: series }, null, 1)}\n`);
  console.log(`\nwrote ${args.output}`);
}
