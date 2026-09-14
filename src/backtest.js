import { fetchKalshiMarkets, KALSHI_API_BASE_URL } from './kalshi.js';
import { evaluateMarkets, kalshiFee, parseSettlementValue, settlementOutcome, strikeFor } from './market.js';
import { clamp } from './utils.js';

const DAY_SECONDS = 86_400;

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchKalshiCandlesticks({
  series, ticker, startTs, endTs, periodInterval = 1440,
  baseUrl = KALSHI_API_BASE_URL, fetchImpl = fetch, retries = 5, retryDelayMs = 1000
}) {
  if (!series || !ticker) throw new Error('series and ticker are required');
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks`);
  url.searchParams.set('start_ts', String(Math.floor(startTs)));
  url.searchParams.set('end_ts', String(Math.floor(endTs)));
  url.searchParams.set('period_interval', String(periodInterval));
  let response;
  for (let attempt = 0; ; attempt += 1) {
    response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (response.ok || !RETRY_STATUS.has(response.status) || attempt >= retries) break;
    await sleep(retryDelayMs * 2 ** attempt);
  }
  if (!response.ok) throw new Error(`Kalshi API returned HTTP ${response.status} for ${ticker} candlesticks`);
  const payload = await response.json();
  if (!Array.isArray(payload.candlesticks)) throw new Error(`Kalshi candlestick response for ${ticker} is malformed`);
  return payload.candlesticks;
}

export function decisionCandle(candles, decisionTs) {
  const eligible = candles
    .filter((candle) => Number.isFinite(Number(candle.end_period_ts)) && Number(candle.end_period_ts) <= decisionTs)
    .sort((a, b) => Number(a.end_period_ts) - Number(b.end_period_ts));
  return eligible.at(-1) || null;
}

function closeDollars(leg) {
  const value = Number(leg?.close_dollars);
  return Number.isFinite(value) ? value : null;
}

export function historicalSnapshot({ market, candles, chip, leadDays, feeRate = 0.07, feePerContract = null, slippage = 0 }) {
  if (market.market_type && market.market_type !== 'binary') throw new Error('not a binary market');
  const { strikeDirection, threshold } = strikeFor(market);
  const closeTime = market.close_time || market.expiration_time;
  const closeTs = Date.parse(closeTime) / 1000;
  if (!Number.isFinite(closeTs)) throw new Error('missing close time');
  if (settlementOutcome({ result: market.result, outcomePrice: market.expiration_value, strikeDirection }, threshold) == null) {
    throw new Error('no usable settlement');
  }

  const decisionTs = closeTs - leadDays * DAY_SECONDS;
  const candle = decisionCandle(candles, decisionTs);
  if (!candle) throw new Error(`no quote at or before ${leadDays}d before close`);
  const yesBid = closeDollars(candle.yes_bid);
  const yesAsk = closeDollars(candle.yes_ask);
  if (yesBid == null || yesAsk == null) throw new Error('candle has no quote');
  if (!(yesAsk > 0 && yesAsk < 1) || !(yesBid > 0 && yesBid < 1)) throw new Error('quote is not two-sided executable');
  if (yesBid > yesAsk) throw new Error('crossed quote');

  const observedAt = new Date(Number(candle.end_period_ts) * 1000).toISOString();
  if (Date.parse(observedAt) >= Date.parse(closeTime)) throw new Error('quote is not pre-settlement');

  return {
    id: market.ticker,
    eventTicker: market.event_ticker,
    date: closeTime.slice(0, 10),
    chip,
    threshold,
    strikeDirection,
    yesPrice: Math.round(clamp((yesBid + yesAsk) / 2, 0.01, 0.99) * 10_000) / 10_000,
    yesBid,
    yesAsk,
    noBid: Math.round((1 - yesAsk) * 10_000) / 10_000,
    noAsk: Math.round((1 - yesBid) * 10_000) / 10_000,
    feePerContract: feePerContract == null ? null : Number(feePerContract),
    feeRate: Number(feeRate),
    slippage: Number(slippage),
    observedAt,
    closeTime,
    outcomePrice: parseSettlementValue(market.expiration_value),
    result: market.result,
    settlementTime: market.settlement_ts,
    volumeAtDecision: Number(candle.volume_fp || 0),
    openInterestAtDecision: Number(candle.open_interest_fp || 0),
    leadDays,
    source: 'kalshi-candlestick-backtest'
  };
}

export async function loadSeriesHistory({
  series, status = 'settled', periodInterval = 1440, concurrency = 2, pauseMs = 250,
  baseUrl = KALSHI_API_BASE_URL, fetchImpl = fetch
}) {
  const markets = await fetchKalshiMarkets({ series, status, baseUrl, fetchImpl });
  const history = [];
  for (let start = 0; start < markets.length; start += concurrency) {
    const batch = markets.slice(start, start + concurrency);
    const loaded = await Promise.all(batch.map(async (market) => {
      const openTs = Date.parse(market.open_time || market.created_time) / 1000;
      const closeTs = Date.parse(market.close_time || market.expiration_time) / 1000;
      if (!Number.isFinite(openTs) || !Number.isFinite(closeTs)) return { market, candles: [] };
      const candles = await fetchKalshiCandlesticks({
        series, ticker: market.ticker, startTs: openTs, endTs: closeTs, periodInterval, baseUrl, fetchImpl
      });
      return { market, candles };
    }));
    history.push(...loaded);
    if (start + concurrency < markets.length && pauseMs > 0) await sleep(pauseMs);
  }
  return history;
}

export function snapshotsForLead(history, options) {
  const markets = [];
  const skipped = [];
  for (const entry of history) {
    try { markets.push(historicalSnapshot({ ...options, market: entry.market, candles: entry.candles })); }
    catch (error) { skipped.push({ ticker: entry.market.ticker, reason: error.message }); }
  }
  return { markets, skipped };
}

function entryFor(market, side) {
  const price = side === 'yes' ? Number(market.yesAsk) : Number(market.noAsk);
  const fee = market.feePerContract != null
    ? Number(market.feePerContract)
    : kalshiFee(1, price, Number(market.feeRate ?? 0.07));
  return { price, cost: price + fee + Number(market.slippage || 0) };
}

export function strategyPnl(markets, chooseSide, label) {
  let pnl = 0;
  let trades = 0;
  let wins = 0;
  for (const market of markets) {
    const side = chooseSide(market);
    if (side !== 'yes' && side !== 'no') continue;
    const outcome = settlementOutcome(market, market.threshold);
    if (outcome == null) continue;
    const { cost } = entryFor(market, side);
    const payout = side === 'yes' ? outcome : 1 - outcome;
    pnl += payout - cost;
    trades += 1;
    wins += payout;
  }
  return {
    strategy: label, trades,
    pnl: Math.round(pnl * 10_000) / 10_000,
    pnl_per_trade: trades ? Math.round((pnl / trades) * 10_000) / 10_000 : 0,
    hit_rate: trades ? Math.round((wins / trades) * 1000) / 1000 : 0
  };
}

export function baselineStrategies(markets) {
  return [
    strategyPnl(markets, () => 'yes', 'always-yes'),
    strategyPnl(markets, () => 'no', 'always-no'),
    strategyPnl(markets, (market) => Number(market.yesAsk) <= Number(market.noAsk) ? 'yes' : 'no', 'cheaper-side'),
    strategyPnl(markets, (market) => Number(market.yesPrice) >= 0.5 ? 'yes' : 'no', 'market-favorite')
  ];
}

export function perEventPnl(results) {
  const events = new Map();
  for (const row of results) {
    if (row.side === 'hold') continue;
    const key = row.event_ticker || `${row.chip}:${row.date}`;
    const current = events.get(key) || { event: key, date: row.date, trades: 0, pnl: 0 };
    current.trades += 1;
    current.pnl = Math.round((current.pnl + row.paper_pnl) * 10_000) / 10_000;
    events.set(key, current);
  }
  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export const VARIANTS = [
  { name: 'demand-signal', requireSignal: true, note: 'trades only when gateway demand features have trained' },
  { name: 'index-persistence', requireSignal: false, note: 'trades on last observed index alone; no demand features' }
];

function variantSummary({ name, note, evaluation }) {
  const events = perEventPnl(evaluation.results);
  return {
    variant: name,
    note,
    trades: evaluation.trades,
    paper_pnl: round(evaluation.paper_pnl),
    paper_pnl_per_trade: evaluation.trades ? round(evaluation.paper_pnl / evaluation.trades) : 0,
    events_traded: events.length,
    winning_events: events.filter((row) => row.pnl > 0).length,
    per_event: events,
    gate: evaluation.gate
  };
}

export function backtestForLead({ history, index, aggregates, leadDays, chip, feeRate, feePerContract, slippage, minimumTraining, edge }) {
  const { markets, skipped } = snapshotsForLead(history, { chip, leadDays, feeRate, feePerContract, slippage });
  if (!markets.length) {
    return { lead_days: leadDays, tradable_markets: 0, skipped: skipped.length, skipped_reasons: countReasons(skipped), variants: [] };
  }
  const evaluations = VARIANTS.map((variant) => ({
    ...variant,
    evaluation: evaluateMarkets({ index, markets, aggregates, minimumTraining, edge, requireSignal: variant.requireSignal })
  }));
  // Both variants share one forecast; requireSignal only gates trading. So the calibration
  // numbers belong to the lead, and only the trading columns differ per variant.
  const reference = evaluations[0].evaluation;
  return {
    lead_days: leadDays,
    tradable_markets: markets.length,
    skipped: skipped.length,
    skipped_reasons: countReasons(skipped),
    observations: reference.observations,
    independent_events: reference.independent_events,
    signal_ready_markets: reference.results.filter((row) => row.signal_ready).length,
    signal_brier: round(reference.signal_brier),
    market_brier: round(reference.market_brier),
    naive_brier: round(reference.naive_brier),
    relative_brier_improvement: round(reference.relative_brier_improvement),
    demand_brier_lift: round(reference.naive_brier - reference.signal_brier),
    variants: evaluations.map(variantSummary),
    baselines: baselineStrategies(markets)
  };
}

function countReasons(skipped) {
  const counts = {};
  for (const row of skipped) counts[row.reason] = (counts[row.reason] || 0) + 1;
  return counts;
}

function round(value) {
  return Math.round(Number(value || 0) * 10_000) / 10_000;
}

export async function runBacktest({
  series, chip, index, aggregates = [], leadDays = [7],
  feeRate = 0.07, feePerContract = null, slippage = 0.01,
  minimumTraining = 5, edge = 0.05, history = null,
  baseUrl = KALSHI_API_BASE_URL, fetchImpl = fetch
}) {
  if (!series || !chip) throw new Error('series and chip are required');
  if (!Array.isArray(index) || !index.length) throw new Error('a non-empty index history is required');
  const loaded = history || await loadSeriesHistory({ series, baseUrl, fetchImpl });
  const settledMarkets = loaded.length;
  const leads = leadDays.map((lead) => backtestForLead({
    history: loaded, index, aggregates, leadDays: lead, chip,
    feeRate, feePerContract, slippage, minimumTraining, edge
  }));
  const indexDates = index.map((row) => row.date).sort();
  const aggregateDates = aggregates.map((row) => row.date).sort();
  return {
    generated_at: new Date().toISOString(),
    paper_only: true,
    series,
    chip,
    settled_markets: settledMarkets,
    settlement_events: new Set(loaded.map((entry) => entry.market.event_ticker)).size,
    index_days: index.length,
    index_range: indexDates.length ? [indexDates[0], indexDates.at(-1)] : null,
    aggregate_days: aggregates.length,
    aggregate_range: aggregateDates.length ? [aggregateDates[0], aggregateDates.at(-1)] : null,
    fee_rate: feeRate,
    slippage_per_contract: slippage,
    minimum_edge: edge,
    minimum_training: minimumTraining,
    leads
  };
}
