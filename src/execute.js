// The order path. Unarmed by default; the research gate is a precondition, not a warning.
//
// Everything in this repository up to here is measurement, and measurement is safe to be wrong
// about. This file is the first one that can lose money, so the guards live inside `Executor`
// rather than in the CLI: a mistaken call from a script cannot widen the envelope.
//
// Four properties matter, in order of how much damage their absence causes:
//
// 1. **Unarmed means no socket to a mutating endpoint.** `armed: false` builds the exact request
//    body, writes it to the journal, and returns a synthetic acknowledgement. A dry run cannot
//    place an order even if the caller ignores the return value, because the HTTP call is not
//    reached rather than merely skipped on a flag the response handler also checks.
//
// 2. **The research gate is checked before the credential.** `evaluateMarkets` returns
//    `gate: false` until there are 30 independent settlement events, a 5% Brier improvement over
//    both baselines, and positive paper P&L. On the current data the demand model is *worse* than
//    index persistence (see the backtest table in README), so arming today would be paying fees
//    to express a hypothesis the repository has already failed to support. Refusing on a closed
//    gate is therefore the normal case and not an error condition.
//
// 3. **Idempotency is deterministic, not random.** `client_order_id` is derived from the market,
//    side and observation timestamp, so re-running a cycle after a timeout cannot double the
//    position. A UUID would make a replay indistinguishable from a new intent.
//
// 4. **Every attempt is journalled before it is sent.** The journal is append-only and records
//    dry runs identically to live sends. "What did it try to do" must be answerable after a crash
//    that loses the response.
//
// VENUE DETAILS THAT ARE EASY TO GET WRONG
// ----------------------------------------
// The legacy `POST /portfolio/orders` answers **410 Gone**. The live create path is
// `/portfolio/events/orders`, and its schema is the fixed-point one: `side` is `bid`/`ask` against
// the *yes* price rather than `yes`/`no`, so buying NO at 0.30 is an `ask` at 0.70. The signature
// covers the path *including* the `/trade-api/v2` prefix and *excluding* the query string; signing
// the query yields a 401 that reads exactly like a bad key.

import { createHash, createSign } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, nowIso } from './utils.js';

const DEFAULT_BASE_URL = 'https://api.elections.kalshi.com';
const API_PREFIX = '/trade-api/v2';
const CREATE_PATH = `${API_PREFIX}/portfolio/events/orders`;
const CANCEL_PATH = `${API_PREFIX}/portfolio/events/orders`;
const ORDER_PATH = `${API_PREFIX}/portfolio/orders`;
const BALANCE_PATH = `${API_PREFIX}/portfolio/balance`;
const POSITIONS_PATH = `${API_PREFIX}/portfolio/positions`;

// The exact string the operator must put in the environment to arm the executor. A boolean would
// be settable by a stray `export HEDGE_ROUTER_LIVE=1` in a shell profile; a sentence cannot be
// typed by accident.
export const ARM_PHRASE = 'I accept live order risk';
export const ARM_ENV = 'HEDGE_ROUTER_LIVE_CONFIRM';
export const KEY_ID_ENV = 'KALSHI_API_KEY_ID';
export const PRIVATE_KEY_ENV = 'KALSHI_PRIVATE_KEY_PATH';

export class ExecutionRefused extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'ExecutionRefused';
    this.reason = reason;
  }
}

export class NotArmed extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotArmed';
  }
}

// Hard caps. Defaults are sized so that the worst credible outcome — every order fills and every
// filled contract settles worthless — costs under ten dollars. They are deliberately far below
// anything that would hedge a real AI bill: the first live run is a test of the wire, not of the
// thesis, and the thesis is what the gate is for.
export const DEFAULT_LIMITS = {
  maxContractsPerOrder: 10,
  maxOrdersPerRun: 5,
  maxNotionalPerOrder: 2.0,
  maxNotionalPerRun: 10.0,
  minBalanceDollars: 25.0,
  // Settlement risk is the one exposure a cancel cannot undo, so never rest an order inside this
  // window. Fifteen minutes is the shortest interval over which the resolve path can observe a
  // settlement and stop the next cycle.
  minSecondsToClose: 900
};

export function executionPaths(dataDir = DATA_DIR) {
  const liveDir = path.join(dataDir, 'live');
  return {
    dataDir,
    liveDir,
    journal: path.join(liveDir, 'orders.ndjson'),
    killSwitch: path.join(dataDir, 'HALT'),
    evaluation: path.join(dataDir, 'evaluation.json')
  };
}

function finitePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number`);
  return number;
}

function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) finitePositive(value, name);
  if (!Number.isInteger(limits.maxContractsPerOrder)) throw new Error('maxContractsPerOrder must be an integer');
  if (!Number.isInteger(limits.maxOrdersPerRun)) throw new Error('maxOrdersPerRun must be an integer');
  if (limits.maxNotionalPerOrder > limits.maxNotionalPerRun) {
    throw new Error('maxNotionalPerOrder cannot exceed maxNotionalPerRun');
  }
  return limits;
}

// Kalshi prices are a two-decimal probability. The venue rejects anything finer, and a float that
// prints as 0.6900000000000001 is rejected as a malformed body rather than rounded.
export function formatPrice(price) {
  const number = Number(price);
  if (!Number.isFinite(number) || number <= 0 || number >= 1) {
    throw new Error(`price must be strictly between 0 and 1, received ${price}`);
  }
  return Math.round(number * 100) / 100;
}

// `side` in the fixed-point schema is a bid or an ask on the YES price. A hedge expressed as "buy
// NO at 0.30" is an ask at 0.70, and the capital at risk is the 0.30 actually paid. Collapsing
// both into one place keeps the risk check and the request body from disagreeing.
export function orderIntent(signal) {
  const side = String(signal.side || '').toLowerCase();
  if (side !== 'yes' && side !== 'no') {
    throw new Error(`side must be yes or no to execute, received ${signal.side}`);
  }
  const entry = formatPrice(signal.entry_price);
  return side === 'yes'
    ? { venueSide: 'bid', venuePrice: entry, costPerContract: entry }
    : { venueSide: 'ask', venuePrice: formatPrice(1 - entry), costPerContract: entry };
}

// Deterministic, so a retry after a network timeout is the same order rather than a second one.
// The observation timestamp is included because a later cycle that re-prices the same market is a
// genuinely new intent and must not be deduplicated against the first.
export function clientOrderId(signal) {
  const digest = createHash('sha256')
    .update(`${signal.id}:${signal.observed_at}:${signal.side}:${signal.entry_price}`)
    .digest('hex')
    .slice(0, 24);
  return `hedgerouter-${digest}`;
}

export function signRequest({ keyId, privateKeyPem, method, requestPath, timestampMs }) {
  if (!keyId) throw new Error('A Kalshi API key id is required to sign a request');
  if (!privateKeyPem) throw new Error('A Kalshi private key is required to sign a request');
  // The query string is stripped here as well as by the caller: signing it returns 401, which is
  // indistinguishable from a wrong key and costs an hour to diagnose.
  const signedPath = String(requestPath).split('?', 1)[0];
  const message = `${timestampMs}${method.toUpperCase()}${signedPath}`;
  const signer = createSign('sha256');
  signer.update(message);
  signer.end();
  return signer.sign({
    key: privateKeyPem,
    padding: 6, // RSA_PKCS1_PSS_PADDING
    saltLength: 32 // Digest length, matching the verified Python signer.
  }, 'base64');
}

export async function loadCredentials(env = process.env, readFileImpl = readFile) {
  const keyId = (env[KEY_ID_ENV] || '').trim();
  const rawPath = (env[PRIVATE_KEY_ENV] || '').trim();
  if (!keyId || !rawPath) {
    return { available: false, keyId: null, privateKeyPem: null, keyPath: rawPath || null };
  }
  // `$HOME/...` and `~/...` both appear in shared credential files; handing either to readFile
  // verbatim fails with a bare ENOENT from inside a request.
  const expanded = rawPath
    .replace(/^~(?=\/|$)/, env.HOME || '')
    .replace(/\$(\w+)|\$\{(\w+)\}/g, (_, a, b) => env[a || b] || '');
  const privateKeyPem = await readFileImpl(expanded, 'utf8');
  return { available: true, keyId, privateKeyPem, keyPath: expanded };
}

async function fileExists(file) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

// The gate is read from the evaluation artifact rather than recomputed, so that what authorises a
// live order is the same number the operator can print with `hedge-router gate`. A missing or
// unparseable artifact is a closed gate, not an open one.
export async function readGate(paths = executionPaths(), readJsonImpl = null) {
  const load = readJsonImpl || (async (file) => JSON.parse(await readFile(file, 'utf8')));
  try {
    const evaluation = await load(paths.evaluation);
    return {
      open: evaluation?.gate === true,
      independentEvents: Number(evaluation?.independent_events ?? 0),
      relativeBrierImprovement: Number(evaluation?.relative_brier_improvement ?? 0),
      paperPnl: Number(evaluation?.paper_pnl ?? 0),
      source: paths.evaluation
    };
  } catch (error) {
    return {
      open: false,
      independentEvents: 0,
      relativeBrierImprovement: 0,
      paperPnl: 0,
      source: paths.evaluation,
      unavailable: error.code === 'ENOENT' ? 'no evaluation artifact' : error.message
    };
  }
}

export class Executor {
  constructor({
    armed = false,
    limits = {},
    baseUrl = DEFAULT_BASE_URL,
    paths = executionPaths(),
    fetchImpl = fetch,
    credentials = null,
    postOnly = true,
    now = null
  } = {}) {
    this.armed = armed === true;
    this.limits = resolveLimits(limits);
    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.paths = paths;
    this.fetchImpl = fetchImpl;
    this.credentials = credentials;
    this.postOnly = postOnly !== false;
    this.now = now;
    this.sent = 0;
    this.notional = 0;
    this.attempts = [];
  }

  timestamp() {
    return this.now || nowIso();
  }

  async journal(entry) {
    await mkdir(this.paths.liveDir, { recursive: true, mode: 0o700 });
    await appendFile(this.paths.journal, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  async request(method, requestPath, body = null) {
    if (!this.armed) {
      // Unreachable by construction: every mutating caller checks `armed` before building a
      // request. Kept as a hard stop so a future caller that forgets cannot open a socket.
      throw new NotArmed(`refusing to ${method} ${requestPath} while unarmed`);
    }
    const credentials = this.credentials || (this.credentials = await loadCredentials());
    if (!credentials.available) {
      throw new ExecutionRefused(
        `Live mode needs ${KEY_ID_ENV} and ${PRIVATE_KEY_ENV}`, 'missing-credentials');
    }
    const timestampMs = String(Date.now());
    const signature = signRequest({
      keyId: credentials.keyId,
      privateKeyPem: credentials.privateKeyPem,
      method,
      requestPath,
      timestampMs
    });
    const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'KALSHI-ACCESS-KEY': credentials.keyId,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    if (!response.ok) {
      // A read-only key answers 403 `insufficient_scope: write::trade required` here, which is
      // indistinguishable from a malformed body unless it is named.
      const scope = response.status === 403 && text.includes('write::trade')
        ? ' (this key can read but not trade)'
        : '';
      throw new ExecutionRefused(
        `Kalshi returned HTTP ${response.status} for ${method} ${requestPath}${scope}: ${text.slice(0, 300)}`,
        `http-${response.status}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async balance() {
    const response = await this.request('GET', BALANCE_PATH);
    return Number(response.balance ?? 0) / 100;
  }

  async positions() {
    return this.request('GET', POSITIONS_PATH);
  }

  async order(orderId) {
    return this.request('GET', `${ORDER_PATH}/${encodeURIComponent(orderId)}`);
  }

  async cancel(orderId) {
    const entry = {
      at: this.timestamp(), action: 'cancel', order_id: orderId, armed: this.armed
    };
    if (!this.armed) {
      await this.journal({ ...entry, dry_run: true });
      return { order_id: orderId, dry_run: true };
    }
    const response = await this.request('DELETE', `${CANCEL_PATH}/${encodeURIComponent(orderId)}`);
    await this.journal({ ...entry, response });
    return response;
  }

  // Preconditions that do not depend on the signal. Separated so `live-status` can report them
  // without constructing an order.
  async preflight() {
    const gate = await readGate(this.paths);
    const halted = await fileExists(this.paths.killSwitch);
    const confirmed = process.env[ARM_ENV] === ARM_PHRASE;
    const credentials = this.credentials || await loadCredentials();
    const blockers = [];
    if (!gate.open) {
      blockers.push({
        reason: 'gate-closed',
        detail: gate.unavailable
          ? `no passing evaluation: ${gate.unavailable}`
          : `evaluation gate is false (${gate.independentEvents}/30 independent events, ` +
            `Brier improvement ${(gate.relativeBrierImprovement * 100).toFixed(2)}% of 5%, ` +
            `paper P&L ${gate.paperPnl >= 0 ? '+' : ''}$${gate.paperPnl.toFixed(2)})`
      });
    }
    if (halted) blockers.push({ reason: 'halted', detail: `kill switch present at ${this.paths.killSwitch}` });
    if (!confirmed) blockers.push({ reason: 'not-confirmed', detail: `${ARM_ENV} is not set to the arming phrase` });
    if (!credentials.available) {
      blockers.push({ reason: 'missing-credentials', detail: `${KEY_ID_ENV} and ${PRIVATE_KEY_ENV} are not both set` });
    }
    return { gate, halted, confirmed, credentials_available: credentials.available, blockers };
  }

  // Per-order envelope. Throws rather than returning a flag: a caller that ignores a return value
  // must not thereby place an order.
  checkEnvelope({ contracts, costPerContract, closeTime }) {
    if (!Number.isInteger(contracts) || contracts < 1) {
      throw new ExecutionRefused(`contracts must be a positive integer, received ${contracts}`, 'bad-size');
    }
    if (contracts > this.limits.maxContractsPerOrder) {
      throw new ExecutionRefused(
        `${contracts} contracts exceeds maxContractsPerOrder ${this.limits.maxContractsPerOrder}`, 'cap-contracts');
    }
    if (this.sent >= this.limits.maxOrdersPerRun) {
      throw new ExecutionRefused(
        `already sent ${this.sent} orders; maxOrdersPerRun is ${this.limits.maxOrdersPerRun}`, 'cap-orders');
    }
    const notional = Math.round(contracts * costPerContract * 100) / 100;
    if (notional > this.limits.maxNotionalPerOrder + 1e-9) {
      throw new ExecutionRefused(
        `$${notional.toFixed(2)} at risk exceeds maxNotionalPerOrder $${this.limits.maxNotionalPerOrder.toFixed(2)}`,
        'cap-notional-order');
    }
    if (this.notional + notional > this.limits.maxNotionalPerRun + 1e-9) {
      throw new ExecutionRefused(
        `$${(this.notional + notional).toFixed(2)} cumulative at risk exceeds maxNotionalPerRun ` +
        `$${this.limits.maxNotionalPerRun.toFixed(2)}`, 'cap-notional-run');
    }
    const secondsToClose = (Date.parse(closeTime) - Date.parse(this.timestamp())) / 1000;
    if (!Number.isFinite(secondsToClose)) {
      throw new ExecutionRefused(`close time ${closeTime} is not a timestamp`, 'bad-close-time');
    }
    if (secondsToClose < this.limits.minSecondsToClose) {
      throw new ExecutionRefused(
        `${Math.round(secondsToClose)}s to close is inside the ${this.limits.minSecondsToClose}s buffer`,
        'too-close-to-settlement');
    }
    return { notional, secondsToClose };
  }

  // Build the exact body that would be sent. Pure, so a dry run and a live send cannot differ in
  // anything except whether the socket is opened.
  buildOrder(signal, contracts) {
    const { venueSide, venuePrice, costPerContract } = orderIntent(signal);
    return {
      body: {
        ticker: signal.id,
        side: venueSide,
        count: String(contracts),
        price: venuePrice,
        time_in_force: 'good_till_canceled',
        self_trade_prevention_type: 'taker_at_cross',
        // A hedge wants the fill, but an accidental taker on a thin book is the documented way
        // this family of markets takes money off you: the backtest skips one-sided and crossed
        // quotes for exactly that reason. post_only makes "became a taker" a venue rejection
        // instead of a bad price, and `--allow-taker` is the explicit opt-out.
        post_only: this.postOnly,
        cancel_order_on_pause: true,
        client_order_id: clientOrderId(signal)
      },
      costPerContract
    };
  }

  async place(signal, contracts) {
    const { body, costPerContract } = this.buildOrder(signal, contracts);
    const { notional } = this.checkEnvelope({ contracts, costPerContract, closeTime: signal.close_time });
    const attempt = {
      at: this.timestamp(),
      action: 'place',
      market_id: signal.id,
      intent_side: signal.side,
      venue_side: body.side,
      venue_price: body.price,
      contracts,
      notional_at_risk: notional,
      client_order_id: body.client_order_id,
      armed: this.armed,
      request: body
    };
    if (!this.armed) {
      const dry = { ...attempt, dry_run: true, order_id: `dry-${body.client_order_id.slice(-8)}` };
      await this.journal(dry);
      this.sent += 1;
      this.notional = Math.round((this.notional + notional) * 100) / 100;
      this.attempts.push(dry);
      return dry;
    }
    // Journal the intent before the send, so a crash between the two leaves evidence of what was
    // attempted rather than a silent gap.
    await this.journal({ ...attempt, phase: 'intent' });
    const response = await this.request('POST', CREATE_PATH, body);
    const orderId = response.order_id || response.order?.order_id;
    if (!orderId) throw new ExecutionRefused(`no order_id in response: ${JSON.stringify(response).slice(0, 300)}`, 'no-order-id');
    const placed = { ...attempt, phase: 'placed', order_id: orderId, response };
    await this.journal(placed);
    this.sent += 1;
    this.notional = Math.round((this.notional + notional) * 100) / 100;
    this.attempts.push(placed);
    return placed;
  }
}

// The one entry point the CLI uses. Arming requires all of: an open research gate, the arming
// phrase in the environment, a readable private key, no kill switch, and an explicit `live: true`
// from the caller. Any missing element downgrades to a dry run that reports why, because the
// useful output when the gate is closed is the order that *would* have been placed.
export async function executeSignals({
  signals,
  live = false,
  limits = {},
  paths = executionPaths(),
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  postOnly = true,
  contractsFor = null,
  now = null
}) {
  if (!signals || !Array.isArray(signals.results)) throw new Error('Signals document must contain results');
  const probe = new Executor({ armed: false, limits, paths, baseUrl, fetchImpl, postOnly, now });
  const preflight = await probe.preflight();
  const armed = live === true && preflight.blockers.length === 0;
  const executor = new Executor({ armed, limits, paths, baseUrl, fetchImpl, postOnly, now });

  if (live && !armed) {
    // Deliberately not an exception: the operator asked for live, and the most useful answer is
    // the full list of what is missing plus the orders that would have gone out.
    await executor.journal({
      at: executor.timestamp(),
      action: 'arm-refused',
      requested_live: true,
      blockers: preflight.blockers
    });
  }

  const sized = contractsFor || ((signal) => {
    const { costPerContract } = orderIntent(signal);
    const budget = Math.min(executor.limits.maxNotionalPerOrder,
      executor.limits.maxNotionalPerRun - executor.notional);
    return Math.max(0, Math.min(executor.limits.maxContractsPerOrder, Math.floor(budget / costPerContract)));
  });

  const placed = [];
  const refused = [];
  const candidates = [...signals.results]
    .filter((signal) => signal.side === 'yes' || signal.side === 'no')
    .sort((a, b) => Number(b.net_edge || 0) - Number(a.net_edge || 0));

  for (const signal of candidates) {
    try {
      const contracts = sized(signal);
      if (!contracts) {
        refused.push({ market_id: signal.id, reason: 'risk-budget-too-small' });
        continue;
      }
      placed.push(await executor.place(signal, contracts));
    } catch (error) {
      if (error instanceof ExecutionRefused) {
        refused.push({ market_id: signal.id, reason: error.reason, detail: error.message });
        continue;
      }
      throw error;
    }
  }

  return {
    mode: armed ? 'live' : 'dry-run',
    requested_live: live === true,
    gate: preflight.gate,
    blockers: preflight.blockers,
    limits: executor.limits,
    post_only: executor.postOnly,
    orders: placed,
    refused,
    notional_at_risk: executor.notional,
    journal: paths.journal
  };
}

export {
  DEFAULT_BASE_URL as KALSHI_TRADE_API_BASE_URL,
  CREATE_PATH as KALSHI_CREATE_ORDER_PATH
};
