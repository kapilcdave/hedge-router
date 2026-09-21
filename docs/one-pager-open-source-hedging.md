# Hedging open-source exposure: four contracts and what they settle on

*2026-09-19. Every figure below was fetched from a named public source; the share
series is reproducible with a 120-line script.*

## The exposure is growing, not shrinking

Open-weights models served **(60%, 62%]** of tokens through Vercel's AI Gateway on
2026-08-28 and **(77.5%, 80%]** by 2026-09-19 — an 18-point rise in 22 days, across
seven settled days.

That series is not published anywhere. I recovered it from Kalshi's own
resolutions: `KXOPENSOURCESHARE` is a `greater` ladder, so the highest YES strike
and the lowest NO strike bracket the print each day.

| close date | implied open-weights share | ladder volume |
| --- | --- | ---: |
| 2026-08-28 | (60%, 62%] | 6,795 |
| 2026-09-11 | (66%, 68%] | 4,634 |
| 2026-09-15 | (72.5%, 75%] | 76,058 |
| 2026-09-17 | (72.5%, 75%] | 1,226 |
| 2026-09-19 | (77.5%, 80%] | 27,662 |

More production inference depends on downloadable weights every month. That is the
case for the hedge: the dependency is compounding, and nobody who has it can price
it today.

## What is already listed, and what it misses

`KXOPENSOURCESHARE` has 72 markets, 110,020 contracts of lifetime volume and 87,562
open interest. 51 of 72 have traded. Thin in absolute terms, but real, and it is
the only listed contract in this space.

It pays on the **share** of one gateway's traffic. A company self-hosting Llama has
a constant exposure to whether those weights stay downloadable and essentially no
exposure to aggregate share — share can fall on a strong closed release while
their costs never move, and rise while the one model they depend on gets gated.
Their weight vector is not the market's, so the covariance is incidental. Share is
a demand proxy. It is a good thing to speculate on and a poor thing to hedge with.

## Four contracts, ranked by whether they can actually resolve

| contract | buyer | settles on | status |
| --- | --- | --- | --- |
| Open-weights token share | speculator | Vercel AI Gateway chart | **listed**; source has no API, methodology or archive |
| Model availability / licence | self-hoster with usage-based spend | Hugging Face `gated` + `cardData.license`, unauthenticated | not listed; **daily snapshot now running**, 12 models from 2026-09-21 |
| Frontier open-weights release | anyone building on open weights | Epoch AI `all_ai_models.csv` (CC-BY), `Open model weights?` | not listed; ~2-week lag, annual tenor only |
| OSS supply-chain event | **cyber insurers and reinsurers** | CISA KEV feed, OSV.dev, UK Cyber Monitoring Centre | not listed; best data of the four, and **no source of this class appears in any of Kalshi's 14,228 series** |

A fifth is listed and larger than any row above: an OpenRouter **model-author**
share family, 284 markets and 3,080,139 contracts of lifetime volume. Its
settlement variable is reproducible from a free unauthenticated endpoint — and it
is *request* share, not the token share everyone reads off the chart; the two rank
the authors differently and the settled prints follow requests to 0.09 share
points. [`settlement-sources.md`](settlement-sources.md) has the recipe, and the
reason it still is not a hedge: the reproducible view keeps no archive, so 20 of
25 settled prints can no longer be checked by anyone.

## The settlement problem, which is the whole problem

The listed contract resolves on "the Open Weights percentage in Vercel AI Gateway's
Open vs. Closed Token Volume chart." That chart is undocumented — Vercel's AI
Gateway docs describe usage statistics as authenticated, per-team features. There
is no public JSON endpoint, no stated methodology for which models count as open
weights, no revision policy and no historical archive. A payout depends on a number
only its publisher can see, computed a way they have not described.

The contrast is instructive. **Hugging Face** serves `gated` and
`cardData.license` for any model with no auth (`meta-llama/Llama-3.1-8B-Instruct`
is `gated: "manual"`, licence `llama3.1`). A model becoming gated or relicensed is
exactly the event a self-hoster fears, and it is a public single-field read. The
weakness is history, not access: the commit endpoint requires a token, so a
"did the licence change" rule needs either authenticated access or an independent
daily snapshot. **Snapshotting those two fields across a watchlist costs nothing
and is the cheapest thing that makes an availability contract settleable** — that
snapshot runs in this repo from 2026-09-21, 12 models, 12 of 12 resolved. One limit
found in building it: a model id that does not exist answers **401**, the same as a
deleted or newly private repo would, so *disappearance* is the one availability
event this source cannot confirm unauthenticated.

For the supply-chain row: CISA's KEV catalog publishes 1,716 entries as public CSV
and JSON with CVE, vendor/product, date added and a ransomware flag. OSV.dev is
free and unauthenticated with no stated rate limits, and is open-source-specific by
construction. The UK **Cyber Monitoring Centre** — an independent non-profit funded
by cyber insurer CFC — categorises UK cyber events 1 to 5 on the percentage of UK
organisations affected and financial impact, explicitly so the market has a common
public benchmark. Its constraint is on its own methodology page: a 30-day target,
set by committee. That rules it out for short-dated binaries and makes it a
credible trigger for annual cover.

## Who the buyer is

Not a $20 subscription. The buyer has **usage-based** spend that moves with token
prices and model availability, and is concentrated enough in one model family that
the exposure is legible on their own invoice. The insurer row is a different buyer
with the same structure: a cyber book carries correlated tail exposure to a single
widely-deployed open-source component, and that tail is expensive to reinsure and
currently impossible to hedge.

## What I would need to go further

A realised-cost ledger from one self-hoster, to measure how much of their bill
actually moves with any of these four variables. Without it, the basis for every
row above is argued rather than measured — and the basis is the only thing that
decides whether these are hedges or just bets.
