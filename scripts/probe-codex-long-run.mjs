#!/usr/bin/env node
/**
 * Probe for bundle 3 "long-run continuity" on Codex: what a real usage limit looks like (P13-P15, the real app-server
 * against a loopback Responses stub, no real account) and sending into a running turn (P12, stub first, then the real
 * provider).
 *
 *   node scripts/probe-codex-long-run.mjs --scratch <dir> --only <steps> [--repeat 1] [--codex-script <codex.js>]
 *
 * Steps, comma separated (a bare group name runs all of it):
 *   limit[:<name>]    a refused call per error body and position (LIMITS)
 *   resume[:<name>]   refused turn, reset, then "Continue." or the original prompt, same app-server or restarted
 *   early[:<n>]       n messages sent before the reset, then "Continue." after it
 *   uuid[:<name>]     the same clientUserMessageId on turn/start twice
 *   steer[:<name>]    turn/steer: during text, a tool, an approval, at the start, stale ids, retries, review, compaction
 *   race[:<n>]        rounds of turn/steer around the end of a turn
 *   queue[:<name>]    thread/queue/* around a running turn
 *   edge[:<name>]     a limit with an approval held, app closed on an approval, a person before the reset, two threads
 *   idle              a refused turn left alone across its reset
 *   real[:<name>]     the real provider (REAL_SCENARIOS): costs usage; two passes with --repeat 2
 *   history           read ~/.codex/sessions for limit records: shapes and counts only
 *
 * Stub runs: the installed app-server with CODEX_HOME and HOME in scratch (so the person's auth.json is out of reach),
 * a custom model_providers entry at a loopback Responses stub and a dummy key, HTTP(S)_PROXY at a deny-and-log proxy with
 * NO_PROXY for loopback. The report shows what the stub saw (header names, a dummy-or-not boolean, never a credential
 * value) and every host the proxy refused.
 *
 * Real runs, safety (fails closed): sandbox read-only; approvalPolicy untrusted where an approval is the point, and every
 * command is declined. Nothing in this probe edits files on the real provider; no danger-full-access anywhere.
 * Report: artifacts/long-run-probe/codex-<time>.json, rewritten after every scenario. Real runs keep marker names, shapes
 * and token counts; limit values are reduced to their granularity, and no account attributes.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewRepo } from './review-probe-repo.mjs';
import {
  DUMMY_OPENAI_KEY, SLOW_SERVER, SLOW_TOOL, clip, codexLimitBody as limitBody, codexLimitHeaders as limitHeaders, codexRolloutFacts, credentialAudit, gate, marker,
  startDenyProxy, startResponsesStub, startSlowToolServer,
} from './long-run-probe-kit.mjs';
import { CODEX_ENVIRONMENT_VARIABLES, delay, errorText, log, number, providerEnvironment, ratio, withTimeout, writeReport } from './wrap-up-probe-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 180_000;
const HOUR = 3_600;
const LONG_TEXT = 'Streaming a long answer word by word so a message can arrive in the middle of it. '.repeat(4);
const READ_ONLY = { approvalPolicy: 'never', sandbox: 'read-only' };
const ASKS = { approvalPolicy: 'untrusted', sandbox: 'read-only' };

function parseArguments(argv) {
  const options = { repeat: 1, only: [], out: path.join(root, 'artifacts', 'long-run-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--only') options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--codex-script') options.codexScript = path.resolve(value);
    else if (flag === '--effort') options.effort = value;
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  if (!options.only.length) throw new Error('--only is required: real-provider steps must be asked for by name.');
  return options;
}

function resolveCodexScript() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean)) {
    const candidate = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Codex CLI not found; pass --codex-script <.../@openai/codex/bin/codex.js>.');
}

// ---------------------------------------------------------------------------
// App-server client (from scripts/probe-codex-turn-wrap-up.mjs, with a full notification log)

const markersIn = (value, markers) => {
  const text = JSON.stringify(value ?? '');
  return Object.entries(markers).filter(([, needle]) => text.includes(needle)).map(([name]) => name);
};

const maskedWindow = (window) => (window ? { keys: Object.keys(window).sort(), windowDurationMins: window.windowDurationMins ?? null, resetsAt: typeof window.resetsAt === 'number' ? { mod60: window.resetsAt % 60, mod600: window.resetsAt % 600 } : null } : null);
const maskedLimits = (limits) => ({ keys: Object.keys(limits ?? {}).sort(), primary: maskedWindow(limits?.primary), secondary: maskedWindow(limits?.secondary), limitId: limits?.limitId ?? null, rateLimitReachedType: limits?.rateLimitReachedType ?? null });

function startAppServer(codexScript, cwd, env, { markers = {}, mask = false } = {}) {
  const child = spawn(process.execPath, [codexScript, 'app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  const waiters = [];
  const log_ = [];
  const origin = Date.now();
  const rateLimits = [];
  const usage = [];
  const held = [];
  const state = { policy: null, activeTurnId: null, lastActivity: Date.now() };
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const push = (entry) => { state.lastActivity = Date.now(); log_.push({ atMs: Date.now() - origin, ...entry }); };
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const respond = (frame, decision) => {
    const accept = decision === 'accept';
    const { method } = frame;
    let result;
    if (method === 'mcpServer/elicitation/request') result = { action: accept ? 'accept' : 'decline', content: accept ? {} : null, _meta: null };
    else if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'execCommandApproval' || method === 'applyPatchApproval') result = { decision: accept ? 'approved' : { denied: { rejection: 'Probe: declined.' } } };
    else if (method.endsWith('/requestApproval')) result = { decision: accept ? 'accept' : 'decline' };
    if (result) send({ jsonrpc: '2.0', id: frame.id, result });
    else send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `No handler for ${method}.` } });
  };
  const answerServerRequest = (frame) => {
    const decision = state.policy ? state.policy(frame.method, frame.params ?? {}) : 'decline';
    push({ kind: `server-request/${frame.method}`, decision, itemId: frame.params?.itemId ?? null });
    if (decision === 'hold') { held.push(frame); return; }
    respond(frame, decision);
  };
  const handle = (frame) => {
    const isMethod = typeof frame.method === 'string' && !('result' in frame) && !('error' in frame);
    if (!isMethod) {
      const call = pending.get(frame.id);
      if (!call) return;
      pending.delete(frame.id);
      if (frame.error) call.reject(Object.assign(new Error(frame.error.message), { rpc: frame.error }));
      else call.resolve(frame.result);
      return;
    }
    if (frame.id !== undefined && frame.id !== null) { answerServerRequest(frame); return; }
    const params = frame.params ?? {};
    const { method } = frame;
    if (method === 'thread/tokenUsage/updated' && params.tokenUsage?.last) {
      usage.push({ atMs: Date.now() - origin, turnId: params.turnId ?? null, input: number(params.tokenUsage.last.inputTokens), cached: number(params.tokenUsage.last.cachedInputTokens), output: number(params.tokenUsage.last.outputTokens) });
    } else if (method === 'account/rateLimits/updated') {
      rateLimits.push({ atMs: Date.now() - origin, limits: mask ? maskedLimits(params.rateLimits) : params.rateLimits ?? null });
      push({ kind: method, reached: params.rateLimits?.rateLimitReachedType ?? null });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item ?? {};
      if (item.type !== 'reasoning') {
        push({
          kind: method, turnId: params.turnId ?? null, type: item.type ?? null, id: item.id ?? null, status: item.status ?? null,
          ...(item.type === 'userMessage' ? { clientId: item.clientId ?? item.clientUserMessageId ?? null, keys: Object.keys(item).sort() } : {}),
          ...(item.type === 'mcpToolCall' ? { tool: item.tool ?? null, error: clip(item.error?.message ?? item.error, 120) } : {}),
          ...(item.type === 'commandExecution' ? { command: clip(item.command, 80), exitCode: item.exitCode ?? null } : {}),
          markers: markersIn(item.type === 'userMessage' ? item.content : item.text, markers),
        });
      }
    } else if (method === 'turn/started' || method === 'turn/completed') {
      const turn = params.turn ?? {};
      push({ kind: method, turnId: turn.id ?? null, status: turn.status ?? null, error: mask ? (turn.error ? { keys: Object.keys(turn.error).sort(), codexErrorInfo: turn.error.codexErrorInfo ?? null } : null) : turn.error ?? null });
    } else if (method === 'error') {
      push({ kind: 'error', turnId: params.turnId ?? null, willRetry: params.willRetry ?? null, error: mask ? { keys: Object.keys(params.error ?? {}).sort(), codexErrorInfo: params.error?.codexErrorInfo ?? null } : params.error ?? null });
    } else if (method === 'thread/status/changed') {
      push({ kind: method, status: params.status ?? null });
    } else if (!/delta$/iu.test(method) && method !== 'thread/tokenUsage/updated') {
      push({ kind: method });
    } else if (/agentMessage\/delta$/u.test(method) && !log_.some((entry) => entry.kind === 'first-delta' && entry.turnId === params.turnId)) {
      push({ kind: 'first-delta', turnId: params.turnId ?? null });
    }
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* non-JSON line */ }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const waitFor = (predicate, ms) => new Promise((resolve, reject) => {
    const waiter = { predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } };
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Timed out waiting for a notification.')); }, ms);
    waiters.push(waiter);
  });
  const quiet = async (quietMs = 2_000, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (Date.now() - state.lastActivity >= quietMs) return true;
      await delay(100);
    }
    return false;
  };
  return { child, request, send, push, respond, waitFor, quiet, state, held, usage, rateLimits, log: log_, origin, exited, stderr: () => stderr };
}

async function openServer(codexScript, cwd, env, options) {
  const server = startAppServer(codexScript, cwd, env, options);
  await withTimeout(server.request('initialize', { clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' }, capabilities: { experimentalApi: true, requestAttestation: false } }), 30_000, 'initialize');
  server.send({ jsonrpc: '2.0', method: 'initialized' });
  return server;
}

async function closeServer(server) {
  server.child.stdin.end();
  await Promise.race([server.exited, delay(4_000)]);
  if (server.child.exitCode === null) server.child.kill();
}

const textInput = (text) => [{ type: 'text', text, text_elements: [] }];
const rpcError = (error) => ({ message: clip(error?.rpc?.message ?? error?.message, 300), code: error?.rpc?.code ?? null, data: error?.rpc?.data ?? null });

async function startThread(server, repo, preset, config) {
  const started = await server.request('thread/start', { cwd: repo, runtimeWorkspaceRoots: [repo], ...preset, ...(config ? { config } : {}), ephemeral: false, historyMode: 'paginated', threadSource: 'ezterminal' });
  return { threadId: started.thread.id, model: started.model ?? null, reasoningEffort: started.reasoningEffort ?? null, rollout: started.thread.path ?? null };
}

/** Starts a turn; `done` settles on its turn/completed. */
async function startTurn(server, threadId, text, { clientUserMessageId = `probe-${randomUUID()}`, deadlineMs = TURN_DEADLINE_MS, extra = {} } = {}) {
  const done = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId, deadlineMs);
  done.catch(() => undefined);
  server.push({ kind: '>> turn/start', clientUserMessageId });
  const started = await server.request('turn/start', { threadId, clientUserMessageId, input: textInput(text), ...extra });
  server.state.activeTurnId = started?.turn?.id ?? null;
  return { turnId: started?.turn?.id ?? null, clientUserMessageId, done };
}

async function steer(server, threadId, expectedTurnId, text, { clientUserMessageId = `steer-${randomUUID()}` } = {}) {
  const startedAt = Date.now();
  server.push({ kind: '>> turn/steer', expectedTurnId, clientUserMessageId });
  try {
    const result = await withTimeout(server.request('turn/steer', { threadId, expectedTurnId, input: textInput(text), clientUserMessageId }), 30_000, 'turn/steer');
    server.push({ kind: '<< turn/steer ok', turnId: result?.turnId ?? null });
    return { ok: true, turnId: result?.turnId ?? null, ms: Date.now() - startedAt, clientUserMessageId };
  } catch (error) {
    const failed = rpcError(error);
    server.push({ kind: '<< turn/steer error', ...failed });
    return { ok: false, ...failed, ms: Date.now() - startedAt, clientUserMessageId };
  }
}

// ---------------------------------------------------------------------------
// Stub conversations

function countMarkers(input) {
  const counts = {};
  for (const item of input) for (const name of item.markers ?? []) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

const itemTag = (item) => (item.type === 'message' ? `${item.role?.[0] ?? '?'}${item.markers?.length ? `[${item.markers.join(',')}]` : ''}` : item.type === 'function_call' || item.type === 'custom_tool_call' ? `call:${item.name}` : item.type.endsWith('_output') ? `out${item.markers?.length ? `[${item.markers.join(',')}]` : ''}` : item.type);

const callFacts = (route, origin) => route.requests.filter((entry) => /\/responses$/u.test(entry.path)).map((entry, position) => ({
  atMs: entry.at - origin, main: entry.main ?? null, index: entry.mainIndex ?? null, answer: entry.answer ?? null, ...(position === 0 ? { tools: entry.toolNames } : {}),
  ...(entry.clientAborted ? { clientAborted: true, abortedAtChunk: entry.abortedAtChunk ?? null } : {}),
  items: entry.input.length, markerCounts: countMarkers(entry.input), shape: entry.input.map(itemTag).join(' '),
}));

async function makeConversation(context, tag, { steps = [], fallback, markers = {}, limit = null, headers = {}, preset = READ_ONLY, mcp = false, providerExtra = '' } = {}) {
  const { codexScript, stub, proxy, slow, options } = context;
  const repo = path.join(options.scratch, tag);
  await createReviewRepo(repo);
  const home = path.join(options.scratch, `${tag}-home`);
  await fs.mkdir(home, { recursive: true });
  const route = stub.route(tag, { steps, fallback, headers, markers, limit });
  const toml = [
    'model = "gpt-stub"', 'model_provider = "stub"', '[model_providers.stub]', 'name = "Stub"', `base_url = "${route.url}"`, 'wire_api = "responses"', 'env_key = "LONG_RUN_STUB_KEY"', providerExtra, '',
  ].join('\n');
  await fs.writeFile(path.join(home, 'config.toml'), toml);
  const env = providerEnvironment(['PATH'], {
    CODEX_HOME: home, HOME: home, USERPROFILE: home, HOMEPATH: home, LONG_RUN_STUB_KEY: DUMMY_OPENAI_KEY,
    HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost',
  });
  const endpoint = mcp ? slow.endpoint(tag) : null;
  const config = endpoint ? { mcp_servers: { [SLOW_SERVER]: { url: endpoint.url, http_headers: { Authorization: `Bearer ${endpoint.token}` }, tool_timeout_sec: 120 } } } : undefined;
  const open = () => openServer(codexScript, repo, env, { markers });
  return {
    repo, route, endpoint, markers, startedAt: Date.now(), open,
    start: async (server) => startThread(server, repo, preset, config),
    resume: async (server, threadId) => {
      const resumed = await server.request('thread/resume', { threadId, ...preset, ...(config ? { config } : {}), historyMode: 'paginated' });
      return { threadId: resumed.thread.id };
    },
  };
}

const serverFacts = (server) => ({
  rateLimits: server.rateLimits, usage: server.usage,
  stream: server.log.map(({ atMs, kind, ...rest }) => `${atMs} ${kind} ${JSON.stringify(rest)}`.replace(/ \{\}$/u, '')),
});

function limitPlan() {
  const now = Math.floor(Date.now() / 1000);
  const primaryResetAt = now + 2 * HOUR;
  const secondaryResetAt = now + 72 * HOUR;
  return {
    primaryResetAt, secondaryResetAt,
    allowed: limitHeaders({ primaryResetAt, secondaryResetAt }),
    refuse: (kind = 'usage', more = {}) => ({ kind: 'raw', status: 429, headers: { ...limitHeaders({ primaryUsed: 100, primaryResetAt, secondaryResetAt }), ...more }, body: limitBody(kind, primaryResetAt) }),
  };
}

const slowCall = (seconds, extra = {}) => ({ kind: 'call', name: SLOW_TOOL, namespace: `mcp__${SLOW_SERVER}`, arguments: { seconds }, ...extra });
const commandCall = (extra = {}) => ({ kind: 'call', name: 'exec_command', arguments: { cmd: 'node -e "process.exit(0)"' }, ...extra });

// ---------------------------------------------------------------------------
// P13: what a limit looks like

const LIMITS = {
  'usage-first': { position: 'first', refuse: (plan) => plan.refuse('usage') },
  'usage-later': { position: 'later', refuse: (plan) => plan.refuse('usage') },
  'usage-weekly': { position: 'first', refuse: (plan) => ({ ...plan.refuse('usage'), headers: { ...plan.refuse('usage').headers, ...limitHeaders({ primaryUsed: 40, secondaryUsed: 100, primaryResetAt: plan.primaryResetAt, secondaryResetAt: plan.secondaryResetAt }) }, body: limitBody('usage', plan.secondaryResetAt) }) },
  'usage-no-reset': { position: 'first', refuse: (plan) => plan.refuse('usage-no-reset') },
  'usage-no-headers': { position: 'first', refuse: (plan) => ({ kind: 'raw', status: 429, headers: {}, body: limitBody('usage', plan.primaryResetAt) }) },
  'usage-sse': { position: 'first', refuse: (plan) => ({ kind: 'failed', error: { code: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: plan.primaryResetAt } }) },
  'not-included': { position: 'first', refuse: (plan) => plan.refuse('not-included') },
  'plain-first': { position: 'first', refuse: (plan) => plan.refuse('plain') },
  'plain-later': { position: 'later', refuse: (plan) => plan.refuse('plain') },
  'plain-retry-after': { position: 'first', refuse: (plan) => plan.refuse('plain', { 'retry-after': '1' }), times: 2 },
  'plain-sse': { position: 'first', refuse: () => ({ kind: 'failed', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1s.' } }) },
};

async function runLimit(context, name, { position, refuse, times }) {
  const tag = `limit-${name}`;
  const markers = { prompt: marker('PROMPT') };
  const plan = limitPlan();
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed, mcp: true });
  const { route } = conversation;
  const refused = refuse(plan);
  let remaining = times ?? Infinity;
  const limit = () => { if (remaining <= 0) return null; remaining -= 1; return refused; };
  if (position === 'first') route.limit = limit;
  else route.steps.push(slowCall(1), (_entry, current) => { current.limit = limit; return limit() ?? { kind: 'text', text: 'Done.' }; });
  route.steps.push({ kind: 'text', text: 'Finished after the limit.' });
  const record = { name, position, startedAt: Date.now() };
  const server = await conversation.open();
  try {
    const thread = await conversation.start(server);
    record.rollout = thread.rollout ? path.basename(thread.rollout) : null;
    const turn = await startTurn(server, thread.threadId, `Please look at src/cart.ts ${markers.prompt}`, { deadlineMs: 150_000 });
    record.turnStartId = turn.turnId;
    const completed = await turn.done;
    record.turnCompleted = { status: completed.params?.turn?.status ?? null, error: completed.params?.turn?.error ?? null };
    record.durationMs = Date.now() - record.startedAt;
    await delay(600);
    const read = await server.request('thread/read', { threadId: thread.threadId, includeTurns: true }).catch((error) => ({ failed: rpcError(error) }));
    record.threadRead = read.failed ?? { status: read.thread?.status ?? null, turns: (read.thread?.turns ?? []).map((entry) => ({ status: entry.status, items: (entry.items ?? []).map((item) => item.type) })) };
    record.rolloutFacts = codexRolloutFacts(thread.rollout, markers);
    if (record.rolloutFacts?.entries) record.rolloutFacts.entries = record.rolloutFacts.entries.filter((entry) => entry.type !== 'session_meta').map((entry) => [entry.type, entry.payload, entry.role, entry.name, entry.markers ? `[${entry.markers.join(',')}]` : null].filter(Boolean).join('/'));
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  return { ...record, ...serverFacts(server), calls: callFacts(route, record.startedAt) };
}

/** A refused turn left alone across its reset: does anything arrive with no call made? */
async function runIdle(context) {
  const tag = 'idle';
  const markers = { prompt: marker('PROMPT') };
  const plan = limitPlan();
  const liftAt = Date.now() + 12_000;
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed });
  const { route } = conversation;
  const refused = plan.refuse();
  route.limit = () => (Date.now() >= liftAt ? null : refused);
  const record = { startedAt: Date.now(), resetInSeconds: 12 };
  const server = await conversation.open();
  try {
    const { threadId } = await conversation.start(server);
    const turn = await startTurn(server, threadId, `Please look at src/cart.ts ${markers.prompt}`);
    await turn.done;
    await delay(300);
    const settled = server.log.length;
    const calls = route.requests.length;
    await delay(Math.max(0, liftAt - Date.now()) + 8_000);
    record.afterTheResult = { notifications: server.log.slice(settled).map((entry) => entry.kind), stubCalls: route.requests.length - calls };
    record.rateLimitsRead = await server.request('account/rateLimits/read').then((value) => ({ keys: Object.keys(value ?? {}) }), (error) => ({ failed: rpcError(error) }));
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  return record;
}

const RESUME = {};
for (const position of ['first', 'later']) {
  for (const how of ['same', 'restarted']) {
    for (const message of ['continue', 'original']) RESUME[`${position}-${how}-${message}`] = { position, how, message };
  }
}

async function runResume(context, name, { position, how, message, early = 0, kind = 'usage' }) {
  const tag = `resume-${name}`;
  const markers = { prompt: marker('PROMPT'), resume: marker('CONT') };
  for (let index = 0; index < early; index += 1) markers[`early${index + 1}`] = marker(`EARLY${index + 1}`);
  const plan = limitPlan();
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed, mcp: true });
  const { route } = conversation;
  const refused = plan.refuse(kind);
  if (position === 'first') route.limit = () => refused;
  else route.steps.push(slowCall(1, { text: 'First step.' }), slowCall(1, { text: 'Second step.' }), (_entry, current) => { current.limit = () => refused; return refused; });
  const original = `Please fix src/cart.ts ${markers.prompt}`;
  const record = { name, position, how, message, early, startedAt: Date.now() };
  let server = await conversation.open();
  try {
    const { threadId, rollout } = await conversation.start(server);
    let turn = await startTurn(server, threadId, original);
    record.failed = (await turn.done).params?.turn?.error ?? null;
    await delay(400);
    for (let index = 0; index < early; index += 1) {
      turn = await startTurn(server, threadId, `Are you there? ${markers[`early${index + 1}`]}`);
      await turn.done;
      await delay(300);
    }
    const read = await server.request('thread/read', { threadId, includeTurns: true }).catch((error) => ({ failed: rpcError(error) }));
    record.threadBeforeReset = read.failed ?? { status: read.thread?.status ?? null, turns: (read.thread?.turns ?? []).map((entry) => ({ status: entry.status, items: (entry.items ?? []).map((item) => item.type) })) };
    record.beforeReset = serverFacts(server);
    if (how === 'restarted') {
      await closeServer(server);
      server = await conversation.open();
      await conversation.resume(server, threadId);
    }
    route.limit = null;
    route.steps.length = 0;
    route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
    turn = await startTurn(server, threadId, message === 'continue' ? `Continue. ${markers.resume}` : original);
    record.resumedStatus = (await turn.done).params?.turn?.status ?? null;
    await delay(400);
    const facts = codexRolloutFacts(rollout, markers);
    record.rollout = { markerLines: facts.markerLines, entries: (facts.entries ?? []).filter((entry) => entry.markers || ['error', 'turn_aborted', 'task_complete'].includes(entry.payload)).map((entry) => [entry.type, entry.payload, entry.role, entry.markers ? `[${entry.markers.join(',')}]` : null].filter(Boolean).join('/')) };
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  record.afterReset = serverFacts(server);
  record.calls = callFacts(route, record.startedAt);
  record.modelRead = record.calls.filter((call) => call.answer === 'text').at(-1) ?? null;
  return record;
}

const UUID_CASES = {
  'after-success': { limited: false, reopen: false },
  'after-success-restarted': { limited: false, reopen: true },
  'after-limit': { limited: true, reopen: false },
  'after-limit-restarted': { limited: true, reopen: true },
};

async function runDuplicateId(context, name, { limited, reopen }) {
  const tag = `uuid-${name}`;
  const markers = { prompt: marker('PROMPT') };
  const plan = limitPlan();
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed });
  const { route } = conversation;
  const refused = plan.refuse();
  if (limited) route.limit = () => refused;
  const clientUserMessageId = `fixed-${randomUUID()}`;
  const record = { name, limited, reopen, startedAt: Date.now() };
  let server = await conversation.open();
  try {
    const { threadId } = await conversation.start(server);
    const text = `One time only please ${markers.prompt}`;
    let turn = await startTurn(server, threadId, text, { clientUserMessageId });
    record.firstStatus = (await turn.done).params?.turn?.status ?? null;
    await delay(400);
    if (reopen) {
      await closeServer(server);
      server = await conversation.open();
      await conversation.resume(server, threadId);
    }
    route.limit = null;
    turn = await startTurn(server, threadId, text, { clientUserMessageId, deadlineMs: 8_000 });
    record.secondTurnId = turn.turnId;
    record.secondStatus = await turn.done.then((frame) => frame.params?.turn?.status ?? null, () => 'no turn/completed');
  } catch (error) {
    record.error = errorText(error);
    record.rpc = rpcError(error);
  }
  await closeServer(server);
  record.calls = callFacts(route, record.startedAt);
  return record;
}

// ---------------------------------------------------------------------------
// P12: turn/steer (stub)

const STEER_CASES = ['text', 'tool', 'approval', 'start', 'stale', 'after', 'retry', 'review', 'compact', 'between'];

async function runSteer(context, where) {
  const tag = `steer-${where}`;
  const markers = { prompt: marker('PROMPT'), steer: marker('STEER'), second: marker('SECOND') };
  const record = { where, startedAt: Date.now(), steers: [] };
  const plan = limitPlan();
  const textGate = gate();
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed, mcp: where === 'tool' || where === 'between', preset: where === 'approval' ? ASKS : READ_ONLY });
  const { route, endpoint } = conversation;
  const server = await conversation.open();
  let thread;
  let turn;
  const steerNow = (text, options) => steer(server, thread.threadId, turn.turnId, text, options).then((outcome) => { record.steers.push(outcome); return outcome; });
  const steerText = `Please also keep the total non-negative ${markers.steer}`;
  try {
    thread = await conversation.start(server);
    if (where === 'text') {
      route.steps.push({ kind: 'text', text: LONG_TEXT, chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) textGate.open(); } }, { kind: 'text', text: 'Second reply.' }, { kind: 'text', text: 'Third reply.' });
      turn = await startTurn(server, thread.threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await textGate.opened;
      await steerNow(steerText);
    } else if (where === 'tool') {
      route.steps.push(slowCall(30, { text: 'Slow step.' }), { kind: 'text', text: 'All done.' }, { kind: 'text', text: 'Third reply.' });
      endpoint.route.onCall = () => textGate.open();
      turn = await startTurn(server, thread.threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await Promise.race([textGate.opened, delay(30_000)]);
      await steerNow(steerText);
      await delay(3_000);
      endpoint.route.release.open();
    } else if (where === 'between') {
      route.steps.push({ ...slowCall(1, { text: 'First step.' }), beforeEnd: () => textGate.open() }, slowCall(1, { text: 'Second step.' }), { kind: 'text', text: 'All done.' }, { kind: 'text', text: 'Fourth reply.' });
      turn = await startTurn(server, thread.threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await textGate.opened;
      await steerNow(steerText);
    } else if (where === 'approval') {
      route.steps.push(commandCall({ text: 'Running a command.' }), { kind: 'text', text: 'All done.' }, { kind: 'text', text: 'Third reply.' });
      server.state.policy = (method) => (method.endsWith('requestApproval') || method === 'execCommandApproval' ? 'hold' : 'decline');
      turn = await startTurn(server, thread.threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await server.waitFor(() => server.held.length > 0, 30_000).catch(() => undefined);
      for (let wait = 0; wait < 300 && !server.held.length; wait += 1) await delay(100);
      record.heldApprovals = server.held.map((frame) => frame.method);
      await steerNow(steerText);
      await delay(2_000);
      record.stillHeldAfterSteer = server.held.length;
      for (const frame of server.held.splice(0)) server.respond(frame, 'decline');
    } else if (where === 'start') {
      route.steps.push({ kind: 'text', text: LONG_TEXT, chunks: 6, chunkMs: 150 }, { kind: 'text', text: 'Second reply.' });
      turn = await startTurn(server, thread.threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await steerNow(steerText);
    } else if (where === 'stale') {
      route.steps.push({ kind: 'text', text: 'First turn.' }, { kind: 'text', text: LONG_TEXT, chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) textGate.open(); } }, { kind: 'text', text: 'Third reply.' });
      turn = await startTurn(server, thread.threadId, `First ${markers.prompt}`);
      await turn.done;
      const old = turn.turnId;
      turn = await startTurn(server, thread.threadId, 'Second turn');
      await textGate.opened;
      record.steers.push({ label: 'previous turn id', ...await steer(server, thread.threadId, old, steerText) });
      record.steers.push({ label: 'made-up id', ...await steer(server, thread.threadId, randomUUID(), steerText) });
    } else if (where === 'after') {
      route.steps.push({ kind: 'text', text: 'Only turn.' });
      turn = await startTurn(server, thread.threadId, `First ${markers.prompt}`);
      await turn.done;
      await delay(300);
      await steerNow(steerText);
    } else if (where === 'retry') {
      route.steps.push({ kind: 'text', text: LONG_TEXT, chunks: 12, chunkMs: 200, onChunk: (index) => { if (index === 3) textGate.open(); } }, { kind: 'text', text: 'Second reply.' }, { kind: 'text', text: 'Third reply.' });
      turn = await startTurn(server, thread.threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await textGate.opened;
      const fixed = `steer-fixed-${randomUUID()}`;
      await steerNow(steerText, { clientUserMessageId: fixed });
      await steerNow(steerText, { clientUserMessageId: fixed });
    } else if (where === 'review') {
      route.steps.push({ kind: 'text', text: '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"ok","overall_confidence_score":0.9}', chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) textGate.open(); } });
      const done = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === thread.threadId, 60_000);
      done.catch(() => undefined);
      const started = await server.request('review/start', { threadId: thread.threadId, target: { type: 'custom', instructions: `Review this ${markers.prompt}` }, delivery: 'inline' });
      record.reviewResponse = { keys: Object.keys(started), turnId: started.turn?.id ?? null, reviewThreadId: started.reviewThreadId ?? null };
      turn = { turnId: started.turn?.id, done };
      await textGate.opened;
      await steerNow(steerText);
    } else if (where === 'compact') {
      route.steps.push({ kind: 'text', text: 'Warm-up reply.' }, { kind: 'text', text: 'Summary of the conversation.', chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) textGate.open(); } }, { kind: 'text', text: 'After compaction.' });
      turn = await startTurn(server, thread.threadId, `Warm up ${markers.prompt}`);
      await turn.done;
      const done = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === thread.threadId, 60_000);
      done.catch(() => undefined);
      const startedAt = server.log.length;
      await server.request('thread/compact/start', { threadId: thread.threadId });
      await Promise.race([textGate.opened, delay(20_000)]);
      const compactTurn = server.log.slice(startedAt).find((entry) => entry.kind === 'turn/started')?.turnId ?? null;
      record.compactTurnSeen = Boolean(compactTurn);
      turn = { turnId: compactTurn ?? turn.turnId, done };
      await steerNow(steerText);
    }
    await turn.done.catch((error) => { record.turnDoneError = errorText(error); });
    await delay(500);
    await server.quiet(2_500, 30_000);
    // Any later turn shows what the thread holds.
    if (where === 'after' || where === 'text' || where === 'tool' || where === 'approval') {
      route.steps.push({ kind: 'text', text: 'Last reply.' });
      const last = await startTurn(server, thread.threadId, `Last message ${markers.second}`, { deadlineMs: 30_000 }).catch((error) => { record.lastTurnError = rpcError(error); return null; });
      if (last) await last.done.catch(() => undefined);
    }
    const facts = codexRolloutFacts(thread.rollout, markers);
    record.rollout = { markerLines: facts.markerLines, entries: (facts.entries ?? []).filter((entry) => entry.markers).map((entry) => [entry.type, entry.payload, entry.role, `[${entry.markers.join(',')}]`].filter(Boolean).join('/')) };
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  return { ...record, ...serverFacts(server), calls: callFacts(route, record.startedAt) };
}

/** Rounds around the end of a turn: what the app-server answers, and whether the message is then there exactly once. */
async function runRace(context, offsets = [-60, -20, -5, 0, 5, 15, 40, 80, 160, 320, -60, -20, -5, 0, 5, 15, 40, 80, 160, 320]) {
  const tag = 'race';
  const markers = {};
  const plan = limitPlan();
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed });
  const { route } = conversation;
  const record = { startedAt: Date.now(), rounds: [] };
  const server = await conversation.open();
  try {
    const { threadId } = await conversation.start(server);
    for (const [index, offset] of offsets.entries()) {
      const prompt = marker('P');
      const steered = marker('S');
      markers[`p${index}`] = prompt;
      markers[`s${index}`] = steered;
      const round = { index, offset };
      let turn;
      const go = () => { round.answer = steer(server, threadId, turn.turnId, `Steer ${steered}`); };
      route.steps.push({ kind: 'text', text: 'Round reply.', beforeEnd: async () => { if (offset < 0) { go(); await delay(-offset); } else setTimeout(go, offset); } });
      const completions = server.log.filter((entry) => entry.kind === 'turn/completed').length;
      turn = await startTurn(server, threadId, `Round ${prompt}`);
      await turn.done;
      await delay(Math.max(0, offset) + 150);
      const answer = await round.answer;
      round.answer = { ok: answer.ok, code: answer.code, message: answer.message };
      await server.quiet(800, 15_000);
      round.turns = server.log.filter((entry) => entry.kind === 'turn/completed').length - completions;
      record.rounds.push(round);
    }
    route.steps.push({ kind: 'text', text: 'Last reply.' });
    const last = await startTurn(server, threadId, 'Last round.');
    await last.done;
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  const lastCall = callFacts(route, record.startedAt).at(-1);
  for (const round of record.rounds) {
    round.promptCount = lastCall?.markerCounts[`p${round.index}`] ?? 0;
    round.steerCount = lastCall?.markerCounts[`s${round.index}`] ?? 0;
  }
  record.acceptedButMissing = record.rounds.filter((round) => round.answer?.ok && round.steerCount === 0).map((round) => round.index);
  record.twice = record.rounds.filter((round) => round.steerCount > 1 || round.promptCount !== 1).map((round) => round.index);
  record.refused = record.rounds.filter((round) => !round.answer?.ok).length;
  record.accepted = record.rounds.filter((round) => round.answer?.ok).length;
  return record;
}

/** thread/queue/*: does it run by itself, and does it survive a restart? */
async function runQueue(context, name) {
  const tag = `queue-${name}`;
  const markers = { prompt: marker('PROMPT'), queued: marker('QUEUED') };
  const plan = limitPlan();
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed });
  const { route } = conversation;
  const record = { name, startedAt: Date.now(), steps: [] };
  const mid = gate();
  route.steps.push({ kind: 'text', text: LONG_TEXT, chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) mid.open(); } }, { kind: 'text', text: 'Second reply.' }, { kind: 'text', text: 'Third reply.' });
  let server = await conversation.open();
  const call = async (method, params) => {
    try {
      const result = await server.request(method, params);
      record.steps.push({ method, ok: true, keys: Object.keys(result ?? {}), count: result?.data?.length ?? null });
      return result;
    } catch (error) {
      record.steps.push({ method, ok: false, ...rpcError(error) });
      return null;
    }
  };
  try {
    const { threadId } = await conversation.start(server);
    const add = { threadId, clientUserMessageId: `queued-${randomUUID()}`, input: textInput(`Queued message ${markers.queued}`) };
    if (name === 'limit') {
      const refused = plan.refuse();
      const turn = await startTurn(server, threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await mid.opened;
      route.steps.length = 0;
      await call('thread/queue/add', add);
      route.limit = () => refused;
      await server.request('turn/steer', { threadId, expectedTurnId: turn.turnId, input: textInput('Then stop.'), clientUserMessageId: `steer-${randomUUID()}` }).catch(() => undefined);
      await turn.done;
      await server.quiet(3_000, 15_000);
      await call('thread/queue/list', { threadId });
      route.limit = null;
      route.steps.push({ kind: 'text', text: 'After the reset.' }, { kind: 'text', text: 'Next.' });
      await server.quiet(1_500, 5_000);
      await call('thread/queue/list', { threadId });
    } else if (name === 'closed') {
      const turn = await startTurn(server, threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await mid.opened;
      await call('thread/queue/add', add);
      await call('thread/queue/list', { threadId });
      await closeServer(server);
      record.beforeRestart = callFacts(route, record.startedAt).length;
      server = await conversation.open();
      await conversation.resume(server, threadId);
      await server.quiet(3_000, 10_000);
      await call('thread/queue/list', { threadId });
      void turn;
    } else if (name === 'idle') {
      await call('thread/queue/add', add);
      await call('thread/queue/list', { threadId });
      await server.quiet(2_000, 10_000);
      await call('thread/queue/start', { threadId });
    } else {
      const turn = await startTurn(server, threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await mid.opened;
      await call('thread/queue/add', add);
      if (name === 'duplicate') await call('thread/queue/add', add);
      await call('thread/queue/list', { threadId });
      await turn.done;
      await server.quiet(3_000, 15_000);
      await call('thread/queue/list', { threadId });
      if (name === 'restart') {
        await closeServer(server);
        server = await conversation.open();
        await conversation.resume(server, threadId);
        await server.quiet(3_000, 10_000);
        await call('thread/queue/list', { threadId });
      }
    }
    await server.quiet(2_500, 15_000);
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  return { ...record, ...serverFacts(server), calls: callFacts(route, record.startedAt) };
}

// ---------------------------------------------------------------------------
// P15: edge cases

async function runEdge(context, name) {
  const tag = `edge-${name}`;
  const markers = { prompt: marker('PROMPT'), resume: marker('CONT'), person: marker('PERSON') };
  const plan = limitPlan();
  const record = { name, startedAt: Date.now() };
  const conversation = await makeConversation(context, tag, { markers, headers: plan.allowed, preset: ASKS });
  const { route } = conversation;
  const refused = plan.refuse();
  let server = await conversation.open();
  try {
    const { threadId, rollout } = await conversation.start(server);
    if (name === 'approval' || name === 'approval-closed') {
      route.steps.push(commandCall({ text: 'Running a command.' }));
      server.state.policy = (method) => (method.endsWith('requestApproval') || method === 'execCommandApproval' ? 'hold' : 'decline');
      let turn = await startTurn(server, threadId, `Please fix src/cart.ts ${markers.prompt}`);
      for (let wait = 0; wait < 300 && !server.held.length; wait += 1) await delay(100);
      record.heldApprovals = server.held.map((frame) => frame.method);
      route.limit = () => refused;
      await delay(1_500);
      record.whileHeld = { rateLimits: server.rateLimits.length, turnCompleted: server.log.some((entry) => entry.kind === 'turn/completed') };
      if (name === 'approval') {
        for (const frame of server.held.splice(0)) server.respond(frame, 'decline');
        record.failed = (await turn.done).params?.turn?.error ?? null;
      } else {
        await closeServer(server);
        record.beforeClose = serverFacts(server);
        server = await conversation.open();
        await conversation.resume(server, threadId);
        const read = await server.request('thread/read', { threadId, includeTurns: true }).catch((error) => ({ failed: rpcError(error) }));
        record.threadAfterRestart = read.failed ?? { status: read.thread?.status ?? null, turns: (read.thread?.turns ?? []).map((entry) => ({ status: entry.status, items: (entry.items ?? []).map((item) => `${item.type}:${item.status ?? ''}`) })) };
      }
      route.limit = null;
      route.steps.length = 0;
      route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
      turn = await startTurn(server, threadId, `Continue. ${markers.resume}`);
      record.resumedStatus = (await turn.done).params?.turn?.status ?? null;
    } else if (name === 'steer-limit') {
      const mid = gate();
      route.steps.push({ kind: 'text', text: LONG_TEXT, chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) mid.open(); } });
      server.state.policy = () => 'decline';
      let turn = await startTurn(server, threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await mid.opened;
      route.limit = () => refused;
      record.steer = await steer(server, threadId, turn.turnId, `And keep it short ${markers.person}`);
      record.failed = (await turn.done).params?.turn?.error ?? null;
      await delay(300);
      route.limit = null;
      route.steps.length = 0;
      route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
      turn = await startTurn(server, threadId, `Continue. ${markers.resume}`);
      record.resumedStatus = (await turn.done).params?.turn?.status ?? null;
    } else if (name === 'child') {
      route.steps.push({ kind: 'call', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: { message: `Look at src/cart.ts ${markers.person}` }, text: 'Starting a helper.' }, (_entry, current) => { current.limit = () => refused; return refused; });
      server.state.policy = () => 'decline';
      let turn = await startTurn(server, threadId, `Use a helper on src/cart.ts ${markers.prompt}`);
      record.failed = (await turn.done).params?.turn?.error ?? null;
      await server.quiet(2_000, 10_000);
      route.limit = null;
      route.steps.length = 0;
      route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
      turn = await startTurn(server, threadId, `Continue. ${markers.resume}`);
      record.resumedStatus = (await turn.done).params?.turn?.status ?? null;
    } else if (name === 'person') {
      route.limit = () => refused;
      let turn = await startTurn(server, threadId, `Please fix src/cart.ts ${markers.prompt}`);
      await turn.done;
      await delay(300);
      turn = await startTurn(server, threadId, `Actually do this instead ${markers.person}`);
      record.personStatus = (await turn.done).params?.turn?.status ?? null;
      await delay(300);
      route.limit = null;
      route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
      turn = await startTurn(server, threadId, `Continue. ${markers.resume}`);
      record.resumedStatus = (await turn.done).params?.turn?.status ?? null;
    }
    const facts = codexRolloutFacts(rollout, markers);
    record.rollout = { markerLines: facts.markerLines };
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  record.calls = callFacts(route, record.startedAt);
  return { ...record, ...serverFacts(server) };
}

/** Two threads go the moment one reset arrives; the stub admits only one call. */
async function runTwo(context) {
  const shared = { limited: true, admits: 1, refusedAfterReset: 0 };
  const plan = limitPlan();
  const refused = plan.refuse();
  const limit = () => {
    if (shared.limited) return refused;
    if (shared.admits > 0) { shared.admits -= 1; return null; }
    shared.refusedAfterReset += 1;
    return refused;
  };
  const record = { startedAt: Date.now(), conversations: [] };
  const members = [];
  for (const name of ['a', 'b']) {
    const markers = { prompt: marker('PROMPT'), resume: marker('CONT') };
    const conversation = await makeConversation(context, `two-${name}`, { markers, headers: plan.allowed, limit });
    const server = await conversation.open();
    const { threadId } = await conversation.start(server);
    const turn = await startTurn(server, threadId, `Please look at src/cart.ts ${markers.prompt}`);
    await turn.done;
    conversation.route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
    members.push({ name, conversation, server, threadId, markers });
  }
  shared.limited = false;
  const sentAt = Date.now();
  const outcomes = await Promise.all(members.map(async (member) => {
    const turn = await startTurn(member.server, member.threadId, `Continue. ${member.markers.resume}`);
    const completed = await turn.done;
    return { name: member.name, status: completed.params?.turn?.status ?? null, error: completed.params?.turn?.error?.codexErrorInfo ?? null };
  }));
  for (const member of members) {
    await closeServer(member.server);
    record.conversations.push({ name: member.name, outcome: outcomes.find((entry) => entry.name === member.name), calls: callFacts(member.conversation.route, sentAt).map((call) => `${call.atMs}:${call.answer}`) });
  }
  record.refusedAfterReset = shared.refusedAfterReset;
  return record;
}

// ---------------------------------------------------------------------------
// Real provider (P12)

const REAL_ENV = () => providerEnvironment(CODEX_ENVIRONMENT_VARIABLES);

const REAL_SCENARIOS = {
  text: {},
  tool: { mcp: true },
  approval: { preset: ASKS },
  stale: {},
  review: {},
};

/** Real turn/steer; the turn after is the cache measure. Read-only, every command declined. */
async function runReal(context, name, spec, pass) {
  const { codexScript, slow, options } = context;
  const tag = `real-p${pass}-${name}`;
  const repo = path.join(options.scratch, tag);
  await createReviewRepo(repo);
  const markers = { prompt: marker('TICKET'), steer: marker('NOTE'), final: marker('FINAL'), acted: 'PINEAPPLE' };
  const record = { name, pass, startedAt: Date.now(), steers: [] };
  const endpoint = spec.mcp ? slow.endpoint(tag) : null;
  const config = endpoint ? { mcp_servers: { [SLOW_SERVER]: { url: endpoint.url, http_headers: { Authorization: `Bearer ${endpoint.token}` }, tool_timeout_sec: 120 } } } : undefined;
  const server = await openServer(codexScript, repo, REAL_ENV(), { markers, mask: true });
  const effort = options.effort ? { effort: options.effort } : {};
  const steerText = `Note ${markers.steer}: when you are finished, also say the word PINEAPPLE once.`;
  try {
    const rate = await server.request('account/rateLimits/read').catch((error) => ({ failed: rpcError(error) }));
    record.rateLimitsRead = rate.failed ?? { keys: Object.keys(rate).sort(), rateLimits: maskedLimits(rate.rateLimits), byLimitId: Object.keys(rate.rateLimitsByLimitId ?? {}) };
    const { threadId, rollout, model, reasoningEffort } = await startThread(server, repo, spec.preset ?? READ_ONLY, config);
    Object.assign(record, { model, reasoningEffort, turnEffort: options.effort ?? null });
    server.state.policy = (method) => (method.endsWith('requestApproval') || method === 'execCommandApproval' ? 'hold' : 'decline');
    let turn;
    if (name === 'text') {
      turn = await startTurn(server, threadId, `Do not use any tools or run any commands. Write a numbered list of 40 short facts about terminals, one per line. Ticket ${markers.prompt}.`, { extra: effort });
      await server.waitFor((frame) => /agentMessage\/delta$/u.test(frame.method), 90_000);
      await delay(800);
      record.steers.push(await steer(server, threadId, turn.turnId, steerText));
    } else if (name === 'tool') {
      turn = await startTurn(server, threadId, `Ticket ${markers.prompt}. Call the ${SLOW_TOOL} tool of the ${SLOW_SERVER} server once with seconds 12. When it returns, reply with exactly: STEP DONE.`, { extra: effort });
      for (let wait = 0; wait < 900 && !endpoint.route.calls.length; wait += 1) await delay(100);
      await delay(1_000);
      record.toolRunning = endpoint.route.calls.length;
      record.steers.push(await steer(server, threadId, turn.turnId, steerText));
    } else if (name === 'approval') {
      turn = await startTurn(server, threadId, `Ticket ${markers.prompt}. Run this exact command once: node -e "console.log(1+1)". Do nothing else. If it is declined, reply with exactly: DECLINED.`, { extra: effort });
      for (let wait = 0; wait < 900 && !server.held.length; wait += 1) await delay(100);
      record.heldApprovals = server.held.map((frame) => frame.method);
      record.steers.push(await steer(server, threadId, turn.turnId, steerText));
      await delay(3_000);
      record.stillHeldAfterSteer = server.held.length;
      for (const frame of server.held.splice(0)) server.respond(frame, 'decline');
    } else if (name === 'stale') {
      turn = await startTurn(server, threadId, `Do not use any tools. Reply with exactly: FIRST. Ticket ${markers.prompt}.`, { extra: effort });
      await turn.done;
      const old = turn.turnId;
      turn = await startTurn(server, threadId, 'Do not use any tools or run any commands. Write a numbered list of 25 short facts about terminals, one per line.', { extra: effort });
      await server.waitFor((frame) => /agentMessage\/delta$/u.test(frame.method), 90_000);
      record.steers.push({ label: 'previous turn id', ...await steer(server, threadId, old, steerText) });
    } else if (name === 'review') {
      const done = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId, 180_000);
      done.catch(() => undefined);
      const started = await server.request('review/start', { threadId, target: { type: 'custom', instructions: `Review src/cart.ts briefly. Ticket ${markers.prompt}.` }, delivery: 'inline' });
      turn = { turnId: started.turn?.id, done };
      await delay(1_500);
      record.steers.push(await steer(server, threadId, turn.turnId, steerText));
    }
    await turn.done;
    await delay(800);
    await server.quiet(3_000, 60_000);
    const last = await startTurn(server, threadId, `Do not use any tools. Reply with exactly: OK. Ticket ${markers.final}.`, { extra: effort });
    record.finalTurn = last.turnId;
    await last.done;
    await delay(1_000);
    const facts = codexRolloutFacts(rollout, markers);
    record.rollout = { markerLines: facts.markerLines, entries: (facts.entries ?? []).filter((entry) => entry.markers).map((entry) => [entry.type, entry.payload, entry.role, `[${entry.markers.join(',')}]`].filter(Boolean).join('/')) };
    const turnsInOrder = [...new Set(server.usage.map((entry) => entry.turnId))];
    record.usageByTurn = turnsInOrder.map((turnId) => {
      const mine = server.usage.filter((entry) => entry.turnId === turnId);
      return { turn: turnId === last.turnId ? 'final' : 'steered', calls: mine.length, first: mine[0], last: mine.at(-1) };
    });
    const steered = record.usageByTurn.find((entry) => entry.turn === 'steered');
    const final = record.usageByTurn.find((entry) => entry.turn === 'final');
    record.crossTurnRatio = ratio(final?.first?.cached, steered?.last?.input);
    if (steered?.calls > 1) record.afterSteerRatio = ratio(server.usage.filter((entry) => entry.turnId === steered.last.turnId)[1]?.cached, steered.first.input);
  } catch (error) {
    record.error = errorText(error);
  }
  await closeServer(server);
  const facts = serverFacts(server);
  return { ...record, ...facts };
}

// ---------------------------------------------------------------------------
// History: real limit records on this PC (read-only, shapes and counts)

function readHistory() {
  const sessions = path.join(homedir(), '.codex', 'sessions');
  const counts = { files: 0, lines: 0, tokenCountWithLimits: 0, errors: 0, reachedTypes: {} };
  const errorForms = {};
  const limitKeys = {};
  const windows = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.jsonl') || statSync(full).size > 200_000_000) continue;
      counts.files += 1;
      for (const line of readFileSync(full, 'utf8').split(/\r?\n/u)) {
        if (!line || !(line.includes('rate_limit') || line.includes('usage_limit') || line.includes('"type":"error"') || line.includes('stream_error'))) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        counts.lines += 1;
        const payload = record.payload ?? {};
        if (payload.type === 'token_count' && payload.rate_limits) {
          counts.tokenCountWithLimits += 1;
          const limits = payload.rate_limits;
          const key = Object.keys(limits).sort().join(',');
          limitKeys[key] = (limitKeys[key] ?? 0) + 1;
          const reached = limits.rate_limit_reached_type ?? 'none';
          counts.reachedTypes[reached] = (counts.reachedTypes[reached] ?? 0) + 1;
          for (const name of ['primary', 'secondary']) {
            const window = limits[name];
            if (!window) continue;
            const shape = `${name}: ${Object.keys(window).sort().join(',')} | window ${window.window_minutes ?? window.windowDurationMins ?? '?'} | resets mod60 ${typeof window.resets_at === 'number' ? window.resets_at % 60 === 0 : '?'}`;
            windows[shape] = (windows[shape] ?? 0) + 1;
          }
        } else if (payload.type === 'error' || payload.type === 'stream_error' || record.type === 'error') {
          counts.errors += 1;
          const form = String(payload.message ?? '').replace(/\d+/gu, '<n>').slice(0, 90);
          const key = `${payload.type ?? record.type} | ${JSON.stringify(payload.codex_error_info ?? null).slice(0, 60)} | ${form}`;
          errorForms[key] = (errorForms[key] ?? 0) + 1;
        }
      }
    }
  };
  if (existsSync(sessions)) walk(sessions);
  return { counts, limitKeys, windows, errorForms };
}

// ---------------------------------------------------------------------------
// Verdicts: what each scenario measured, and the claims the runs support

function scenarioVerdict(key, scenario) {
  if (scenario.error && !scenario.calls) return { error: scenario.error };
  const group = key.split(/[:#]/u)[0];
  const retries = (scenario.stream ?? []).filter((line) => / error /u.test(line) && /"willRetry":true/u.test(line)).length;
  if (group === 'limit') {
    return { status: scenario.turnCompleted?.status ?? null, codexErrorInfo: scenario.turnCompleted?.error?.codexErrorInfo ?? null, willRetry: retries, calls: scenario.calls?.length ?? 0, threadStatus: scenario.threadRead?.status?.type ?? null, primaryResetsAt: typeof scenario.rateLimits?.at(-1)?.limits?.primary?.resetsAt === 'number', resetInMessage: /try again at /u.test(scenario.turnCompleted?.error?.message ?? '') };
  }
  if (group === 'resume' || group === 'early') {
    return { promptRead: scenario.modelRead?.markerCounts?.prompt ?? 0, continueRead: scenario.modelRead?.markerCounts?.resume ?? 0, earlyRead: Object.entries(scenario.modelRead?.markerCounts ?? {}).filter(([name]) => name.startsWith('early')).length, toolPairsKept: (scenario.modelRead?.shape?.match(/call:/gu) ?? []).length, finished: scenario.resumedStatus === 'completed' };
  }
  if (group === 'uuid') return { first: scenario.firstStatus ?? null, second: scenario.secondStatus ?? null, promptRead: scenario.calls?.at(-1)?.markerCounts?.prompt ?? 0 };
  if (group === 'steer' || group === 'real') {
    const turns = (scenario.stream ?? []).filter((line) => / turn\/completed /u.test(line)).length;
    return { steers: (scenario.steers ?? []).map((entry) => ({ ok: entry.ok, ...(entry.ok ? {} : { message: entry.message, code: entry.code, info: entry.data?.codexErrorInfo ?? null }) })), steerRead: scenario.calls?.at(-1)?.markerCounts?.steer ?? null, streamAborted: scenario.calls?.some((call) => call.clientAborted) ?? null, turnsCompleted: turns, crossTurnRatio: scenario.crossTurnRatio ?? null, afterSteerRatio: scenario.afterSteerRatio ?? null, stillHeldAfterSteer: scenario.stillHeldAfterSteer ?? null };
  }
  if (group === 'race') return { rounds: scenario.rounds?.length ?? 0, accepted: scenario.accepted ?? null, refused: scenario.refused ?? null, acceptedButMissing: scenario.acceptedButMissing ?? null, twice: scenario.twice ?? null };
  if (group === 'queue') return { steps: scenario.steps?.map((step) => `${step.method}:${step.ok ? step.count ?? 'ok' : step.message}`) ?? [], calls: scenario.calls?.map((call) => call.answer) ?? [] };
  return { resumed: scenario.resumedStatus ?? null, failed: scenario.failed?.codexErrorInfo ?? null, calls: scenario.calls?.map((call) => call.answer) ?? null };
}

function claims(verdicts) {
  const pick = (prefix) => Object.entries(verdicts).filter(([key]) => key.startsWith(prefix));
  const resume = pick('resume:');
  const check = (entries, test) => (entries.length ? { holds: entries.every(([, verdict]) => test(verdict)), runs: entries.length } : null);
  return {
    continueReadsThePromptOnce: check(resume.filter(([key]) => key.includes('-continue')), (verdict) => verdict.promptRead === 1 && verdict.continueRead === 1),
    resendingReadsThePromptTwice: check(resume.filter(([key]) => key.includes('-original')), (verdict) => verdict.promptRead === 2),
    finishedAfterReset: check(resume, (verdict) => verdict.finished),
    clientUserMessageIdDoesNotDedupeTurnStart: check(pick('uuid:'), (verdict) => verdict.promptRead === 2),
    raceNothingLostOrDoubled: check(pick('race'), (verdict) => verdict.acceptedButMissing?.length === 0 && verdict.twice?.length === 0),
  };
}

// ---------------------------------------------------------------------------

function expandSteps(only) {
  const out = [];
  for (const step of only) {
    if (step === 'limit') out.push(...Object.keys(LIMITS).map((name) => `limit:${name}`));
    else if (step === 'resume') out.push(...Object.keys(RESUME).map((name) => `resume:${name}`));
    else if (step === 'uuid') out.push(...Object.keys(UUID_CASES).map((name) => `uuid:${name}`));
    else if (step === 'steer') out.push(...STEER_CASES.map((name) => `steer:${name}`));
    else if (step === 'queue') out.push('queue:running', 'queue:idle', 'queue:duplicate', 'queue:restart', 'queue:limit', 'queue:closed');
    else if (step === 'edge') out.push('edge:approval', 'edge:approval-closed', 'edge:person', 'edge:steer-limit', 'edge:child', 'two');
    else if (step === 'early') out.push('early:1', 'early:3');
    else if (step === 'real') out.push(...Object.keys(REAL_SCENARIOS).map((name) => `real:${name}`));
    else out.push(step);
  }
  return out;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  options.scratch = path.join(options.scratch, `codex-${stamp}`);
  await fs.mkdir(options.scratch, { recursive: true });
  const codexScript = options.codexScript ?? resolveCodexScript();
  const stub = await startResponsesStub({ dummies: [DUMMY_OPENAI_KEY] });
  const proxy = await startDenyProxy();
  const slow = await startSlowToolServer();
  const file = path.join(options.out, `codex-${stamp}.json`);
  const report = { probe: 'codex-long-run', at: new Date().toISOString(), facts: { only: options.only, repeat: options.repeat, effort: options.effort ?? null }, scenarios: {} };
  const context = { codexScript, stub, proxy, slow, options };
  const save = async () => {
    report.audit = { stub: credentialAudit(stub.requests), refusedHosts: proxy.hosts() };
    report.verdicts = Object.fromEntries(Object.entries(report.scenarios).filter(([key]) => key !== 'history').map(([key, scenario]) => [key, scenarioVerdict(key, scenario)]));
    report.claims = claims(report.verdicts);
    await writeReport(file, report);
  };
  const run = async (key, work) => {
    log(key);
    try {
      report.scenarios[key] = await work();
    } catch (error) {
      report.scenarios[key] = { error: errorText(error) };
      log(`${key} failed: ${errorText(error)}`);
    }
    await save();
  };
  try {
    for (let pass = 1; pass <= options.repeat; pass += 1) {
      const suffix = options.repeat > 1 ? `#${pass}` : '';
      for (const step of expandSteps(options.only)) {
        const [group, ...rest] = step.split(':');
        const key = `${step}${suffix}`;
        const uniqueContext = { ...context, options: { ...options, scratch: path.join(options.scratch, `pass-${pass}`) } };
        await fs.mkdir(uniqueContext.options.scratch, { recursive: true });
        if (group === 'limit') await run(key, () => runLimit(uniqueContext, rest[0], LIMITS[rest[0]]));
        else if (group === 'resume') await run(key, () => runResume(uniqueContext, rest[0], RESUME[rest[0]]));
        else if (group === 'early') await run(key, () => runResume(uniqueContext, `early-${rest[0]}`, { position: 'later', how: 'same', message: 'continue', early: Number(rest[0]) }));
        else if (group === 'uuid') await run(key, () => runDuplicateId(uniqueContext, rest[0], UUID_CASES[rest[0]]));
        else if (group === 'steer') await run(key, () => runSteer(uniqueContext, rest[0]));
        else if (group === 'race') await run(key, () => runRace(uniqueContext));
        else if (group === 'queue') await run(key, () => runQueue(uniqueContext, rest[0]));
        else if (group === 'edge') await run(key, () => runEdge(uniqueContext, rest[0]));
        else if (group === 'two') await run(key, () => runTwo(uniqueContext));
        else if (group === 'idle') await run(key, () => runIdle(uniqueContext));
        else if (group === 'real') await run(key, () => runReal(uniqueContext, rest[0], REAL_SCENARIOS[rest[0]], pass));
        else if (group === 'history') await run(key, async () => readHistory());
        else throw new Error(`Unknown step: ${step}`);
      }
    }
  } finally {
    await save();
    await stub.close();
    await proxy.close();
    await slow.close();
  }
  console.log(JSON.stringify({ file }));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
