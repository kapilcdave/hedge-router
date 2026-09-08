# The token-price hedge, and why the index is not a price

A contract on dollars-per-million-tokens is the hedge an API customer actually
wants. A GPU rental index hedges an inference bill only through a chain of
substitutions — rental price → serving cost → posted price → your invoice — and
every link is a source of basis. A $/token contract skips the chain.

Kalshi listed four such series in August 2026 (`KXOPENTOKEND`, `KXANTHTOKEND`,
`KXGOOGTOKEND`, `KXDEEPTOKEND`), settling on the Ornn Token Price Index. This
records what was measured before any of it was built on.

## The settlement variable is exactly reproducible

`GET /api/otpi` is public: four labs, trailing one month, no key. The collector is
`hedge-router otpi-history`:

```sh
hedge-router otpi-history --lab anthropic --chip ANTHROPIC-TOK \
  --start 2026-08-08 --end 2026-09-07 --output .hedge-router/otpi-anthropic.json
```

The free tier narrows a wider request instead of erroring, so the command reports
coverage and says so explicitly rather than letting withheld history read as
absent history.

Against all 87 settled token markets (8 ladders, 2 close dates), one rule fits
**8 of 8 ladders with zero exceptions**:

> settle on the OTPI print for `close_date − 1 day`, rounded to 2 decimals,
> YES if that value is **strictly greater** than the strike.

Grid-searching anchor (ticker date vs `close_time`), lag (0/1/2 days), rounding,
and strict-vs-inclusive comparison, no other combination fits more than 7:

| rule | ladders fit |
| --- | ---: |
| `close_time − 1d`, round to 2dp, `v > k` | **8 / 8** |
| ticker date − 1d, round to 2dp, `v > k` | 7 / 8 |
| `close_time − 1d`, raw, either comparison | 7 / 8 |
| same-day print, raw, `v >= k` | 3 / 8 |

The market's own `rules_secondary` confirms each element independently: "rounded
to two decimal places", `strike_type: greater`, and "the settled print available
at Expiration Time may reference the prior calendar day's Underlying". Anchoring
on the ticker date is what fails — the Anthropic `26AUG31` ladder closed early on
2026-08-14, and only `close_time` catches that.

So the settlement index is free, public, and reconstructible. The wall is not data
access.

## The index is a mix index wearing a price costume

Over 2026-08-08 → 2026-09-07 (31 settled days, four public labs):

| lab | first | last | change | days unchanged | daily sd | annualized | AR(1) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| anthropic | 1.6217 | 1.3928 | −15.2% | 0 / 30 | 12.28% | 235% | −0.32 |
| openai | 0.3859 | 0.3116 | −21.4% | 0 / 30 | 14.60% | 279% | −0.17 |
| google | 0.6309 | 0.4941 | −24.4% | 0 / 30 | 15.13% | 289% | +0.03 |
| deepseek | 0.0762 | 0.0950 | +22.0% | 0 / 30 | 12.53% | 239% | −0.05 |

The same statistics on the GPU index hedge-router actually trades, same window:

| index | days unchanged | daily sd | annualized | AR(1) |
| --- | ---: | ---: | ---: | ---: |
| H100 SXM | 1 / 30 | 4.39% | 84% | −0.10 |
| H200 | 1 / 30 | 3.32% | 63% | +0.28 |
| B200 | 0 / 30 | 2.42% | 46% | +0.33 |
| A100 SXM4 | 5 / 30 | 4.21% | 80% | −0.37 |

**Posted per-token prices do not move 12–15% per day.** They move in steps, a few
times a year, on announcement. A series that never once repeats a value, moves
12–15% daily, and has zero or negative autocorrelation is not measuring price. By
Ornn's own published method it is a *volume-weighted blend across each lab's paid
production models*, with light-coverage models dropped day by day — so almost all
of its variance is the **weights**: market-wide model mix and constituent churn,
not the price of anything a customer is quoted.

The GPU index, for contrast, behaves like a price: 3–4× less volatile, positive
autocorrelation on half the chips, and days where nothing changes.

Cross-lab correlation of daily changes is also incoherent with a common price
driver — `anthropic × openai` −0.116, `openai × google` −0.225,
`anthropic × deepseek` +0.436. There is no shared "inference is getting cheaper"
factor in these numbers; each lab's index wanders on its own mix.

## Which settles the basis question without a cost ledger

The basis measurement this doc was scoped to run — regress your realized
`$ / Mtok` on the index and read the hedge ratio — does not need to be run to be
answered, because the index side alone decides it:

- Your bill moves when **your** mix moves. OTPI moves when the **market's** mix
  moves. These are different weight vectors over the same posted prices, so their
  covariance is incidental.
- For a concentrated consumer the basis is total. A ledger that is 100%
  `claude-opus-5` has a *constant* realized $/Mtok: it printed 0% change over a
  month in which the Anthropic index printed −15.2%. Regressing a constant gives
  β = 0, R² = 0 exactly. No amount of extra data changes that.
- The basis shrinks only as your mix approaches the market's aggregate mix, which
  is not a property a single customer can arrange or verify.

Ornn does publish the decomposition that would make this precise —
`/api/workload` returns `priceEffect`, `mixEffect`, and `intensityEffect` per
provider, and `/api/token-volume` the weights behind them. Both are keyed;
Premium is $500/month. That would let the price component be separated and sized
rather than bounded. It is not needed to reach the verdict above, and it should
not be bought to confirm a negative.

## What was left standing, and the one live curiosity

Not tradeable: every token market is `finalized`, zero open, two close dates ever
(2026-08-14 and 2026-08-31), against a 30-event gate. Lifetime volume across all
87 markets is **4,779 contracts** — under $5k notional, ever — and 35 of 87 never
traded at all. Zero had a two-sided book at close.

One structural artifact is worth recording in case the series is relisted. The
markets closed at 14:00Z (10AM ET) and settled on a print Ornn publishes at
roughly 12:00Z the same morning. **The outcome was public and deterministic for
the final two hours of trading.** That is a genuine free option on paper and worth
nothing in practice: at close, every one of the 87 books was one-sided or empty,
liquidity `$0.00`, and the last trades were stale by more than 24 hours (e.g.
`KXOPENTOKEND-26AUG14-T0.41` last printed 76¢ on a contract that resolved NO).
The edge was never the scarce thing.

## Falsification, if this is ever revisited

The claim to attack is "OTPI variance is mix, not price". It fails if:

1. A posted-price table for a lab's production models, dated daily, reproduces the
   index's daily changes without reweighting. Cheap to test the moment such a
   table exists; the free API does not expose one.
2. `/api/workload`'s `priceEffect` carries a material share of `cCents` variance
   for `anthropic`/`openai`/`google`. This is the direct test and costs $500/month.
3. A consumer ledger with per-call cost shows realized $/Mtok tracking the index
   at β near 1 with R² above 0.5, measured on log first differences with a
   mismatched-lab placebo to rule out a shared trend, and with the day count
   discounted for autocorrelation — 31 daily points are far fewer than 31
   observations.

Note that (3) needs a gateway that reports cost. A Claude Code transcript carries
tokens but no per-call price, so realized $/token is not computable from it at
all; substituting a modeled price table makes the price component zero by
construction and measures only mix, which is the thing already established.
