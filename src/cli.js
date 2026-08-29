#!/usr/bin/env node
import { copyFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { startCollector } from './collector.js';
import { runDashboard } from './dashboard.js';
import { createKalshiSnapshots, resolveKalshiSnapshots } from './kalshi.js';
import { evaluateMarkets, forecastMarkets } from './market.js';
import { fetchOrnnIndex, mergeOrnnIndex } from './ornn.js';
import { createPaperPortfolio, placePaperOrders, settlePaperPortfolio } from './paper.js';
import { pilotPaths, runPilotCycle, weeklyPilotReport } from './pilot.js';
import { startServer } from './server.js';
import { aggregateDaily, createTelemetry, deleteLocalTelemetry, deleteRemoteTelemetry, experimentReport, loadEvents, savingsReport } from './telemetry.js';
import { DATA_DIR, parseBoolean, readJson, writeJsonAtomic } from './utils.js';

function parseArgs(values) {
  const args = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) args._.push(value);
    else {
      const [key, inline] = value.slice(2).split('=', 2);
      args[key] = inline ?? (values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : true);
    }
  }
  return args;
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

async function optionalJson(file) {
  try { return await readJson(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runCommand(command) {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function commandServe(args) {
  const { config, file } = await loadConfig(args.config);
  const server = await startServer(config);
  print(`Hedge Router listening on http://${config.server.host}:${config.server.port} (config: ${file})`);
  const close = () => server.close(() => process.exit(0));
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

async function commandCollect(args) {
  const { config, file } = await loadConfig(args.config);
  const server = await startCollector(config);
  print(`Hedge Router collector listening on http://${config.collector.host}:${config.collector.port} (config: ${file})`);
  const close = () => server.close(() => process.exit(0));
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

async function commandReport(args) {
  const events = await loadEvents(args.events);
  print(savingsReport(events));
}

async function commandDashboard(args, demo = false) {
  const refreshMs = Number(args['refresh-ms'] || (demo ? 500 : 750));
  if (!Number.isFinite(refreshMs) || refreshMs < 100) throw new Error('--refresh-ms must be at least 100');
  const duration = args.duration == null ? null : Number(args.duration);
  if (duration != null && (!Number.isFinite(duration) || duration <= 0)) throw new Error('--duration must be positive');
  const frames = args.frames == null
    ? duration == null ? null : Math.max(1, Math.ceil((duration * 1000) / refreshMs))
    : Number(args.frames);
  if (frames != null && (!Number.isInteger(frames) || frames < 1)) throw new Error('--frames must be a positive integer');
  await runDashboard({
    demo, eventsFile: args.events, marketFile: args.market, paperFile: args.paper, refreshMs,
    frames, once: Boolean(args.once), width: args.width ? Number(args.width) : undefined,
    color: !args['no-color'], forceColor: Boolean(args.color)
  });
}

async function commandOutcome(args) {
  if (!args.session) throw new Error('--session is required');
  const { config } = await loadConfig(args.config);
  let testsPass = args['tests-pass'] == null ? null : parseBoolean(args['tests-pass']);
  if (args['run-checks']) {
    const results = [];
    for (const command of config.quality.commands) results.push(await runCommand(command));
    testsPass = results.length ? results.every(Boolean) : null;
  }
  const rating = args.rating == null ? null : Number(args.rating);
  if (rating != null && ![-1, 0, 1].includes(rating)) throw new Error('--rating must be -1, 0, or 1');
  const telemetry = await createTelemetry(config);
  const event = await telemetry.record({ event_type: 'outcome', session_id: args.session, tests_pass: testsPass, rating });
  print({ recorded: true, session_id: event.session_id, tests_pass: testsPass, rating });
}

async function commandAggregate(args) {
  const { config } = await loadConfig(args.config);
  const events = await loadEvents(args.events);
  const minimum = args.minimum ? Number(args.minimum) : config.telemetry.minimumCohort;
  const result = aggregateDaily(events, minimum);
  if (args.output) await writeJsonAtomic(path.resolve(args.output), result);
  else print(result);
}

async function commandEvaluate(args) {
  if (!args.index || !args.markets) throw new Error('--index and --markets are required');
  const index = await readJson(path.resolve(args.index));
  const marketDocument = await readJson(path.resolve(args.markets));
  const markets = marketDocument.resolved || marketDocument;
  const aggregates = args.aggregates ? await readJson(path.resolve(args.aggregates)) : [];
  const result = evaluateMarkets({ index, markets, aggregates });
  if (args.output) await writeJsonAtomic(path.resolve(args.output), result);
  else print(result);
}

async function commandPaperOpen(args) {
  if (!args.index || !args.markets || !args.output) throw new Error('--index, --markets, and --output are required');
  const index = await readJson(path.resolve(args.index));
  const marketDocument = await readJson(path.resolve(args.markets));
  const markets = marketDocument.snapshots || marketDocument;
  const aggregates = args.aggregates ? await readJson(path.resolve(args.aggregates)) : [];
  const signals = forecastMarkets({
    index, markets, aggregates,
    minimumTraining: Number(args['minimum-training'] || 5),
    edge: Number(args.edge || 0.05)
  });
  const portfolio = args.portfolio
    ? await optionalJson(path.resolve(args.portfolio)) || createPaperPortfolio({ bankroll: Number(args.bankroll || 1000) })
    : createPaperPortfolio({ bankroll: Number(args.bankroll || 1000) });
  const result = placePaperOrders({
    portfolio, signals,
    riskPercent: Number(args['risk-percent'] || 1),
    maxEventPercent: Number(args['max-event-percent'] || 5),
    maxContracts: Number(args['max-contracts'] || 100),
    maxSnapshotAgeMinutes: Number(args['max-snapshot-age-minutes'] || 5)
  });
  await writeJsonAtomic(path.resolve(args.output), result.portfolio);
  const skippedByReason = Object.fromEntries([...new Set(result.skipped.map((row) => row.reason))]
    .map((reason) => [reason, result.skipped.filter((row) => row.reason === reason).length]));
  print({
    output: path.resolve(args.output), placed: result.placed.length, skipped: result.skipped.length,
    skipped_by_reason: skippedByReason,
    orders: result.portfolio.order_count, open: result.portfolio.open,
    cash: result.portfolio.cash, equity_at_cost: result.portfolio.equity_at_cost
  });
}

async function commandPaperSettle(args) {
  if (!args.portfolio || !args.markets || !args.output) throw new Error('--portfolio, --markets, and --output are required');
  const portfolio = await readJson(path.resolve(args.portfolio));
  const markets = await readJson(path.resolve(args.markets));
  const result = settlePaperPortfolio({ portfolio, markets });
  await writeJsonAtomic(path.resolve(args.output), result.portfolio);
  print({ output: path.resolve(args.output), settled: result.settled.length, pending: result.pending.length, realized_pnl: result.portfolio.realized_pnl });
}

async function pilotOptions(args) {
  const { config } = await loadConfig(args.config);
  if (!args.series || !args.gpu || !args.chip) throw new Error('--series, --gpu, and --chip are required');
  return {
    series: String(args.series).toUpperCase(), gpu: args.gpu, chip: String(args.chip).toUpperCase(),
    dataDir: args.dir ? path.resolve(args.dir) : DATA_DIR, eventsFile: args.events,
    minimumContributors: Number(args['minimum-contributors'] ?? config.telemetry.minimumCohort),
    historyDays: Number(args['history-days'] ?? 85), minimumTraining: Number(args['minimum-training'] ?? 5),
    edge: Number(args.edge ?? 0.05), bankroll: Number(args.bankroll ?? 1000),
    riskPercent: Number(args['risk-percent'] ?? 1), maxEventPercent: Number(args['max-event-percent'] ?? 5),
    maxContracts: Number(args['max-contracts'] ?? 100), maxSnapshotAgeMinutes: Number(args['max-snapshot-age-minutes'] ?? 5),
    maxLockAgeHours: Number(args['max-lock-age-hours'] ?? 6),
    feeRate: Number(args['fee-rate'] ?? 0.07), slippage: Number(args.slippage ?? 0.01)
  };
}

async function commandPilot(args, daemon = false) {
  const options = await pilotOptions(args);
  const intervalHours = Number(args['interval-hours'] ?? 24);
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) throw new Error('--interval-hours must be positive');
  do {
    try { print((await runPilotCycle(options)).summary); }
    catch (error) {
      if (!daemon) throw error;
      print({ status: 'error', timestamp: new Date().toISOString(), message: error.message });
    }
    if (!daemon || args.once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalHours * 3_600_000));
  } while (true);
}

async function commandPilotReport(args) {
  const chip = String(args.chip || 'H100').toUpperCase();
  const paths = pilotPaths(args.dir ? path.resolve(args.dir) : DATA_DIR, chip);
  const [runs, portfolio, evaluation, events] = await Promise.all([
    loadEvents(args.runs || paths.runs),
    optionalJson(path.resolve(args.portfolio || paths.paper)),
    optionalJson(path.resolve(args.market || paths.evaluation)),
    loadEvents(args.events)
  ]);
  const report = weeklyPilotReport({ runs, portfolio, evaluation, events, days: Number(args.days || 7) });
  if (args.output) await writeJsonAtomic(path.resolve(args.output), report);
  else print(report);
}

async function commandKalshiSnapshot(args) {
  if (!args.series || !args.chip || !args.output) throw new Error('--series, --chip, and --output are required');
  const result = await createKalshiSnapshots({
    series: String(args.series).toUpperCase(), chip: String(args.chip).toUpperCase(),
    status: args.status || 'open', feePerContract: args.fee == null ? null : Number(args.fee),
    feeRate: Number(args['fee-rate'] ?? 0.07),
    slippage: Number(args.slippage || 0)
  });
  await writeJsonAtomic(path.resolve(args.output), result);
  print({ output: path.resolve(args.output), captured: result.snapshots.length, skipped: result.skipped.length });
}

async function commandKalshiResolve(args) {
  if (!args.input || !args.output) throw new Error('--input and --output are required');
  const snapshots = await readJson(path.resolve(args.input));
  const result = await resolveKalshiSnapshots(snapshots);
  await writeJsonAtomic(path.resolve(args.output), result);
  print({ output: path.resolve(args.output), resolved: result.resolved.length, pending: result.pending.length });
}

async function commandOrnnHistory(args) {
  if (!args.gpu || !args.chip || !args.start || !args.end || !args.output) {
    throw new Error('--gpu, --chip, --start, --end, and --output are required');
  }
  const imported = await fetchOrnnIndex({
    gpu: args.gpu, chip: args.chip, startDate: args.start, endDate: args.end
  });
  const rows = args.merge
    ? mergeOrnnIndex(await readJson(path.resolve(args.merge)), imported)
    : imported;
  await writeJsonAtomic(path.resolve(args.output), rows);
  print({ output: path.resolve(args.output), imported: imported.length, rows: rows.length, gpu: imported[0]?.sourceGpu || args.gpu });
}

async function commandGate(args) {
  const router = experimentReport(await loadEvents(args.events));
  const market = args.market ? await readJson(path.resolve(args.market)) : null;
  print({
    combined_gate: Boolean(router.router_gate && market?.gate),
    router,
    market: market ? {
      gate: Boolean(market.gate),
      observations: market.observations,
      independent_events: market.independent_events,
      relative_brier_improvement: market.relative_brier_improvement,
      paper_pnl: market.paper_pnl,
      trades: market.trades
    } : null
  });
}

async function commandExport(args) {
  if (!args.output) throw new Error('--output is required');
  const output = path.resolve(args.output);
  await writeJsonAtomic(output, await loadEvents(args.events));
  print(`Exported sanitized telemetry to ${output}`);
}

async function commandDeleteData(args) {
  if (args.confirm !== 'DELETE') throw new Error('Refusing deletion; pass --confirm DELETE');
  let remote = { configured: false, removed: 0 };
  if (!args['local-only']) {
    const { config } = await loadConfig(args.config);
    remote = await deleteRemoteTelemetry(config);
  }
  const deleted = await deleteLocalTelemetry();
  print({ local_files_deleted: deleted, remote });
}

async function commandSync(args) {
  const { config } = await loadConfig(args.config);
  const telemetry = await createTelemetry(config);
  print(await telemetry.sync());
}

async function commandInit(args) {
  const destination = path.resolve(args.output || 'hedge-router.config.json');
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hedge-router.config.example.json');
  try {
    await readFile(destination);
    throw new Error(`${destination} already exists`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await copyFile(source, destination);
  print(`Created ${destination}`);
}

function help() {
  print(`Usage: hedge-router <command> [options]

Commands:
  init [--output FILE]               Create a starter configuration
  serve [--config FILE]              Start the local proxy
  dashboard [--events FILE] [--market FILE] [--paper FILE]
    [--refresh-ms N] [--once]        Watch live routes and paper hedges
  demo [--duration SEC] [--frames N] Show a deterministic, recordable feed
    [--refresh-ms N] [--no-color]
  collect [--config FILE]            Start the authenticated telemetry collector
  report [--events FILE]             Show cost, savings, latency, and quality metrics
  session-outcome --session ID       Record tests and rating metadata
    [--tests-pass BOOL] [--rating -1|0|1] [--run-checks]
  aggregate [--events FILE]          Create privacy-thresholded daily features
    [--minimum N] [--output FILE]
  evaluate --index FILE --markets FILE [--aggregates FILE] [--output FILE]
                                     Walk-forward paper evaluation; never trades
  paper-open --index FILE --markets SNAPSHOT --output FILE
    [--aggregates FILE] [--portfolio FILE] [--bankroll USD]
    [--risk-percent N] [--max-event-percent N] [--max-contracts N]
    [--max-snapshot-age-minutes N]
                                     Record immutable pre-close paper orders
  paper-settle --portfolio FILE --markets RESOLVED --output FILE
                                     Settle paper orders and calculate P&L
  pilot-run --series TICKER --gpu GPU --chip CHIP
    [--minimum-contributors N] [--max-lock-age-hours N] [--dir DIR]
                                     Run one locked capture-to-report cycle
  pilot-daemon --series TICKER --gpu GPU --chip CHIP
    [--interval-hours N] [--max-lock-age-hours N] [--once]
                                     Run the pilot cycle every 24 hours
  pilot-report [--chip CHIP] [--days N] [--output FILE]
    [--dir DIR]                      Produce a weekly falsification scorecard
  kalshi-snapshot --series TICKER --chip CHIP --output FILE
    [--fee-rate N] [--fee USD] [--slippage USD]
                                     Capture public prices before settlement
  kalshi-resolve --input FILE --output FILE
                                     Resolve captured snapshots after settlement
  ornn-history --gpu GPU --chip CHIP --start YYYY-MM-DD --end YYYY-MM-DD --output FILE
                                     Download an Ornn GPU index series
    [--merge EXISTING_FILE]          Preserve older rows while refreshing history
  gate [--events FILE] [--market EVALUATION_FILE]
                                     Check independent router and market gates
  export --output FILE               Export sanitized local telemetry as JSON
  sync [--config FILE]               Retry the durable telemetry outbox
  delete-data --confirm DELETE       Delete remote and local telemetry
    [--local-only] [--config FILE]
`);
}

async function main() {
  const [command = 'help', ...values] = process.argv.slice(2);
  const args = parseArgs(values);
  if (command === 'serve') await commandServe(args);
  else if (command === 'dashboard') await commandDashboard(args);
  else if (command === 'demo') await commandDashboard(args, true);
  else if (command === 'collect') await commandCollect(args);
  else if (command === 'report') await commandReport(args);
  else if (command === 'session-outcome') await commandOutcome(args);
  else if (command === 'aggregate') await commandAggregate(args);
  else if (command === 'evaluate') await commandEvaluate(args);
  else if (command === 'paper-open') await commandPaperOpen(args);
  else if (command === 'paper-settle') await commandPaperSettle(args);
  else if (command === 'pilot-run') await commandPilot(args);
  else if (command === 'pilot-daemon') await commandPilot(args, true);
  else if (command === 'pilot-report') await commandPilotReport(args);
  else if (command === 'kalshi-snapshot') await commandKalshiSnapshot(args);
  else if (command === 'kalshi-resolve') await commandKalshiResolve(args);
  else if (command === 'ornn-history') await commandOrnnHistory(args);
  else if (command === 'gate') await commandGate(args);
  else if (command === 'export') await commandExport(args);
  else if (command === 'sync') await commandSync(args);
  else if (command === 'delete-data') await commandDeleteData(args);
  else if (command === 'init') await commandInit(args);
  else if (command === 'help' || command === '--help' || command === '-h') help();
  else throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`hedge-router: ${error.message}\n`);
  process.exitCode = 1;
});
