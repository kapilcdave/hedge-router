# Hedge Router

> A model router that doesn't just **SAVE** money, but also **MAKES** money by hedging compute prices on Kalshi.

Hedge Router is a local, bring-your-own-key model router for coding tools. It exposes an OpenAI-compatible endpoint, chooses the least expensive eligible model, records a local savings ledger, and can optionally use privacy-thresholded metadata for compute-price research.

The routing and research pipeline work today. The market module is deliberately paper-only: the “makes money” thesis must pass its out-of-sample gates before live trading is considered.

## Quick start

```sh
cp hedge-router.config.example.json hedge-router.config.json
export OPENAI_API_KEY=...
npm start
```

Point an OpenAI-compatible client at `http://127.0.0.1:8787/v1` and request model `auto`. Explicit configured model IDs bypass automatic routing.

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-hedge-router-session-id: demo' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Fix the failing test"}]}'
```

## Terminal dashboard

Open a second terminal while the router is running:

```sh
hedge-router dashboard
```

The dashboard watches the local event ledger, `.hedge-router/evaluation.json`, and `.hedge-router/paper.json`. It shows completed routes, fallbacks, per-request savings, model mix, the latest compute-price signal, and persistent Kalshi paper orders. Press `q` to exit.

For a deterministic animated feed suitable for demos and terminal recordings:

```sh
hedge-router demo --duration 20
```

Both displays say `PAPER EXECUTION` prominently because Hedge Router does not place live orders. Prompts, code, paths, and tool output never appear in the dashboard. Use `--once --no-color` for a static snapshot in logs, or pass `--market FILE` and `--paper FILE` to watch different research files.

Useful commands:

```sh
hedge-router report
hedge-router session-outcome --session demo --tests-pass true --rating 1
hedge-router aggregate --output .hedge-router/daily.json
hedge-router evaluate --index examples/index.json --markets examples/markets.json \
  --aggregates examples/aggregates.json --output .hedge-router/evaluation.json
hedge-router gate --market .hedge-router/evaluation.json
hedge-router export --output telemetry-export.json
```

Install the `hedge-router` command locally with `npm link`, or use `node src/cli.js`. A `comp` command alias is included for convenience. The runtime has no third-party dependencies and requires Node 20 or newer.

## Privacy boundary

Prompts, code, paths, filenames, tool arguments, and tool output are never written to telemetry or sent to the optional telemetry collector. Only request metadata, token counts, latency, provider errors, coarse task class, price snapshots, routing decisions, and explicit quality outcomes are eligible. Telemetry is off by default. Provider-bound request content still goes to the provider selected by the user-configured router.

Run `hedge-router delete-data --confirm DELETE` to remove the local event ledger and pseudonymous identity. When remote telemetry is configured, deletion is sent to the collector before local state is removed. Failed uploads stay in a durable, metadata-only outbox and can be retried with `hedge-router sync`.

The optional collector is a separate authenticated service:

```sh
export HEDGE_ROUTER_COLLECTOR_TOKEN='replace-with-at-least-16-random-characters'
hedge-router collect --config hedge-router.config.json
```

Set `telemetry.remoteEnabled`, `telemetry.remoteUrl`, and `telemetry.remoteTokenEnv` in the client config. The collector rejects unknown fields and content-like fields, deduplicates request IDs, applies retention, and only exposes aggregates after the configured minimum cohort size.

## Routing behavior

- `model: "auto"` selects the cheapest model that fits the estimated context and requested quality tier.
- `x-hedge-router-quality: economy|balanced|high` overrides the local quality preference.
- `x-hedge-router-task-class` can supply a coarse category; otherwise it is derived locally and only the category is recorded.
- A stable randomized control cohort uses the configured default model.
- Local latency and provider-error history break near-cost ties and temporarily deprioritize routes with at least a 20% error rate over five or more samples.
- Retryable upstream failures escalate to the next eligible quality tier before any response bytes reach the client.
- Each provider attempt has a configurable timeout (120 seconds by default).
- OpenAI-only Responses features (including built-in tools, stored conversations, and background mode) remain on an OpenAI-backed route instead of being lossy-translated.

The `x-hedge-router-route`, `x-hedge-router-session-id`, and `x-hedge-router-request-id` response headers make routing auditable.

## Market research

The evaluator uses horizon-matched walk-forward ridge regression and never places a live order. It is testing whether privacy-thresholded usage metadata adds predictive value beyond the last observed index value and the market price. It will not generate an order until aligned router aggregates and the configured minimum number of training rows exist. Live trading is intentionally absent pending legal, privacy, security, and exchange-rule review.

An end-to-end public-data workflow is available:

```sh
# 1. Capture prices while the contracts are still open.
hedge-router kalshi-snapshot --series KXH100WS --chip H100 \
  --fee-rate 0.07 --slippage 0.01 --output .hedge-router/kalshi-open.json

# 2. Refresh the corresponding public compute-price history.
hedge-router ornn-history --gpu H100 --chip H100 \
  --start 2026-06-01 --end 2026-08-28 \
  --merge .hedge-router/ornn-h100.json --output .hedge-router/ornn-h100.json

# 3. Build privacy-thresholded router features.
hedge-router aggregate --output .hedge-router/daily.json

# 4. Within five minutes of the market snapshot, record risk-limited paper orders.
hedge-router paper-open --index .hedge-router/ornn-h100.json \
  --markets .hedge-router/kalshi-open.json --aggregates .hedge-router/daily.json \
  --portfolio .hedge-router/paper.json --output .hedge-router/paper.json \
  --bankroll 1000 --risk-percent 1 --max-event-percent 5

# 5. After settlement, attach outcomes without replacing the entry-time quotes.
hedge-router kalshi-resolve \
  --input .hedge-router/kalshi-open.json --output .hedge-router/kalshi-resolved.json
hedge-router paper-settle --portfolio .hedge-router/paper.json \
  --markets .hedge-router/kalshi-resolved.json --output .hedge-router/paper.json

# 6. Evaluate the research history strictly out of sample.
hedge-router evaluate --index .hedge-router/ornn-h100.json \
  --markets .hedge-router/kalshi-resolved.json --aggregates .hedge-router/daily.json \
  --output .hedge-router/evaluation.json
hedge-router gate --market .hedge-router/evaluation.json
```

`kalshi-snapshot` uses Kalshi's unauthenticated market-data API, captures executable Yes and No asks, and rejects observations at or after contract close. Paper placement also rejects stale snapshots, duplicate markets, and positions outside the bankroll or per-event exposure limits. `kalshi-resolve` preserves the entry-time quotes, so settlement data cannot leak into the prediction. `ornn-history` normalizes the public Ornn index history for H100, H200, B200, A100, and RTX 5090 into evaluator-ready rows. Keep imported index data local unless your license permits redistribution.

The default event-contract taker fee is calculated per trade as `ceil(0.07 × contracts × price × (1-price))` in cents, following Kalshi's published [fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf). Use `--fee-rate` or the legacy fixed `--fee` override when a product has a different schedule. Modeled slippage is separate.

### Automated pilot

Run the complete workflow once:

```sh
hedge-router pilot-run --series KXH100WS --gpu H100 --chip H100 \
  --minimum-contributors 1
```

For a private single-user experiment, `--minimum-contributors 1` permits local aggregates. Keep the configured privacy threshold for any multi-user pilot.

The cycle is locked against overlapping runs and performs these operations in order:

1. Refresh and merge the Ornn index history.
2. Build privacy-thresholded daily router aggregates.
3. Retry settlement of contracts captured by earlier runs.
4. Settle matching paper positions and update realized P&L.
5. Capture and archive current executable Kalshi quotes.
6. Forecast at each contract's actual time horizon.
7. Place only fresh, trained, risk-limited paper orders.
8. Refresh the evaluation and append an immutable run summary.

Run it continuously in the foreground every 24 hours:

```sh
hedge-router pilot-daemon --series KXH100WS --gpu H100 --chip H100 \
  --minimum-contributors 1 --interval-hours 24
```

For a deployed pilot, invoke `pilot-run` from a process manager or operating-system scheduler instead of relying on an unattended terminal. Each run is resumable: pending markets, resolved history, paper orders, daily aggregates, index history, archived snapshots, and run logs live under `.hedge-router/`. Overlapping cycles are rejected; a lock abandoned for more than six hours is recovered automatically.

Produce the weekly falsification scorecard:

```sh
hedge-router pilot-report --chip H100 --days 7 \
  --output .hedge-router/pilot/weekly.json
```

The scorecard reports collection failures, routing savings and quality, independent market events, Brier improvement, portfolio results, and the still-unmeasured basis risk. Its verdict is `collecting`, `passed`, or `failed`; insufficient data never becomes a pass.

Because the public history window is limited, preserve an accumulating local series during later refreshes with `--merge .hedge-router/ornn-h100.json --output .hedge-router/ornn-h100.json`. Fresh same-day observations replace older ones; older dates remain intact.

The files in `examples/` are synthetic and document the input shapes:

- Index rows contain `date`, an exact `chip` series name, and the observed `price` from the contract's stated settlement source.
- Market rows contain the contract ID, settlement date, chip, threshold, normalized Yes price, per-contract fee, modeled slippage, and resolved index price.
- Aggregate rows are produced by `hedge-router aggregate` only after the configured minimum contributor count is met.

The market gate requires at least 30 distinct settlement events—not merely 30 correlated strikes—a 5% out-of-sample Brier-score improvement over both the public-market and last-price baselines, and positive paper P&L after fees and slippage. The router gate requires 500 completed sessions from 25 contributors, at least 20% savings, no more than five percentage points of quality degradation against the control cohort, and less than 100 ms p95 local routing overhead.

This software is experimental and is not investment advice.

## What this can and cannot hedge

The relevant Kalshi contracts settle on a stated compute-price index crossing a threshold; they are not bets on a GPU literally running faster or slower. A coding-session router lowers the user's API bill immediately. Aggregated usage could become an early demand signal, but it is only a hedge if the user's real compute costs reliably move with the same settlement index. Until that relationship survives the independent gates above, the market side should be treated as research rather than a customer promise.

API behavior was implemented against the official [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), [Kalshi market-data documentation](https://docs.kalshi.com/getting_started/quick_start_market_data), and [Ornn API documentation](https://index.ornn.com/docs).
