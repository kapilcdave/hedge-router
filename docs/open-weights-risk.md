# Hedging open-weights risk: the listed market, and what it does not hedge

The pitch for an "open source is dying" hedge is that a company which built on
downloadable weights faces a cost shock if those weights stop shipping. That is a
real exposure. This records what is actually listed against it, what the listed
contract settles on, and what the traded data says about the premise.

Two things are separable and get conflated:

- **availability** — can I still download and run weights, under what licence
- **share** — how much of the market's inference is served by open weights

Only the second is listed. It is a mix variable, and the distinction is the same
one that closed the token-price work in [`token-price-basis.md`](token-price-basis.md).

## The premise, measured from settlements

`KXOPENSOURCESHARE` is a `greater` ladder, so a YES at strike `k` means the print
was above `k` and a NO means it was not: the highest YES and lowest NO bracket the
print. That recovers a history of the settlement variable without any access to
the publisher. `scripts/opensource-share.mjs` regenerates the whole table:

| close date | markets | volume | implied open-weights share |
| --- | ---: | ---: | --- |
| 2026-08-28 | 9 | 6,795 | (60%, 62%] |
| 2026-09-03 | 9 | 1,896 | (60%, 62%] |
| 2026-09-11 | 9 | 4,634 | (66%, 68%] |
| 2026-09-13 | 9 | 101 | > 75% — whole ladder settled YES |
| 2026-09-15 | 9 | 76,058 | (72.5%, 75%] |
| 2026-09-17 | 9 | 1,226 | (72.5%, 75%] |
| 2026-09-19 | 9 | 19,310 | unsettled at time of writing |
| 2026-09-25 | 9 | 0 | unsettled |

**The share rose from ~61% to ~74% in three weeks.** Whatever case there is for
open weights being in retreat, it is not this series, and a document that leads
with decline is contradicted by the only number the venue has settled on.

Two caveats that matter more than the trend:

1. This is **one gateway's traffic mix**, not the world's. A gateway whose users
   are disproportionately coding agents, and whose own routing defaults and model
   catalog change, will move this number for reasons that have nothing to do with
   the availability of weights.
2. The ladder lags the print. Strikes ran 52–68% on 2026-08-28 and 66–90% by
   2026-09-25, and on 2026-09-13 *every* strike settled YES — the listed range
   did not contain the outcome. That is n=1 and is recorded as an observation, not
   an edge.

## The settlement source is a vendor chart with no archive

`rules_secondary`, verbatim:

> This event resolves using the Open Weights percentage in Vercel AI Gateway's
> Open vs. Closed Token Volume chart. At 10:00 AM ET on \[date], Kalshi will use
> the chart's updated value for \[prior day].

What could be confirmed about that source:

- Not documented. `vercel.com/docs/ai-gateway` describes usage, spend, token
  counts and a Custom Reporting API as **authenticated, per-team** features. No
  public aggregate statistics are mentioned anywhere in the docs.
- Not fetchable as data. No public JSON endpoint was found. The chart was not
  present in the fetched markup of `vercel.com/ai-gateway` or
  `vercel.com/ai-gateway/models`; `vercel.com/ai-gateway/leaderboard` is a 404.
  It is most likely client-rendered, which is consistent with a chart that exists
  in a browser and nowhere else.
- No published methodology: no definition of which models count as open weights,
  no revision policy, no historical archive.

Contrast with the token-price series, where the settlement rule was reproducible
exactly from a free public endpoint. Here the settlement variable is **not
independently computable before or after the fact**, except by the strike-bracket
reconstruction above, which is ex-post and only ever brackets. A hedge whose
payout depends on a number only its publisher can see, under a methodology they
have not published and may revise, carries a settlement risk that is not priced
anywhere in the ladder.

## Why share is the wrong variable for the exposure

A company's open-weights exposure is that its costs rise if weights become
unavailable or restrictively licensed. The listed contract pays on the share of a
third party's traffic. These come apart completely:

- Share can fall because the *market's* mix shifted — a strong closed release, a
  price cut, one large customer re-routing — while every open-weight model you run
  remains downloadable at zero change in your cost.
- Share can rise while the specific model you depend on gets gated or relicensed.
- A company self-hosting one model family has a **constant** exposure to that
  family's availability and essentially no exposure to aggregate share. This is
  the same β = 0 argument that closed the token-price basis: your weight vector is
  not the market's weight vector, so the covariance is incidental.

Share is a demand proxy. It is a reasonable thing to speculate on and a poor thing
to hedge with.

## Availability instruments that are actually machine-readable

For a contract on availability rather than share, these were verified directly:

| source | endpoint | carries | verified |
| --- | --- | --- | --- |
| Hugging Face | `GET /api/models/{id}`, unauthenticated | `gated` (`"manual"` on `meta-llama/Llama-3.1-8B-Instruct`), `cardData.license` (`llama3.1`), `lastModified`, `createdAt`, `downloads` | yes |
| Hugging Face | `GET /api/models/{id}/commits/main` | would give a timestamped licence-change audit trail | **401, needs auth** |
| Epoch AI | `epoch.ai/data/all_ai_models.csv`, CC-BY | `Model accessibility` (API access / Hosted / Open weights / Unreleased), `Open model weights?`, `Publication date`; major models added within ~2 weeks | yes |

`gated` and `cardData.license` are the closest thing to a direct availability
trigger: a model moving to gated, or a licence string changing, is exactly the
event a self-hoster fears, and both are public single-field reads. The weakness is
that the *current* value is free but the *history* is not — the commits endpoint
needs a token, so a settlement rule over "did the licence change" requires either
authenticated access or an independently maintained daily snapshot. Snapshotting
those two fields daily across a watchlist costs nothing and is the cheapest thing
that would make such a contract settleable.

`hedge-router availability-snapshot` now does it: 12 models, one row per model per
UTC date, first captured 2026-09-21 with 12 of 12 resolved. Two corrections to the
table above came out of building it. A model id that does not exist returns **401**,
not 404 — the same status a deleted or newly private repo would return — so
disappearance, the strongest availability event, is the one this source cannot
confirm without a token. And `cardData.license` is not sufficient on its own:
`Qwen/Qwen2.5-72B-Instruct` is `license: "other"` with the terms in `license_name`,
and `deepseek-ai/DeepSeek-V3` carries no `cardData.license` at all.
[`availability-snapshot.md`](availability-snapshot.md) records the ledger's
semantics and the four ways a naive version settles wrong.

Adjacent series exist as shells with zero markets listed — `KXAIOPEN` (frontier
open-source model), `KXBESTLLMOS`, `KXOPENSOURCEOAI`, `KXGROK2OS`, `KXCMECOMPUTE`
(will CME offer compute futures before 2027). They resolve in the series endpoint
and return no markets at any status, so there is nothing to measure on them.

## The software-supply-chain reading, which has better data

"Open source risk" also means the other thing: a cyber book with correlated tail
exposure to one widely-deployed open-source component. That reading has settlement
substrate the AI reading does not, and all three of these were verified:

- **CISA KEV** — 1,716 entries, public CSV and JSON feeds
  (`/sites/default/files/feeds/known_exploited_vulnerabilities.json`, schema
  updated 2026-09-02). Per entry: CVE, vendor/product, date added, due date,
  ransomware-use flag, BOD 26-04 forensic-triage flag. Objective and fast.
- **OSV.dev** — free, unauthenticated, no stated rate limits. `POST /v1/query`,
  `POST /v1/querybatch`, `GET /v1/vulns/{id}`. Open-source-specific by
  construction, which is the exact population the AI-side sources cannot isolate.
  32 MiB response cap on HTTP/1.1.
- **Cyber Monitoring Centre (UK)** — independent non-profit, **funded by CFC**
  (a cyber insurer), built to categorise UK cyber events 1–5 on percentage of UK
  organisations impacted and financial impact. Inputs: polling, technical
  indicators, incident data, and firsthand insight; a Technical Committee sets the
  classification. Began categorising 2025-02-06. Statements issued on retail-sector
  ransomware (Jun 2025), Jaguar Land Rover (Oct 2025), and Canvas (Jun 2026).

The CMC is the closest thing in existence to a purpose-built public settlement
index for cyber loss — it was created by the insurance market to *be* a common
benchmark, which is the opposite provenance from an undocumented vendor chart. Its
disqualifying property for short-dated binaries is stated on its own methodology
page: **the target is 30 days from the event being known**, by committee, and in
2025 it ran longer. KEV and OSV settle fast and mechanically, but a CVE being
published is not a loss, and the gap between "exploited in the wild" and "someone
paid a claim" is where the basis lives. No number here bridges that gap yet.

## Unverified — do not cite

No web search was available while compiling this; every claim above was fetched
from a named URL. These names came up in drafting and **could not be verified from
any primary source**, so they must not appear in anything that leaves this repo:
a "BenchLM Token Price Index" (`benchlm.com/data/price-index.json` returns
nothing; the real index this repo uses is Ornn's OTPI), a Meta closed-weights
model called "Muse Spark", and an "OCPI" cleared by ICE. Treat as fabricated until
a primary source says otherwise.

## Falsification

The claim to attack is "the listed share market does not hedge open-weights
availability". It fails if:

1. A ledger of realised costs for a self-hosting consumer tracks the recovered
   share series at β near 1. The bracket history gives at most 6 coarse points, so
   this is not testable until a real index history exists.
2. The publisher exposes the chart as data with a methodology, at which point the
   settlement-risk objection narrows to methodology revisions only.
3. Availability events and share moves turn out to be contemporaneous — testable
   for free by snapshotting Hugging Face `gated`/`license` daily and comparing
   against the next settled bracket. This is the cheapest open test, and the
   snapshot side of it is now running; the ledger starts 2026-09-21 and holds one
   day, so there is nothing to compare yet.

And the premise claim, "the open-weights share is rising", fails if the bracket
series reverses. It is six settled days on one gateway; it should be re-run, not
believed.
