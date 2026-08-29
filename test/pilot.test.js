import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pilotPaths, runPilotCycle, weeklyPilotReport } from '../src/pilot.js';

function requestEvent(date, index) {
  return {
    event_type: 'request', timestamp: `${date}T10:00:00.000Z`, install_id: `install-${index}`,
    session_id: `session-${index}`, model: 'openai/gpt-5-mini', baseline_model: 'openai/gpt-5',
    actual_cost_usd: 0.01, baseline_cost_usd: 0.02, savings_usd: 0.01,
    input_tokens: 1000 + index * 10, cached_input_tokens: 100, output_tokens: 200,
    latency_ms: 500, routing_overhead_ms: 5, provider_status: 200,
    attempts: 1, control: false
  };
}

function mockPublicApis() {
  const history = Array.from({ length: 10 }, (_, index) => ({
    timestamp: `2026-08-${String(18 + index).padStart(2, '0')}T20:00:00.000Z`,
    index_value: 2.5 + index * 0.03
  }));
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'ornn.test') {
      return new Response(JSON.stringify({ success: true, data: history }), { status: 200 });
    }
    if (parsed.searchParams.get('status') === 'settled') {
      return new Response(JSON.stringify({ markets: [], cursor: '' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      markets: [{
        ticker: 'KXH100WS-26SEP04-2.700', event_ticker: 'KXH100WS-26SEP04',
        market_type: 'binary', status: 'active', strike_type: 'greater', floor_strike: 2.7,
        yes_bid_dollars: '0.40', yes_ask_dollars: '0.44',
        no_bid_dollars: '0.56', no_ask_dollars: '0.60',
        last_price_dollars: '0.42', close_time: '2026-09-04T20:00:00Z',
        volume_fp: '100', rules_primary: 'Synthetic public API fixture.'
      }],
      cursor: ''
    }), { status: 200 });
  };
}

test('pilot cycle archives a fresh snapshot and persists resumable state', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hedge-router-pilot-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const eventsFile = path.join(dataDir, 'events.ndjson');
  const events = Array.from({ length: 10 }, (_, index) => requestEvent(`2026-08-${String(18 + index).padStart(2, '0')}`, index));
  await writeFile(eventsFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  const result = await runPilotCycle({
    series: 'KXH100WS', gpu: 'H100', chip: 'H100', dataDir, eventsFile,
    minimumContributors: 1, minimumTraining: 1, now: '2026-08-28T12:00:00Z',
    ornnBaseUrl: 'https://ornn.test', kalshiBaseUrl: 'https://kalshi.test/v2',
    fetchImpl: mockPublicApis()
  });
  assert.equal(result.summary.status, 'ok');
  assert.equal(result.summary.index.imported, 10);
  assert.equal(result.summary.telemetry.aggregate_days, 10);
  assert.equal(result.summary.markets.captured, 1);
  assert.equal(result.summary.markets.pending, 1);
  assert.equal(result.summary.signals.ready, 1);
  assert.equal((await readFile(result.paths.runs, 'utf8')).trim().split('\n').length, 1);
  assert.equal(JSON.parse(await readFile(result.paths.pending, 'utf8')).snapshots.length, 1);
  assert.equal(JSON.parse(await readFile(result.paths.paper, 'utf8')).paper_only, true);
  await assert.rejects(() => readFile(result.paths.lock), /ENOENT/);
});

test('pilot lock prevents overlapping scheduler cycles', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hedge-router-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const paths = pilotPaths(dataDir, 'H100');
  await writeFile(paths.lock, 'busy').catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    await import('node:fs/promises').then(({ mkdir }) => mkdir(paths.pilotDir, { recursive: true }));
    await writeFile(paths.lock, 'busy');
  });
  await assert.rejects(() => runPilotCycle({
    series: 'KXH100WS', gpu: 'H100', chip: 'H100', dataDir,
    now: '2026-08-28T12:00:00Z', fetchImpl: mockPublicApis()
  }), /already running/);
});

test('pilot recovers its own stale lock after the bounded timeout', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hedge-router-stale-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const paths = pilotPaths(dataDir, 'H100');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(paths.pilotDir, { recursive: true }));
  await writeFile(paths.lock, JSON.stringify({ pid: 1, started_at: '2026-08-27T00:00:00Z' }));
  const result = await runPilotCycle({
    series: 'KXH100WS', gpu: 'H100', chip: 'H100', dataDir,
    minimumContributors: 1, minimumTraining: 1, now: '2026-08-28T12:00:00Z',
    maxLockAgeHours: 6, ornnBaseUrl: 'https://ornn.test', kalshiBaseUrl: 'https://kalshi.test/v2',
    fetchImpl: mockPublicApis()
  });
  assert.equal(result.summary.status, 'ok');
});

test('weekly report stays collecting until gates mature and flags mature failures', () => {
  const runs = Array.from({ length: 7 }, (_, index) => ({
    run_at: `2026-08-${String(22 + index).padStart(2, '0')}T12:00:00Z`, status: 'ok',
    markets: { captured: 10 }, signals: { ready: index > 3 ? 2 : 0 }, errors: []
  }));
  const collecting = weeklyPilotReport({
    runs, portfolio: { orders: [], cash: 1000 }, evaluation: { independent_events: 2 },
    events: [], now: '2026-08-28T23:00:00Z'
  });
  assert.equal(collecting.verdict, 'collecting');
  assert.equal(collecting.collection.unique_days, 7);
  assert.equal(collecting.falsification.basis_risk, 'not_measured');

  const failed = weeklyPilotReport({
    runs, portfolio: { orders: [], cash: 1000 },
    evaluation: { independent_events: 31, observations: 50, gate: false, paper_pnl: -2 },
    events: [], now: '2026-08-28T23:00:00Z'
  });
  assert.equal(failed.verdict, 'failed');
  assert.match(failed.falsification.failures[0], /market gate failed/);
});
