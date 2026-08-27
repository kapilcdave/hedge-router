import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRequest } from '../src/providers.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.TEST_PROVIDER_KEY;
});

test('OpenAI adapter rewrites the model and normalizes usage', async () => {
  process.env.TEST_PROVIDER_KEY = 'secret';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://provider.test/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer secret');
    assert.equal(JSON.parse(options.body).model, 'mock-model');
    return new Response(JSON.stringify({
      id: 'upstream', object: 'chat.completion', model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await providerRequest({
    model: {
      id: 'mock/cheap', provider: 'openai', upstreamModel: 'mock-model',
      apiKeyEnv: 'TEST_PROVIDER_KEY', baseUrl: 'https://provider.test/v1'
    },
    body: { model: 'auto', messages: [{ role: 'user', content: 'hello' }] }, mode: 'chat'
  });
  assert.equal(result.ok, true);
  assert.equal(result.json.choices[0].message.content, 'ok');
  assert.deepEqual(result.usage, { input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2 });
});

test('Anthropic adapter translates OpenAI tools and responses', async () => {
  process.env.TEST_PROVIDER_KEY = 'secret';
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'claude-test');
    assert.equal(request.tools[0].name, 'read_file');
    assert.equal(request.messages[0].role, 'user');
    return new Response(JSON.stringify({
      id: 'msg_1', content: [
        { type: 'text', text: 'Reading' },
        { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'a.js' } }
      ], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 5 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await providerRequest({
    model: {
      id: 'anthropic/test', provider: 'anthropic', upstreamModel: 'claude-test',
      apiKeyEnv: 'TEST_PROVIDER_KEY', baseUrl: 'https://anthropic.test/v1'
    },
    body: {
      model: 'auto', messages: [{ role: 'user', content: 'read it' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
    }, mode: 'chat'
  });
  assert.equal(result.ok, true);
  assert.equal(result.json.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.json.choices[0].message.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(result.usage, { input_tokens: 12, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5 });
});

test('stream adapter captures usage without buffering response content', async () => {
  process.env.TEST_PROVIDER_KEY = 'secret';
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream_options.include_usage, true);
    return new Response([
      'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"x","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n'
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await providerRequest({
    model: {
      id: 'mock/cheap', provider: 'openai', upstreamModel: 'mock-model',
      apiKeyEnv: 'TEST_PROVIDER_KEY', baseUrl: 'https://provider.test/v1'
    },
    body: { model: 'auto', stream: true, messages: [{ role: 'user', content: 'hello' }] }, mode: 'chat'
  });
  const output = await new Response(result.stream).text();
  assert.match(output, /"content":"hi"/);
  assert.deepEqual(await result.usage, { input_tokens: 7, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 3 });
});

test('Anthropic Responses translation preserves function call outputs', async () => {
  process.env.TEST_PROVIDER_KEY = 'secret';
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.messages[0], {
      role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { key: 'x' } }]
    });
    assert.deepEqual(request.messages[1], {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'value' }]
    });
    return new Response(JSON.stringify({
      id: 'msg_2', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 4 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await providerRequest({
    model: { id: 'anthropic/test', provider: 'anthropic', upstreamModel: 'claude-test', apiKeyEnv: 'TEST_PROVIDER_KEY', baseUrl: 'https://anthropic.test/v1' },
    body: {
      model: 'auto', input: [
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"key":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'value' }
      ]
    }, mode: 'responses'
  });
  assert.equal(result.json.output[0].content[0].text, 'done');
  assert.deepEqual(result.usage, { input_tokens: 27, cached_input_tokens: 5, cache_write_input_tokens: 2, output_tokens: 4 });
});
