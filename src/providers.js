import { normalizeUsage } from './catalog.js';
import { newId, nowIso } from './utils.js';

function apiKey(model) {
  const value = process.env[model.apiKeyEnv];
  if (!value) throw new Error(`Missing provider credential in ${model.apiKeyEnv}`);
  return value;
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/$/, '')}/${suffix.replace(/^\//, '')}`;
}

function anthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.flatMap((item) => {
    if (item.type === 'text' || item.type === 'input_text') {
      return [{ type: 'text', text: item.text }];
    }
    if (item.type === 'image_url' && item.image_url?.url?.startsWith('data:')) {
      const match = item.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) return [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }];
    }
    return [];
  });
}

function toAnthropicMessages(body, mode) {
  let source = mode === 'responses' ? body.input : body.messages;
  if (typeof source === 'string') source = [{ role: 'user', content: source }];
  const messages = [];
  let system = mode === 'responses' ? body.instructions : undefined;

  for (const message of source || []) {
    if (mode === 'responses' && message.type === 'function_call_output') {
      const output = typeof message.output === 'string' ? message.output : JSON.stringify(message.output ?? '');
      messages.push({
        role: 'user', content: [{ type: 'tool_result', tool_use_id: message.call_id, content: output }]
      });
      continue;
    }
    if (mode === 'responses' && message.type === 'function_call') {
      let input = {};
      try { input = JSON.parse(message.arguments || '{}'); } catch { input = {}; }
      messages.push({
        role: 'assistant',
        content: [{ type: 'tool_use', id: message.call_id || message.id, name: message.name, input }]
      });
      continue;
    }
    if (!message.role) continue;
    if (message.role === 'system' || message.role === 'developer') {
      const text = typeof message.content === 'string'
        ? message.content
        : (message.content || []).map((part) => part.text || '').join('\n');
      system = [system, text].filter(Boolean).join('\n');
      continue;
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') }]
      });
      continue;
    }
    const content = anthropicContent(message.content);
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
    if (message.role === 'assistant' && message.tool_calls) {
      for (const call of message.tool_calls) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
      }
    }
    messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks });
  }
  return { messages, system };
}

function anthropicRequest(body, model, mode) {
  const converted = toAnthropicMessages(body, mode);
  const tools = (body.tools || []).map((tool) => {
    const fn = tool.function || tool;
    return { name: fn.name, description: fn.description, input_schema: fn.parameters || fn.input_schema || { type: 'object' } };
  });
  let toolChoice;
  if (body.tool_choice === 'auto') toolChoice = { type: 'auto' };
  else if (body.tool_choice === 'required') toolChoice = { type: 'any' };
  else if (body.tool_choice === 'none') toolChoice = { type: 'none' };
  else if (body.tool_choice?.function?.name) toolChoice = { type: 'tool', name: body.tool_choice.function.name };
  else if (body.tool_choice?.type === 'function' && body.tool_choice.name) toolChoice = { type: 'tool', name: body.tool_choice.name };
  return {
    model: model.upstreamModel,
    messages: converted.messages,
    ...(converted.system ? { system: converted.system } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    max_tokens: body.max_tokens || body.max_output_tokens || 4096,
    temperature: body.temperature,
    top_p: body.top_p,
    ...(body.stop ? { stop_sequences: Array.isArray(body.stop) ? body.stop : [body.stop] } : {}),
    stream: Boolean(body.stream)
  };
}

function finishReason(reason) {
  return ({ end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', stop_sequence: 'stop' })[reason] || reason || 'stop';
}

function fromAnthropic(json, requestedModel, mode) {
  const text = (json.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
  const toolCalls = (json.content || []).filter((part) => part.type === 'tool_use').map((part) => ({
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
  }));
  const totalInput = Number(json.usage?.input_tokens || 0) + Number(json.usage?.cache_read_input_tokens || 0) + Number(json.usage?.cache_creation_input_tokens || 0);
  const usage = {
    prompt_tokens: totalInput,
    completion_tokens: Number(json.usage?.output_tokens || 0),
    total_tokens: totalInput + Number(json.usage?.output_tokens || 0),
    prompt_tokens_details: {
      cached_tokens: Number(json.usage?.cache_read_input_tokens || 0),
      cache_write_tokens: Number(json.usage?.cache_creation_input_tokens || 0)
    }
  };
  if (mode === 'responses') {
    const output = [{
      id: newId('msg'), type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }]
    }];
    for (const call of toolCalls) {
      output.push({ type: 'function_call', id: call.id, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' });
    }
    return {
      id: newId('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'completed', model: requestedModel, output,
      usage: {
        input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        input_tokens_details: usage.prompt_tokens_details
      }
    };
  }
  return {
    id: json.id || newId('chatcmpl'), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: finishReason(json.stop_reason) }],
    usage
  };
}

async function openaiFetch(model, body, mode, signal) {
  const endpoint = mode === 'responses' ? 'responses' : 'chat/completions';
  const requestBody = {
    ...body,
    model: model.upstreamModel,
    ...(mode === 'chat' && body.stream
      ? { stream_options: { ...body.stream_options, include_usage: true } }
      : {})
  };
  return fetch(joinUrl(model.baseUrl, endpoint), {
    method: 'POST', signal,
    headers: { authorization: `Bearer ${apiKey(model)}`, 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
}

async function anthropicFetch(model, body, mode, signal) {
  return fetch(joinUrl(model.baseUrl, 'messages'), {
    method: 'POST', signal,
    headers: {
      'x-api-key': apiKey(model), 'anthropic-version': '2023-06-01', 'content-type': 'application/json'
    },
    body: JSON.stringify(anthropicRequest(body, model, mode))
  });
}

function sseStream(upstream, onEvent, translate = (line) => `${line}\n`) {
  let resolveUsage;
  const usage = new Promise((resolve) => { resolveUsage = resolve; });
  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = '';
      let captured = {};
      try {
        for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const eventUsage = onEvent(line);
            if (eventUsage) captured = { ...captured, ...eventUsage };
            const output = translate(line);
            if (output) controller.enqueue(encoder.encode(output));
          }
        }
        if (buffer) {
          const eventUsage = onEvent(buffer);
          if (eventUsage) captured = { ...captured, ...eventUsage };
          const output = translate(buffer);
          if (output) controller.enqueue(encoder.encode(output));
        }
        resolveUsage(normalizeUsage(captured));
        controller.close();
      } catch (error) {
        resolveUsage(normalizeUsage(captured));
        controller.error(error);
      }
    }
  });
  return { stream, usage };
}

function tapOpenAiStream(upstream) {
  return sseStream(upstream, (line) => {
    if (!line.startsWith('data:') || line === 'data: [DONE]') return null;
    try {
      const data = JSON.parse(line.slice(5));
      return data.usage || data.response?.usage;
    } catch { return null; }
  });
}

function translateAnthropicChatStream(upstream, requestedModel) {
  let eventName = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let toolIndex = 0;
  const id = newId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, reason = null, usage) => `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {})
  })}\n\n`;
  return sseStream(upstream, (line) => {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (!line.startsWith('data:')) return null;
    try {
      const data = JSON.parse(line.slice(5));
      if (data.message?.usage) {
        inputTokens = data.message.usage.input_tokens || inputTokens;
        cachedInputTokens = data.message.usage.cache_read_input_tokens || cachedInputTokens;
        cacheWriteInputTokens = data.message.usage.cache_creation_input_tokens || cacheWriteInputTokens;
      }
      if (data.usage?.output_tokens != null) outputTokens = data.usage.output_tokens;
      return {
        input_tokens: inputTokens,
        cache_read_input_tokens: cachedInputTokens,
        cache_creation_input_tokens: cacheWriteInputTokens,
        output_tokens: outputTokens
      };
    } catch { return null; }
  }, (line) => {
    if (!line.startsWith('data:')) return '';
    let data;
    try { data = JSON.parse(line.slice(5)); } catch { return ''; }
    if (eventName === 'message_start') return chunk({ role: 'assistant', content: '' });
    if (eventName === 'content_block_start' && data.content_block?.type === 'tool_use') {
      toolIndex = data.index;
      return chunk({ tool_calls: [{ index: toolIndex, id: data.content_block.id, type: 'function', function: { name: data.content_block.name, arguments: '' } }] });
    }
    if (eventName === 'content_block_delta' && data.delta?.type === 'text_delta') return chunk({ content: data.delta.text });
    if (eventName === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
      return chunk({ tool_calls: [{ index: data.index, function: { arguments: data.delta.partial_json } }] });
    }
    if (eventName === 'message_delta') return chunk({}, finishReason(data.delta?.stop_reason), {
      prompt_tokens: inputTokens, completion_tokens: data.usage?.output_tokens || outputTokens,
      total_tokens: inputTokens + (data.usage?.output_tokens || outputTokens)
    });
    if (eventName === 'message_stop') return 'data: [DONE]\n\n';
    return '';
  });
}

export function supportsRequest(model, body, mode) {
  if (model.provider === 'openai') return true;
  if (mode === 'responses' && body.stream) return false;
  if (mode === 'responses' && (body.previous_response_id || body.conversation || body.background)) return false;
  if ((body.tools || []).some((tool) => tool.type !== 'function')) return false;
  return true;
}

export async function providerRequest({ model, body, mode, signal }) {
  if (!supportsRequest(model, body, mode)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: { message: `${model.id} cannot preserve the requested OpenAI feature; choose an OpenAI-backed route` }
      }), { status: 400, headers: { 'content-type': 'application/json' } })
    };
  }
  const upstream = model.provider === 'openai'
    ? await openaiFetch(model, body, mode, signal)
    : await anthropicFetch(model, body, mode, signal);
  if (!upstream.ok) return { ok: false, response: upstream };

  if (!body.stream) {
    const json = await upstream.json();
    const result = model.provider === 'anthropic' ? fromAnthropic(json, body.model, mode) : json;
    const usage = model.provider === 'anthropic' ? normalizeUsage(json.usage) : normalizeUsage(result.usage);
    return { ok: true, json: result, usage, status: upstream.status };
  }
  const tapped = model.provider === 'anthropic'
    ? translateAnthropicChatStream(upstream, body.model)
    : tapOpenAiStream(upstream);
  return { ok: true, stream: tapped.stream, usage: tapped.usage, status: upstream.status };
}

export function providerError(status, message, model) {
  return { timestamp: nowIso(), status, message: String(message).slice(0, 300), model: model.id };
}
