import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CLI ingestion writes a ledger and makes export replay idempotent', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hedge-router-ingest-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const ledger = path.join(dataDir, 'events.ndjson');
  const sourceFile = path.join(dataDir, 'weave.ndjson');
  const fixture = await readFile(path.join(root, 'examples/weave-routing-decisions.ndjson'), 'utf8');
  await writeFile(sourceFile, `${fixture.trim()}\n${fixture.trim()}\n`);
  const args = [
    path.join(root, 'src/cli.js'), 'ingest', '--format', 'weave',
    '--input', sourceFile,
    '--output', ledger, '--config', path.join(root, 'hedge-router.config.example.json')
  ];
  const options = { cwd: root, env: { ...process.env, HEDGE_ROUTER_DATA_DIR: dataDir } };
  const first = JSON.parse((await exec(process.execPath, args, options)).stdout);
  const replay = JSON.parse((await exec(process.execPath, args, options)).stdout);
  assert.equal(first.accepted, 1);
  assert.equal(first.duplicates, 1);
  assert.equal(replay.accepted, 0);
  assert.equal(replay.duplicates, 2);

  const report = JSON.parse((await exec(process.execPath, [
    path.join(root, 'src/cli.js'), 'report', '--events', ledger
  ], options)).stdout);
  assert.equal(report.requests, 1);
  assert.equal(report.sources.weave, 1);
  assert.equal(report.actual_cost_usd, 0.00066);
});
