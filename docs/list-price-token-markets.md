# The list-price token markets

Every hedge this project had tried before settled on an *index*. A GPU rental
index, or the Ornn token index. An index is a proxy, and a proxy is basis risk:
your invoice is not the index, so a correct forecast can still leave you unpaid.

In June 2026 Kalshi listed seven series that settle on something else entirely —
**the provider's own published price page**:

> If the Output Token Price of OpenAI GPT 5.5 on
> `https://openai.com/api/pricing/` is at or below $25 in 2026, then the market
> resolves to Yes.
> — `rules_primary`, `KXGBT55OY-27-NA-25`

> If the Input Token Price of Claude Opus 4.8 on `https://claude.com/pricing#api`
> is at or below $4 in 2026, then the market resolves to Yes.
> — `rules_primary`, `KXOPUS48Y-27-NA-4`

If you pay list price, that settlement variable is not correlated with your cost.
It *is* your cost. The chain of substitutions that
[`token-price-basis.md`](token-price-basis.md) had to argue about — rental price →
serving cost → posted price → your invoice — collapses to a single link.

![The GPT 5.5 output-token ladder on Kalshi, showing a 28.2 implied price and Yes
27¢ / No 79¢ on the $25 strike](img/kalshi-gpt55-output-token-ladder.png)

![The seven token-price series: GPT 5.5, Gemini 3.5 Flash and Claude Opus 4.8,
input and output](img/kalshi-token-price-series.png)

Note the `28.2 forecast` on the market page: a continuously updating market-implied
dollars-per-MTok for GPT 5.5 output, ranging from about 25.8 to 29 since June. That
number is not exposed anywhere in the public API — not on the series, event, or
market record — so it can only be read off the page or rebuilt from the ladder.

Everything below is measured from the public API on 2026-09-14. Numbers move;
the commands to re-measure are in each section.

## What the exposure actually is

The hedge these markets serve is not "runaway AI spend." Token prices have only
fallen. The exposure is the opposite one, and it is specific:

**You signed a fixed-price contract. The provider cuts list price. You keep
paying the old rate.**

A company committed to $25/MTok on GPT 5.5 output does not care that spend is
rising with volume — that is a budgeting problem, and no contract protects
against it. What it loses is the *option value* of the price cut everyone else
receives. That loss is exactly proportional to the gap between its contract and
the published list price, which is exactly what these markets pay on.

## The direction is YES, and getting it backwards is easy

These are `strike_type: less_or_equal` markets. YES pays when the price ends **at
or below** the strike. So the hedge against being locked into a *high* price is to
**buy YES**: the cut that hurts your contract is the event that pays.

Buying NO is the same bet as your contract, twice.

This is not a hypothetical confusion. On all 24 open markets, Kalshi's
`no_sub_title` field is byte-identical to `yes_sub_title` — both read
`"$25/MTok or below"`:

```
markets: 24 | yes_sub_title === no_sub_title: 24
```

Any interface or bot that labels the NO side from `no_sub_title` will describe the
NO contract as "at or below," which is the inverse of what it is. The repo now
carries the direction explicitly rather than inferring it from any label
(`strikeFor` in `src/market.js`), and `test/market.test.js` asserts the boundary
case in both directions, because on the strike the two conventions disagree:

```js
yesFromValue(15, 15, 'less_or_equal') === 1
yesFromValue(15, 15, 'greater')       === 0
```

## A worked hedge, and where it runs out

Take a book of 1B output tokens a year (1,000 MTok) contracted at $25/MTok on GPT
5.5, hedged with the four-rung `KXGBT55OY` ladder at the asks quoted on
2026-09-14. Size each rung to the incremental loss it covers:

| list price falls to | value lost vs list | contracts needed (cumulative) | premium paid | deepest rung as % of its own open interest |
| --- | --- | --- | --- | --- |
| $25 | $0 | 0 | $0 | — |
| $20 | $5,000 | 5,000 | $850 | 79% of 6,304 |
| $15 | $10,000 | 10,000 | $1,500 | 74% of 6,766 |
| $10 | $15,000 | 15,000 | $1,950 | **215% of 2,326** |

$1,950 of premium against $15,000 of contract value is a defensible price for the
insurance. The economics are not the problem.

**Capacity is.** The entire GPT-5.5-output ladder holds 18,095 contracts of open
interest — a maximum possible payout of $18,095 if you owned every contract on
every rung. Buying all of it at the ask costs $2,889. That means the whole ladder
currently supports roughly **one** customer hedging a ~1.2B output-token/year book
against a fall to $10. The second such customer moves the market against the
first.

Across all six series with open markets: 43,390 contracts of open interest,
121,053 contracts of lifetime volume, and **362 contracts of volume in the last 24
hours**. This is a real market with real two-sided depth and it is very small.

```sh
node -e 'import("./src/kalshi.js").then(async({fetchKalshiMarkets})=>{
  for (const m of await fetchKalshiMarkets({series:"KXGBT55OY",status:"open"}))
    console.log(m.ticker, m.cap_strike, m.yes_ask_dollars, m.open_interest_fp);
})'
```

## Spreads are tighter than the depth suggests

1,804 market-days of daily candlesticks since the markets opened between
2026-06-04 and 2026-06-08:

| measure | value |
| --- | --- |
| market-days observed | 1,804 |
| two-sided and executable | 1,783 (98.8%) |
| median yes spread | 5¢ |
| p90 yes spread | 7¢ |

A 5¢ spread on a contract priced at 13¢ is a 38% round-trip cost. For a hedge held
to expiry that is a one-time entry cost, not a recurring one — but it means these
markets cannot be traded, only held.

## Two ladders are not internally monotone

`P(price ≤ $20)` must be at least `P(price ≤ $15)`. Three rung pairs, both in the
Opus series, violate this on the ask:

```
KXOPUS48Y     ask(<=2)=0.06  < ask(<=1)=0.09
KXOPUS48OY    ask(<=10)=0.02 < ask(<=5)=0.05
KXOPUS48OY    ask(<=20)=0.07 < ask(<=15)=0.08
```

There is **no executable arbitrage** in any of them: no wider-cap ask sits below a
tighter-cap bid, so the spreads absorb the inconsistency. What it tells you is that
the rungs are quoted independently and nobody is enforcing coherence across the
ladder. Price a hedge rung by rung, not off the ladder's implied distribution.

## Operational defects worth knowing before you rely on these

These are Kalshi metadata errors, not repo bugs. Documented because a hedger
reading the API rather than the market page would be misled by each one.

1. **Three of seven *series* records name the wrong settlement source.**
   `KXGBT55OY`, `KXOPUS48OY` and `KXGEMINI35OY` all report
   `settlement_sources: [{ name: " San Francisco Unified School District", url: "https://www.sfusd.edu/" }]`
   — including `KXGBT55OY`, the highest-volume series of the seven at 50,178
   contracts. The corresponding *event* record is correct
   (`{ name: "OpenAI", url: "https://openai.com/api/pricing/" }`), and so is
   `rules_primary` on each market. The defect is confined to the series level; read
   the event or the market, not the series.
2. **`KXGBT55OY`'s series title says "Input."** The series is titled
   `GPT 5.5 Input Token`; its markets are titled
   `Will Output Token Price of OpenAI GPT 5.5 be at or below $25/MTok in 2026?`
   and their rules say `Output Token Price`. The strikes ($10–$25) confirm output.
   Trust the market, not the series.
3. **`no_sub_title` duplicates `yes_sub_title` on all 24 markets** — see the
   direction section above. This is the defect most likely to cost someone money.
4. **The category filter is many-to-many and unreliable for discovery.** All seven
   series report `category: "Commodities"` from `/series/{ticker}`, yet they are
   also returned by `/series?category=Financials`. A single-category sweep will
   miss them; a paginated `/markets` sweep drowns in `KXMVECROSSCATEGORY` parlay
   shards before reaching them. Enumerate by series ticker.
5. **The settlement source is not machine-readable.** `openai.com/api/pricing/`
   returns HTTP 403 to an automated fetch. Settlement can be verified by a human
   reading the page and cannot currently be verified by this pipeline. There is no
   API for the variable these contracts settle on.

## What cannot be claimed yet

**Zero of these markets have settled.** All 24 open markets close `2027-04-01`,
and every series has `settled: 0`:

```
KXGPT55Y 0 · KXGBT55OY 0 · KXOPUS48Y 0 · KXOPUS48OY 0
KXGEMINI35Y 0 · KXGEMINI35OY 0 · KXOPUS48M 0
```

They are annual contracts that resolve once. That has hard consequences:

- **No backtest is possible.** There are no settlement events, so there is no
  Brier score, no comparison against a naive baseline, and no paper P&L history.
- **The market gate cannot open on these series.** It requires ≥30 independent
  settlement events. These seven series can produce at most 7 in a year.
- **The 1,804 market-days of candles measure liquidity, not accuracy.** They tell
  you what it costs to get in. They say nothing about whether anyone's forecast of
  the settlement variable is any good.

So the honest status is: *the basis problem is solved and the forecasting problem
is untouched.* This project's whole claim to being research rather than a pitch is
that it does not trade a signal it has not measured out of sample. On these
markets it cannot measure one yet. What it can do is price them correctly, size
them, and refuse to pretend.

There is also a limit no amount of history would fix: `rules_secondary` excludes
"promotional, temporary, or volume-discount pricing — only the standard listed API
price applies." A customer whose $25/MTok comes from a negotiated enterprise
agreement is hedging **list price**, not their own rate. The hedge is a good proxy
for them only insofar as their contract is benchmarked to list.

## What the repo now does with them

`snapshotKalshiMarket` and `historicalSnapshot` previously rejected every one of
these markets with `unsupported strike type less_or_equal`. They now read the
strike from `cap_strike`, carry `strikeDirection` through the snapshot, the
forecast, the paper order and the settlement, and complement the forecast
probability so that YES always means "at or below." All 24 open markets snapshot
with zero skips:

```
KXGPT55Y      4 snapped  0 skipped   <=$4@25c <=$3@16c <=$2@13c <=$1@8c
KXOPUS48Y     4 snapped  0 skipped   <=$4@22c <=$3@16c <=$2@6c <=$1@9c
KXGBT55OY     4 snapped  0 skipped   <=$25@27c <=$20@17c <=$15@13c <=$10@9c
KXGEMINI35Y   4 snapped  0 skipped   <=$1.25@23c <=$1@19c <=$0.75@10c <=$0.5@6c
KXGEMINI35OY  4 snapped  0 skipped   <=$8@12c <=$7@10c <=$6@7c <=$5@7c
KXOPUS48OY    4 snapped  0 skipped   <=$20@7c <=$15@8c <=$10@2c <=$5@5c
```

The pipeline remains paper-only. No command in this repository can place a live
order, and nothing here is investment advice.
