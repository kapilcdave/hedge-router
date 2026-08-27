import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('durable outbox delivers metadata and supports remote deletion', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'comp-outbox-'));
  process.env.COMP_DATA_DIR = dataDir;
  process.env.OUTBOX_TOKEN = 'outbox-test-secret';
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const [{ createCollector }, telemetryModule] = await Promise.all([
    import('../src/collector.js'), import('../src/telemetry.js')
  ]);
  const collectorFile = path.join(dataDir, 'collector.ndjson');
  const config = {
    telemetry: {
      enabled: true, remoteUrl: null, remoteTokenEnv: 'OUTBOX_TOKEN',
      rawRetentionDays: 30, minimumCohort: 20
    },
    collector: {
      host: '127.0.0.1', port: 8790, tokenEnv: 'OUTBOX_TOKEN',
      rawRetentionDays: 30, minimumCohort: 2
    }
  };
  const collector = await createCollector(config, { file: collectorFile });
  let collectorUrl;
  try { collectorUrl = await listen(collector); }
  catch (error) {
    if (error.code === 'EPERM') {
      t.skip('environment forbids loopback sockets');
      return;
    }
    throw error;
  }
  t.after(() => collector.close());
  config.telemetry.remoteUrl = `${collectorUrl}/v1/telemetry/events`;

  const telemetry = await telemetryModule.createTelemetry(config);
  await telemetry.record({
    event_type: 'request', session_id: 'outbox-session', request_id: 'req_outbox',
    model: 'openai/test', baseline_model: 'openai/test', provider: 'openai',
    route_reason: 'cheapest_eligible', task_class: 'test', input_tokens: 10,
    output_tokens: 2, latency_ms: 100, routing_overhead_ms: 1,
    provider_status: 200, actual_cost_usd: 0.01, baseline_cost_usd: 0.02,
    savings_usd: 0.01, attempts: 1
  });
  const synced = await telemetry.sync();
  assert.equal(synced.pending, 0);
  const received = (await readFile(collectorFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(received.length, 1);
  assert.equal(received[0].request_id, 'req_outbox');
  assert.equal('prompt' in received[0], false);

  const deletion = await telemetryModule.deleteRemoteTelemetry(config);
  assert.equal(deletion.removed, 1);
  assert.equal((await readFile(collectorFile, 'utf8')).trim(), '');
});
