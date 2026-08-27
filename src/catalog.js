const QUALITY_TIERS = { economy: 1, balanced: 2, high: 3 };

export function requestedTier(value = 'balanced') {
  return QUALITY_TIERS[value] || QUALITY_TIERS.balanced;
}

export function unitCost(model, usage) {
  const input = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const cached = Math.min(input, Number(usage.cached_input_tokens || 0));
  const cacheWrite = Math.min(input - cached, Number(usage.cache_write_input_tokens || 0));
  const output = Number(usage.output_tokens || usage.completion_tokens || 0);
  const uncached = input - cached - cacheWrite;
  return (
    uncached * model.inputPerMillion +
    cached * (model.cachedInputPerMillion ?? model.inputPerMillion) +
    cacheWrite * (model.cacheWriteInputPerMillion ?? model.inputPerMillion) +
    output * model.outputPerMillion
  ) / 1_000_000;
}

export function estimatedBlendedCost(model) {
  return model.inputPerMillion * 0.7 + model.outputPerMillion * 0.3;
}

export function estimateInputTokens(body) {
  const source = body.messages ?? body.input ?? '';
  const serialized = typeof source === 'string' ? source : JSON.stringify(source);
  return Math.ceil(serialized.length / 4);
}

export function classifyTask(body) {
  const source = JSON.stringify(body.messages ?? body.input ?? '').toLowerCase();
  if (/\b(test|spec|assert|coverage)\b/.test(source)) return 'test';
  if (/\b(debug|bug|error|exception|fail)\b/.test(source)) return 'debug';
  if (/\b(refactor|rename|cleanup|simplif)\b/.test(source)) return 'refactor';
  if (/\b(explain|review|analy[sz]e|why)\b/.test(source)) return 'analysis';
  if (/\b(create|build|implement|add|write)\b/.test(source)) return 'implementation';
  return 'other';
}

export function normalizeUsage(usage = {}) {
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const anthropicCached = Number(usage.cache_read_input_tokens || 0);
  const anthropicCacheWrite = Number(usage.cache_creation_input_tokens || 0);
  const baseInput = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const isAnthropicShape = 'cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage;
  return {
    input_tokens: baseInput + (isAnthropicShape ? anthropicCached + anthropicCacheWrite : 0),
    cached_input_tokens: Number(usage.cached_input_tokens ?? details.cached_tokens ?? anthropicCached),
    cache_write_input_tokens: Number(usage.cache_write_input_tokens ?? details.cache_write_tokens ?? anthropicCacheWrite),
    output_tokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0)
  };
}
