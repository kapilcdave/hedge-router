import { classifyTask, estimatedBlendedCost, estimateInputTokens, requestedTier } from './catalog.js';
import { stableBucket } from './utils.js';

const TASK_TIERS = { test: 1, refactor: 1, other: 1, debug: 2, implementation: 2, analysis: 2 };

function rank(models, modelStats = {}) {
  return [...models].sort((a, b) => {
    const aStats = modelStats[a.id] || {};
    const bStats = modelStats[b.id] || {};
    const aUnreliable = aStats.samples >= 5 && aStats.error_rate >= 0.2 ? 1 : 0;
    const bUnreliable = bStats.samples >= 5 && bStats.error_rate >= 0.2 ? 1 : 0;
    const reliability = aUnreliable - bUnreliable;
    if (reliability) return reliability;
    const aCost = estimatedBlendedCost(a);
    const bCost = estimatedBlendedCost(b);
    const costDifference = aCost - bCost;
    if (Math.abs(costDifference) > Math.min(aCost, bCost) * 0.1) return costDifference;
    return (aStats.mean_latency_ms ?? Infinity) - (bStats.mean_latency_ms ?? Infinity) || costDifference;
  });
}

export function buildRoute({ config, body, sessionId, quality, explicitModel, modelStats = {}, taskClass }) {
  if (explicitModel && explicitModel !== 'auto') {
    const exact = config.models.find((model) => model.id === explicitModel);
    if (!exact) throw new Error(`Unknown model: ${explicitModel}`);
    return { candidates: [exact], control: false, reason: 'explicit_model' };
  }

  const inputTokens = estimateInputTokens(body);
  const localTaskClass = taskClass || classifyTask(body);
  const tier = Math.max(requestedTier(quality || config.routing.qualityBias), TASK_TIERS[localTaskClass] || 1);
  const eligible = config.models.filter((model) => model.contextWindow >= inputTokens);
  if (!eligible.length) throw new Error('No configured model has a large enough context window');

  const control = stableBucket(sessionId) < config.routing.controlPercent;
  if (control) {
    const selected = config.models.find((model) => model.id === config.routing.defaultModel);
    if (selected && selected.contextWindow >= inputTokens) {
      return { candidates: [selected], control: true, reason: 'control_cohort' };
    }
  }

  let primaryPool = eligible.filter((model) => model.qualityTier >= tier);
  if (!primaryPool.length) primaryPool = eligible;
  const primary = rank(primaryPool, modelStats)[0];
  const escalation = rank(eligible.filter((model) => model.id !== primary.id), modelStats)
    .sort((a, b) => {
      const aIsEscalation = a.qualityTier >= primary.qualityTier ? 0 : 1;
      const bIsEscalation = b.qualityTier >= primary.qualityTier ? 0 : 1;
      return aIsEscalation - bIsEscalation || a.qualityTier - b.qualityTier || estimatedBlendedCost(a) - estimatedBlendedCost(b);
    });
  const candidates = [primary, ...escalation]
    .slice(0, Math.max(1, config.routing.maxAttempts));
  return { candidates, control: false, reason: 'cheapest_eligible' };
}
