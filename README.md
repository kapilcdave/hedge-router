# Hedge Router

> Turn model-gateway telemetry into a compute-price hedge.

Hedge Router is not a model router. Use an existing gateway such as
[Agentgateway](https://agentgateway.dev/) or
[Weave Router](https://github.com/workweave/router) to choose and serve models.
Hedge Router consumes their metadata, measures compute exposure, builds a demand
signal, and evaluates risk-limited paper hedges against compute-price markets.

```text
Agentgateway / Weave Router / any OTLP-capable gateway
                         ↓
              metadata-only normalization
                         ↓
             daily compute exposure ledger
                         ↓
              forecast → paper hedge → P&L
```

The research pipeline is deliberately paper-only. No command in this repository
places a live order.

## Quick start

The runtime has no third-party dependencies and requires Node 20 or newer.

```sh
npm link
hedge-router init

# Weave's /v1/analytics/routing-decisions export is NDJSON.
hedge-router ingest --format weave --input routing-decisions.ndjson

# Agentgateway JSON access logs and OTLP JSON exports are also supported.
hedge-router ingest --format agentgateway --input agentgateway.jsonl
hedge-router ingest --format otel --source agentgateway-prod --input traces.json

hedge-router report
hedge-router aggregate --minimum 1 --output .hedge-router/daily.json
hedge-router dashboard
```

Use `--input -` to read stdin, `--dry-run` to validate without writing, and
`--output FILE` to maintain an alternate ledger. Replaying an export is safe:
source event IDs are converted into deterministic request IDs and duplicates are
not appended.

Auto-detection works for known shapes:

```sh
hedge-router ingest --input gateway-export.ndjson
```

## Supported inputs

### Weave Router

Pull immutable routing decisions with a read-only analytics key, then ingest the
NDJSON page:

```sh
curl -sS --compressed \
  -H "Authorization: Bearer $WEAVE_ANALYTICS_KEY" \
  "$WEAVE_ROUTER_URL/v1/analytics/routing-decisions?since=2026-08-01T00:00:00Z&limit=10000" \
  -o routing-decisions.ndjson

hedge-router ingest --format weave --input routing-decisions.ndjson
```

Hedge Router uses the chosen model/provider, token counts, realized input/output
cost, route and upstream latency, status, and failover flag. It does not ingest
end-user identity fields, candidate lists, prompts, or model output. Weave does
not define savings for you; a baseline is an assumption owned by the operator.

### Agentgateway

Agentgateway emits `gen_ai.*` token/model/provider attributes in access logs and
OpenTelemetry spans. Configure JSON log output for the simplest file workflow:

```yaml
config:
  logging:
    format: json
```

```sh
kubectl logs deployment/agentgateway-proxy -n agentgateway-system \
  > agentgateway.jsonl
hedge-router ingest --format agentgateway --input agentgateway.jsonl
```

The default `key=value` access-log format is accepted too. When Agentgateway has
a model cost catalog, Hedge Router reads `agw.ai.usage.cost.total`; otherwise it
still records tokens and operational exposure. OTLP JSON uses the same
`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name`, and
`gen_ai.usage.*` attributes.

### Claude Code

Local coding-agent transcripts are a usable demand ledger when no gateway sits in
front of the model:

```sh
cat ~/.claude/projects/*/*.jsonl \
  | hedge-router ingest --format claude-code --input -
```

Only the assistant turn's model, timestamp, and token counts cross the privacy
boundary. Message content, working directory, git branch, and tool arguments
recorded in the same transcript are not read into the ledger. Transcripts carry
no per-call price or latency, so realized spend stays absent rather than zero —
`report` and `dashboard` show `n/a`, not `$0.00`.

### Generic and canonical inputs

`--format otel` accepts OTLP JSON containing `resourceSpans`. `--format
canonical` accepts Hedge Router request events for migration and controlled
imports. The normalized ledger is `.hedge-router/events.ndjson`.

## Exposure pipeline

Useful commands:

```sh
hedge-router report
hedge-router status
hedge-router aggregate --minimum 1 --output .hedge-router/daily.json
hedge-router gate --market .hedge-router/evaluation.json
hedge-router export --output metadata-export.json
```

`report` summarizes calls, tokens, realized spend, gateway/model mix, latency,
errors, and failovers. `aggregate` produces daily demand features used by the
forecast: request volume, input/output tokens, cache ratio, latency, error rate,
and failover rate. A local single-user study can use `--minimum 1`; shared or
remote studies should retain the configured privacy threshold.

`status` prints a compact line such as `hedge router · spend $1.25 · 1.5M tokens
· paper +$0.42`. A companion plugin for Claude Code, Codex, and OpenCode lives in
[`plugins/hedge-router-status`](plugins/hedge-router-status/README.md).

`hedge-router demo` renders the same dashboard without a local ledger. It is a
recording, not a simulation: the gateway rows are real ingested requests and the
hedges, Brier scores, and P&L are exactly what
[`backtest`](#retrospective-backtest) produced, losses included. The demo cannot
display an open gate, because the research has not earned one.

## Privacy boundary

Normalization is an allowlist, not a raw-log archive. Prompts, completions, code,
paths, filenames, tool arguments, tool output, credentials, email addresses, and
gateway user IDs are never written to the exposure ledger. Session identifiers
are pseudonymized with a rotating local salt. Telemetry upload is off by default.

Run `hedge-router delete-data --confirm DELETE` to remove the local event ledger
and pseudonymous identity. Failed optional uploads stay in a durable,
metadata-only outbox and can be retried with `hedge-router sync`.

The optional authenticated collector accepts only the normalized metadata
allowlist, deduplicates request IDs, enforces retention, and exposes aggregates
only after the configured cohort threshold:

```sh
export HEDGE_ROUTER_COLLECTOR_TOKEN='replace-with-at-least-16-random-characters'
hedge-router collect --config hedge-router.config.json
```

## Paper-hedge research

The evaluator uses horizon-matched walk-forward ridge regression to test whether
gateway demand metadata adds predictive value beyond the last observed index and
the public market price. It never trains on data observed after the forecast.

```sh
# Capture executable market prices before close.
hedge-router kalshi-snapshot --series KXH100WS --chip H100 \
  --fee-rate 0.07 --slippage 0.01 --output .hedge-router/kalshi-open.json

# Refresh the public compute-price index.
hedge-router ornn-history --gpu H100 --chip H100 \
  --start 2026-06-01 --end 2026-08-28 \
  --merge .hedge-router/ornn-h100.json --output .hedge-router/ornn-h100.json

# The token-price index, for a bill denominated in tokens rather than GPU-hours.
# Free for four labs over a trailing month; the command reports what was withheld.
hedge-router otpi-history --lab anthropic --chip ANTHROPIC-TOK \
  --start 2026-08-08 --end 2026-09-07 --output .hedge-router/otpi-anthropic.json

# Build demand features from any supported gateway.
hedge-router aggregate --minimum 1 --output .hedge-router/daily.json

# Record fresh, trained, risk-limited paper orders.
hedge-router paper-open --index .hedge-router/ornn-h100.json \
  --markets .hedge-router/kalshi-open.json --aggregates .hedge-router/daily.json \
  --portfolio .hedge-router/paper.json --output .hedge-router/paper.json \
  --bankroll 1000 --risk-percent 1 --max-event-percent 5

# Resolve and settle without replacing the entry-time snapshot.
hedge-router kalshi-resolve \
  --input .hedge-router/kalshi-open.json --output .hedge-router/kalshi-resolved.json
hedge-router paper-settle --portfolio .hedge-router/paper.json \
  --markets .hedge-router/kalshi-resolved.json --output .hedge-router/paper.json

# Evaluate strictly out of sample.
hedge-router evaluate --index .hedge-router/ornn-h100.json \
  --markets .hedge-router/kalshi-resolved.json --aggregates .hedge-router/daily.json \
  --output .hedge-router/evaluation.json
hedge-router gate --market .hedge-router/evaluation.json
```

The market gate requires at least 30 independent settlement events, a 5%
out-of-sample Brier-score improvement over both the market and last-price
baselines, and positive paper P&L after fees and slippage. The independent data
gate requires at least 500 calls spanning 30 days with token coverage of 90% or
better. Insufficient data never becomes a pass.

The relevant contracts settle on a stated compute-price index crossing a
threshold. They hedge a customer only when that customer's real compute costs
move with the same index. The pilot reports this basis risk as unmeasured until it
can be estimated from actual cost history.

A $/token contract would shorten that chain, and Kalshi listed four in August
2026. [`docs/token-price-basis.md`](docs/token-price-basis.md) records what
measuring them found: the settlement rule is reproducible exactly from the free
public index, but the index is a volume-weighted *mix* blend with 235–289%
annualized volatility and no autocorrelation, so almost none of its variance is
price. A consumer with a fixed model mix has no exposure to it. All 87 markets are
settled with 4,779 contracts of lifetime volume.

Seven further series shorten the chain completely: they settle on the *provider's
own published price page*, so for a customer paying list price the settlement
variable is not correlated with their cost, it is their cost.
[`docs/list-price-token-markets.md`](docs/list-price-token-markets.md) measures
them. The hedge is against being locked into a contract the provider later
undercuts, and because the strikes are `less_or_equal` the correct side is YES —
Kalshi's own `no_sub_title` field says otherwise on all 24 markets. The pipeline
now prices and sizes them, but **none has settled**: they are annual contracts
closing 2027-04-01, so there is no Brier score, no paper P&L, and the market gate
cannot open on them. The basis problem is solved; the forecasting problem is
untouched.

A third family is listed against *open-weights risk* rather than price:
`KXOPENSOURCESHARE`, 72 markets and 110,020 contracts of lifetime volume, settling
on the open-weights percentage in a third-party gateway's token-volume chart.
[`docs/open-weights-risk.md`](docs/open-weights-risk.md) measures it with
`scripts/opensource-share.mjs`, which recovers the settlement variable from settled
strikes because the publisher exposes no API and no archive. The recovered share
*rose* from ~61% to ~74% over three weeks, so the decline premise is not what the
venue has settled. But the contract pays on one gateway's traffic mix, which is
the same wrong variable as the token index: a self-hoster's exposure is whether
weights stay downloadable, not what share they serve. The doc lists the
availability instruments that are machine-readable instead.

### Availability snapshot

The availability fields are free to read *now* and impossible to read
historically — Hugging Face serves `gated` and `cardData.license` unauthenticated,
but the commits endpoint that would date a change is 401 without a token. So the
history has to be owned:

```sh
hedge-router availability-snapshot --watchlist examples/availability-watchlist.json
hedge-router availability-report
```

One row per model per UTC date in `.hedge-router/availability.ndjson`, first
captured 2026-09-21 across 12 frontier open-weight models, 12 of 12 resolved. A
change is reported as a bracket — `(previous observation, this one]` — narrowed by
`lastModified` only when the commit hash also moved, because gating is a repo
setting rather than a commit. A non-200 is written as `unresolved` with no field
values: a model id that does not exist answers **401**, exactly as a deleted or
newly private repo would, so disappearance is the one event this source cannot
confirm and a bad collector would report it every time the network blinked.
[`docs/availability-snapshot.md`](docs/availability-snapshot.md) records the rest.

### Retrospective backtest

Forward paper trading accumulates one settlement event per week. `backtest`
reconstructs the decision that *would* have been made on already-settled markets
by reading Kalshi daily candlesticks, so a hypothesis can be falsified today
rather than next year. Each market is entered at the historical `yes_ask` (or
`no_ask`) that existed `--lead-days` before close, plus fees and slippage; quotes
that were one-sided, crossed, or published after the decision time are skipped
with a stated reason rather than filled at a midpoint.

```sh
hedge-router backtest --series KXH100WS --chip H100 \
  --index .hedge-router/ornn-h100.json --aggregates .hedge-router/daily.json \
  --lead-days 1,3,7,14 --fee-rate 0.07 --slippage 0.01 \
  --save-history .hedge-router/kalshi-history.json \
  --output .hedge-router/backtest.json
```

`--save-history` caches the fetched candlesticks; pass it back with `--history`
to re-run offline without re-hitting the API. Two variants share one forecast:
`demand-signal` trades only where the demand model has trained, and
`index-persistence` trades on the last index print alone. The difference between
them, `demand_brier_lift`, is the only number that measures whether gateway
telemetry adds anything.

#### What it currently measures

On `KXH100WS` (102 settled markets, **10 independent settlement events**, first
settlement 2026-07-03) against the Ornn H100 SXM index:

| lead | demand lift | signal Brier | market Brier | index Brier | demand P&L | persistence P&L |
| ---: | ----------: | -----------: | -----------: | ----------: | ---------: | --------------: |
|   1d |     −0.0012 |       0.0499 |       0.0573 |      0.0486 | −$0.78 (3) |     +$0.56 (8)  |
|   3d |     −0.0022 |       0.0421 |       0.0402 |      0.0399 | +$0.20 (2) |     −$0.28 (10) |
|   7d |           0 |       0.0332 |       0.0422 |      0.0332 |   — (0)    |     +$1.41 (7)  |
|  14d |           0 |       0.0347 |       0.0533 |      0.0347 |   — (0)    |     +$2.09 (9)  |

The core hypothesis is **not** supported on this data. Where the demand model
trains at all, it makes forecasts slightly *worse* than the last index price. At
7 and 14 days no aligned aggregate reaches back far enough to train, so the
demand variant is the index variant with no trades. The persistence variant is
profitable at three of four leads, but on 7–10 trades across 8–10 correlated
events that is noise, not evidence. Of the fixed baselines, only
`market-favorite` makes money, and only at longer leads.

The one pattern that repeats at every lead is that the index's own persistence
beats the market's implied probability (Brier 0.033–0.049 against 0.040–0.057).
That is a statement about this thin market, not about demand telemetry.

At one settlement event per week, the 30-event market gate cannot be evaluated
before roughly March 2027. Until then `gate` reports collecting, which is the
honest answer.

### Automated pilot

```sh
hedge-router pilot-run --series KXH100WS --gpu H100 --chip H100 \
  --minimum-contributors 1

hedge-router pilot-daemon --series KXH100WS --gpu H100 --chip H100 \
  --minimum-contributors 1 --interval-hours 24

hedge-router pilot-report --chip H100 --days 7 \
  --output .hedge-router/pilot/weekly.json
```

Each cycle is resumable and locked against overlap. It refreshes index history,
aggregates gateway exposure, settles prior paper positions, captures fresh market
quotes, forecasts at each contract's actual horizon, places qualifying paper
orders, and writes an immutable run summary.

## Optional legacy proxy

The original OpenAI-compatible router remains available as a demo and migration
aid under `hedge-router serve`, but it is no longer the product boundary or the
default configuration. A complete configuration is available at
[`examples/legacy-proxy.config.json`](examples/legacy-proxy.config.json). Provider
credentials are required only for this optional command.

This software is experimental and is not investment advice.
