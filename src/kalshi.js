import { clamp } from './utils.js';

const DEFAULT_BASE_URL = 'https://external-api.kalshi.com/trade-api/v2';

function finite(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Kalshi market is missing numeric ${name}`);
  return number;
}

async function getJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Kalshi API returned HTTP ${response.status} for ${new URL(url).pathname}`);
  return response.json();
}

export async function fetchKalshiMarkets({ series, status = 'open', tickers, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  if (!series && (!tickers || !tickers.length)) throw new Error('A series or at least one ticker is required');
  const markets = [];
  let cursor = '';
  do {
    const url = new URL(`${baseUrl.replace(/\/$/, '')}/markets`);
    url.searchParams.set('limit', '1000');
    if (series) url.searchParams.set('series_ticker', series);
    if (status) url.searchParams.set('status', status);
    if (tickers?.length) url.searchParams.set('tickers', tickers.join(','));
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await getJson(url, fetchImpl);
    if (!Array.isArray(page.markets)) throw new Error('Kalshi API response did not contain markets');
    markets.push(...page.markets);
    cursor = page.cursor || '';
  } while (cursor);
  return markets;
}

export function yesMidpoint(market) {
  const bid = Number(market.yes_bid_dollars);
  const directAsk = Number(market.yes_ask_dollars);
  const noBid = Number(market.no_bid_dollars);
  const ask = Number.isFinite(directAsk) && directAsk > 0 ? directAsk : Number.isFinite(noBid) ? 1 - noBid : NaN;
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    return Math.round(clamp((bid + ask) / 2, 0.01, 0.99) * 10_000) / 10_000;
  }
  const last = Number(market.last_price_dollars);
  if (Number.isFinite(last) && last > 0 && last < 1) return last;
  throw new Error(`${market.ticker} has no usable Yes market price`);
}

function executableQuotes(market) {
  const yesBid = Number(market.yes_bid_dollars);
  const directYesAsk = Number(market.yes_ask_dollars);
  const noBid = Number(market.no_bid_dollars);
  const directNoAsk = Number(market.no_ask_dollars);
  const yesAsk = Number.isFinite(directYesAsk) && directYesAsk > 0 ? directYesAsk : 1 - noBid;
  const noAsk = Number.isFinite(directNoAsk) && directNoAsk > 0 ? directNoAsk : 1 - yesBid;
  return {
    yesBid: Number.isFinite(yesBid) && yesBid >= 0 ? yesBid : null,
    yesAsk: Number.isFinite(yesAsk) && yesAsk > 0 && yesAsk < 1 ? yesAsk : null,
    noBid: Number.isFinite(noBid) && noBid >= 0 ? noBid : null,
    noAsk: Number.isFinite(noAsk) && noAsk > 0 && noAsk < 1 ? noAsk : null
  };
}

export function snapshotKalshiMarket(market, options) {
  if (market.market_type && market.market_type !== 'binary') throw new Error(`${market.ticker} is not binary`);
  if (market.strike_type !== 'greater') throw new Error(`${market.ticker} uses unsupported strike type ${market.strike_type}`);
  const observedAt = options.observedAt || new Date().toISOString();
  const closeTime = market.close_time || market.expiration_time;
  if (!Number.isFinite(Date.parse(closeTime))) throw new Error(`${market.ticker} has no valid close time`);
  if (Date.parse(observedAt) >= Date.parse(closeTime)) throw new Error(`${market.ticker} is no longer eligible for a pre-settlement snapshot`);
  return {
    id: market.ticker,
    eventTicker: market.event_ticker,
    date: closeTime.slice(0, 10),
    chip: options.chip,
    threshold: finite(market.floor_strike, 'floor_strike'),
    yesPrice: yesMidpoint(market),
    ...executableQuotes(market),
    feePerContract: options.feePerContract == null ? null : Number(options.feePerContract),
    feeRate: Number(options.feeRate ?? 0.07),
    slippage: Number(options.slippage || 0),
    observedAt,
    closeTime,
    source: 'kalshi-public-api',
    statusAtObservation: market.status,
    volume: Number(market.volume_fp || 0),
    rulesPrimary: market.rules_primary
  };
}

export async function createKalshiSnapshots(options) {
  const observedAt = options.observedAt || new Date().toISOString();
  const markets = await fetchKalshiMarkets({
    series: options.series, status: options.status || 'open',
    baseUrl: options.baseUrl, fetchImpl: options.fetchImpl
  });
  const snapshots = [];
  const skipped = [];
  for (const market of markets) {
    try { snapshots.push(snapshotKalshiMarket(market, { ...options, observedAt })); }
    catch (error) { skipped.push({ ticker: market.ticker, reason: error.message }); }
  }
  return { capturedAt: observedAt, series: options.series, snapshots, skipped };
}

export async function resolveKalshiSnapshots(snapshotDocument, options = {}) {
  if (!Array.isArray(snapshotDocument.snapshots)) throw new Error('Snapshot document must contain snapshots');
  const snapshots = snapshotDocument.snapshots;
  const byTicker = new Map();
  for (let index = 0; index < snapshots.length; index += 100) {
    const tickers = snapshots.slice(index, index + 100).map((snapshot) => snapshot.id);
    const markets = await fetchKalshiMarkets({
      tickers, status: 'settled', baseUrl: options.baseUrl, fetchImpl: options.fetchImpl
    });
    for (const market of markets) byTicker.set(market.ticker, market);
  }
  const resolved = [];
  const pending = [];
  for (const snapshot of snapshots) {
    const market = byTicker.get(snapshot.id);
    if (!market || market.status !== 'settled') {
      pending.push(snapshot.id);
      continue;
    }
    const outcomePrice = Number(market.expiration_value);
    if (!Number.isFinite(outcomePrice)) {
      pending.push(snapshot.id);
      continue;
    }
    resolved.push({
      id: snapshot.id,
      eventTicker: snapshot.eventTicker,
      date: snapshot.date,
      chip: snapshot.chip,
      threshold: snapshot.threshold,
      yesPrice: snapshot.yesPrice,
      yesBid: snapshot.yesBid,
      yesAsk: snapshot.yesAsk,
      noBid: snapshot.noBid,
      noAsk: snapshot.noAsk,
      feePerContract: snapshot.feePerContract,
      feeRate: snapshot.feeRate,
      slippage: snapshot.slippage,
      observedAt: snapshot.observedAt,
      closeTime: snapshot.closeTime,
      outcomePrice,
      result: market.result,
      settlementTime: market.settlement_ts,
      source: snapshot.source
    });
  }
  return { resolved, pending };
}

export { DEFAULT_BASE_URL as KALSHI_API_BASE_URL };
