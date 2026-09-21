# Settlement records Kalshi can actually use for open-source risk

*Every number below was fetched from a named public endpoint on 2026-09-21.
`scripts/author-share.mjs` regenerates the reproduction section.*

[`open-weights-risk.md`](open-weights-risk.md) argued that the listed share market
settles on a vendor chart with no API, no methodology and no archive, and treated
that as the ceiling of what the venue will accept. That was wrong in both
directions, and this records what the catalog actually shows.

It is wrong optimistically, because a much larger and more liquid family of
open-source markets exists than the one that document measures, and its
settlement variable **is** reproducible from a free endpoint — but not the
variable everyone assumes. It is wrong pessimistically, because the sources the
document recommends instead (CISA KEV, OSV.dev, the Cyber Monitoring Centre) have
no precedent anywhere in Kalshi's 14,228 series. The bar is not "is this good
data". The bar is "has this venue ever underwritten a source of this class".

## What Kalshi demonstrably accepts

The whole catalog is one page at `limit=1000`: **14,228 series**, declaring
**3,020 distinct settlement sources**. In the Science & Technology / AI part of
that catalog, every source is a vendor leaderboard or vendor dashboard — Ornn,
OpenRouter, Vercel, Artificial Analysis, LM Arena, Ramp, LMSYS-on-Hugging-Face,
Hugging Face model cards.

Searching the source list for the supply-chain instruments returns nothing. There
is **no CISA, NVD, OSV, npm, PyPI, OpenSSF, or CMC source in any of the 14,228
series**. So the comparison in `open-weights-risk.md` — an undocumented vendor
chart versus an archived government feed — is not a comparison between something
Kalshi listed and something better it could have listed. It is a comparison
between the only class Kalshi has ever used and a class it has never used once.
The supply-chain row of the one-pager is a proposal for a new source class, and
should be argued as one.

## The family the repo was not measuring

`KXOPENSOURCESHARE` (the Vercel chart, 72 markets, 110,020 contracts) is not the
main event. A second family settles on OpenRouter and is 28× larger:

| series | markets | lifetime volume | open interest |
| --- | ---: | ---: | ---: |
| `KXANTHSHARE` | 49 | 673,336 | 392,871 |
| `KXGOOGSHARE` | 50 | 591,222 | 290,008 |
| `KXTENCENTSHARE` | 46 | 556,521 | 279,478 |
| `KXDEEPSHARE` | 52 | 548,583 | 292,245 |
| `KXOPENSHARE` | 57 | 512,000 | 331,382 |
| `KXSTEALTHSHARE` | 11 | 194,748 | 145,314 |
| `KXZAISHARE` | 19 | 3,728 | 3,711 |
| **total** | **284** | **3,080,139** | **1,735,009** |

257 of 284 markets have traded. 31 events are finalized. Declared source:
`OpenRouter - AI Market Share`, `https://openrouter.ai/rankings#market-share`.
`rules_primary` is of the form *"If Google scores above 16.4% on OpenRouter text
market share by model author week of Sep 14, 2026, then the market resolves to
Yes"*, with `rules_secondary` adding *"10:00AM ET Monday updated values"* and an
`others` clause.

This matters for the availability thesis because these are the same open-weight
authors the availability ledger watches — DeepSeek, Google, Tencent, Z-AI,
Moonshot — and a contract that already trades 3.08M contracts is a better place to
look for basis than one that trades 110,020.

## The settlement variable is requests, not tokens

Two public datasets sit behind the phrase "text market share by model author",
and they are not the same number. Both are unauthenticated:

| endpoint | what it holds | archive |
| --- | --- | --- |
| `/api/frontend/v1/rankings/market-share` | weekly **token** volume per author, top 10 plus an `others` bucket | **53 weekly buckets**, 2025-09-22 → 2026-09-21 |
| `/api/frontend/v1/rankings/models` | per-model totals including a request `count` | **one trailing week**, no history |

Token share does not reproduce the settled prints. Request share does — and the
two do not even rank the authors in the same order, which is what makes the test
decisive rather than a matter of tuning:

| author | Kalshi settled, week of Sep 14 | requests | tokens |
| --- | ---: | ---: | ---: |
| deepseek | 25.4 | 25.54 | 25.66 |
| google | 18.6 | **18.78** | 5.37 |
| tencent | 6.4 | **6.46** | 13.43 |
| anthropic | 2.7 | 2.72 | 3.60 |
| z-ai | 9.4 | **9.43** | 14.71 |

Mean absolute error over the five prints: **0.086 share points on requests,
5.346 on tokens.** Google and Tencent are inverted between the two metrics and
the settled prints follow requests both times. Z-AI was not used to choose the
metric — it was scored after the recipe was fixed, and it lands within 0.03.

The recipe that reproduces it:

1. `GET /api/frontend/v1/rankings/models`, unauthenticated.
2. Keep only the dominant `date` stamp. The payload is **not** a panel: 539 of
   572 rows carry one date, and that date's token total is 127.91T against the
   weekly chart's 128.90T for the corresponding bucket — a ratio of 0.992. The
   rows are a **trailing-week total stamped at the end of the window**, not a day.
3. Keep only rows with `total_completion_tokens > 0`. The payload also carries
   embedding, rerank, speech and video models (`voyageai/voyage-4-lite` alone is
   6.1M requests, `deepgram/nova-3` 170k, `runway/gen-4.5`, `google/veo-3.1`),
   which is 6.3% of all requests and none of the "text" the rule names. Every
   media counter in the payload — `image_output_requests`, `num_media_prompt`,
   `rerank_documents`, `stt_transcript_characters` — is **zero-filled on all 539
   rows**, so filtering on them removes nothing. A filter that appears to work and
   removes zero rows is the trap here; the token column is the only usable
   discriminator.
4. Sum `count` by the namespace before the `/` in `model_permaslug`, take the top
   15, and normalize within them.

The denominator is the one part not identified. Every cut from all-authors to
top-15 fits the five prints inside 0.1–0.9 points, and five prints cannot choose
between them. Top-15 is the best fit, not a recovered rule.

## Why reproducibility does not make it settleable

The archived dataset is the wrong variable and the right variable has no archive.
That is the whole finding, and it is worse than "no API":

- **The reproducible view is a single trailing window.** 20 of the 25 numeric
  settled prints in this family cannot be checked against any public data today.
  A print can be verified on settlement morning and never again. A disputed
  settlement is unauditable a week later — by anyone, including the venue.
- **The archived view's newest bucket is live.** The 2026-09-21 point read 17.56T,
  then 18.01T minutes later, against ~128T for a complete week. The rule reads
  "10:00AM ET Monday updated values for the week of \[date]", and on Monday
  morning that bucket holds a couple of hours of traffic. Which authors are even
  displayed in it is close to arbitrary.
- **The chart is top-10 plus `others`, and membership churns.** 21 authors have
  appeared across 53 weekly buckets for 9–10 slots, with **1.27 authors entering
  or leaving the displayed set per week**. The smallest displayed author's share
  runs 1.28–5.90% (median 3.18%). Under the `others` clause, absence is an
  automatic all-NO regardless of the actual number:

  | author | weeks displayed | weeks that would have voided |
  | --- | ---: | ---: |
  | google, anthropic, openai, deepseek | 53/53 | 0 |
  | z-ai | 48/53 | 5 |
  | qwen | 34/53 | 19 |
  | minimax | 32/53 | 21 |
  | xiaomi | 29/53 | 24 |
  | x-ai | 28/53 | 25 |
  | tencent | 22/53 | **31** |
  | mistralai | 15/53 | 38 |
  | nvidia | 14/53 | 39 |
  | moonshotai | 11/53 | 42 |

  `KXTENCENTSHARE` has 556,521 contracts of volume on an author displayed in 42%
  of weeks. A buyer of NO there is partly buying a display cut: the contract is
  not on the author's share, it is on the joint event of the share and the author
  being rendered.
- **The author key is a namespace, not a company.** Meta ships as `meta-llama`
  (1.85% of requests) *and* `meta` (0.88%) in the same current window, and the
  weekly chart has never displayed both in one bucket — `meta-llama` through
  October 2025, `meta` from September 2026. A "Meta market share" contract is
  ambiguous by a factor of two depending on which key the chart happens to show.
  `openrouter` itself is an author in 10 of 53 weeks, and `typesafe` — an
  application, not a lab — outranks Anthropic by requests (2.71% vs 2.72%,
  8th and 7th).
- **The week named in the rule is prose.** 11 of the 31 finalized events name a
  day that is not a Monday and therefore not a bucket label in the source at all
  (`KXOPENSHARE-26SEP21` says "week of Sep 17"; `KXZAISHARE-26SEP21` says the same
  and settled to 9.4). It is not machine-readable and should not be parsed.

## Two corrections to this repo's own method

**`expiration_value` is a display field.** `scripts/opensource-share.mjs` recovers
the settlement variable from strike brackets, which is sound, but the companion
habit of reading `expiration_value` is not. Four events in this family settled
all-NO; two carry the number (`"21.8"`, `"2.5"`) and two carry the literal string
`"No"`. `KXOPENSHARE-26SEP21` carries `"No"` and was **not** an `others` void:
OpenAI measured 17.20% of requests, ranked third, and the ladder's lowest strike
was 18, so every market was correctly NO. Reading `"No"` as "the author fell into
`others`" — which is what I did before measuring it — inverts the cause. Of the
two `"No"` events, only `KXTENCENTSHARE-26AUG24` is consistent with a genuine
void, and with no archive it cannot be separated from a ladder listed above a
≤1.5% print.

**An all-NO ladder is the venue's error, not the source's.** Three of the four are
ladders listed off the print, including one 12-market event. That is a listing
process that does not see the number it is bracketing until after it has listed —
consistent with a settlement source whose current value is not archived.

## The archive is now running

`author-share-snapshot` writes one row per author per trailing window to
`.hedge-router/author-share.ndjson`, and `author-share-report` derives shares from
it at read time. First window captured 2026-09-21:

| | |
| --- | ---: |
| window end / week start | 2026-09-20 / 2026-09-14 |
| authors | 71 |
| model rows on the window date | 539 of 572 |
| generation requests | 5,526,669,903 |
| requests excluded as non-generation | 369,456,475 (6.3%) |
| authors never displayed in the token chart | 62 of 71 |
| `weeks_until_backtestable` | 11 |

Its top-15 shares reproduce the five 2026-09-21 prints to the same 0.086 as the
one-off script, so the collector and `scripts/author-share.mjs` agree. Four design
choices are load-bearing, and each one is a trap this family already contains:

- **Counts are archived; shares are derived.** Five simultaneous prints fit every
  denominator from all-authors to top-15 inside 0.9 points, so the cut is *not
  identified*. Writing a share into the ledger would freeze a guess into the record
  the ledger exists to be. The report publishes all three cuts side by side; where
  they disagree by more than a strike increment, the print does not discriminate
  either.
- **The window is the dominant date, not the latest.** 539 of 572 rows carry one
  date and 33 are stragglers on other days. `max(date)` would reduce each week to
  whichever handful of models reported last.
- **Namespaces are never merged into companies.** `meta` and `meta-llama` are kept
  apart, because summing them would hide the factor-of-two ambiguity the contract
  actually carries. Three live rows (`text-embedding-3-small`,
  `text-embedding-3-large`, and one empty permaslug) have no namespace at all;
  they are bucketed as unattributed rather than dropped or guessed — attributing
  them would invent traffic for OpenAI, and throwing would void a week that cannot
  be re-fetched.
- **A partial week must not be archived as a week.** Two guards: the window has to
  be Monday-to-Sunday, and its token total has to be in line with recent complete
  weeks. The first version of the second guard compared against the median of *all
  52* archived buckets and scored a complete week at **6.25×**, because weekly
  volume grew from ~20T to ~128T over the archived year — against a year-old median
  a half-finished 60T week reads 0.97 and passes the check built to catch it. A
  trailing 4-week reference measures completeness; a full-history one measures
  growth. The complete window now reads 1.009.

Twelve windows is the minimum for a backtest, so the earliest date this family's
settlements become checkable from a local record is mid-December 2026. Nothing
automates the capture — no cron job — so the ledger is only as complete as the
runs.

## Scoring the candidates

Judged on the dimensions that decide whether a payout can be defended: public and
free, archived, stated methodology, fixed schedule, revision policy, resistant to
the publisher's own product decisions, and whether Kalshi has precedent.

| source | public | archived | methodology | precedent | verdict |
| --- | --- | --- | --- | --- | --- |
| OpenRouter requests by author | yes, unauthenticated | **no — one trailing window** | no | **yes, 284 markets** | reproducible for one week at a time; unauditable after |
| OpenRouter weekly token share | yes, unauthenticated | yes, 53 weeks | no | same series, wrong variable | archived but not what settles |
| Vercel AI Gateway open-vs-closed | chart only, no data | no | no | yes, 72 markets | worst of the four; only the publisher can see it |
| Hugging Face `gated` / `cardData.license` | yes, unauthenticated | **no** — commits endpoint is 401 | field semantics are documented | model cards are already a Kalshi source | settleable **only** against an owned snapshot |
| Artificial Analysis open-source intelligence | API needs a key (401) | unknown | published index methodology | yes, `KXOPENINTAI`, 91 markets | needs a key; cannot be verified by a counterparty |
| Epoch AI `all_ai_models.csv` | yes, CC-BY | yes | yes | none | best provenance, ~2-week lag, annual tenor only |
| CISA KEV / OSV.dev / CMC | yes | yes | yes | **none in 14,228 series** | good data, no precedent, different buyer |

The ranking that falls out of this is not the one the one-pager implies. **Epoch
AI is the only candidate that is simultaneously public, archived, methodologically
documented and free**, and it is the only one with no Kalshi precedent among the
AI sources. The Hugging Face availability fields are the only ones that touch the
exposure a self-hoster actually carries, and their single defect — no history —
is the one defect a counterparty can fix itself, which is why
[`availability-snapshot.md`](availability-snapshot.md) exists and why the ledger
is the asset. OpenRouter requests are the only variable here that is both
reproducible and already trading at scale, and the reason it stays a speculation
rather than a hedge is unchanged from
[`open-weights-risk.md`](open-weights-risk.md): it is a share of someone else's
traffic.

## What would change these verdicts

1. ~~**An archive of the request view.**~~ Done — `author-share-snapshot`, one
   window captured. This verdict stops being "unauditable" for windows from
   2026-09-20 forward and stays true for the 20 prints before it, which no archive
   can recover.
2. **A ladder that pays on a named author's availability** rather than share, at
   which point the snapshot ledger is the settlement record and the basis argument
   in `open-weights-risk.md` stops being hypothetical.
3. **Any Kalshi series settling on a government or foundation feed.** One would
   overturn the precedent claim above, and the supply-chain row becomes a proposal
   with a comparable rather than a first.

## Falsification

The claim to attack is "the settlement variable of the author-share family is
text-generation request share over a trailing week". It fails if a sixth print
lands outside ±0.5 points, and it is only supported by five simultaneous prints
from a single week — because one week is all the source serves. Item 1 above is
what would turn n=5 into a real test, and until it runs this section is the honest
limit of the finding.
