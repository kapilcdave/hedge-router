import { access } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './utils.js';

const DEFAULTS = {
  server: { host: '127.0.0.1', port: 8787 },
  routing: {
    defaultModel: null,
    controlPercent: 10,
    maxAttempts: 2,
    requestTimeoutMs: 120000,
    qualityBias: 'balanced'
  },
  models: [],
  telemetry: {
    enabled: false,
    remoteUrl: null,
    remoteTokenEnv: null,
    rawRetentionDays: 30,
    minimumCohort: 20
  },
  collector: {
    host: '127.0.0.1',
    port: 8790,
    tokenEnv: 'HEDGE_ROUTER_COLLECTOR_TOKEN',
    rawRetentionDays: 30,
    minimumCohort: 20
  },
  quality: { commands: [] }
};

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid configuration: ${message}`);
}

export function validateConfig(config) {
  assert(['127.0.0.1', '::1', 'localhost'].includes(config.server.host),
    'server.host must be loopback; the proxy intentionally has no remote-listen mode');
  assert(config.models.length > 0, 'at least one model is required');
  const ids = new Set();
  for (const model of config.models) {
    assert(model.id && !ids.has(model.id), `model id must be unique: ${model.id}`);
    ids.add(model.id);
    assert(['openai', 'anthropic'].includes(model.provider), `${model.id} has unsupported provider`);
    assert(model.upstreamModel, `${model.id} requires upstreamModel`);
    assert(model.apiKeyEnv, `${model.id} requires apiKeyEnv`);
    assert(Number.isFinite(model.inputPerMillion), `${model.id} requires inputPerMillion`);
    assert(Number.isFinite(model.outputPerMillion), `${model.id} requires outputPerMillion`);
    assert(Number.isFinite(model.contextWindow), `${model.id} requires contextWindow`);
    assert([1, 2, 3].includes(model.qualityTier), `${model.id} qualityTier must be 1, 2, or 3`);
  }
  assert(ids.has(config.routing.defaultModel), 'routing.defaultModel must name a configured model');
  assert(config.routing.controlPercent >= 0 && config.routing.controlPercent <= 100,
    'routing.controlPercent must be between 0 and 100');
  assert(Number.isInteger(config.routing.maxAttempts) && config.routing.maxAttempts >= 1,
    'routing.maxAttempts must be a positive integer');
  assert(Number.isFinite(config.routing.requestTimeoutMs) && config.routing.requestTimeoutMs >= 1000,
    'routing.requestTimeoutMs must be at least 1000');
  assert(config.telemetry.minimumCohort >= 1, 'telemetry.minimumCohort must be positive');
  if (config.telemetry.remoteUrl) {
    const remote = new URL(config.telemetry.remoteUrl);
    assert(remote.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(remote.hostname),
      'telemetry.remoteUrl must use HTTPS unless it is loopback');
  }
  assert(config.collector.tokenEnv, 'collector.tokenEnv is required');
  assert(Number.isInteger(config.collector.port) && config.collector.port > 0 && config.collector.port <= 65535,
    'collector.port must be a valid TCP port');
  assert(config.collector.minimumCohort >= 2, 'collector.minimumCohort must be at least 2');
  assert(config.collector.rawRetentionDays >= 1, 'collector.rawRetentionDays must be positive');
  return config;
}

export async function findConfig(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.HEDGE_ROUTER_CONFIG,
    path.resolve('hedge-router.config.json'),
    process.env.COMP_CONFIG,
    path.resolve('comp.config.json')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }
  throw new Error('No configuration found. Copy hedge-router.config.example.json to hedge-router.config.json.');
}

export async function loadConfig(explicitPath) {
  const file = await findConfig(explicitPath);
  const supplied = await readJson(file);
  const config = {
    ...DEFAULTS,
    ...supplied,
    server: { ...DEFAULTS.server, ...supplied.server },
    routing: { ...DEFAULTS.routing, ...supplied.routing },
    telemetry: { ...DEFAULTS.telemetry, ...supplied.telemetry },
    collector: { ...DEFAULTS.collector, ...supplied.collector },
    quality: { ...DEFAULTS.quality, ...supplied.quality }
  };
  return { config: validateConfig(config), file };
}
