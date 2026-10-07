// CME Group compute futures: contract terms and hedge sizing. Read-only by construction.
//
// Terms come from the NYMEX Submission No. 26-370 (filed 2026-08-11, listing on Globex Sunday
// 2026-10-04 for trade date 2026-10-05, subject to CFTC approval). Nothing here opens a socket:
// CME is reached through a futures commission merchant, and no FCM credential exists in this
// repository, so an order can be *described* (and journalled as a dry run) but never sent.
//
// The point of this file that is easiest to get wrong: the contract does NOT settle on the Ornn
// index the rest of the pipeline forecasts. It settles on the arithmetic mean of Silicon Data's
// on-demand index over every business day of the contract month. Using an Ornn forecast to price
// it imports an unmeasured basis, so `basis` is reported on every sizing rather than assumed zero.

export const CME_CONTRACTS = {
  H100: { globex: 'GPU1', clearport: '1045', index: 'SD-H100', title: 'Silicon Data H100 Rental Index Futures' },
  B200: { globex: 'GPU2', clearport: '1047', index: 'SD-B200', title: 'Silicon Data B200 Rental Index Futures' }
};

export const CME_TERMS = {
  contractGpuHours: 730,
  tick: 0.01,
  tickValue: 7.3,
  listedMonths: 36,
  blockMinimum: 5,
  // Per contract, from the filing's Exhibit C. Exchange fees only: the FCM commission is extra and
  // unknown until an account exists.
  fees: {
    globexMember: 3.65, globexNonMember: 5.5,
    cashSettlementMember: 0.9, cashSettlementNonMember: 1.35
  },
  settlement: 'arithmetic mean of the Silicon Data on-demand index over each business day of the contract month',
  source: 'NYMEX Submission 26-370; CME SER-9785'
};

const MONTH_CODES = 'FGHJKMNQUVXZ';

export function resolveCmeContract(chip) {
  const key = String(chip || '').trim().toUpperCase();
  const contract = CME_CONTRACTS[key];
  if (!contract) throw new Error(`No CME compute future for ${chip}. Listed: ${Object.keys(CME_CONTRACTS).join(', ')}`);
  return { chip: key, ...contract };
}

// `2026-12` -> `GPU1Z6`. Globex single-digit year is conventional for the nearest decade; confirm
// the exact symbol at the FCM before routing anything.
export function cmeSymbol(chip, month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month || '');
  if (!match) throw new Error('month must be YYYY-MM');
  return `${resolveCmeContract(chip).globex}${MONTH_CODES[Number(match[2]) - 1]}${match[1].slice(-1)}`;
}

// Weekdays only. CME/Silicon Data holiday handling is not in the filing, so a holiday is counted as
// a business day here and the resulting error is at most one day in the average.
export function businessDays(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!match) throw new Error('month must be YYYY-MM');
  const days = [];
  const cursor = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  while (cursor.getUTCMonth() === Number(match[2]) - 1) {
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

// Expected final settlement given prints so far. Days already published are locked into the mean;
// only the remainder carries forecast risk, which is why a mid-month hedge needs fewer contracts
// than the full-month GPU-hours imply.
export function floatingPrice({ month, observed = {}, forecast }) {
  const days = businessDays(month);
  const forecastPrice = Number(forecast);
  if (!Number.isFinite(forecastPrice) || forecastPrice <= 0) throw new Error('forecast must be a positive price');
  let locked = 0;
  let lockedCount = 0;
  for (const day of days) {
    const price = Number(observed[day]);
    if (Number.isFinite(price) && price > 0) { locked += price; lockedCount += 1; }
  }
  const remaining = days.length - lockedCount;
  return {
    expected: (locked + remaining * forecastPrice) / days.length,
    businessDays: days.length,
    lockedDays: lockedCount,
    unlockedShare: remaining / days.length
  };
}

export function cmeFee(contracts, { member = false } = {}) {
  if (!Number.isInteger(contracts) || contracts < 1) throw new Error('contracts must be a positive integer');
  const { fees } = CME_TERMS;
  const perContract = member
    ? fees.globexMember + fees.cashSettlementMember
    : fees.globexNonMember + fees.cashSettlementNonMember;
  return Math.round(contracts * perContract * 100) / 100;
}

// A consumer of compute hedges by going long: the position gains when the monthly average rises.
// Whole contracts only, so the residual is reported rather than hidden.
export function sizeCmeHedge({ chip, month, gpuHours, entryPrice, hedgeRatio = 1, member = false }) {
  const contract = resolveCmeContract(chip);
  const hours = Number(gpuHours);
  const entry = Number(entryPrice);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('gpuHours must be positive');
  if (!Number.isFinite(entry) || entry <= 0) throw new Error('entryPrice must be a positive $/GPU-hour');
  if (!Number.isFinite(hedgeRatio) || hedgeRatio <= 0 || hedgeRatio > 1) throw new Error('hedgeRatio must be in (0, 1]');
  const contracts = Math.round((hours * hedgeRatio) / CME_TERMS.contractGpuHours);
  const hedgedHours = contracts * CME_TERMS.contractGpuHours;
  return {
    venue: 'cme',
    symbol: cmeSymbol(chip, month),
    index: contract.index,
    side: 'long',
    contracts,
    hedged_gpu_hours: hedgedHours,
    unhedged_gpu_hours: Math.round((hours - hedgedHours) * 100) / 100,
    notional: Math.round(hedgedHours * entry * 100) / 100,
    pnl_per_tick: CME_TERMS.tickValue * contracts,
    exchange_fees: contracts ? cmeFee(contracts, { member }) : 0,
    // Not zero and not measured: Ornn and Silicon Data are different indexes.
    basis: { versus: 'ornn', measured: false },
    can_send: false,
    blocker: 'no FCM account or credential; this repository has no CME order path'
  };
}

// A journal-only record in the same shape executeSignals writes, so a CME intent can sit in the
// same orders.ndjson. `armed` is a constant: there is nothing for an arming phrase to unlock.
export function cmeDryRunIntent({ sizing, limitPrice, at = new Date().toISOString() }) {
  const price = Number(limitPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error('limitPrice must be positive');
  if (Math.abs(price / CME_TERMS.tick - Math.round(price / CME_TERMS.tick)) > 1e-9) {
    throw new Error(`limitPrice ${limitPrice} is off the $${CME_TERMS.tick} tick`);
  }
  return {
    at, action: 'place', venue: 'cme', dry_run: true, armed: false,
    symbol: sizing.symbol, side: 'buy', contracts: sizing.contracts, limit_price: price,
    time_in_force: 'day'
  };
}
