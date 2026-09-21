# The availability snapshot: making a gated/licence contract settleable

*Day one captured 2026-09-21. Every status code and field value below came from an
unauthenticated read of `huggingface.co/api/models/{id}` on that date.*

[`open-weights-risk.md`](open-weights-risk.md) ends on the one cheap thing nothing
in this repo did: the listed contract pays on a **share** of one gateway's traffic,
the exposure a self-hoster actually carries is **availability**, and the two fields
that carry availability — `gated` and `cardData.license` — are free to read now and
impossible to read historically, because `GET /api/models/{id}/commits/main` is 401
without a token (re-verified 2026-09-21). A daily snapshot is the whole fix: it is
the only way to own the history a settlement rule would need.

```sh
hedge-router availability-snapshot                     # append today's row per model
hedge-router availability-snapshot --watchlist examples/availability-watchlist.json
hedge-router availability-report                       # bracket every change so far
```

The ledger is `.hedge-router/availability.ndjson`: one row per model per UTC date.
A cron line is the whole deployment.

```cron
17 9 * * * cd /path/to/hedge-router && node src/cli.js availability-snapshot >> availability.log 2>&1
```

## Day one, 12 models

| state | models |
| --- | --- |
| `gated: "manual"` | `meta-llama/Llama-3.1-8B-Instruct`, `meta-llama/Llama-3.3-70B-Instruct`, `google/gemma-2-9b-it` |
| `license: "other"`, terms in `license_name` | `Qwen/Qwen2.5-72B-Instruct` (`qwen`), `moonshotai/Kimi-K2-Instruct` (`modified-mit`) |
| no `cardData.license` at all | `deepseek-ai/DeepSeek-V3` |
| unresolved | none |

Three of twelve are already gated, so "did it become gated" is not the only
question a contract can ask — a watchlist of frontier open weights starts a
quarter of the way into the event.

## Four ways a naive version of this would settle wrong

**1. A missing model answers 401, not 404.** `nonexistent-org-xyz/nope-9999` and
`meta-llama/does-not-exist` both return `401 {"error":"Invalid username or
password."}`. So does, presumably, a repo that was deleted or made private. One
status code covers *deleted*, *private* and *never existed*, and unauthenticated
there is no way to separate them. A 401 is therefore recorded as `status:
"unresolved"` with **no field values written at all**, it never emits an event, and
it never breaks the chain: a later change brackets back to the last read that
carried values. The strongest availability event — the weights are gone — is the
one this source cannot confirm. That is a limit of the instrument, not a bug in the
collector, and it is why `settleable.unresolved` is in the report.

**2. `license: "other"` is a pointer, not a licence.** Qwen2.5-72B is
`license: "other"` with `license_name: "qwen"`. The terms can be rewritten with
`license` frozen, so a rule reading `cardData.license` alone sees nothing happen.
The ledger tracks `license`, `licenseName` and `licenseLink` as separate fields.

**3. An absent licence is its own state.** DeepSeek-V3 carries no
`cardData.license`. Coercing that to a default would make a later card edit read as
a relicensing *away* from something. Absence is stored as `null` and a
`null → "mit"` transition is reported with `from: null`, not as a licence change
from a permissive baseline. The same rule applies to `gated`: if the API stops
returning the field, the row becomes unresolved rather than silently ungated.

**4. A change is bracketed, never timestamped.** A daily read locates a change in
`(previous observation, this observation]` and no tighter. `lastModified` narrows it
only when `sha` also moved — and **gating is a repo setting, not a commit**, so it
can flip with `sha` and `lastModified` unchanged. Every event carries
`observedBetween`, `bracketDays`, both hashes, and `narrowedTo: null` when the
commit did not move. This is the same discipline as the strike-bracket
reconstruction in `open-weights-risk.md`: publish the interval, not a point.

## Two properties that stop the series depending on how it was run

- **One capture time for the whole snapshot.** Stamping each model with its own
  clock lets a run that straddles midnight UTC split one observation across two
  settlement dates.
- **One row per model per day, first resolved read wins.** A retry upgrades an
  unresolved row to a resolved one; a second *resolved* read of the same day is
  dropped. Running the snapshot hourly and running it daily produce the same
  series, which is the minimum a settlement rule can ask for.

## What this makes possible, and what it still does not

It makes an availability contract **settleable going forward**: from day one there
is an owned, timestamped, bracketed history of the two fields, which is exactly
what the 401 on the commits endpoint denies. It does not backfill: there is no
history before 2026-09-21, so nothing here can be backtested yet, and no number in
this document is evidence about the *rate* of gating or relicensing events.

It also does not settle the basis question. The open test named in
`open-weights-risk.md` is whether availability events and share moves are
contemporaneous, and that needs both series: this ledger accumulating, and
`scripts/opensource-share.mjs` re-run as brackets settle. With 12 models and events
this rare, the first useful comparison is months away — and if the ledger runs for
months and records zero events, that is the finding, and it prices an availability
binary far cheaper than the pitch for one assumes.
