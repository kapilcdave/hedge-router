import { clamp, mean } from './utils.js';

export function validateMarketDataset({ index, markets, aggregates }) {
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
    for (const field of ['threshold', 'yesPrice', 'feePerContract', 'slippage', 'outcomePrice']) {
      if (!Number.isFinite(Number(market[field]))) throw new Error(`${market.id} has invalid ${field}`);
    }
    if (market.yesPrice <= 0 || market.yesPrice >= 1) throw new Error(`${market.id} yesPrice must be between 0 and 1`);
    if (market.feePerContract < 0 || market.slippage < 0) throw new Error(`${market.id} costs cannot be negative`);
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

function trainingRows(index, aggregates, chip, beforeDate) {
  const series = index.filter((row) => row.chip === chip && row.date < beforeDate).sort((a, b) => a.date.localeCompare(b.date));
  const aggregateMap = new Map(aggregates.map((row) => [row.date, row]));
  const rows = [];
  for (let i = 1; i < series.length; i += 1) {
    const prior = series[i - 1];
    const current = series[i];
    const aggregate = aggregateMap.get(prior.date);
    if (aggregate) rows.push({ features: featuresFor(aggregate), target: current.price - prior.price });
  }
  return rows;
}

export function evaluateMarkets({ index, markets, aggregates, minimumTraining = 5, edge = 0.05 }) {
  validateMarketDataset({ index, markets, aggregates });
  const aggregateMap = new Map(aggregates.map((row) => [row.date, row]));
  const results = [];
  for (const market of [...markets].sort((a, b) => a.date.localeCompare(b.date))) {
    const prior = previousIndex(index, market.date, market.chip);
    if (!prior) continue;
    const aggregate = aggregateMap.get(prior.date);
    const training = trainingRows(index, aggregates, market.chip, market.date);
    const targets = training.map((row) => row.target);
    let predictedPrice = prior.price;
    if (aggregate && training.length >= minimumTraining) {
      const coefficients = ridge(training.map((row) => row.features), targets);
      predictedPrice = prior.price + dot(coefficients, featuresFor(aggregate));
    }
    const residualStd = Math.sqrt(mean(targets.map((target) => (target - mean(targets)) ** 2))) || 0.1;
    const probability = probabilityAbove(predictedPrice, market.threshold, residualStd);
    const naiveProbability = probabilityAbove(prior.price, market.threshold, residualStd);
    const outcome = market.outcomePrice > market.threshold ? 1 : 0;
    const marketProbability = clamp(Number(market.yesPrice), 0.01, 0.99);
    const tradingCost = Number(market.feePerContract || 0) + Number(market.slippage || 0);
    let side = 'hold';
    let paperPnl = 0;
    if (probability - marketProbability > edge + tradingCost) {
      side = 'yes';
      paperPnl = outcome - marketProbability - tradingCost;
    } else if (marketProbability - probability > edge + tradingCost) {
      side = 'no';
      paperPnl = (1 - outcome) - (1 - marketProbability) - tradingCost;
    }
    results.push({
      id: market.id, date: market.date, chip: market.chip, threshold: market.threshold,
      predicted_price: predictedPrice, outcome_price: market.outcomePrice,
      probability, market_probability: marketProbability, naive_probability: naiveProbability,
      outcome, side, paper_pnl: paperPnl, training_rows: training.length
    });
  }
  const brier = (field) => mean(results.map((row) => (row[field] - row.outcome) ** 2));
  const signalBrier = brier('probability');
  const marketBrier = brier('market_probability');
  const naiveBrier = brier('naive_probability');
  const strongest = Math.min(marketBrier, naiveBrier);
  return {
    observations: results.length,
    signal_brier: signalBrier,
    market_brier: marketBrier,
    naive_brier: naiveBrier,
    relative_brier_improvement: strongest ? (strongest - signalBrier) / strongest : 0,
    paper_pnl: results.reduce((sum, row) => sum + row.paper_pnl, 0),
    trades: results.filter((row) => row.side !== 'hold').length,
    gate: results.length >= 30 && signalBrier <= strongest * 0.95 && results.reduce((sum, row) => sum + row.paper_pnl, 0) > 0,
    results
  };
}
