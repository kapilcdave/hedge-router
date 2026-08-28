import { createHash } from 'node:crypto';
import { kalshiFee } from './market.js';

function finite(value, name, minimum = -Infinity) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return number;
}

function orderId(signal) {
  const digest = createHash('sha256')
    .update(`${signal.id}:${signal.observed_at}:${signal.side}`)
    .digest('hex').slice(0, 16);
  return `paper_${digest}`;
}

function feeFor(signal, contracts, price) {
  return signal.fee_rate == null
    ? Number(signal.fee_per_contract || 0) * contracts
    : kalshiFee(contracts, price, Number(signal.fee_rate));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function portfolioSummary(portfolio) {
  const open = portfolio.orders.filter((order) => order.status === 'open');
  const settled = portfolio.orders.filter((order) => order.status === 'settled');
  const openCost = open.reduce((sum, order) => sum + order.capital_at_risk, 0);
  const openValue = open.reduce((sum, order) => sum + order.contracts * order.entry_price, 0);
  return {
    order_count: portfolio.orders.length,
    open: open.length,
    settled: settled.length,
    cash: roundMoney(portfolio.cash),
    open_cost: roundMoney(openCost),
    open_value_at_entry: roundMoney(openValue),
    equity_at_cost: roundMoney(portfolio.cash + openValue),
    realized_pnl: roundMoney(settled.reduce((sum, order) => sum + order.realized_pnl, 0))
  };
}

function validatePortfolio(portfolio) {
  if (!portfolio || portfolio.schema_version !== 1 || portfolio.paper_only !== true || !Array.isArray(portfolio.orders)) {
    throw new Error('Invalid paper portfolio');
  }
  return portfolio;
}

export function createPaperPortfolio(options = {}) {
  const bankroll = finite(options.bankroll ?? 1000, 'bankroll', 1);
  const timestamp = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('now must be an ISO timestamp');
  return {
    schema_version: 1,
    paper_only: true,
    created_at: timestamp,
    updated_at: timestamp,
    bankroll_start: bankroll,
    cash: bankroll,
    realized_pnl: 0,
    orders: []
  };
}

export function placePaperOrders({
  portfolio, signals, now, riskPercent = 1, maxEventPercent = 5,
  maxContracts = 100, maxSnapshotAgeMinutes = 5
}) {
  const current = portfolio ? structuredClone(validatePortfolio(portfolio)) : createPaperPortfolio({ bankroll: 1000, now });
  if (!signals || !Array.isArray(signals.results)) throw new Error('Signals document must contain results');
  const timestamp = now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error('now must be an ISO timestamp');
  const orderRisk = finite(riskPercent, 'riskPercent', 0.01) / 100;
  const eventRisk = finite(maxEventPercent, 'maxEventPercent', 0.01) / 100;
  const contractLimit = finite(maxContracts, 'maxContracts', 1);
  const maximumAge = finite(maxSnapshotAgeMinutes, 'maxSnapshotAgeMinutes', 0.1) * 60_000;
  if (!Number.isInteger(contractLimit)) throw new Error('maxContracts must be an integer');
  const existing = new Set(current.orders.map((order) => order.market_id));
  const eventExposure = new Map();
  for (const order of current.orders.filter((item) => item.status === 'open')) {
    eventExposure.set(order.event_key, (eventExposure.get(order.event_key) || 0) + order.capital_at_risk);
  }
  const placed = [];
  const skipped = [];

  const candidates = [...signals.results].sort((a, b) => Number(b.net_edge || 0) - Number(a.net_edge || 0));
  for (const signal of candidates) {
    if (signal.side === 'hold') {
      skipped.push({ market_id: signal.id, reason: 'no qualifying edge' });
      continue;
    }
    if (existing.has(signal.id)) {
      skipped.push({ market_id: signal.id, reason: 'market already ordered' });
      continue;
    }
    if (!Number.isFinite(Date.parse(signal.close_time)) || Date.parse(timestamp) >= Date.parse(signal.close_time)) {
      skipped.push({ market_id: signal.id, reason: 'market is closed' });
      continue;
    }
    const observed = Date.parse(signal.observed_at);
    const age = Date.parse(timestamp) - observed;
    if (!Number.isFinite(observed) || age < 0 || age > maximumAge) {
      skipped.push({ market_id: signal.id, reason: 'snapshot is stale' });
      continue;
    }
    const entryPrice = Number(signal.entry_price);
    const slippage = finite(signal.slippage_per_contract || 0, 'slippage', 0);
    const eventKey = signal.event_ticker || `${signal.chip}:${signal.date}`;
    const perOrderBudget = current.bankroll_start * orderRisk;
    const remainingEventBudget = Math.max(0, current.bankroll_start * eventRisk - (eventExposure.get(eventKey) || 0));
    const budget = Math.min(perOrderBudget, remainingEventBudget, current.cash);
    let contracts = 0;
    let fee = 0;
    let capitalAtRisk = 0;
    for (let candidate = 1; candidate <= contractLimit; candidate += 1) {
      const candidateFee = feeFor(signal, candidate, entryPrice);
      const candidateRisk = roundMoney(candidate * (entryPrice + slippage) + candidateFee);
      if (candidateRisk > budget + 1e-9) break;
      contracts = candidate;
      fee = candidateFee;
      capitalAtRisk = candidateRisk;
    }
    if (!contracts) {
      skipped.push({ market_id: signal.id, reason: 'risk budget too small' });
      continue;
    }
    const order = {
      order_id: orderId(signal),
      market_id: signal.id,
      event_ticker: signal.event_ticker,
      event_key: eventKey,
      chip: signal.chip,
      date: signal.date,
      threshold: signal.threshold,
      side: signal.side,
      contracts,
      entry_price: entryPrice,
      probability: signal.probability,
      market_probability: signal.market_probability,
      predicted_price: signal.predicted_price,
      edge: signal.edge,
      net_edge: signal.net_edge,
      fee: roundMoney(fee),
      fee_rate: signal.fee_rate,
      slippage: roundMoney(slippage * contracts),
      capital_at_risk: roundMoney(capitalAtRisk),
      observed_at: signal.observed_at,
      close_time: signal.close_time,
      placed_at: timestamp,
      status: 'open',
      paper_only: true
    };
    current.orders.push(order);
    current.cash = roundMoney(current.cash - capitalAtRisk);
    eventExposure.set(eventKey, (eventExposure.get(eventKey) || 0) + capitalAtRisk);
    existing.add(signal.id);
    placed.push(order);
  }
  current.updated_at = timestamp;
  Object.assign(current, portfolioSummary(current));
  return { portfolio: current, placed, skipped };
}

export function settlePaperPortfolio({ portfolio, markets, now }) {
  const current = structuredClone(validatePortfolio(portfolio));
  const resolved = Array.isArray(markets?.resolved) ? markets.resolved : markets;
  if (!Array.isArray(resolved)) throw new Error('Resolved markets must be an array');
  const timestamp = now || new Date().toISOString();
  const byId = new Map(resolved.map((market) => [market.id, market]));
  const settled = [];
  const pending = [];
  current.orders = current.orders.map((order) => {
    if (order.status !== 'open') return order;
    const market = byId.get(order.market_id);
    const settlementTime = Date.parse(market?.settlementTime || timestamp);
    if (!market || !Number.isFinite(Number(market.outcomePrice)) ||
        Date.parse(timestamp) < Date.parse(order.close_time) ||
        !Number.isFinite(settlementTime) || settlementTime < Date.parse(order.placed_at)) {
      pending.push(order.market_id);
      return order;
    }
    const outcome = Number(market.outcomePrice) > Number(order.threshold) ? 1 : 0;
    const winning = order.side === 'yes' ? outcome : 1 - outcome;
    const payout = order.contracts * winning;
    const realizedPnl = roundMoney(payout - order.capital_at_risk);
    const updated = {
      ...order,
      status: 'settled',
      outcome,
      outcome_price: Number(market.outcomePrice),
      payout,
      realized_pnl: realizedPnl,
      settled_at: market.settlementTime || timestamp
    };
    current.cash = roundMoney(current.cash + payout);
    settled.push(updated);
    return updated;
  });
  current.updated_at = timestamp;
  Object.assign(current, portfolioSummary(current));
  return { portfolio: current, settled, pending };
}

export { portfolioSummary };
