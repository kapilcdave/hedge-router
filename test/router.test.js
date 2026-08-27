import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute } from '../src/router.js';

const models = [
  { id: 'cheap', qualityTier: 2, contextWindow: 10000, inputPerMillion: 1, outputPerMillion: 2 },
  { id: 'strong', qualityTier: 3, contextWindow: 10000, inputPerMillion: 4, outputPerMillion: 8 },
  { id: 'large', qualityTier: 3, contextWindow: 100000, inputPerMillion: 5, outputPerMillion: 10 }
];

const config = {
  models,
  routing: { defaultModel: 'strong', controlPercent: 0, maxAttempts: 2, qualityBias: 'balanced' }
};

test('auto routing selects cheapest eligible model then a stronger fallback', () => {
  const route = buildRoute({
    config, body: { messages: [{ role: 'user', content: 'implement a parser' }] },
    sessionId: 'session', quality: 'balanced', explicitModel: 'auto'
  });
  assert.equal(route.candidates[0].id, 'cheap');
  assert.equal(route.candidates[1].id, 'strong');
});

test('high quality excludes lower tiers', () => {
  const route = buildRoute({
    config, body: { messages: [{ role: 'user', content: 'hard task' }] },
    sessionId: 'session', quality: 'high', explicitModel: 'auto'
  });
  assert.equal(route.candidates[0].id, 'strong');
});

test('explicit models bypass automatic routing', () => {
  const route = buildRoute({ config, body: {}, sessionId: 'session', explicitModel: 'large' });
  assert.deepEqual(route.candidates.map((model) => model.id), ['large']);
  assert.equal(route.reason, 'explicit_model');
});

test('latency history breaks near-cost ties without overriding large savings', () => {
  const tied = [
    { id: 'slow', qualityTier: 2, contextWindow: 10000, inputPerMillion: 1, outputPerMillion: 2 },
    { id: 'fast', qualityTier: 2, contextWindow: 10000, inputPerMillion: 1.05, outputPerMillion: 2 }
  ];
  const route = buildRoute({
    config: { models: tied, routing: { defaultModel: 'slow', controlPercent: 0, maxAttempts: 2, qualityBias: 'balanced' } },
    body: { input: 'explain this' }, sessionId: 'session', explicitModel: 'auto',
    modelStats: { slow: { samples: 10, mean_latency_ms: 2000, error_rate: 0 }, fast: { samples: 10, mean_latency_ms: 500, error_rate: 0 } }
  });
  assert.equal(route.candidates[0].id, 'fast');
});
