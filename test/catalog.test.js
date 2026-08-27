import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, normalizeUsage, unitCost } from '../src/catalog.js';

test('cost accounting separates cached, uncached, and output tokens', () => {
  const model = { inputPerMillion: 2, cachedInputPerMillion: 0.2, outputPerMillion: 10 };
  const cost = unitCost(model, { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200 });
  assert.equal(cost, (600 * 2 + 400 * 0.2 + 200 * 10) / 1_000_000);
});

test('normalizes OpenAI and Anthropic usage shapes', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } }), {
    input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 4
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 1 }), {
    input_tokens: 9, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 3
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 }), {
    input_tokens: 11, cached_input_tokens: 1, cache_write_input_tokens: 2, output_tokens: 3
  });
});

test('task classification emits only coarse categories', () => {
  assert.equal(classifyTask({ messages: [{ role: 'user', content: 'Debug this exception' }] }), 'debug');
  assert.equal(classifyTask({ input: 'hello there' }), 'other');
});
