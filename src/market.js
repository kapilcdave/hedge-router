import { clamp, mean } from './utils.js';

export function kalshiFee(contracts, price, rate = 0.07) {
  const count = Number(contracts);
  const probability = Number(price);
  const feeRate = Number(rate);
  if (!Number.isInteger(count) || count < 1) throw new Error('contracts must be a positive integer');
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) throw new Error('price must be between 0 and 1');
  if (!Number.isFinite(feeRate) || feeRate < 0) throw new Error('fee rate cannot be negative');
  return Math.ceil((feeRate * count * probability * (1 - probability)) * 100 - 1e-9) / 100;
}

export function validateMarketDataset({ index, markets, aggregates, requireOutcome = true }) {
  if (!Array.isArray(index) || !Array.isArray(markets) || !Array.isArray(aggregates)) {
    throw new Error('Index, markets, and aggregates must be arrays');
  }
  const seenIndex = new Set();
  for (const row of index) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '') || !row.chip || !Number.isFinite(Number(row.price))) {
      throw new Error('Invalid index row');
    }
    const key = `${row.date}:${row.chip}`;
    if (seenIndex.has(key)) throw new Error(`Duplicate index row: ${key}`);
    seenIndex.add(key);
  }
  const seenMarkets = new Set();
  for (const market of markets) {
    if (!market.id || seenMarkets.has(market.id)) throw new Error(`Invalid or duplicate market id: ${market.id}`);
    seenMarkets.add(market.id);
    for (const field of ['threshold', 'yesPrice', 'slippage']) {
      if (!Number.isFinite(Number(market[field]))) throw new Error(`${market.id} has invalid ${field}`);
    }
    if (requireOutcome && !Number.isFinite(Number(market.outcomePrice))) throw new Error(`${market.id} has invalid outcomePrice`);
    if (market.feePerContract != null && !Number.isFinite(Number(market.feePerContract))) throw new Error(`${market.id} has invalid feePerContract`);
    if (market.feeRate != null && !Number.isFinite(Number(market.feeRate))) throw new Error(`${market.id} has invalid feeRate`);
    for (const field of ['yesAsk', 'noAsk']) {
      if (market[field] != null && (!Number.isFinite(Number(market[field])) || Number(market[field]) <= 0 || Number(market[field]) >= 1)) {
        throw new Error(`${market.id} has invalid ${field}`);
      }
    }
    if (market.yesPrice <= 0 || market.yesPrice >= 1) throw new Error(`${market.id} yesPrice must be between 0 and 1`);
    if (market.feePerContract < 0 || market.feeRate < 0 || market.slippage < 0) throw new Error(`${market.id} costs cannot be negative`);
    if (!Number.isFinite(Date.parse(market.observedAt)) || !Number.isFinite(Date.parse(market.closeTime))) {
      throw new Error(`${market.id} requires observedAt and closeTime`);
    }
    if (Date.parse(market.observedAt) >= Date.parse(market.closeTime)) {
      throw new Error(`${market.id} observation is not pre-settlement`);
    }
  }
  const seenAggregates = new Set();
  for (const aggregate of aggregates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(aggregate.date || '') || seenAggregates.has(aggregate.date)) {
      throw new Error(`Invalid or duplicate aggregate date: ${aggregate.date}`);
    }
    seenAggregates.add(aggregate.date);
  }
  return true;
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function multiply(a, b) {
  const bt = transpose(b);
  return a.map((row) => bt.map((column) => row.reduce((sum, value, index) => sum + value * column[index], 0)));
}

function inverse(matrix) {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => i === j ? 1 : 0)]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    if (Math.abs(augmented[column][column]) < 1e-12) throw new Error('Singular feature matrix');
    const divisor = augmented[column][column];
    augmented[column] = augmented[column].map((value) => value / divisor);
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, i) => value - factor * augmented[column][i]);
    }
  }
  return augmented.map((row) => row.slice(n));
}

function ridge(features, targets, lambda = 1) {
  const x = features.map((row) => [1, ...row]);
  const xt = transpose(x);
  const xtx = multiply(xt, x);
  for (let i = 1; i < xtx.length; i += 1) xtx[i][i] += lambda;
  return multiply(multiply(inverse(xtx), xt), targets.map((target) => [target])).map(([value]) => value);
}

function dot(coefficients, features) {
  return coefficients[0] + features.reduce((sum, value, index) => sum + value * coefficients[index + 1], 0);
}

function erf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function probabilityAbove(center, threshold, standardDeviation) {
  if (standardDeviation < 1e-9) return center > threshold ? 0.99 : 0.01;
  return clamp(0.5 * (1 + erf((center - threshold) / (standardDeviation * Math.sqrt(2)))), 0.01, 0.99);
}

function featuresFor(aggregate = {}) {
  return [
    Math.log1p(aggregate.request_count || 0),
    Math.log1p(aggregate.input_tokens || 0),
    Math.log1p(aggregate.output_tokens || 0),
    aggregate.cache_ratio || 0,
    Math.log1p(aggregate.mean_latency_ms || 0),
    aggregate.error_rate || 0,
    aggregate.fallback_rate || 0
  ];
}

function previousIndex(index, date, chip) {
  return index.filter((row) => row.chip === chip && row.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return Math.max(1, Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000));
}

function historicalChanges(index, chip, beforeDate, horizonDays) {
  const series = index.filter((row) => row.chip === chip && row.date < beforeDate).sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(series.map((row) => [row.date, row]));
  return series.flatMap((prior) => {
    const current = byDate.get(addDays(prior.date, horizonDays));
    return current ? [{ prior, current, target: current.price - prior.price }] : [];
  });
}

function trainingRows(index, aggregates, chip, beforeDate, horizonDays) {
  const aggregateMap = new Map(aggregates.map((row) => [row.date, row]));
  const rows = [];
  for (const change of historicalChanges(index, chip, beforeDate, horizonDays)) {
    const aggregate = aggregateMap.get(change.prior.date);
    if (aggregate) rows.push({ features: featuresFor(aggregate), target: change.target });
  }
  return rows;
}

function tradeFee(market, price, contracts = 1) {
  if (market.feePerContract != null) return Number(market.feePerContract) * contracts;
  return kalshiFee(contracts, price, Number(market.feeRate ?? 0.07));
}

export function forecastMarkets({ index, markets, aggregates, minimumTraining = 5, edge = 0.05 }) {
  validateMarketDataset({ index, markets, aggregates, requireOutcome: false });
  const aggregateMap = new Map(aggregates.map((row) => [row.date, row]));
  const results = [];
  for (const market of [...markets].sort((a, b) => a.date.localeCompare(b.date))) {
    const prior = previousIndex(index, market.date, market.chip);
    if (!prior) continue;
    const horizonDays = daysBetween(prior.date, market.date);
    const aggregate = aggregateMap.get(prior.date);
    const training = trainingRows(index, aggregates, market.chip, market.date, horizonDays);
    const targets = training.map((row) => row.target);
    const historicalTargets = historicalChanges(index, market.chip, market.date, horizonDays).map((row) => row.target);
    let predictedPrice = prior.price;
    const signalReady = Boolean(aggregate && training.length >= minimumTraining);
    if (signalReady) {
      const coefficients = ridge(training.map((row) => row.features), targets);
      predictedPrice = prior.price + dot(coefficients, featuresFor(aggregate));
    }
    const residualStd = Math.sqrt(mean(historicalTargets.map((target) => (target - mean(historicalTargets)) ** 2))) || 0.1;
    const probability = probabilityAbove(predictedPrice, market.threshold, residualStd);
    const naiveProbability = probabilityAbove(prior.price, market.threshold, residualStd);
    const marketProbability = clamp(Number(market.yesPrice), 0.01, 0.99);
    const yesEntry = Number(market.yesAsk ?? marketProbability);
    const noEntry = Number(market.noAsk ?? 1 - marketProbability);
    const yesCost = tradeFee(market, yesEntry) + Number(market.slippage || 0);
    const noCost = tradeFee(market, noEntry) + Number(market.slippage || 0);
    const yesEdge = probability - yesEntry;
    const noEdge = (1 - probability) - noEntry;
    let side = 'hold';
    let selectedEdge = Math.max(yesEdge, noEdge);
    let tradingCost = selectedEdge === yesEdge ? yesCost : noCost;
    if (signalReady && yesEdge > edge + yesCost) {
      side = 'yes';
      selectedEdge = yesEdge;
      tradingCost = yesCost;
    } else if (signalReady && noEdge > edge + noCost) {
      side = 'no';
      selectedEdge = noEdge;
      tradingCost = noCost;
    }
    results.push({
      id: market.id, event_ticker: market.eventTicker || market.event_ticker || null,
      date: market.date, chip: market.chip, threshold: market.threshold,
      observed_at: market.observedAt, close_time: market.closeTime,
      predicted_price: predictedPrice,
      probability, market_probability: marketProbability, naive_probability: naiveProbability,
      side, edge: selectedEdge, net_edge: selectedEdge - tradingCost,
      signal_ready: signalReady,
      entry_price: side === 'yes' ? yesEntry : side === 'no' ? noEntry : selectedEdge === yesEdge ? yesEntry : noEntry,
      fee_per_contract: tradeFee(market, side === 'yes' ? yesEntry : side === 'no' ? noEntry : selectedEdge === yesEdge ? yesEntry : noEntry),
      fee_rate: market.feeRate == null ? null : Number(market.feeRate),
      slippage_per_contract: Number(market.slippage || 0),
      horizon_days: horizonDays,
      calibration_rows: historicalTargets.length,
      training_rows: training.length
    });
  }
  return { generated_at: new Date().toISOString(), minimum_training: minimumTraining, minimum_edge: edge, results };
}

export function evaluateMarkets({ index, markets, aggregates, minimumTraining = 5, edge = 0.05 }) {
  validateMarketDataset({ index, markets, aggregates });
  const forecast = forecastMarkets({ index, markets, aggregates, minimumTraining, edge });
  const marketById = new Map(markets.map((market) => [market.id, market]));
  const results = forecast.results.map((signal) => {
    const market = marketById.get(signal.id);
    const outcome = Number(market.outcomePrice) > Number(market.threshold) ? 1 : 0;
    const entryPrice = signal.entry_price;
    const payout = signal.side === 'no' ? 1 - outcome : signal.side === 'yes' ? outcome : 0;
    const tradingCost = signal.fee_per_contract + signal.slippage_per_contract;
    return {
      ...signal,
      outcome_price: Number(market.outcomePrice), outcome,
      paper_pnl: signal.side === 'hold' ? 0 : payout - entryPrice - tradingCost
    };
  });
  const brier = (field) => mean(results.map((row) => (row[field] - row.outcome) ** 2));
  const signalBrier = brier('probability');
  const marketBrier = brier('market_probability');
  const naiveBrier = brier('naive_probability');
  const strongest = Math.min(marketBrier, naiveBrier);
  const independentEvents = new Set(results.map((row) => row.event_ticker || `${row.chip}:${row.date}`)).size;
  const paperPnl = results.reduce((sum, row) => sum + row.paper_pnl, 0);
  return {
    observations: results.length,
    independent_events: independentEvents,
    signal_brier: signalBrier,
    market_brier: marketBrier,
    naive_brier: naiveBrier,
    relative_brier_improvement: strongest ? (strongest - signalBrier) / strongest : 0,
    paper_pnl: paperPnl,
    trades: results.filter((row) => row.side !== 'hold').length,
    gate: independentEvents >= 30 && signalBrier <= strongest * 0.95 && paperPnl > 0,
    results
  };
}
