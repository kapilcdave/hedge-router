import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ARM_ENV, ARM_PHRASE, Executor, clientOrderId, executeSignals, executionPaths,
  formatPrice, loadCredentials, orderIntent, readGate, signRequest
} from '../src/execute.js';

async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'hedge-router-exec-'));
  return executionPaths(dir);
}

// Close times are relative to the present because `checkEnvelope` compares them against the real
// clock: a hardcoded date silently turns every test into an assertion about the settlement buffer
// once it passes.
const MINUTE = 60_000;
const observedAt = new Date(Date.now() - MINUTE).toISOString();
const closeTime = new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString();

function signal(overrides = {}) {
  return {
    id: 'KXH100WS-26SEP01-2.700',
    event_ticker: 'KXH100WS-26SEP01',
    side: 'yes',
    entry_price: 0.2,
    net_edge: 0.1,
    observed_at: observedAt,
    close_time: closeTime,
    ...overrides
  };
}

function signals(rows) {
  return { results: rows };
}

// A fetch that fails the test if it is ever called. Dry runs must not open a socket, and a flag
// checked only in the response handler would pass a weaker assertion than this one.
function forbiddenFetch() {
  return () => {
    throw new Error('dry run opened a socket to a mutating endpoint');
  };
}

async function openGate(paths, overrides = {}) {
  await writeFile(paths.evaluation, JSON.stringify({
    gate: true, independent_events: 30, relative_brier_improvement: 0.06, paper_pnl: 1.25, ...overrides
  }));
}

test('price formatting rejects anything the venue would reject', () => {
  assert.equal(formatPrice(0.2), 0.2);
  assert.equal(formatPrice(0.6900000000000001), 0.69);
  assert.equal(formatPrice(0.125), 0.13);
  assert.throws(() => formatPrice(0), /strictly between 0 and 1/);
  assert.throws(() => formatPrice(1), /strictly between 0 and 1/);
  assert.throws(() => formatPrice('abc'), /strictly between 0 and 1/);
});

// The bid/ask schema is the single easiest thing to invert here, and inverting it buys the
// opposite of the intended hedge at a plausible-looking price.
test('buying NO becomes an ask on the YES price, with the paid premium as the risk', () => {
  assert.deepEqual(orderIntent(signal({ side: 'yes', entry_price: 0.2 })),
    { venueSide: 'bid', venuePrice: 0.2, costPerContract: 0.2 });
  assert.deepEqual(orderIntent(signal({ side: 'no', entry_price: 0.3 })),
    { venueSide: 'ask', venuePrice: 0.7, costPerContract: 0.3 });
  assert.throws(() => orderIntent(signal({ side: 'hold' })), /side must be yes or no/);
});

test('client order id is deterministic across runs and distinct across intents', () => {
  assert.equal(clientOrderId(signal()), clientOrderId(signal()));
  assert.notEqual(clientOrderId(signal()), clientOrderId(signal({ side: 'no' })));
  assert.notEqual(clientOrderId(signal()), clientOrderId(signal({ observed_at: closeTime })));
  assert.match(clientOrderId(signal()), /^hedgerouter-[0-9a-f]{24}$/);
});

test('signature covers timestamp, method and prefixed path, and excludes the query', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const base = {
    keyId: 'abc', privateKeyPem, method: 'post', timestampMs: '1700000000000'
  };
  const withQuery = signRequest({ ...base, requestPath: '/trade-api/v2/portfolio/orders?limit=1' });
  const withoutQuery = signRequest({ ...base, requestPath: '/trade-api/v2/portfolio/orders' });
  // PSS is randomized, so equality of signatures is not the available assertion; equality of the
  // signed message is, and it is what the 401-on-signed-query bug actually violates.
  assert.equal(typeof withQuery, 'string');
  assert.notEqual(withQuery, withoutQuery);
  assert.equal(Buffer.from(withoutQuery, 'base64').length, 256);
  assert.throws(() => signRequest({ ...base, keyId: '', requestPath: '/x' }), /key id is required/);
  assert.throws(() => signRequest({ ...base, privateKeyPem: null, requestPath: '/x' }), /private key is required/);
});

test('credentials expand $VAR and ~ in the key path', async () => {
  const env = { KALSHI_API_KEY_ID: 'key-1', KALSHI_PRIVATE_KEY_PATH: '$HOME/.config/k.pem', HOME: '/home/t' };
  const seen = [];
  const credentials = await loadCredentials(env, async (file) => {
    seen.push(file);
    return 'PEM';
  });
  assert.equal(credentials.available, true);
  assert.deepEqual(seen, ['/home/t/.config/k.pem']);

  const tilde = await loadCredentials(
    { ...env, KALSHI_PRIVATE_KEY_PATH: '~/k.pem' }, async (file) => file);
  assert.equal(tilde.keyPath, '/home/t/k.pem');

  const absent = await loadCredentials({}, async () => 'PEM');
  assert.equal(absent.available, false);
});

test('a missing or failing evaluation artifact is a closed gate, never an open one', async () => {
  const paths = await workspace();
  const missing = await readGate(paths);
  assert.equal(missing.open, false);
  assert.equal(missing.unavailable, 'no evaluation artifact');

  await writeFile(paths.evaluation, 'not json');
  assert.equal((await readGate(paths)).open, false);

  await writeFile(paths.evaluation, JSON.stringify({ gate: 'true' }));
  // A string is not a pass: only the boolean the evaluator emits opens the gate.
  assert.equal((await readGate(paths)).open, false);

  await openGate(paths);
  assert.equal((await readGate(paths)).open, true);
});

test('a closed gate refuses to arm and still reports the order it would have sent', async () => {
  const paths = await workspace();
  process.env[ARM_ENV] = ARM_PHRASE;
  try {
    const result = await executeSignals({
      signals: signals([signal()]), live: true, paths, fetchImpl: forbiddenFetch()
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.requested_live, true);
    assert.deepEqual(result.blockers.map((row) => row.reason).sort(), ['gate-closed', 'missing-credentials']);
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0].dry_run, true);
    assert.equal(result.orders[0].request.ticker, 'KXH100WS-26SEP01-2.700');
    assert.equal(result.orders[0].request.side, 'bid');
    assert.equal(result.orders[0].request.post_only, true);
    const journal = await readFile(paths.journal, 'utf8');
    assert.match(journal, /arm-refused/);
  } finally {
    delete process.env[ARM_ENV];
  }
});

test('an open gate without the arming phrase is still a dry run', async () => {
  const paths = await workspace();
  await openGate(paths);
  delete process.env[ARM_ENV];
  const result = await executeSignals({
    signals: signals([signal()]), live: true, paths, fetchImpl: forbiddenFetch()
  });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.blockers.map((row) => row.reason).sort(), ['missing-credentials', 'not-confirmed']);
});

test('the kill switch closes the path even with an open gate and a set phrase', async () => {
  const paths = await workspace();
  await openGate(paths);
  await writeFile(paths.killSwitch, 'halt');
  process.env[ARM_ENV] = ARM_PHRASE;
  try {
    const result = await executeSignals({
      signals: signals([signal()]), live: true, paths, fetchImpl: forbiddenFetch()
    });
    assert.equal(result.mode, 'dry-run');
    assert.ok(result.blockers.some((row) => row.reason === 'halted'));
  } finally {
    delete process.env[ARM_ENV];
  }
});

test('an unarmed executor cannot reach the network even if a caller asks it to', async () => {
  const paths = await workspace();
  const executor = new Executor({ armed: false, paths, fetchImpl: forbiddenFetch() });
  await assert.rejects(() => executor.request('POST', '/trade-api/v2/portfolio/events/orders', {}),
    /refusing to POST .* while unarmed/);
  await assert.rejects(() => executor.balance(), /while unarmed/);
});

test('hold signals never become orders', async () => {
  const paths = await workspace();
  const result = await executeSignals({
    signals: signals([signal({ side: 'hold' })]), live: false, paths, fetchImpl: forbiddenFetch()
  });
  assert.equal(result.orders.length, 0);
  assert.equal(result.refused.length, 0);
});

test('per-order and per-run notional caps are enforced before any send', async () => {
  const paths = await workspace();
  const executor = new Executor({
    armed: false, paths,
    limits: { maxContractsPerOrder: 5, maxNotionalPerOrder: 1, maxNotionalPerRun: 1.5, maxOrdersPerRun: 2 }
  });
  assert.throws(() => executor.checkEnvelope({ contracts: 6, costPerContract: 0.1, closeTime }),
    /exceeds maxContractsPerOrder/);
  assert.throws(() => executor.checkEnvelope({ contracts: 5, costPerContract: 0.5, closeTime }),
    /exceeds maxNotionalPerOrder/);
  assert.throws(() => executor.checkEnvelope({ contracts: 1, costPerContract: 0.2, closeTime: new Date(Date.now() + 5 * MINUTE).toISOString() }),
    /inside the .*s buffer/);
  assert.throws(() => executor.checkEnvelope({ contracts: 1, costPerContract: 0.2, closeTime: 'never' }),
    /is not a timestamp/);

  await executor.place(signal({ entry_price: 0.2 }), 5); // $1.00 of $1.50
  assert.throws(() => executor.checkEnvelope({ contracts: 5, costPerContract: 0.2, closeTime }),
    /exceeds maxNotionalPerRun/);
});

test('the per-run order count cap stops a loop', async () => {
  const paths = await workspace();
  const executor = new Executor({
    armed: false, paths,
    limits: { maxOrdersPerRun: 1, maxNotionalPerRun: 100, maxNotionalPerOrder: 10 }
  });
  await executor.place(signal(), 1);
  assert.throws(() => executor.checkEnvelope({ contracts: 1, costPerContract: 0.2, closeTime }),
    /maxOrdersPerRun is 1/);
});

test('limits that contradict each other are rejected at construction', () => {
  assert.throws(() => new Executor({ limits: { maxNotionalPerOrder: 50, maxNotionalPerRun: 10 } }),
    /cannot exceed maxNotionalPerRun/);
  assert.throws(() => new Executor({ limits: { maxContractsPerOrder: 1.5 } }),
    /maxContractsPerOrder must be an integer/);
  assert.throws(() => new Executor({ limits: { maxNotionalPerOrder: -1 } }),
    /must be a positive number/);
});

test('every attempt is journalled, dry runs included', async () => {
  const paths = await workspace();
  const result = await executeSignals({
    signals: signals([signal(), signal({ id: 'KXH100WS-26SEP01-2.800', entry_price: 0.4, net_edge: 0.2 })]),
    live: false, paths, fetchImpl: forbiddenFetch()
  });
  assert.equal(result.mode, 'dry-run');
  const rows = (await readFile(paths.journal, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.dry_run === true && row.armed === false));
  // Highest net edge first, so a truncated run places the best-scoring orders rather than the
  // first ones the snapshot happened to list.
  assert.equal(rows[0].market_id, 'KXH100WS-26SEP01-2.800');
});

test('an armed send uses the v2 events path and signs the request', async () => {
  const paths = await workspace();
  await openGate(paths);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const executor = new Executor({
    armed: true,
    paths,
    credentials: {
      available: true,
      keyId: 'key-1',
      privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' })
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ order_id: 'ord-1' }) };
    }
  });
  const placed = await executor.place(signal(), 2);
  assert.equal(placed.order_id, 'ord-1');
  assert.equal(calls.length, 1);
  // The legacy /portfolio/orders POST answers 410; this must be the events path.
  assert.equal(calls[0].url, 'https://api.elections.kalshi.com/trade-api/v2/portfolio/events/orders');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['KALSHI-ACCESS-KEY'], 'key-1');
  assert.ok(calls[0].options.headers['KALSHI-ACCESS-SIGNATURE']);
  assert.ok(calls[0].options.headers['KALSHI-ACCESS-TIMESTAMP']);
  assert.deepEqual(JSON.parse(calls[0].options.body).client_order_id, clientOrderId(signal()));
});

test('a read-only key is named rather than reported as a bad request', async () => {
  const paths = await workspace();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const executor = new Executor({
    armed: true,
    paths,
    credentials: {
      available: true, keyId: 'key-1', privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' })
    },
    fetchImpl: async () => ({
      ok: false, status: 403, text: async () => '{"error":{"code":"insufficient_scope","message":"write::trade required"}}'
    })
  });
  await assert.rejects(() => executor.place(signal(), 1), /this key can read but not trade/);
});

test('--allow-taker is the only way post_only comes off', async () => {
  const paths = await workspace();
  const guarded = await executeSignals({
    signals: signals([signal()]), live: false, paths, fetchImpl: forbiddenFetch()
  });
  assert.equal(guarded.orders[0].request.post_only, true);
  const taker = await executeSignals({
    signals: signals([signal()]), live: false, paths, postOnly: false, fetchImpl: forbiddenFetch()
  });
  assert.equal(taker.orders[0].request.post_only, false);
});
