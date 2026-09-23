# 23rd September 2026

## OVERVIEW

Open-source inference dependence is compounding — open-weights share on one major
AI gateway rose from (60–62)% to (77.5–80)% in 22 days — yet the only contract
listed against that exposure pays on a number only its publisher can see: Vercel
AI Gateway's open-vs-closed chart, which has no API, no methodology and no
archive. The buyers and the settlement data both exist. What is missing is the
settlement standard.

## GOALS

- Give self-hosters a real hedge: contracts on **availability** (weights stay
  downloadable under their licence) and on OSS **supply-chain** events — not on a
  share of someone else's traffic.
- Give cyber insurers and reinsurers a tradeable tool for correlated tail exposure
  to a single widely-deployed open-source component.
- Every listed market settles on a source that is public, archived, method-stated,
  and **re-auditable weeks after settlement**.
- Measure basis with a realised-cost ledger, so each contract is a hedge rather
  than a bet.

## SPECIFICATIONS

Four settlement sources, verified against their live endpoints. They are the
bread and butter — each defines its own mechanics, schedule and market shape.

**1. Hugging Face model cards — availability.** Carries `gated` and
`cardData.license` as unauthenticated single-field reads. Settlement read: "did
model X become gated or get relicensed between observation A and observation B."
The current value is free; the history is not — the commits endpoint is 401, so
history must be owned. A daily snapshot of the two fields is the record (12
frontier models, running since 2026-09-21). Changes settle as brackets, never
timestamps; a 401 is `unresolved`, so deletion is the one event this source
cannot confirm.

**2. OpenRouter rankings — author request share.** Carries per-model request
counts (`/api/frontend/v1/rankings/models`, unauthenticated). This is the variable
the listed author-share family actually settles on — **not tokens** (Google is
18.8% of requests but 5.4% of tokens; five settled prints match requests to 0.086
points, vs 5.346 on tokens). One trailing window with no archive: reproducible for
exactly one week, then unauditable forever — 20 of 25 settled prints are already
gone. A weekly archive is running; the family becomes backtestable in
mid-December.

**3. Epoch AI — frontier model registry.** Carries `all_ai_models.csv` (CC-BY):
model, `Open model weights?`, access, publication date. The only source that is
public, archived, methodologically documented **and** free. Additions lag the
release by ~2 weeks, so the tenor is annual, not intraday.

**4. CISA KEV / OSV.dev / UK Cyber Monitoring Centre — supply chain.** CISA KEV:
1,716 entries, public CSV/JSON, with CVE, vendor/product, dates and a ransomware
flag. OSV.dev: open-source-specific, free, unauthenticated. The CMC — funded by
cyber insurer CFC — categorises UK cyber events 1–5 on prevalence and financial
impact, with a 30-day committee target that rules it out for short binaries and
defines annual cover. No government or foundation source appears in any of
Kalshi's 14,228 series: this is a source class without precedent.

Every source above must clear the same bar: public · free · archived · stated
methodology · fixed schedule · revision policy · indifferent to the publisher's
own product decisions.

## MILESTONES

- **Live** — availability ledger: 12 frontier models, one row per model per UTC
  date since 2026-09-21.
- **Live** — OpenRouter author-share archive: weekly windows since 2026-09-20;
  backtestable at twelve windows (mid-December).
- **Proven** — settlement-variable recovery: the request-share recipe reproduces
  five settled prints to 0.086 share points.
- **Open** — a realised-cost ledger from one self-hoster, to measure whether a
  payer's own bill moves with any of these variables. Until one exists, the basis
  is argued, not measured.