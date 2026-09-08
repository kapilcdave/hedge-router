import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStatusLine } from '../src/status.js';

test('status line keeps the brand lowercase and shows spend, exposure, and paper pnl', () => {
  const line = formatStatusLine({ actual_cost_usd: 1.25, input_tokens: 1200, output_tokens: 300 }, 0.42);
  assert.equal(line, 'hedge router · spend $1.25 · 1.5K tokens · paper +$0.42');
  assert.doesNotMatch(line, /HEDGE ROUTER/);
});

test('status line handles tiny spend and negative paper pnl', () => {
  const line = formatStatusLine({ actual_cost_usd: 0.0042, input_tokens: 8, output_tokens: 2 }, -0.12);
  assert.equal(line, 'hedge router · spend $0.0042 · 10 tokens · paper -$0.12');
});
