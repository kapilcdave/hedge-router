import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

function config(overrides = {}) {
  return {
    server: { host: '127.0.0.1', port: 8787 },
    routing: { defaultModel: 'one', controlPercent: 10, maxAttempts: 2, requestTimeoutMs: 120000 },
    models: [{
      id: 'one', provider: 'openai', upstreamModel: 'one', apiKeyEnv: 'KEY',
      inputPerMillion: 1, outputPerMillion: 2, contextWindow: 1000, qualityTier: 2
    }],
    telemetry: { minimumCohort: 20, remoteUrl: null },
    collector: { host: '127.0.0.1', port: 8790, tokenEnv: 'TOKEN', rawRetentionDays: 30, minimumCohort: 20 },
    ...overrides
  };
}

test('configuration refuses a remotely exposed unauthenticated proxy', () => {
  assert.throws(() => validateConfig(config({ server: { host: '0.0.0.0', port: 8787 } })), /loopback/);
});

test('configuration requires TLS for nonlocal telemetry', () => {
  assert.throws(() => validateConfig(config({ telemetry: { minimumCohort: 20, remoteUrl: 'http://collector.example/events' } })), /HTTPS/);
  assert.doesNotThrow(() => validateConfig(config({ telemetry: { minimumCohort: 20, remoteUrl: 'https://collector.example/events' } })));
});
