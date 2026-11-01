/**
 * Shared pieces of the long-run continuity probes (scripts/probe-claude-long-run.mjs,
 * scripts/probe-codex-long-run.mjs): scripted loopback stubs of the Anthropic Messages API and the OpenAI
 * Responses API so the real CLIs run with no real account, a deny-and-log proxy that shows whether a CLI tried a
 * real endpoint, a gated slow MCP tool, and session-file facts that report shapes and markers, never text.
 *
 * Credentials: the stubs never keep an Authorization or x-api-key value. A request log holds the header names and
 * one boolean, whether the presented credential equals the dummy this probe set.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { delay } from './wrap-up-probe-kit.mjs';

/** Not real credentials: they only exist inside these scratch runs. */
export const DUMMY_API_KEY = `sk-ant-api03-long-run-probe-dummy-${randomBytes(8).toString('hex')}`;
export const DUMMY_OAUTH_TOKEN = `sk-ant-oat01-long-run-probe-dummy-${randomBytes(8).toString('hex')}`;
export const DUMMY_OPENAI_KEY = `sk-long-run-probe-dummy-${randomBytes(8).toString('hex')}`;

export const clip = (value, limit = 200) => (typeof value === 'string' ? (value.length > limit ? `${value.slice(0, limit)}…(${value.length})` : value) : value ?? null);
/** Which of the `markers` (name -> text) a text holds; reports keep these names, never the text. */
export const markerNames = (text, markers) => Object.entries(markers).filter(([, needle]) => String(text ?? '').includes(needle)).map(([name]) => name);
export const marker = (prefix) => `${prefix}-${randomBytes(4).toString('hex')}`;
/** A promise with its resolver, for holding a stub response or a callback until the probe says so. */
export function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

function sameSecret(presented, expected) {
  const left = Buffer.from(String(presented));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Names of the headers a request carried, and whether its credential is one of this probe's dummies. */
function requestIdentity(headers, dummies) {
  const authorization = headers.authorization ? String(headers.authorization).replace(/^Bearer\s+/iu, '') : null;
  const apiKey = headers['x-api-key'] ?? null;
  const presented = apiKey ?? authorization;
  return {
    headerNames: Object.keys(headers).sort(),
    credential: apiKey ? 'x-api-key' : authorization ? 'authorization' : null,
    credentialIsDummy: presented === null ? null : dummies.some((dummy) => sameSecret(presented, dummy)),
  };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let raw = Buffer.concat(chunks);
      try {
        if (/gzip/iu.test(String(request.headers['content-encoding'] ?? ''))) raw = gunzipSync(raw);
        resolve(raw.length ? JSON.parse(raw.toString('utf8')) : {});
      } catch {
        resolve({ unreadable: true, bytes: raw.length });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Deny proxy

/** Every outbound attempt through HTTP(S)_PROXY is logged and refused: nothing reaches a real host. */
export async function startDenyProxy() {
  const attempts = [];
  const server = http.createServer((request, response) => {
    let host = 'unparsed';
    try { host = new URL(request.url).host; } catch { /* a relative URL */ }
    attempts.push({ at: Date.now(), kind: 'http', method: request.method, host });
    response.writeHead(403);
    response.end();
  });
  server.on('connect', (request, socket) => {
    attempts.push({ at: Date.now(), kind: 'connect', host: request.url });
    socket.on('error', () => undefined);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    attempts,
    hosts: () => {
      const counts = {};
      for (const entry of attempts) counts[entry.host] = (counts[entry.host] ?? 0) + 1;
      return counts;
    },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages stub

/** What a request's `messages` held: enough to tell what the model would have read, in order. */
export function messagesShape(messages, markers = {}, keepText = false) {
  const found = (text) => markerNames(text, markers);
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : [];
    return {
      role: message.role,
      blocks: content.map((block) => {
        if (block.type === 'text') return { type: 'text', chars: block.text?.length ?? 0, markers: found(block.text), ...(keepText ? { text: clip(block.text, 400) } : {}) };
        if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name };
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((part) => part.text ?? '').join('\n');
          return { type: 'tool_result', id: block.tool_use_id, isError: block.is_error ?? false, chars: text.length, markers: found(text) };
        }
        return { type: block.type };
      }),
    };
  });
}

/** The headers a real allowed response carries (see the unifiedWindows of a real rate_limit_event). */
export function allowedHeaders({ fiveHourResetAt, sevenDayResetAt, fiveHour = 0.2, sevenDay = 0.3 }) {
  return {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-reset': String(fiveHourResetAt),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': String(fiveHourResetAt),
    'anthropic-ratelimit-unified-5h-utilization': String(fiveHour),
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': String(sevenDayResetAt),
    'anthropic-ratelimit-unified-7d-utilization': String(sevenDay),
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
  };
}

/** A real-shaped refusal: the window that ran out is `claim`, the other stays allowed. */
export function rejectedHeaders({ claim = 'five_hour', fiveHourResetAt, sevenDayResetAt, overage = true }) {
  const weekly = claim === 'seven_day';
  const resetAt = weekly ? sevenDayResetAt : fiveHourResetAt;
  return {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(resetAt),
    'anthropic-ratelimit-unified-representative-claim': claim,
    'anthropic-ratelimit-unified-5h-status': weekly ? 'allowed' : 'rejected',
    'anthropic-ratelimit-unified-5h-reset': String(fiveHourResetAt),
    'anthropic-ratelimit-unified-5h-utilization': weekly ? '0.4' : '1',
    'anthropic-ratelimit-unified-7d-status': weekly ? 'rejected' : 'allowed',
    'anthropic-ratelimit-unified-7d-reset': String(sevenDayResetAt),
    'anthropic-ratelimit-unified-7d-utilization': weekly ? '1' : '0.6',
    ...(overage ? {
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
    } : {}),
    'retry-after': String(Math.max(0, resetAt - Math.floor(Date.now() / 1000))),
  };
}

/** What Codex's server answers at a limit: `usage`, `usage-no-reset`, `not-included`, or a plain rate limit. */
export const codexLimitBody = (kind, resetsAt) => {
  if (kind === 'usage') return { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: resetsAt } };
  if (kind === 'usage-no-reset') return { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus' } };
  if (kind === 'not-included') return { error: { type: 'usage_not_included', message: 'Upgrade to use this', plan_type: 'free' } };
  return { error: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1s.' } };
};

/** The rate-limit headers a real response carries: primary is the 5-hour window, secondary the week. */
export function codexLimitHeaders({ primaryUsed = 20, secondaryUsed = 30, primaryResetAt, secondaryResetAt }) {
  return {
    'x-codex-active-limit': 'codex',
    'x-codex-primary-used-percent': String(primaryUsed), 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(primaryResetAt),
    'x-codex-secondary-used-percent': String(secondaryUsed), 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-at': String(secondaryResetAt),
  };
}

export const RATE_LIMIT_BODY = {
  type: 'error',
  error: { type: 'rate_limit_error', message: "This request would exceed your account's rate limit. Please try again later." },
  request_id: 'req_stub',
};

const sse = (response, event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);

/**
 * `route(tag)` gives a base URL and a script. Calls the probe calls main (tools present) take the next `steps`
 * entry, or `fallback`; a step may be a function of the request entry. Other calls (titles and the like) get
 * a short text. Steps:
 *   { kind: 'text', text, chunks, chunkMs, onStart, onChunk, beforeEnd }
 *   { kind: 'tool', name, input, text, calls, onStart, beforeEnd }  (calls: several parallel tool uses)
 *   { kind: 'raw', status, headers, body }
 * `headers` of a route are added to every streamed success.
 */
export async function startAnthropicStub({ dummies }) {
  const routes = new Map();
  const requests = [];
  let messageCount = 0;

  const sendRaw = (response, step) => {
    const body = JSON.stringify(step.body ?? {});
    response.writeHead(step.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...step.headers });
    response.end(body);
  };

  const stream = async (response, entry, route, step, model) => {
    const id = `msg_stub_${(messageCount += 1)}`;
    let closed = false;
    response.on('close', () => { if (!response.writableEnded) { closed = true; entry.clientAborted = true; entry.abortedAtChunk = entry.chunksSent ?? 0; } });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_stub_${messageCount}`, ...route.headers });
    await step.onStart?.(entry);
    sse(response, 'message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    let index = 0;
    const text = step.text ?? (step.kind === 'text' ? 'OK' : null);
    if (text) {
      sse(response, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
      const chunks = Math.max(1, step.chunks ?? 1);
      const size = Math.ceil(text.length / chunks);
      for (let chunk = 0; chunk < chunks && !closed; chunk += 1) {
        sse(response, 'content_block_delta', { index, delta: { type: 'text_delta', text: text.slice(chunk * size, (chunk + 1) * size) } });
        entry.chunksSent = chunk + 1;
        await step.onChunk?.(chunk, entry);
        if (step.chunkMs) await delay(step.chunkMs);
      }
      if (closed) return;
      sse(response, 'content_block_stop', { index });
      index += 1;
    }
    const calls = step.kind === 'tool' ? step.calls ?? [{ name: step.name, input: step.input }] : [];
    for (const call of calls) {
      if (closed) return;
      const toolId = call.id ?? `toolu_stub_${randomBytes(6).toString('hex')}`;
      sse(response, 'content_block_start', { index, content_block: { type: 'tool_use', id: toolId, name: call.name, input: {} } });
      sse(response, 'content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input ?? {}) } });
      sse(response, 'content_block_stop', { index });
      index += 1;
    }
    await step.beforeEnd?.(entry);
    if (closed) return;
    sse(response, 'message_delta', { delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
    sse(response, 'message_stop', {});
    response.end();
    entry.finishedAt = Date.now();
  };

  const plain = (response, body, text) => {
    const message = { id: `msg_stub_${(messageCount += 1)}`, type: 'message', role: 'assistant', model: body.model ?? 'stub', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } };
    const payload = JSON.stringify(message);
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    response.end(payload);
  };

  const server = http.createServer(async (request, response) => {
    const match = /^\/s\/([^/]+)(\/[^?]*)?(\?.*)?$/u.exec(request.url ?? '');
    const route = match ? routes.get(decodeURIComponent(match[1])) : undefined;
    const body = await readBody(request);
    const entry = {
      at: Date.now(), tag: match?.[1] ?? null, method: request.method, path: match?.[2] ?? (request.url ?? ''),
      ...requestIdentity(request.headers, dummies),
      model: body.model ?? null, stream: body.stream ?? null, maxTokens: body.max_tokens ?? null,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0, systemChars: JSON.stringify(body.system ?? '').length,
      messages: messagesShape(body.messages, route?.markers, route?.keepText),
    };
    requests.push(entry);
    route?.requests.push(entry);
    try {
      if (route && /\/v1\/messages$/u.test(entry.path)) {
        // A limit answers every call while it lasts, the title and quota calls too.
        const refused = route.limit?.(entry);
        if (refused) {
          entry.main = entry.toolCount > 0;
          entry.answer = `limited:${refused.status}`;
          sendRaw(response, refused);
          return;
        }
      }
      if (!route || !/\/v1\/messages$/u.test(entry.path)) {
        entry.answer = 'not-found';
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"type":"error","error":{"type":"not_found_error","message":"stub"}}');
        return;
      }
      const main = entry.toolCount > 0 && (route.isMain?.(entry, body) ?? true);
      entry.main = main;
      if (!main) {
        entry.answer = 'side';
        const limited = route.sideStep?.(entry);
        if (limited) { sendRaw(response, limited); return; }
        if (body.stream) await stream(response, entry, route, { kind: 'text', text: 'Stub title' }, body.model ?? 'stub');
        else plain(response, body, 'Stub title');
        return;
      }
      entry.mainIndex = route.mainCalls;
      route.mainCalls += 1;
      let step = route.steps.shift() ?? route.fallback;
      if (typeof step === 'function') step = await step(entry, route);
      entry.answer = step.kind === 'raw' ? `raw:${step.status}` : step.kind;
      if (step.kind === 'raw') sendRaw(response, step);
      else await stream(response, entry, route, step, body.model ?? 'stub');
    } catch (error) {
      entry.stubError = String(error?.message ?? error).slice(0, 200);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    requests,
    route(tag, { steps = [], fallback = { kind: 'text', text: 'OK' }, headers = {}, isMain, sideStep, markers = {}, limit = null, keepText = false } = {}) {
      const entry = { tag, steps, fallback, headers, isMain, sideStep, markers, limit, keepText, requests: [], mainCalls: 0, url: `http://127.0.0.1:${port}/s/${encodeURIComponent(tag)}` };
      routes.set(tag, entry);
      return entry;
    },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// ---------------------------------------------------------------------------
// OpenAI Responses stub

/** What a Responses request's `input` held, in order. */
export function responsesInputShape(input, markers = {}) {
  return (Array.isArray(input) ? input : []).map((item) => {
    if (item.type === 'message' || item.role) {
      const text = (Array.isArray(item.content) ? item.content : []).map((part) => part.text ?? '').join('\n');
      return { type: 'message', role: item.role, chars: text.length, markers: markerNames(text, markers) };
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') return { type: item.type, name: item.name, callId: item.call_id };
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
      return { type: item.type, callId: item.call_id, chars: output.length, markers: markerNames(output, markers) };
    }
    return { type: item.type ?? 'unknown' };
  });
}

/**
 * Same script model as the Anthropic stub, for `POST …/responses`. Steps:
 *   { kind: 'text', text, chunks, chunkMs, onStart, onChunk, beforeEnd }
 *   { kind: 'call', name, arguments, custom, text, onStart, beforeEnd }
 *   { kind: 'raw', status, headers, body }
 *   { kind: 'failed', error }  (a 200 stream whose response.failed carries `error`)
 */
export async function startResponsesStub({ dummies }) {
  const routes = new Map();
  const requests = [];
  let count = 0;
  const event = (response, type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);

  const stream = async (response, entry, route, step) => {
    const id = `resp_stub_${(count += 1)}`;
    let closed = false;
    response.on('close', () => { if (!response.writableEnded) { closed = true; entry.clientAborted = true; entry.abortedAtChunk = entry.chunksSent ?? 0; } });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...route.headers, ...step.headers });
    await step.onStart?.(entry);
    event(response, 'response.created', { response: { id } });
    const output = [];
    let index = 0;
    const text = step.text ?? (step.kind === 'text' ? 'OK' : null);
    if (text) {
      const itemId = `msg_stub_${count}`;
      event(response, 'response.output_item.added', { output_index: index, item: { type: 'message', role: 'assistant', id: itemId, content: [] } });
      const chunks = Math.max(1, step.chunks ?? 1);
      const size = Math.ceil(text.length / chunks);
      for (let chunk = 0; chunk < chunks && !closed; chunk += 1) {
        event(response, 'response.output_text.delta', { item_id: itemId, output_index: index, content_index: 0, delta: text.slice(chunk * size, (chunk + 1) * size) });
        entry.chunksSent = chunk + 1;
        await step.onChunk?.(chunk, entry);
        if (step.chunkMs) await delay(step.chunkMs);
      }
      if (closed) return;
      const item = { type: 'message', role: 'assistant', id: itemId, content: [{ type: 'output_text', text, annotations: [] }] };
      event(response, 'response.output_item.done', { output_index: index, item });
      output.push(item);
      index += 1;
    }
    if (step.kind === 'failed') {
      await step.beforeEnd?.(entry);
      if (closed) return;
      event(response, 'response.failed', { response: { id, status: 'failed', error: step.error } });
      response.end();
      return;
    }
    for (const call of step.kind === 'call' ? step.calls ?? [step] : []) {
      if (closed) return;
      const callId = call.callId ?? `call_stub_${randomBytes(6).toString('hex')}`;
      const item = call.custom
        ? { type: 'custom_tool_call', id: `ctc_${callId}`, call_id: callId, name: call.name, input: call.input }
        : { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: call.name, ...(call.namespace ? { namespace: call.namespace } : {}), arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}) };
      event(response, 'response.output_item.added', { output_index: index, item });
      event(response, 'response.output_item.done', { output_index: index, item });
      output.push(item);
      index += 1;
    }
    await step.beforeEnd?.(entry);
    if (closed) return;
    event(response, 'response.completed', { response: { id, status: 'completed', output, usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 132 } } });
    response.end();
    entry.finishedAt = Date.now();
  };

  const server = http.createServer(async (request, response) => {
    const match = /^\/s\/([^/]+)(\/[^?]*)?(\?.*)?$/u.exec(request.url ?? '');
    const route = match ? routes.get(decodeURIComponent(match[1])) : undefined;
    const body = await readBody(request);
    const entry = {
      at: Date.now(), tag: match?.[1] ?? null, method: request.method, path: match?.[2] ?? (request.url ?? ''),
      ...requestIdentity(request.headers, dummies),
      model: body.model ?? null, stream: body.stream ?? null, toolNames: (body.tools ?? []).flatMap((tool) => (tool.type === 'namespace' ? (tool.tools ?? []).map((inner) => `${tool.name}/${inner.name}`) : [tool.name ?? tool.type])), input: responsesInputShape(body.input, route?.markers),
    };
    requests.push(entry);
    route?.requests.push(entry);
    try {
      if (route && request.method === 'GET' && /\/models$/u.test(entry.path)) {
        entry.answer = 'models';
        const payload = JSON.stringify({ models: [], data: [] });
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
        response.end(payload);
        return;
      }
      if (!route || !/\/responses$/u.test(entry.path)) {
        entry.answer = 'not-found';
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"stub","type":"not_found"}}');
        return;
      }
      const refused = route.limit?.(entry);
      if (refused) {
        entry.main = true;
        entry.answer = `limited:${refused.status ?? refused.kind}`;
        if (refused.kind === 'failed') { await stream(response, entry, route, refused); return; }
        const payload = JSON.stringify(refused.body ?? {});
        response.writeHead(refused.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...refused.headers });
        response.end(payload);
        return;
      }
      const side = route.isSide?.(entry, body);
      entry.main = !side;
      if (side) {
        entry.answer = 'side';
        await stream(response, entry, route, { kind: 'text', text: 'Stub side reply' });
        return;
      }
      entry.mainIndex = route.mainCalls;
      route.mainCalls += 1;
      let step = route.steps.shift() ?? route.fallback;
      if (typeof step === 'function') step = await step(entry, route);
      entry.answer = step.kind === 'raw' ? `raw:${step.status}` : step.kind;
      if (step.kind === 'raw') {
        const payload = JSON.stringify(step.body ?? {});
        response.writeHead(step.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...step.headers });
        response.end(payload);
      } else {
        await stream(response, entry, route, step);
      }
    } catch (error) {
      entry.stubError = String(error?.message ?? error).slice(0, 200);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    requests,
    route(tag, { steps = [], fallback = { kind: 'text', text: 'OK' }, headers = {}, isSide, markers = {}, limit = null } = {}) {
      const entry = { tag, steps, fallback, headers, isSide, markers, limit, requests: [], mainCalls: 0, url: `http://127.0.0.1:${port}/s/${encodeURIComponent(tag)}/v1` };
      routes.set(tag, entry);
      return entry;
    },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// ---------------------------------------------------------------------------
// A slow MCP tool, for "during a long tool" with no shell involved

export const SLOW_SERVER = 'long_run_probe';
export const SLOW_TOOL = 'slow_step';

/**
 * Loopback MCP server (POST-only stateless JSON-RPC, one bearer token per `/mcp/<label>`, the shape of the product's
 * session endpoint and of wrap-up-probe-kit's suggest_task server) with one read-only tool that takes `seconds`, or
 * until the label's `release` is called. `onCall(label, entry)` runs when a call starts.
 */
export async function startSlowToolServer({ onCall } = {}) {
  const routes = new Map();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => {
      const body = value === undefined ? '' : JSON.stringify(value);
      response.writeHead(status, { 'cache-control': 'no-store', ...(body ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) } : {}) });
      response.end(body);
    };
    const match = /^\/mcp\/([^/?#]+)$/u.exec(request.url ?? '');
    const label = match ? decodeURIComponent(match[1]) : null;
    const route = label ? routes.get(label) : undefined;
    if (request.method !== 'POST') { send(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only POST is supported.' } }); return; }
    if (!route || !sameSecret(String(request.headers.authorization ?? ''), `Bearer ${route.token}`)) {
      send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid session capability.' } });
      return;
    }
    const message = await readBody(request);
    if (message?.id === undefined) { response.writeHead(202); response.end(); return; }
    const reply = (result) => send(200, { jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'long-run-probe', version: '1.0.0' } });
    } else if (message.method === 'ping') {
      reply({});
    } else if (message.method === 'tools/list') {
      reply({ tools: [{
        name: SLOW_TOOL,
        description: 'A slow step of the current task. It waits, then returns the step id. Call it when asked to.',
        inputSchema: { type: 'object', additionalProperties: false, required: ['seconds'], properties: { seconds: { type: 'integer', minimum: 1, maximum: 60 } } },
        annotations: { title: 'Slow step', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'anthropic/alwaysLoad': true },
      }] });
    } else if (message.method === 'tools/call') {
      const seconds = Math.min(60, Math.max(1, Number(message.params?.arguments?.seconds) || 5));
      const entry = { startedAt: Date.now(), label, seconds, endedAt: null };
      requests.push(entry);
      route.calls.push(entry);
      await onCall?.(label, entry);
      route.onCall?.(entry);
      await Promise.race([delay(seconds * 1_000), route.release.opened]);
      entry.endedAt = Date.now();
      reply({ content: [{ type: 'text', text: `step finished after ${Math.round((entry.endedAt - entry.startedAt) / 1000)} s` }] });
    } else {
      send(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    requests,
    endpoint(label) {
      const route = { token: randomBytes(24).toString('hex'), calls: [], release: gate(), onCall: null };
      routes.set(label, route);
      return { url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(label)}`, token: route.token, route };
    },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

// ---------------------------------------------------------------------------
// Session files

/** Which of the `markers` (name -> text) a line holds; the line's text itself is never kept. */

/** A Claude session .jsonl as an ordered list of shapes, with where each marker landed. */
export function claudeSessionFacts(file, markers = {}) {
  if (!file || !existsSync(file)) return { found: false };
  const entries = [];
  const counts = {};
  let lines = 0;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (!line) continue;
    lines += 1;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    const blocks = typeof content === 'string' ? ['text'] : Array.isArray(content) ? content.map((block) => block.type) : [];
    const shape = {
      type: entry.type ?? null,
      ...(entry.subtype ? { subtype: entry.subtype } : {}),
      ...(entry.operation ? { operation: entry.operation } : {}),
      ...(entry.attachment?.type ? { attachment: entry.attachment.type } : {}),
      ...(entry.attachment?.commandMode ? { commandMode: entry.attachment.commandMode } : {}),
      ...(entry.attachment?.source_uuid ? { sourceUuid: entry.attachment.source_uuid } : {}),
      ...(blocks.length ? { blocks } : {}),
      ...(entry.isMeta ? { isMeta: true } : {}),
      ...(entry.isSidechain ? { isSidechain: true } : {}),
      ...(entry.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.apiErrorStatus ? { apiErrorStatus: entry.apiErrorStatus } : {}),
      ...(entry.uuid ? { uuid: entry.uuid } : {}),
      ...(entry.isApiErrorMessage ? { keys: Object.keys(entry).sort(), quotaLimits: entry.quotaLimits ?? null, apiError: entry.apiError ?? null, apiErrorParams: entry.apiErrorParams ?? null } : {}),
    };
    const found = markerNames(line, markers);
    if (found.length) shape.markers = found;
    entries.push(shape);
    for (const name of found) counts[name] = (counts[name] ?? 0) + 1;
  }
  return { found: true, lines, markerLines: counts, entries };
}

export function claudeSessionFile(configDirectory, sessionId) {
  const projects = path.join(configDirectory, 'projects');
  if (!existsSync(projects)) return null;
  const directory = readdirSync(projects).find((name) => existsSync(path.join(projects, name, `${sessionId}.jsonl`)));
  return directory ? path.join(projects, directory, `${sessionId}.jsonl`) : null;
}

/** A Codex rollout as an ordered list of shapes, with where each marker landed. */
export function codexRolloutFacts(file, markers = {}) {
  if (!file || !existsSync(file)) return { found: false };
  const entries = [];
  const counts = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload ?? {};
    const shape = { type: entry.type ?? null, payload: payload.type ?? null, ...(payload.role ? { role: payload.role } : {}), ...(payload.name ? { name: payload.name } : {}) };
    const found = markerNames(line, markers);
    if (found.length) shape.markers = found;
    entries.push(shape);
    for (const name of found) counts[name] = (counts[name] ?? 0) + 1;
  }
  return { found: true, lines: entries.length, markerLines: counts, entries };
}

/** Whether a stream of requests presented anything but this probe's dummies. */
export function credentialAudit(requests) {
  const withCredential = requests.filter((entry) => entry.credential);
  return {
    requests: requests.length,
    withCredential: withCredential.length,
    allDummy: withCredential.every((entry) => entry.credentialIsDummy === true),
    notDummy: withCredential.filter((entry) => entry.credentialIsDummy !== true).length,
    credentialHeaders: [...new Set(withCredential.map((entry) => entry.credential))],
  };
}

export const shortHash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
export const newUuid = () => randomUUID();
