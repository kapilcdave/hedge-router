import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createKalshiSnapshots, resolveKalshiSnapshots } from './kalshi.js';
import { evaluateMarkets, forecastMarkets } from './market.js';
import { fetchOrnnIndex, mergeOrnnIndex } from './ornn.js';
import { createPaperPortfolio, placePaperOrders, settlePaperPortfolio } from './paper.js';
import { aggregateDaily, experimentReport, loadEvents } from './telemetry.js';
import { DATA_DIR, readJson, writeJsonAtomic } from './utils.js';

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

async function optionalJson(file, fallback) {
  try { return await readJson(file); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function mergeById(existing, incoming) {
  const values = new Map(existing.map((row) => [row.id, row]));
  for (const row of incoming) values.set(row.id, row);
  return [...values.values()].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function pilotPaths(dataDir = DATA_DIR, chip = 'H100') {
  const pilotDir = path.join(dataDir, 'pilot');
  return {
    dataDir,
    pilotDir,
    lock: path.join(pilotDir, 'run.lock'),
    snapshotsDir: path.join(pilotDir, 'snapshots'),
    index: path.join(dataDir, `index-${slug(chip)}.json`),
    aggregates: path.join(dataDir, 'daily.json'),
    paper: path.join(dataDir, 'paper.json'),
    evaluation: path.join(dataDir, 'evaluation.json'),
    pending: path.join(pilotDir, 'pending.json'),
    resolved: path.join(pilotDir, 'resolved.json'),
    latest: path.join(pilotDir, 'latest.json'),
    runs: path.join(pilotDir, 'runs.ndjson')
  };
}

async function acquireLock(paths, cycleAt, maxAgeHours) {
  const create = async () => {
    const handle = await open(paths.lock, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, started_at: cycleAt })}\n`);
    return handle;
  };
  try { return await create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await optionalJson(paths.lock, null).catch(() => null);
    const age = existing?.started_at ? Date.parse(cycleAt) - Date.parse(existing.started_at) : 0;
    if (!Number.isFinite(age) || age <= Number(maxAgeHours) * 3_600_000) {
      throw new Error(`Pilot cycle already running; lock exists at ${paths.lock}`);
    }
    await unlink(paths.lock);
    return create();
  }
}

export async function runPilotCycle(options) {
  if (!options?.series || !options.gpu || !options.chip) throw new Error('series, gpu, and chip are required');
  const cycleAt = options.now || new Date().toISOString();
  if (!Number.isFinite(Date.parse(cycleAt))) throw new Error('now must be an ISO timestamp');
  const paths = pilotPaths(options.dataDir || DATA_DIR, options.chip);
  await mkdir(paths.snapshotsDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(paths, cycleAt, Number(options.maxLockAgeHours ?? 6));

  const errors = [];
  const markError = (stage, error) => errors.push({ stage, message: error.message });
  try {
    const today = cycleAt.slice(0, 10);
    const historyDays = Number(options.historyDays ?? 85);
    const startDate = addDays(today, -historyDays);
    let index = await optionalJson(paths.index, []);
    let imported = [];
    try {
      imported = await fetchOrnnIndex({
        gpu: options.gpu, chip: options.chip, startDate, endDate: today,
        baseUrl: options.ornnBaseUrl, fetchImpl: options.fetchImpl
      });
      index = mergeOrnnIndex(index, imported);
      await writeJsonAtomic(paths.index, index);
    } catch (error) {
      markError('ornn_history', error);
      if (!index.length) throw error;
    }

    const events = await loadEvents(options.eventsFile);
    const aggregates = aggregateDaily(events, Number(options.minimumContributors ?? 20));
    await writeJsonAtomic(paths.aggregates, aggregates);

    const pendingDocument = await optionalJson(paths.pending, { snapshots: [] });
    const resolvedDocument = await optionalJson(paths.resolved, { resolved: [] });
    let pending = Array.isArray(pendingDocument.snapshots) ? pendingDocument.snapshots : [];
    let resolved = Array.isArray(resolvedDocument.resolved) ? resolvedDocument.resolved : [];
    let newlyResolved = [];
    if (pending.length) {
      try {
        const resolution = await resolveKalshiSnapshots({ snapshots: pending }, {
          baseUrl: options.kalshiBaseUrl, fetchImpl: options.fetchImpl
        });
        newlyResolved = resolution.resolved;
        const stillPending = new Set(resolution.pending);
        pending = pending.filter((row) => stillPending.has(row.id));
        resolved = mergeById(resolved, newlyResolved);
      } catch (error) {
        markError('kalshi_resolution', error);
      }
    }

    let portfolio = await optionalJson(paths.paper, null);
    if (!portfolio) portfolio = createPaperPortfolio({ bankroll: Number(options.bankroll ?? 1000), now: cycleAt });
    let settlement = { portfolio, settled: [], pending: [] };
    if (resolved.length) {
      try {
        settlement = settlePaperPortfolio({ portfolio, markets: { resolved }, now: cycleAt });
        portfolio = settlement.portfolio;
      } catch (error) {
        markError('paper_settlement', error);
      }
    }

    let snapshot = { capturedAt: cycleAt, series: options.series, snapshots: [], skipped: [] };
    let signals = { generated_at: cycleAt, results: [] };
    let placement = { portfolio, placed: [], skipped: [] };
    try {
      snapshot = await createKalshiSnapshots({
        series: options.series, chip: String(options.chip).toUpperCase(), status: 'open',
        observedAt: cycleAt, feePerContract: options.feePerContract ?? null,
        feeRate: Number(options.feeRate ?? 0.07), slippage: Number(options.slippage ?? 0.01),
        baseUrl: options.kalshiBaseUrl, fetchImpl: options.fetchImpl
      });
      const archiveName = `${cycleAt.replace(/[:.]/g, '-')}.json`;
      await writeJsonAtomic(path.join(paths.snapshotsDir, archiveName), snapshot);
      signals = forecastMarkets({
        index, markets: snapshot.snapshots, aggregates,
        minimumTraining: Number(options.minimumTraining ?? 5), edge: Number(options.edge ?? 0.05)
      });
      placement = placePaperOrders({
        portfolio, signals, now: cycleAt,
        riskPercent: Number(options.riskPercent ?? 1),
        maxEventPercent: Number(options.maxEventPercent ?? 5),
        maxContracts: Number(options.maxContracts ?? 100),
        maxSnapshotAgeMinutes: Number(options.maxSnapshotAgeMinutes ?? 5)
      });
      portfolio = placement.portfolio;
    } catch (error) {
      markError('kalshi_capture_or_signal', error);
    }

    const resolvedIds = new Set(resolved.map((row) => row.id));
    const pendingById = new Map(pending.map((row) => [row.id, row]));
    for (const row of snapshot.snapshots) {
      if (!resolvedIds.has(row.id) && !pendingById.has(row.id)) pendingById.set(row.id, row);
    }
    pending = [...pendingById.values()].sort((a, b) => a.closeTime.localeCompare(b.closeTime) || a.id.localeCompare(b.id));
    await writeJsonAtomic(paths.pending, { updated_at: cycleAt, snapshots: pending });
    await writeJsonAtomic(paths.resolved, { updated_at: cycleAt, resolved });
    await writeJsonAtomic(paths.paper, portfolio);

    let evaluation = { observations: 0, independent_events: 0, trades: 0, paper_pnl: 0, gate: false, results: [] };
    if (resolved.length) {
      try {
        evaluation = evaluateMarkets({
          index, markets: resolved, aggregates,
          minimumTraining: Number(options.minimumTraining ?? 5), edge: Number(options.edge ?? 0.05)
        });
      } catch (error) {
        markError('evaluation', error);
      }
    }
    await writeJsonAtomic(paths.evaluation, evaluation);

    const summary = {
      schema_version: 1,
      run_at: cycleAt,
      status: errors.length ? 'partial' : 'ok',
      series: options.series,
      chip: String(options.chip).toUpperCase(),
      index: { imported: imported.length, rows: index.length, start_date: startDate, end_date: today },
      telemetry: { events: events.length, aggregate_days: aggregates.length, minimum_contributors: Number(options.minimumContributors ?? 20) },
      markets: {
        captured: snapshot.snapshots.length, capture_skipped: snapshot.skipped.length,
        pending: pending.length, newly_resolved: newlyResolved.length, resolved_total: resolved.length
      },
      signals: {
        evaluated: signals.results.length,
        ready: signals.results.filter((row) => row.signal_ready).length,
        qualifying: signals.results.filter((row) => row.side !== 'hold').length
      },
      paper: {
        placed: placement.placed.length, placement_skipped: placement.skipped.length,
        settled_now: settlement.settled.length, orders: portfolio.order_count || portfolio.orders.length,
        open: portfolio.open || 0, settled: portfolio.settled || 0,
        cash: portfolio.cash, equity_at_cost: portfolio.equity_at_cost ?? portfolio.cash,
        realized_pnl: portfolio.realized_pnl || 0
      },
      evaluation: {
        observations: evaluation.observations, independent_events: evaluation.independent_events,
        trades: evaluation.trades, relative_brier_improvement: evaluation.relative_brier_improvement ?? 0,
        paper_pnl: evaluation.paper_pnl, gate: Boolean(evaluation.gate)
      },
      errors
    };
    await writeJsonAtomic(paths.latest, summary);
    await appendFile(paths.runs, `${JSON.stringify(summary)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { summary, paths };
  } finally {
    await lock.close();
    await unlink(paths.lock).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function weeklyPilotReport({ runs, portfolio, evaluation, events, now, days = 7 }) {
  const generatedAt = now || new Date().toISOString();
  const cutoff = Date.parse(generatedAt) - Number(days) * 86_400_000;
  const recentRuns = (runs || []).filter((run) => Date.parse(run.run_at) >= cutoff && Date.parse(run.run_at) <= Date.parse(generatedAt));
  const router = experimentReport(events || []);
  const orders = Array.isArray(portfolio?.orders) ? portfolio.orders : [];
  const settled = orders.filter((order) => order.status === 'settled' && Date.parse(order.settled_at) >= cutoff);
  const wins = settled.filter((order) => order.realized_pnl > 0).length;
  const marketMature = Number(evaluation?.independent_events || 0) >= 30;
  const routerMature = router.completed_sessions >= 500 && router.contributors >= 25;
  const failures = [];
  if (routerMature && !router.router_gate) failures.push('router gate failed after reaching sample minimums');
  if (marketMature && !evaluation?.gate) failures.push('market gate failed after reaching 30 independent events');
  const verdict = router.router_gate && evaluation?.gate ? 'passed' : failures.length ? 'failed' : 'collecting';
  const runErrors = recentRuns.flatMap((run) => run.errors || []);
  return {
    generated_at: generatedAt,
    period_days: Number(days),
    verdict,
    collection: {
      runs: recentRuns.length,
      unique_days: new Set(recentRuns.map((run) => run.run_at.slice(0, 10))).size,
      successful_runs: recentRuns.filter((run) => run.status === 'ok').length,
      captured_markets: recentRuns.reduce((sum, run) => sum + Number(run.markets?.captured || 0), 0),
      signal_ready_runs: recentRuns.filter((run) => Number(run.signals?.ready || 0) > 0).length,
      errors: runErrors
    },
    router: {
      gate: router.router_gate,
      mature: routerMature,
      sessions: router.completed_sessions,
      contributors: router.contributors,
      savings_percent: router.savings_percent,
      quality_degradation: router.quality_degradation,
      p95_routing_overhead_ms: router.p95_routing_overhead_ms
    },
    market: {
      gate: Boolean(evaluation?.gate),
      mature: marketMature,
      observations: Number(evaluation?.observations || 0),
      independent_events: Number(evaluation?.independent_events || 0),
      relative_brier_improvement: Number(evaluation?.relative_brier_improvement || 0),
      backtest_pnl: Number(evaluation?.paper_pnl || 0)
    },
    portfolio: {
      orders: orders.length,
      open: orders.filter((order) => order.status === 'open').length,
      settled_this_period: settled.length,
      win_rate: settled.length ? wins / settled.length : null,
      realized_pnl: Number(portfolio?.realized_pnl || 0),
      equity_at_cost: Number(portfolio?.equity_at_cost ?? portfolio?.cash ?? 0)
    },
    falsification: {
      failures,
      basis_risk: 'not_measured',
      blockers: [
        ...(!routerMature ? ['router sample minimum not reached'] : []),
        ...(!marketMature ? ['30 independent settlement events not reached'] : []),
        'actual customer cost versus settlement-index basis risk not measured'
      ]
    }
  };
}
