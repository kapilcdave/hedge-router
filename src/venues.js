// What each venue can do today, stated as data so `hedge-router venues` cannot drift from the code.
//
// "tradable" means this repository can send an order there. It is a statement about code and
// credentials, not about whether the operator may legally trade the venue.

import { CME_TERMS } from './cme.js';

export const VENUES = [
  {
    id: 'kalshi',
    kind: 'prediction-market',
    instruments: 'binary compute-price, list-price and share contracts',
    data: true,
    execution: true,
    tradable: false,
    blocker: 'research gate closed (src/execute.js); arming also needs the phrase and a trade-scoped key',
    settles_on: 'per series: Ornn index, provider price page, or third-party chart'
  },
  {
    id: 'cme',
    kind: 'futures',
    instruments: 'Silicon Data H100 (GPU1) and B200 (GPU2) monthly rental index futures',
    data: false,
    execution: false,
    tradable: false,
    blocker: 'needs a futures broker (FCM); Alpaca lists no futures. Contract terms and sizing only',
    settles_on: CME_TERMS.settlement
  },
  {
    id: 'ornn',
    kind: 'index',
    instruments: 'H100/H200/B200/A100/RTX5090 GPU-hour index, token index',
    data: true,
    execution: false,
    tradable: false,
    blocker: 'reference data, not a venue',
    settles_on: 'n/a'
  },
  {
    id: 'polymarket-us',
    kind: 'prediction-market',
    instruments: 'unverified: no compute-price market has been found there',
    data: false,
    execution: false,
    tradable: false,
    blocker: 'no adapter until a compute contract is confirmed to be listed',
    settles_on: 'unknown'
  }
];

export function venueStatus() {
  return {
    tradable_now: VENUES.filter((venue) => venue.tradable).map((venue) => venue.id),
    venues: VENUES
  };
}
