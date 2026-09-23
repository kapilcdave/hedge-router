# What Kalshi can do to make open-source risk hedgable

*One page · 2026-09-23 · every claim sourced in hedge-router/docs/*

**Thesis.** Open-source dependence is compounding — open-weights share on one
major AI gateway rose from (60–62)% to (77.5–80)% in 22 days — and the only
contract listed against it pays on a number only its publisher can see. The
buyers and the settlement data both exist. The gap is the settlement standard.

## The buyers

Two, both with exposure that is legible on their own invoice:

- **Self-hosters with usage-based spend** concentrated in one model family.
- **Cyber insurers / reinsurers** with correlated tail exposure to one
  widely-deployed open-source component — expensive to reinsure, currently
  impossible to hedge.

## The settlement gap

`KXOPENSOURCESHARE` (72 markets, 110k contracts) settles on Vercel AI Gateway's
open-vs-closed chart: **no API, no methodology, no archive**. The larger
OpenRouter model-author family (284 markets, **3.08M contracts**) settles on a
number reproducible for one week and then gone — **20 of 25 settled prints can
no longer be audited by anyone**. And none of Kalshi's **14,228 series** (3,020
settlement sources) settles on a government or foundation feed.

## What Kalshi can do

**1. List availability, not just share.** A self-hoster's cost moves on whether
weights stay downloadable — carried by `gated` and `cardData.license` on Hugging
Face, both unauthenticated reads. A public daily snapshot of those two fields now
exists (hedge-router, 12 frontier models, running since 2026-09-21). That ledger
*is* the settlement record.
*Stake: "Llama 3.3-70B stays downloadable under its current licence through
[date]."*

**2. Make "re-auditable" a listing requirement.** A series that cannot be
re-checked a week after settlement should not be listed — the OpenRouter family
demonstrates the alternative. It needs an archive from day one, and the
hedge-router repo is now archiving it weekly (12 windows, backtestable
mid-December). Same family, same variable — suddenly defensible.

**3. Resolve on the variable named in the rule.** OpenRouter author-share is
*request* share, not *token* share: Google is 18.8% of requests but 5.4% of
tokens, and five settled prints follow requests to 0.086 points vs 5.346 on
tokens. Three all-NO ladders were listed off the number the venue could not see.
Name the metric, then bracket it.

**4. Underwrite the first government or foundation source.** CISA KEV (1,716
entries, public CSV/JSON, ransomware flags, dates), OSV.dev, and the UK Cyber
Monitoring Centre are the most documented, best-archived settlement data in this
space, and the most defensible — independent of any publisher's product
decisions. This opens the cyber-insurer buyer *and* a source class Kalshi has
never used.

## Candidates at a glance

| instrument | settles on | status |
| --- | --- | --- |
| Model availability / licence | HF `gated` + `cardData.license` | ledger running since 2026-09-21 — ready to be the settlement record |
| OpenRouter author share | request share (reproducible now, unauditable after) | 284 mkts / 3.08M listed; weekly archive now running |
| Frontier open-weights release | Epoch AI CSV — public, archived, documented, free | not listed; ~2-wk lag, annual tenor |
| OSS supply-chain event | CISA KEV / OSV.dev / CMC | not listed; no precedent in 14,228 series |

## The honest limit

Whether any of these is a hedge rather than a bet is the basis question, and it
is argued, not measured, until one self-hoster produces a realised-cost ledger.
The settlement side — records anyone can re-audit — is no longer the blocker.