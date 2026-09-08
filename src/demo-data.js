// Recorded, not simulated. Every row below came out of the real pipeline; the demo replays it
// so a recording can never look better than what the research actually produced.
//
// Gateway rows: `hedge-router ingest --format claude-code` over local Claude Code transcripts,
// sampled across 2026-09-03. The source reports no per-call price or latency, so those stay zero.
//
// Market rows: `hedge-router backtest --series KXH100WS --chip H100 --lead-days 1`
// against the public Kalshi settled series and the Ornn H100 SXM index, entering at the
// historical ask with a 7% fee rate and 1c of slippage. These are the trades the trained
// demand signal actually took: one winner, two losers.
export const DEMO_RECORDING = {
  captured_at: '2026-09-05',
  series: 'KXH100WS',
  chip: 'H100',
  lead_days: 1,
  settlement_window: ['2026-07-03', '2026-09-04'],
  requests: [
    { event_type: 'request', timestamp: '2026-09-03T00:38:40.704Z', source: 'claude-code', session_id: 'demo-1', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 40047, cached_input_tokens: 0, output_tokens: 1346, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T06:26:02.764Z', source: 'claude-code', session_id: 'demo-2', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 136793, cached_input_tokens: 136374, output_tokens: 1284, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T07:16:27.874Z', source: 'claude-code', session_id: 'demo-3', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 59253, cached_input_tokens: 58539, output_tokens: 175, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T07:28:52.074Z', source: 'claude-code', session_id: 'demo-3', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 98144, cached_input_tokens: 92964, output_tokens: 104, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T07:42:57.825Z', source: 'claude-code', session_id: 'demo-3', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 133361, cached_input_tokens: 132639, output_tokens: 395, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T22:01:24.510Z', source: 'claude-code', session_id: 'demo-4', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 59270, cached_input_tokens: 58676, output_tokens: 196, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T22:06:22.744Z', source: 'claude-code', session_id: 'demo-4', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 81190, cached_input_tokens: 79455, output_tokens: 723, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 },
    { event_type: 'request', timestamp: '2026-09-03T22:16:09.101Z', source: 'claude-code', session_id: 'demo-4', model: 'claude-opus-5', provider: 'anthropic', input_tokens: 102448, cached_input_tokens: 100906, output_tokens: 3226, latency_ms: 0, provider_status: 200, attempts: 1, actual_cost_usd: 0, baseline_cost_usd: 0, savings_usd: 0 }
  ],
  market: {
    observations: 52,
    independent_events: 10,
    signal_brier: 0.0499,
    market_brier: 0.0573,
    naive_brier: 0.0486,
    relative_brier_improvement: -0.0253,
    paper_pnl: -0.78,
    trades: 3,
    gate: false,
    results: [
      {
        id: 'KXH100WS-26AUG28-2.750', event_ticker: 'KXH100WS-26AUG28', date: '2026-08-28',
        chip: 'H100', threshold: 2.75, predicted_price: 2.6712, probability: 0.2536,
        market_probability: 0.43, naive_probability: 0.278, side: 'no', entry_price: 0.63,
        edge: 0.1164, net_edge: 0.0864, outcome: 1, outcome_price: 2.93, paper_pnl: -0.66,
        training_rows: 8, horizon_days: 2, signal_ready: true
      },
      {
        id: 'KXH100WS-26SEP04-3.000', event_ticker: 'KXH100WS-26SEP04', date: '2026-09-04',
        chip: 'H100', threshold: 3, predicted_price: 2.8109, probability: 0.0622,
        market_probability: 0.355, naive_probability: 0.0836, side: 'no', entry_price: 0.84,
        edge: 0.0978, net_edge: 0.0778, outcome: 0, outcome_price: 2.89, paper_pnl: 0.14,
        training_rows: 15, horizon_days: 2, signal_ready: true
      },
      {
        id: 'KXH100WS-26SEP04-2.750', event_ticker: 'KXH100WS-26SEP04', date: '2026-09-04',
        chip: 'H100', threshold: 2.75, predicted_price: 2.8109, probability: 0.6895,
        market_probability: 0.88, naive_probability: 0.7421, side: 'no', entry_price: 0.23,
        edge: 0.0805, net_edge: 0.0505, outcome: 1, outcome_price: 2.89, paper_pnl: -0.26,
        training_rows: 15, horizon_days: 2, signal_ready: true
      }
    ]
  }
};
