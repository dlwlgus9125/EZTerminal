#!/usr/bin/env node
/**
 * Probe for bundle 3 "long-run continuity" on Claude: what a real usage limit looks like (P13-P15, the real CLI against
 * a loopback stub, no real account) and sending into a running turn (P11, stub first, then the real provider).
 *
 *   node scripts/probe-claude-long-run.mjs --scratch <dir> --only <steps> [--repeat 1] [--claude-executable <path>]
 *
 * Steps, comma separated (a bare group name runs all of it):
 *   shape[:<name>]    one refused call per auth path, retry setting and header set (SHAPES)
 *   resume[:<name>]   refused turn, reset, then "Continue." or the original prompt, same process or resumed
 *   early[:<n>]       n messages sent before the reset, then "Continue." after it
 *   uuid[:<name>]     the same user-message uuid sent twice: does the CLI drop the second?
 *   approval[:<name>] a limit that arrives while a permission is held; the app closed on that permission
 *   watchdog[:<name>] the CLI's unattended retry mode (CLAUDE_CODE_RETRY_WATCHDOG): waits, people, interrupt, runtime switch
 *   idle              a refused turn left alone across its reset
 *   child             a subagent's call refused
 *   queued[:<p>]      a message queued with priority p when the running turn is refused
 *   two               two conversations waiting on one reset that goes at once
 *   steer[:<where>:<priority>[:replay]]   a message sent mid-turn (where: text, between, tool, permission, end)
 *   race[:<priority>] rounds of messages sent around the end of a turn
 *   real[:<name>]     the real provider (REAL_SCENARIOS): costs usage; two passes by default with --repeat 2
 *   history           read ~/.claude/projects for rate-limit records: shapes and counts only
 *
 * Stub runs: the installed CLI, CLAUDE_CONFIG_DIR and HOME in scratch (so the person's credentials are out of reach),
 * ANTHROPIC_BASE_URL at a loopback stub, a dummy CLAUDE_CODE_OAUTH_TOKEN (the subscriber path: a dummy
 * ANTHROPIC_API_KEY takes the API path, where the CLI reads no unified limit headers) or ANTHROPIC_API_KEY,
 * HTTP(S)_PROXY at a deny-and-log proxy with NO_PROXY for loopback. The report shows what the stub saw (header names,
 * a dummy-or-not boolean, never a credential value) and every host the proxy refused.
 *
 * Session options mirror startSession in src/main/claude-provider-adapter.ts at the standard preset.
 * Report: artifacts/long-run-probe/claude-<time>.json, rewritten after every scenario. Real runs keep marker names,
 * shapes and token counts; limit values are reduced to their granularity (see maskedLimit), and no account attributes.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, promises as fs, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createReviewRepo } from './review-probe-repo.mjs';
import {
  DUMMY_API_KEY, DUMMY_OAUTH_TOKEN, RATE_LIMIT_BODY, SLOW_SERVER, SLOW_TOOL, allowedHeaders, claudeSessionFacts, claudeSessionFile, clip,
  credentialAudit, gate, marker, rejectedHeaders, startAnthropicStub, startDenyProxy, startSlowToolServer,
} from './long-run-probe-kit.mjs';
import { CLAUDE_ENVIRONMENT_VARIABLES, delay, errorText, log, number, providerEnvironment, ratio, withTimeout, writeReport } from './wrap-up-probe-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 180_000;
const HOUR = 3_600;
const SLOW_FULL_NAME = `mcp__${SLOW_SERVER}__${SLOW_TOOL}`;
const LONG_TEXT = 'Streaming a long answer word by word so a message can arrive in the middle of it. '.repeat(4);

function parseArguments(argv) {
  const options = { repeat: 1, only: [], out: path.join(root, 'artifacts', 'long-run-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--only') options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--claude-executable') options.claudeExecutable = path.resolve(value);
    else if (flag === '--model') options.model = value;
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  if (!options.only.length) throw new Error('--only is required: real-provider steps must be asked for by name.');
  return options;
}

function resolveClaudeExecutable() {
  const directories = (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean);
  for (const directory of directories) {
    for (const candidate of [
      path.join(directory, 'claude.exe'),
      path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Claude Code executable not found; pass --claude-executable.');
}

class AsyncQueue {
  #values = [];
  #waiters = [];
  #closed = false;
  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }
  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        if (this.#values.length) return { done: false, value: this.#values.shift() };
        if (this.#closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: async () => { this.close(); return { done: true, value: undefined }; },
    };
  }
}

// ---------------------------------------------------------------------------
// Sessions

const markersIn = (value, markers) => {
  const text = JSON.stringify(value ?? '');
  return Object.entries(markers).filter(([, needle]) => text.includes(needle)).map(([name]) => name);
};

/** Real resetsAt values and utilization are the account's; a real report keeps their shape only. */
function maskedLimit(info) {
  const granularity = (value) => (typeof value === 'number' ? { mod60: value % 60, mod600: value % 600 } : null);
  return {
    status: info.status ?? null, rateLimitType: info.rateLimitType ?? null, keys: Object.keys(info).sort(),
    resetsAt: granularity(info.resetsAt), overageStatus: info.overageStatus ?? null,
    windows: Object.fromEntries(Object.entries(info.unifiedWindows ?? {}).map(([name, window]) => [name, { keys: Object.keys(window).sort(), status: window.status ?? null, resetsAt: granularity(window.resetsAt) }])),
  };
}

function openSession(query, options, sessionId, { markers = {}, mask = false } = {}) {
  const input = new AsyncQueue();
  const abortController = new AbortController();
  const session = query({ prompt: input, options: { ...options, abortController } });
  const state = { stream: [], results: [], lifecycle: [], rateLimits: [], retries: [], errorMessage: null, streamError: null, init: null, origin: Date.now(), markers, lastActivity: Date.now() };
  let checks = [];
  const notify = () => { for (const check of [...checks]) check(); };
  const until = (predicate, ms) => new Promise((resolve) => {
    if (predicate()) { resolve(true); return; }
    let timer;
    const done = (value) => { clearTimeout(timer); checks = checks.filter((entry) => entry !== check); resolve(value); };
    const check = () => { if (predicate()) done(true); };
    timer = setTimeout(() => done(false), ms);
    checks.push(check);
  });
  const push = (entry) => { state.lastActivity = Date.now(); state.stream.push({ atMs: Date.now() - state.origin, ...entry }); };
  const iterate = (async () => {
    for await (const message of session) {
      const kind = message.type === 'system' ? `system/${message.subtype}` : message.type;
      if (message.type === 'stream_event') {
        const event = message.event ?? {};
        if (event.type === 'message_start') push({ kind: 'se/message_start', id: event.message?.id ?? null });
        else if (event.type === 'content_block_start') push({ kind: 'se/block_start', block: event.content_block?.type ?? null });
        else if (event.type === 'message_stop') push({ kind: 'se/message_stop' });
        notify();
        continue;
      }
      const at = Date.now();
      if (kind === 'system/init') {
        state.init = { atMs: at - state.origin, model: message.model ?? null, version: message.claude_code_version ?? null, apiKeySource: message.apiKeySource ?? null };
        push({ kind });
      } else if (message.type === 'user') {
        const content = message.message?.content;
        push({
          kind: 'user', uuid: message.uuid ?? null, isReplay: message.isReplay ?? false, isSynthetic: message.isSynthetic ?? false, priority: message.priority ?? null,
          blocks: typeof content === 'string' ? ['text'] : (content ?? []).map((block) => block.type), markers: markersIn(content, state.markers),
          ...(Array.isArray(content) && content.some((block) => block.type === 'tool_result' && block.is_error) ? { toolError: true } : {}),
        });
      } else if (message.type === 'assistant') {
        if (message.error && !state.errorMessage) {
          state.errorMessage = { keys: Object.keys(message).sort(), error: message.error, model: message.message?.model ?? null, text: mask ? null : clip((message.message?.content ?? []).map((block) => block.text ?? '').join(' '), 200) };
        }
        push({
          kind: 'assistant', messageId: message.message?.id ?? null, model: message.message?.model ?? null, blocks: (message.message?.content ?? []).map((block) => block.type),
          error: message.error ?? null, markers: markersIn(message.message?.content, state.markers), ...(message.parent_tool_use_id ? { sideChain: true } : {}),
        });
      } else if (message.type === 'command_lifecycle') {
        state.lifecycle.push({ atMs: at - state.origin, uuid: message.command_uuid ?? null, state: message.state ?? null });
        push({ kind, uuid: message.command_uuid ?? null, state: message.state ?? null });
      } else if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info ?? {};
        state.rateLimits.push({ atMs: at - state.origin, info: mask ? maskedLimit(info) : info });
        push({ kind, status: info.status ?? null, rateLimitType: info.rateLimitType ?? null });
      } else if (kind === 'system/api_retry') {
        const retry = { atMs: at - state.origin, attempt: message.attempt ?? null, maxRetries: message.max_retries ?? null, delayMs: message.retry_delay_ms ?? null, status: message.error_status ?? null, error: message.error ?? null, keys: Object.keys(message).sort() };
        state.retries.push(retry);
        push({ kind, attempt: retry.attempt, delayMs: retry.delayMs, status: retry.status, error: retry.error });
      } else if (message.type === 'result') {
        const result = {
          atMs: at - state.origin, uuid: message.uuid ?? null, subtype: message.subtype ?? null, isError: message.is_error ?? null, numTurns: message.num_turns ?? null,
          stopReason: message.stop_reason ?? null, terminalReason: message.terminal_reason ?? null, errors: message.errors ?? null, apiError: message.api_error ?? null, apiErrorStatus: message.api_error_status ?? null,
          keys: Object.keys(message).sort(), text: mask ? null : clip(message.result, 300), markers: markersIn(message.result, state.markers),
          userMessageUuid: message.user_message_uuid ?? null, userMessageUuids: message.user_message_uuids ?? null, resultIndex: message.result_index ?? null, queuedTurnCount: message.queued_turn_count ?? null,
        };
        state.results.push(result);
        push({ kind, subtype: result.subtype, isError: result.isError, numTurns: result.numTurns, terminalReason: result.terminalReason, queued: result.queuedTurnCount });
      } else {
        push({ kind, ...(message.state ? { state: message.state } : {}), ...(message.status ? { status: message.status } : {}), ...(!mask && (message.text || message.content) ? { text: clip(String(message.text ?? message.content), 160) } : {}) });
      }
      notify();
    }
    push({ kind: 'stream-ended' });
    notify();
  })();
  iterate.catch((error) => { state.streamError = errorText(error); push({ kind: 'stream-error', error: state.streamError }); notify(); });

  const send = (text, { priority, uuid = randomUUID() } = {}) => {
    push({ kind: '>> send', uuid, priority: priority ?? null, markers: markersIn(text, state.markers) });
    input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid, session_id: sessionId, ...(priority ? { priority } : {}) });
    return uuid;
  };
  const resultsAtLeast = (count, ms = TURN_DEADLINE_MS) => until(() => state.results.length >= count || state.streamError, ms);
  /** Nothing new for `quietMs`: the only way to see that no further result is coming. */
  const quiet = async (quietMs = 2_000, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (Date.now() - state.lastActivity >= quietMs) return true;
      await delay(100);
    }
    return false;
  };
  const close = async () => {
    input.close();
    session.close();
    await Promise.race([iterate.catch(() => undefined), delay(5_000)]);
  };
  return { session, state, send, until, resultsAtLeast, quiet, close, abortController };
}

function countMarkers(messages) {
  const counts = {};
  for (const message of messages) {
    for (const block of message.blocks) for (const name of block.markers ?? []) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

const blockTag = (block) => (block.type === 'text' ? `t${block.markers?.length ? `[${block.markers.join(',')}]` : ''}` : block.type === 'tool_result' ? `result${block.isError ? '!' : ''}${block.markers?.length ? `[${block.markers.join(',')}]` : ''}` : block.type === 'tool_use' ? `use:${block.name}` : block.type);

/** What each call to the stub carried, in order. */
const callFacts = (route, origin) => route.requests.filter((entry) => /\/v1\/messages$/u.test(entry.path)).map((entry) => ({
  atMs: entry.at - origin, main: entry.main ?? null, index: entry.mainIndex ?? null, answer: entry.answer ?? null, model: entry.model,
  ...(entry.clientAborted ? { clientAborted: true, abortedAtChunk: entry.abortedAtChunk ?? null } : {}),
  messageCount: entry.messages.length, markerCounts: countMarkers(entry.messages),
  shape: entry.messages.map((message) => `${message.role[0]}: ${message.blocks.map(blockTag).join(' ')}`),
}));

/** The session file without its request blobs and bookkeeping. */
function fileFacts(conversation) {
  const facts = conversation.sessionFile();
  if (!facts.found) return facts;
  const kept = facts.entries.filter((entry) => ['user', 'assistant', 'queue-operation', 'attachment', 'system'].includes(entry.type)
    && !(entry.type === 'attachment' && !entry.markers?.length));
  const inMessages = {};
  for (const entry of kept) {
    if (entry.type !== 'user' && entry.type !== 'attachment') continue;
    for (const name of entry.markers ?? []) inMessages[name] = (inMessages[name] ?? 0) + 1;
  }
  return {
    found: true, lines: facts.lines, markerLines: facts.markerLines, userAndAttachmentLines: inMessages,
    limitRecords: facts.entries.filter((entry) => entry.keys).map(({ keys, quotaLimits, apiError, apiErrorParams }) => ({ keys, quotaLimits, apiError, apiErrorParams })),
    entries: kept.map((entry) => [entry.type, entry.subtype, entry.operation, entry.attachment, entry.commandMode, entry.blocks?.join('+'), entry.isMeta ? 'meta' : null, entry.isApiErrorMessage ? 'apiError' : null, typeof entry.error === 'string' ? entry.error : null, entry.markers ? `[${entry.markers.join(',')}]` : null].filter(Boolean).join('/')),
  };
}

// ---------------------------------------------------------------------------
// Stub conversations

function seedHome(claudeHome) {
  mkdirSync(path.join(claudeHome, '.claude'), { recursive: true });
  writeFileSync(path.join(claudeHome, '.claude', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.312' }));
}

function limitPlan({ fiveHourIn = 2 * HOUR, sevenDayIn = 72 * HOUR } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const fiveHourResetAt = now + fiveHourIn;
  const sevenDayResetAt = now + sevenDayIn;
  return {
    fiveHourResetAt, sevenDayResetAt,
    allowed: allowedHeaders({ fiveHourResetAt, sevenDayResetAt }),
    refuse: (claim = 'five_hour', more = {}, drop = []) => {
      const headers = { ...rejectedHeaders({ claim, fiveHourResetAt, sevenDayResetAt }), ...more };
      for (const name of drop) delete headers[name];
      return { kind: 'raw', status: 429, headers, body: RATE_LIMIT_BODY };
    },
  };
}

async function makeConversation(context, tag, { auth = 'oauth', steps = [], fallback, markers = {}, extraEnv = {}, limit = null, plan = limitPlan(), canUseTool, extra = {}, keepText = false } = {}) {
  const { query, stub, proxy, options } = context;
  const repo = path.join(options.scratch, tag);
  await createReviewRepo(repo);
  const claudeHome = path.join(options.scratch, `${tag}-home`);
  seedHome(claudeHome);
  const route = stub.route(tag, { steps, fallback, headers: plan.allowed, markers, limit, keepText });
  const sessionId = randomUUID();
  const env = providerEnvironment([], {
    HOME: claudeHome, USERPROFILE: claudeHome, HOMEPATH: claudeHome, CLAUDE_CONFIG_DIR: path.join(claudeHome, '.claude'),
    ANTHROPIC_BASE_URL: route.url,
    ...(auth === 'oauth' ? { CLAUDE_CODE_OAUTH_TOKEN: DUMMY_OAUTH_TOKEN } : { ANTHROPIC_API_KEY: DUMMY_API_KEY }),
    HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    ...extraEnv,
  });
  const sessionOptions = (resume) => ({
    cwd: repo,
    pathToClaudeCodeExecutable: context.executable,
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    canUseTool: canUseTool ?? (async (_name, toolInput) => ({ behavior: 'allow', updatedInput: toolInput })),
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    persistSession: true,
    env,
    settingSources: ['user', 'project', 'local'],
    model: 'claude-opus-5-5',
    ...(resume ? { resume: sessionId } : { sessionId }),
    ...extra,
  });
  const started = Date.now();
  return {
    repo, route, plan, sessionId, markers, startedAt: started,
    open: async (resume = false) => {
      const claude = openSession(query, sessionOptions(resume), sessionId, { markers });
      await withTimeout(claude.session.initializationResult(), 60_000, 'initialization');
      return claude;
    },
    sessionFile: () => claudeSessionFacts(claudeSessionFile(path.join(claudeHome, '.claude'), sessionId), markers),
  };
}

const streamFacts = (state) => ({
  init: state.init, results: state.results, rateLimits: state.rateLimits, retries: state.retries, lifecycle: state.lifecycle, errorMessage: state.errorMessage,
  stream: state.stream.map(({ atMs, kind, ...rest }) => `${atMs} ${kind} ${JSON.stringify(rest)}`.replace(/ \{\}$/u, '')),
});

// ---------------------------------------------------------------------------
// P13/P14: what a limit looks like

const readFile = (repo, relative) => ({ kind: 'tool', name: 'Read', input: { file_path: path.join(repo, ...relative.split('/')) }, text: `Reading ${relative}.` });
const editCart = (repo) => ({ kind: 'tool', name: 'Edit', input: { file_path: path.join(repo, 'src', 'cart.ts'), old_string: 'index <= items.length', new_string: 'index < items.length' }, text: 'Fixing the bound.' });

const SHAPES = {
  'key-first-noretry': { auth: 'key', position: 'first', extraEnv: { CLAUDE_CODE_MAX_RETRIES: '0' } },
  'key-first': { auth: 'key', position: 'first', waitMs: 170_000 },
  'key-first-near': { auth: 'key', position: 'first', refuse: (plan) => plan.refuse('five_hour', { 'retry-after': '1' }), times: 2 },
  'oauth-first': { position: 'first' },
  'oauth-later': { position: 'later' },
  'oauth-weekly': { position: 'first', claim: 'seven_day' },
  'oauth-should-retry': { position: 'first', refuse: (plan) => plan.refuse('five_hour', { 'x-should-retry': 'true' }) },
  'oauth-should-not-retry': { position: 'first', refuse: (plan) => plan.refuse('five_hour', { 'x-should-retry': 'false' }) },
  'oauth-headerless-near': { position: 'first', refuse: () => ({ kind: 'raw', status: 429, headers: { 'retry-after': '1' }, body: RATE_LIMIT_BODY }), times: 2 },
  'oauth-headerless': { position: 'first', refuse: () => ({ kind: 'raw', status: 429, headers: {}, body: RATE_LIMIT_BODY }), waitMs: 170_000 },
  'oauth-no-reset': { position: 'first', refuse: (plan) => plan.refuse('five_hour', {}, ['anthropic-ratelimit-unified-reset', 'anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-7d-reset', 'retry-after']) },
  'oauth-status-only': { position: 'first', refuse: () => ({ kind: 'raw', status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected' }, body: RATE_LIMIT_BODY }), waitMs: 170_000 },
  'watchdog-near': { position: 'first', resetIn: 20, flip: true, extraEnv: { CLAUDE_CODE_RETRY_WATCHDOG: '1' }, waitMs: 90_000 },
  'watchdog-later': { position: 'later', resetIn: 20, flip: true, extraEnv: { CLAUDE_CODE_RETRY_WATCHDOG: '1' }, waitMs: 90_000 },
  'watchdog-capped': { position: 'first', extraEnv: { CLAUDE_CODE_RETRY_WATCHDOG: '1', CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS: '5000' } },
};

async function runShape(context, name, spec) {
  const { position, auth = 'oauth', claim, refuse, times, resetIn, flip, extraEnv = {}, waitMs = 60_000 } = spec;
  const tag = `shape-${name}`;
  const markers = { prompt: marker('PROMPT'), limitText: "You've hit your" };
  const plan = limitPlan(resetIn ? { fiveHourIn: resetIn } : {});
  const refused = refuse ? refuse(plan) : plan.refuse(claim);
  let remaining = times ?? Infinity;
  const resetAtMs = plan.fiveHourResetAt * 1_000;
  const limit = () => {
    if (flip && Date.now() >= resetAtMs) return null;
    if (remaining <= 0) return null;
    remaining -= 1;
    return refused;
  };
  const conversation = await makeConversation(context, tag, { auth, markers, extraEnv, plan });
  const route = conversation.route;
  if (position === 'first') route.limit = limit;
  else route.steps.push(readFile(conversation.repo, 'src/cart.ts'), (_entry, current) => { current.limit = limit; return limit() ?? { kind: 'text', text: 'Done.' }; });
  route.steps.push({ kind: 'text', text: 'Finished after the limit.' });
  const record = { name, spec: { auth, position, claim: claim ?? null, resetIn: resetIn ?? null, extraEnv: Object.keys(extraEnv) }, startedAt: Date.now() };
  const claude = await conversation.open();
  try {
    claude.send(`Please look at src/cart.ts ${markers.prompt}`);
    await claude.resultsAtLeast(1, waitMs);
    await claude.quiet(1_500, 10_000);
  } catch (error) {
    record.error = errorText(error);
  }
  record.durationMs = Date.now() - record.startedAt;
  await claude.close();
  return { ...record, ...streamFacts(claude.state), calls: callFacts(route, record.startedAt), sessionFile: fileFacts(conversation) };
}

/** A refused turn left alone across its reset: does anything arrive with no call made? */
async function runIdle(context) {
  const tag = 'idle';
  const markers = { prompt: marker('PROMPT'), limitText: "You've hit your" };
  const plan = limitPlan({ fiveHourIn: 12 });
  const refused = plan.refuse();
  const conversation = await makeConversation(context, tag, { markers, plan });
  const { route } = conversation;
  route.limit = () => (Date.now() >= plan.fiveHourResetAt * 1_000 ? null : refused);
  const record = { startedAt: Date.now(), resetInSeconds: 12 };
  const claude = await conversation.open();
  claude.send(`Please look at src/cart.ts ${markers.prompt}`);
  await claude.resultsAtLeast(1, 30_000);
  const settled = claude.state.stream.length;
  const calls = route.requests.length;
  await delay(Math.max(0, plan.fiveHourResetAt * 1_000 - Date.now()) + 8_000);
  record.afterTheResult = { streamMessages: claude.state.stream.slice(settled).map((entry) => entry.kind), stubCalls: route.requests.length - calls };
  await claude.close();
  return record;
}

const RESUME = {};
for (const position of ['first', 'later']) {
  for (const how of ['same', 'resumed']) {
    for (const message of ['continue', 'original']) RESUME[`${position}-${how}-${message}`] = { position, how, message };
  }
}

/** Refused turn, reset, then the message; `early` extra sends while still refused, the last one the person's. */
async function runResume(context, name, { position, how, message, early = 0 }) {
  const tag = `resume-${name}`;
  const markers = { prompt: marker('PROMPT'), resume: marker('CONT'), limitText: "You've hit your" };
  for (let index = 0; index < early; index += 1) markers[`early${index + 1}`] = marker(`EARLY${index + 1}`);
  const conversation = await makeConversation(context, tag, { markers });
  const { route, repo, plan } = conversation;
  const refused = plan.refuse();
  if (position === 'first') {
    route.limit = () => refused;
  } else {
    route.steps.push(readFile(repo, 'src/cart.ts'), editCart(repo), (_entry, current) => { current.limit = () => refused; return refused; });
  }
  const original = `Please fix src/cart.ts ${markers.prompt}`;
  const record = { name, position, how, message, early, startedAt: Date.now() };
  let claude = await conversation.open();
  claude.send(original);
  await claude.resultsAtLeast(1, 60_000);
  await claude.quiet(1_000, 10_000);
  for (let index = 0; index < early; index += 1) {
    claude.send(`Are you there? ${markers[`early${index + 1}`]}`);
    await claude.resultsAtLeast(2 + index, 30_000);
    await claude.quiet(800, 10_000);
  }
  record.beforeReset = { ...streamFacts(claude.state), sessionFile: fileFacts(conversation) };
  record.fileChangedBeforeReset = readFileSync(path.join(repo, 'src', 'cart.ts'), 'utf8').includes('index < items.length');
  if (how === 'resumed') {
    await claude.close();
    claude = await conversation.open(true);
  }
  route.limit = null;
  route.steps.length = 0;
  route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
  const before = claude.state.results.length;
  claude.send(message === 'continue' ? `Continue. ${markers.resume}` : original);
  await claude.resultsAtLeast(before + 1, 60_000);
  await claude.quiet(1_000, 10_000);
  await claude.close();
  record.afterReset = streamFacts(claude.state);
  record.calls = callFacts(route, record.startedAt);
  const mainCalls = record.calls.filter((call) => call.main && call.answer === 'text');
  record.modelRead = mainCalls.at(-1) ?? null;
  record.sessionFile = fileFacts(conversation);
  record.fileChangedAfterReset = readFileSync(path.join(repo, 'src', 'cart.ts'), 'utf8').includes('index < items.length');
  return record;
}

const UUID_CASES = {
  'after-success': { limited: false, reopen: false },
  'after-success-reopened': { limited: false, reopen: true },
  'after-limit': { limited: true, reopen: false },
  'after-limit-reopened': { limited: true, reopen: true },
};

/** Does a second send with the same uuid run? (the host's command ids map to fixed uuids) */
async function runDuplicateUuid(context, name, { limited, reopen }) {
  const tag = `uuid-${name}`;
  const markers = { prompt: marker('PROMPT') };
  const conversation = await makeConversation(context, tag, { markers });
  const { route, plan } = conversation;
  const refused = plan.refuse();
  if (limited) route.limit = () => refused;
  const uuid = randomUUID();
  const record = { name, limited, reopen, startedAt: Date.now(), uuid };
  let claude = await conversation.open();
  const text = `One time only please ${markers.prompt}`;
  claude.send(text, { uuid });
  await claude.resultsAtLeast(1, 30_000);
  await claude.quiet(800, 10_000);
  record.first = streamFacts(claude.state);
  if (reopen) {
    await claude.close();
    claude = await conversation.open(true);
  }
  route.limit = null;
  const before = claude.state.results.length;
  claude.send(text, { uuid });
  await claude.resultsAtLeast(before + 1, 8_000);
  await claude.quiet(1_200, 10_000);
  await claude.close();
  record.second = { ...streamFacts(claude.state), gotResult: claude.state.results.length > before };
  record.calls = callFacts(route, record.startedAt);
  record.sessionFile = fileFacts(conversation);
  return record;
}

// ---------------------------------------------------------------------------
// P15: edge cases

/** The limit arrives while a permission is held: `close` shuts the app on the open permission instead of answering. */
async function runApproval(context, name, { close }) {
  const tag = `approval-${name}`;
  const markers = { prompt: marker('PROMPT'), resume: marker('CONT'), limitText: "You've hit your" };
  const held = gate();
  const answer = gate();
  const seen = { signalAborted: null };
  const canUseTool = async (toolName, toolInput, toolOptions) => {
    if (toolName === 'Edit') {
      held.open();
      toolOptions.signal?.addEventListener('abort', () => { seen.signalAborted = Date.now(); }, { once: true });
      await answer.opened;
    }
    return { behavior: 'allow', updatedInput: toolInput };
  };
  const conversation = await makeConversation(context, tag, { markers, canUseTool });
  const { route, repo, plan } = conversation;
  const refused = plan.refuse();
  route.steps.push(readFile(repo, 'src/cart.ts'), editCart(repo));
  const record = { name, close, startedAt: Date.now() };
  let claude = await conversation.open();
  claude.send(`Please fix src/cart.ts ${markers.prompt}`);
  await Promise.race([held.opened, delay(30_000)]);
  // Another conversation used up the account while this one waits on the person.
  route.limit = () => refused;
  await delay(1_500);
  const heldAt = claude.state.stream.length;
  record.whileHeld = { rateLimits: claude.state.rateLimits.length, results: claude.state.results.length, messagesInHold: claude.state.stream.slice(heldAt).map((entry) => entry.kind) };
  if (close) {
    await claude.close();
    answer.open();
    record.signalAbortedOnClose = seen.signalAborted !== null;
    record.beforeReset = streamFacts(claude.state);
    record.sessionFileWhileClosed = fileFacts(conversation);
    route.limit = null;
    claude = await conversation.open(true);
  } else {
    answer.open();
    await claude.resultsAtLeast(1, 30_000);
    await claude.quiet(1_000, 10_000);
    record.beforeReset = streamFacts(claude.state);
    record.fileChangedAtLimit = readFileSync(path.join(repo, 'src', 'cart.ts'), 'utf8').includes('index < items.length');
    route.limit = null;
  }
  route.steps.length = 0;
  route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
  const before = claude.state.results.length;
  claude.send(`Continue. ${markers.resume}`);
  await claude.resultsAtLeast(before + 1, 60_000);
  await claude.quiet(1_000, 10_000);
  await claude.close();
  record.afterReset = streamFacts(claude.state);
  record.calls = callFacts(route, record.startedAt);
  record.sessionFile = fileFacts(conversation);
  record.fileChanged = readFileSync(path.join(repo, 'src', 'cart.ts'), 'utf8').includes('index < items.length');
  return record;
}

/** A subagent's call is refused (the limit is the account's, so the parent's next call is too). */
async function runChild(context) {
  const tag = 'child';
  const markers = { prompt: marker('PROMPT'), resume: marker('CONT'), child: marker('CHILD'), limitText: "You've hit your" };
  const conversation = await makeConversation(context, tag, { markers });
  const { route, plan } = conversation;
  const refused = plan.refuse();
  route.steps.push(
    { kind: 'tool', name: 'Agent', input: { description: 'Look at the cart', prompt: `Read src/cart.ts and report ${markers.child}`, subagent_type: 'general-purpose' }, text: 'Starting a helper.' },
    (_entry, current) => { current.limit = () => refused; return refused; },
  );
  const record = { startedAt: Date.now() };
  const claude = await conversation.open();
  claude.send(`Use a helper on src/cart.ts ${markers.prompt}`);
  await claude.resultsAtLeast(1, 60_000);
  await claude.quiet(2_000, 15_000);
  record.beforeReset = streamFacts(claude.state);
  route.limit = null;
  route.steps.length = 0;
  route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
  const before = claude.state.results.length;
  claude.send(`Continue. ${markers.resume}`);
  await claude.resultsAtLeast(before + 1, 60_000);
  await claude.quiet(1_000, 10_000);
  await claude.close();
  record.afterReset = streamFacts(claude.state);
  record.calls = callFacts(route, record.startedAt);
  record.sessionFile = fileFacts(conversation);
  return record;
}

/** A message waits in the CLI's queue when the running turn is refused. */
async function runQueued(context, priority) {
  const tag = `queued-${priority}`;
  const markers = { prompt: marker('PROMPT'), steer: marker('STEER'), resume: marker('CONT'), limitText: "You've hit your" };
  const conversation = await makeConversation(context, tag, { markers });
  const { route, repo, plan } = conversation;
  const refused = plan.refuse();
  const record = { priority, startedAt: Date.now() };
  let claude;
  route.steps.push(
    { ...readFile(repo, 'src/cart.ts'), beforeEnd: () => { record.steerUuid = claude.send(`Also check the tests ${markers.steer}`, { priority }); } },
    (_entry, current) => { current.limit = () => refused; return refused; },
  );
  claude = await conversation.open();
  claude.send(`Please look at src/cart.ts ${markers.prompt}`);
  await claude.resultsAtLeast(1, 30_000);
  await claude.quiet(2_000, 15_000);
  record.beforeReset = streamFacts(claude.state);
  route.limit = null;
  route.steps.length = 0;
  route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
  const before = claude.state.results.length;
  claude.send(`Continue. ${markers.resume}`);
  await claude.resultsAtLeast(before + 1, 30_000);
  await claude.quiet(1_500, 10_000);
  await claude.close();
  record.afterReset = streamFacts(claude.state);
  record.calls = callFacts(route, record.startedAt);
  record.sessionFile = fileFacts(conversation);
  return record;
}

/** Two conversations go the moment one reset arrives; the stub admits only one call (a tight account). */
async function runTwo(context) {
  const shared = { limited: true, admits: 1, refusedAfterReset: 0 };
  const plan = limitPlan();
  const refused = plan.refuse();
  const limit = (entry) => {
    if (shared.limited) return refused;
    if (!entry.toolCount) return null;
    if (shared.admits > 0) { shared.admits -= 1; return null; }
    shared.refusedAfterReset += 1;
    return refused;
  };
  const record = { startedAt: Date.now(), conversations: [] };
  const members = [];
  for (const name of ['a', 'b']) {
    const markers = { prompt: marker('PROMPT'), resume: marker('CONT') };
    const conversation = await makeConversation(context, `two-${name}`, { markers, plan, limit });
    const claude = await conversation.open();
    claude.send(`Please look at src/cart.ts ${markers.prompt}`);
    await claude.resultsAtLeast(1, 30_000);
    await claude.quiet(800, 10_000);
    conversation.route.steps.length = 0;
    conversation.route.steps.push({ kind: 'text', text: 'Carried on and finished.' });
    members.push({ name, conversation, claude, markers });
  }
  shared.limited = false;
  const sentAt = Date.now();
  for (const member of members) member.claude.send(`Continue. ${member.markers.resume}`);
  await Promise.all(members.map((member) => member.claude.resultsAtLeast(2, 30_000)));
  await delay(1_500);
  for (const member of members) {
    const { claude, conversation, name } = member;
    await claude.close();
    record.conversations.push({ name, results: claude.state.results, lastRateLimit: claude.state.rateLimits.at(-1) ?? null, calls: callFacts(conversation.route, sentAt) });
  }
  record.refusedAfterReset = shared.refusedAfterReset;
  return record;
}

// ---------------------------------------------------------------------------
// The CLI's own unattended retry mode

const WATCHDOG_ON = { CLAUDE_CODE_RETRY_WATCHDOG: '1' };
const WATCHDOG_CASES = {
  far: { resetIn: 2 * HOUR, watchMs: 65_000 },
  weekly: { resetIn: 2 * HOUR, sevenDayIn: 72 * HOUR, claim: 'seven_day', watchMs: 8_000 },
  'person-plain': { resetIn: 22, person: 'plain' },
  'person-next': { resetIn: 22, person: 'next' },
  'person-now': { resetIn: 22, person: 'now' },
  'person-later': { resetIn: 22, person: 'later' },
  interrupt: { resetIn: 60, interruptAtMs: 4_000 },
  runtime: { launchEnv: {}, runtime: { CLAUDE_CODE_RETRY_WATCHDOG: '1' }, resetIn: 12 },
  'runtime-off': { runtime: { CLAUDE_CODE_RETRY_WATCHDOG: '' }, resetIn: 12 },
  recheck: { resetIn: 60, liftAtMs: 6_000, extraEnv: { CLAUDE_CODE_RETRY_WATCHDOG_USAGE_LIMIT_RECHECK_MS: '3000' } },
  'lift-early': { resetIn: 25, liftAtMs: 6_000 },
  'reset-late': { resetIn: 8, liftAtMs: 18_000 },
  'no-reset': { drop: ['anthropic-ratelimit-unified-reset', 'anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-7d-reset', 'retry-after'], liftAtMs: 12_000 },
  reopen: { resetIn: 20, reopen: true },
  'should-not-retry': { resetIn: 15, more: { 'x-should-retry': 'false' } },
};

async function runWatchdog(context, name, spec) {
  const { resetIn, sevenDayIn, claim, person, interruptAtMs, runtime, liftAtMs, drop, more = {}, reopen, watchMs, launchEnv = WATCHDOG_ON, extraEnv = {} } = spec;
  const tag = `watchdog-${name}`;
  const markers = { prompt: marker('PROMPT'), person: marker('PERSON'), resume: marker('CONT'), limitText: "You've hit your" };
  const plan = limitPlan({ ...(resetIn ? { fiveHourIn: resetIn } : {}), ...(sevenDayIn ? { sevenDayIn } : {}) });
  const startedAt = Date.now();
  const refused = plan.refuse(claim ?? 'five_hour', more, drop ?? []);
  const liftAt = liftAtMs ? startedAt + liftAtMs : resetIn ? plan.fiveHourResetAt * 1_000 : Infinity;
  const conversation = await makeConversation(context, tag, { markers, extraEnv: { ...launchEnv, ...extraEnv }, plan, keepText: Boolean(reopen) });
  const { route, repo } = conversation;
  route.steps.push(readFile(repo, 'src/cart.ts'), (_entry, current) => { current.limit = () => (Date.now() >= liftAt ? null : refused); return current.limit() ?? { kind: 'text', text: 'Done.' }; });
  route.steps.push({ kind: 'text', text: 'Finished after the limit.' }, { kind: 'text', text: 'Second reply.' });
  const record = { name, spec: { resetIn: resetIn ?? null, person: person ?? null, liftAtMs: liftAtMs ?? null, watchMs: watchMs ?? null }, startedAt };
  let claude = await conversation.open();
  try {
    if (runtime) {
      await claude.session.applyFlagSettings({ env: runtime });
      record.runtimeApplied = true;
    }
    claude.send(`Please look at src/cart.ts ${markers.prompt}`);
    if (watchMs) {
      await delay(watchMs);
      record.watched = { calls: route.requests.length, retries: claude.state.retries.length };
    } else {
      if (person) {
        await delay(4_000);
        record.personUuid = claude.send(`One more thing ${markers.person}`, { priority: person === 'plain' ? undefined : person });
      }
      if (interruptAtMs) {
        await delay(interruptAtMs);
        const started = Date.now();
        record.interruptReceipt = await withTimeout(claude.session.interrupt(), 20_000, 'interrupt').catch((error) => ({ failed: errorText(error) }));
        record.interruptMs = Date.now() - started;
        await claude.resultsAtLeast(1, 10_000);
        await claude.quiet(1_000, 5_000);
        record.afterInterrupt = { results: claude.state.results.length };
        route.limit = null;
        claude.send(`Carry on ${markers.resume}`);
        await claude.resultsAtLeast(2, 15_000);
      }
      if (reopen) {
        await delay(3_000);
        await claude.close();
        await delay(Math.max(0, liftAt - Date.now()) + 500);
        claude = await conversation.open(true);
        claude.send(`Continue. ${markers.resume}`);
      }
      await claude.resultsAtLeast(1, 60_000);
      await claude.quiet(2_000, 30_000);
    }
  } catch (error) {
    record.error = errorText(error);
  }
  record.durationMs = Date.now() - startedAt;
  await claude.close();
  if (reopen) record.assistantTextAfterClose = route.requests.at(-1)?.messages.filter((message) => message.role === 'assistant').flatMap((message) => message.blocks.filter((block) => block.type === 'text').map((block) => block.text));
  return { ...record, ...streamFacts(claude.state), calls: callFacts(route, startedAt), sessionFile: fileFacts(conversation) };
}

// ---------------------------------------------------------------------------
// P11: sending into a running turn (stub)

const STEER_WHERE = ['text', 'between', 'tool', 'permission', 'end'];
const PRIORITIES = ['now', 'next', 'later'];

async function runSteer(context, name, { where, priority, replay = false }) {
  const tag = `steer-${name.replaceAll(':', '-')}`;
  const markers = { prompt: marker('PROMPT'), steer: marker('STEER'), interruptNote: 'interrupted by user' };
  const record = { name, where, priority, replay, startedAt: Date.now() };
  let claude;
  const inject = () => {
    if (record.steerUuid) return;
    record.injectedAtMs = Date.now() - claude.state.origin;
    record.steerUuid = claude.send(`Please also keep the total non-negative ${markers.steer}`, { priority: priority === 'plain' ? undefined : priority });
  };
  const held = gate();
  const answer = gate();
  const canUseTool = async (toolName, toolInput, toolOptions) => {
    if (where === 'permission' && toolName === 'Edit') {
      record.permissionHeldAtMs = Date.now() - claude.state.origin;
      toolOptions.signal?.addEventListener('abort', () => { record.permissionSignalAbortedAtMs = Date.now() - claude.state.origin; }, { once: true });
      held.open();
      await answer.opened;
    }
    return { behavior: 'allow', updatedInput: toolInput };
  };
  const endpoint = where === 'tool' ? context.slow.endpoint(tag) : null;
  const conversation = await makeConversation(context, tag, {
    markers, canUseTool, keepText: true,
    extra: {
      ...(replay ? { extraArgs: { 'replay-user-messages': null } } : {}),
      ...(endpoint ? { mcpServers: { [SLOW_SERVER]: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, timeout: 120_000 } }, allowedTools: [SLOW_FULL_NAME] } : {}),
    },
  });
  const { route, repo } = conversation;
  if (where === 'text') {
    route.steps.push({ kind: 'text', text: LONG_TEXT, chunks: 12, chunkMs: 150, onChunk: (index) => { if (index === 3) inject(); } }, { kind: 'text', text: 'Second reply.' }, { kind: 'text', text: 'Third reply.' });
  } else if (where === 'between') {
    route.steps.push({ ...readFile(repo, 'src/cart.ts'), beforeEnd: () => inject() }, readFile(repo, 'src/auth.ts'), { kind: 'text', text: 'All done.' }, { kind: 'text', text: 'Fourth reply.' });
  } else if (where === 'tool') {
    route.steps.push({ kind: 'tool', name: SLOW_FULL_NAME, input: { seconds: 30 }, text: 'Slow step.' }, { kind: 'text', text: 'All done.' }, { kind: 'text', text: 'Third reply.' });
    endpoint.route.onCall = () => {
      inject();
      setTimeout(() => endpoint.route.release.open(), 3_000);
    };
  } else if (where === 'permission') {
    route.steps.push(readFile(repo, 'src/cart.ts'), editCart(repo), { kind: 'text', text: 'All done.' }, { kind: 'text', text: 'Fourth reply.' });
  } else {
    route.steps.push({ kind: 'text', text: 'All done.', beforeEnd: async () => { inject(); await delay(150); } }, { kind: 'text', text: 'Second reply.' });
  }
  claude = await conversation.open();
  claude.send(`Please fix src/cart.ts ${markers.prompt}`);
  if (where === 'permission') {
    await Promise.race([held.opened, delay(30_000)]);
    inject();
    await delay(3_000);
    record.whileHeldStream = claude.state.stream.length;
    answer.open();
  }
  await claude.resultsAtLeast(1, 60_000);
  await claude.quiet(2_500, 30_000);
  await claude.close();
  record.toolCall = endpoint?.route.calls[0] ? { seconds: endpoint.route.calls[0].seconds, ranMs: (endpoint.route.calls[0].endedAt ?? Date.now()) - endpoint.route.calls[0].startedAt } : null;
  record.calls = callFacts(route, record.startedAt);
  record.steerLanded = record.calls.filter((call) => call.main && call.markerCounts.steer).map((call) => ({ index: call.index, count: call.markerCounts.steer, last: call.shape.at(-1) }));
  const carrier = route.requests.find((entry) => entry.main && countMarkers(entry.messages).steer);
  record.steerBlock = carrier ? carrier.messages.flatMap((message) => message.blocks.filter((block) => block.markers?.includes('steer')).map((block) => ({ role: message.role, text: block.text?.replace(markers.steer, '<STEER>') ?? null }))) : null;
  record.fileChanged = readFileSync(path.join(repo, 'src', 'cart.ts'), 'utf8').includes('index < items.length');
  return { ...record, ...streamFacts(claude.state), sessionFile: fileFacts(conversation) };
}

/** Rounds around the end of a turn, offset from the stub's last byte; every message must land exactly once. */
async function runRace(context, priority, offsets = [-40, -10, 0, 5, 15, 30, 60, 120, 250, 500]) {
  const tag = `race-${priority}`;
  const markers = {};
  const conversation = await makeConversation(context, tag, { markers });
  const { route } = conversation;
  const record = { priority, startedAt: Date.now(), rounds: [] };
  const claude = await conversation.open();
  for (const [index, offset] of offsets.entries()) {
    const prompt = marker('P');
    const steer = marker('S');
    markers[`p${index}`] = prompt;
    markers[`s${index}`] = steer;
    const round = { index, offset, resultsBefore: claude.state.results.length, steerUuid: null };
    const inject = () => { round.steerUuid = claude.send(`Steer ${steer}`, { priority: priority === 'plain' ? undefined : priority }); };
    route.steps.push({
      kind: 'text', text: 'Round reply.',
      beforeEnd: async () => {
        if (offset < 0) { inject(); await delay(-offset); } else setTimeout(inject, offset);
      },
    });
    claude.send(`Round ${prompt}`);
    await claude.resultsAtLeast(round.resultsBefore + 1, 30_000);
    await delay(Math.max(0, offset) + 200);
    await claude.quiet(1_200, 20_000);
    round.results = claude.state.results.length - round.resultsBefore;
    round.steerLifecycle = claude.state.lifecycle.filter((entry) => entry.uuid === round.steerUuid).map((entry) => entry.state);
    round.steerInResult = claude.state.results.slice(round.resultsBefore).findIndex((result) => result.userMessageUuids?.includes(round.steerUuid));
    record.rounds.push(round);
  }
  // One last call carries the whole history: each message must be there exactly once.
  route.steps.push({ kind: 'text', text: 'Last reply.' });
  const before = claude.state.results.length;
  claude.send('Last round.');
  await claude.resultsAtLeast(before + 1, 30_000);
  await claude.quiet(1_000, 10_000);
  await claude.close();
  record.calls = callFacts(route, record.startedAt);
  const last = record.calls.filter((call) => call.main).at(-1);
  for (const round of record.rounds) {
    round.promptCount = last?.markerCounts[`p${round.index}`] ?? 0;
    round.steerCount = last?.markerCounts[`s${round.index}`] ?? 0;
  }
  record.neverOrTwice = record.rounds.filter((round) => round.steerCount !== 1 || round.promptCount !== 1).map((round) => round.index);
  record.results = claude.state.results;
  delete record.calls;
  record.sessionFile = { markerLines: conversation.sessionFile().markerLines };
  return record;
}

// ---------------------------------------------------------------------------
// Real provider (P11): telemetry and scenarios

const KEPT_ATTRIBUTES = new Set(['event.name', 'event.timestamp', 'query_source', 'query_source_safe', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'status_code', 'error']);

function startTelemetryReceiver() {
  const events = [];
  const value = (any) => any?.stringValue ?? (any?.intValue !== undefined ? Number(any.intValue) : undefined) ?? any?.doubleValue ?? any?.boolValue;
  const server = http.createServer((request, response) => {
    const tag = (request.url ?? '').split('/').filter(Boolean)[0];
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        let raw = Buffer.concat(chunks);
        if (/gzip/iu.test(String(request.headers['content-encoding'] ?? ''))) raw = gunzipSync(raw);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        for (const resourceLogs of body.resourceLogs ?? []) {
          for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
            for (const record of scopeLogs.logRecords ?? []) {
              const attributes = {};
              for (const attribute of record.attributes ?? []) if (KEPT_ATTRIBUTES.has(attribute.key)) attributes[attribute.key] = value(attribute.value);
              const name = attributes['event.name'] ?? value(record.body);
              if (name === 'api_request' || name === 'claude_code.api_request') events.push({ receivedAt: Date.now(), tag, ...attributes });
            }
          }
        }
      } catch {
        // A malformed export shows up as missing telemetry.
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve({ server, events, port: server.address().port })); });
}

const telemetryEnvironment = (port, tag) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/${tag}/v1/logs`, OTEL_LOGS_EXPORT_INTERVAL: '1000',
});

const requestsOf = (telemetry, tag, origin) => telemetry.events.filter((event) => event.tag === tag).map((event) => {
  const at = Date.parse(event['event.timestamp'] ?? '') || event.receivedAt;
  return { atMs: at - origin, source: event.query_source ?? event.query_source_safe ?? null, model: event.model ?? null, input: number(event.input_tokens), cacheRead: number(event.cache_read_tokens), cacheCreation: number(event.cache_creation_tokens), output: number(event.output_tokens) };
}).sort((left, right) => left.atMs - right.atMs);

const REAL_SCENARIOS = {
  'text-now': { where: 'text', priority: 'now' },
  'text-next': { where: 'text', priority: 'next' },
  'text-later': { where: 'text', priority: 'later' },
  'tool-now': { where: 'tool', priority: 'now' },
  'tool-next': { where: 'tool', priority: 'next' },
  'tool-later': { where: 'tool', priority: 'later' },
  'permission-now': { where: 'permission', priority: 'now' },
  'permission-next': { where: 'permission', priority: 'next' },
  'end-next': { where: 'end', priority: 'next' },
};

const REAL_PROMPTS = {
  text: (markers) => `Without using any tools, write a numbered list of 40 short facts about terminals, one per line. Ticket ${markers.prompt}.`,
  tool: (markers) => `Ticket ${markers.prompt}. Call the ${SLOW_TOOL} tool once with seconds 12. When it returns, reply with exactly: STEP DONE.`,
  permission: (markers) => `Ticket ${markers.prompt}. In src/cart.ts, change index <= items.length to index < items.length with the Edit tool. Change nothing else, run no commands, and reply with exactly: EDIT DONE.`,
  end: (markers) => `Ticket ${markers.prompt}. Without using any tools, reply with exactly: READY.`,
};

/** One steering message into a real turn. The person's answer to a permission is `allow`, for edits in the repo only. */
async function runReal(context, name, spec, pass) {
  const { query, executable, telemetry, slow, options } = context;
  const { where, priority } = spec;
  const tag = `real-p${pass}-${name}`;
  const repo = path.join(options.scratch, tag);
  await createReviewRepo(repo);
  const markers = { prompt: marker('TICKET'), steer: marker('NOTE'), final: marker('FINAL'), acted: 'PINEAPPLE' };
  const sessionId = randomUUID();
  const record = { name, where, priority, pass, startedAt: Date.now() };
  let claude;
  const held = gate();
  const answer = gate();
  const canUseTool = async (toolName, toolInput, toolOptions) => {
    record.approvals = [...(record.approvals ?? []), toolName];
    if (toolName === 'Edit' || toolName === 'MultiEdit') {
      const inside = path.resolve(repo, String(toolInput?.file_path ?? '')).startsWith(path.resolve(repo));
      if (where === 'permission') {
        record.permissionHeldAtMs = Date.now() - claude.state.origin;
        toolOptions.signal?.addEventListener('abort', () => { record.permissionSignalAbortedAtMs = Date.now() - claude.state.origin; }, { once: true });
        held.open();
        await answer.opened;
      }
      return inside ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'Probe: outside the repo.' };
    }
    if (toolName === SLOW_FULL_NAME || toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') return { behavior: 'allow', updatedInput: toolInput };
    return { behavior: 'deny', message: 'Probe: this tool is not available here.' };
  };
  const endpoint = where === 'tool' ? slow.endpoint(tag) : null;
  const sessionOptions = {
    cwd: repo, pathToClaudeCodeExecutable: executable, permissionMode: 'default', allowDangerouslySkipPermissions: false, canUseTool,
    includePartialMessages: true, forwardSubagentText: true, agentProgressSummaries: true, persistSession: true,
    env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, { CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ...telemetryEnvironment(telemetry.port, tag) }),
    settingSources: ['user', 'project', 'local'],
    sessionId,
    ...(options.model ? { model: options.model } : {}),
    ...(endpoint ? { mcpServers: { [SLOW_SERVER]: { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, timeout: 120_000 } }, allowedTools: [SLOW_FULL_NAME] } : {}),
  };
  claude = openSession(query, sessionOptions, sessionId, { markers, mask: true });
  const inject = () => {
    if (record.steerUuid) return;
    record.injectedAtMs = Date.now() - claude.state.origin;
    record.steerUuid = claude.send(`Note ${markers.steer}: when you are finished, also say the word PINEAPPLE once.`, { priority });
  };
  try {
    await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    claude.send(REAL_PROMPTS[where](markers));
    if (where === 'text') {
      await claude.until(() => claude.state.stream.filter((entry) => entry.kind === 'se/block_start' && entry.block === 'text').length > 0, 60_000);
      await delay(1_200);
      inject();
    } else if (where === 'tool') {
      await claude.until(() => endpoint.route.calls.length > 0, 90_000);
      await delay(1_000);
      inject();
    } else if (where === 'permission') {
      await Promise.race([held.opened, delay(90_000)]);
      inject();
      await delay(3_000);
      answer.open();
    } else {
      await claude.until(() => claude.state.stream.some((entry) => entry.kind === 'se/message_stop'), 60_000);
      inject();
    }
    await claude.resultsAtLeast(1, 180_000);
    await claude.quiet(4_000, 120_000);
    // The call after the event, then one ordinary turn for comparison.
    const before = claude.state.results.length;
    claude.send(`Ticket ${markers.final}. Without using any tools, reply with exactly: OK.`);
    await claude.resultsAtLeast(before + 1, 120_000);
    await claude.quiet(2_500, 30_000);
  } catch (error) {
    record.error = errorText(error);
  }
  await claude.close();
  await delay(2_500);
  record.requests = requestsOf(telemetry, tag, claude.state.origin);
  const facts = claudeSessionFacts(claudeSessionFile(path.join(homedir(), '.claude'), sessionId), markers);
  const shaped = { sessionFile: () => facts };
  record.fileChanged = readFileSync(path.join(repo, 'src', 'cart.ts'), 'utf8').includes('index < items.length');
  record.toolCall = endpoint?.route.calls[0] ? { ranMs: (endpoint.route.calls[0].endedAt ?? Date.now()) - endpoint.route.calls[0].startedAt } : null;
  return { ...record, ...streamFacts(claude.state), sessionFile: fileFacts(shaped) };
}

// ---------------------------------------------------------------------------
// History: real limit records on this PC (read-only, shapes and counts)

function readHistory() {
  const projects = path.join(homedir(), '.claude', 'projects');
  const shapes = {};
  const counts = { files: 0, lines: 0, apiErrors: 0, rateLimitErrors: 0, requestErrors: 0 };
  const textForms = {};
  const versions = {};
  const quotaShapes = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.jsonl') || statSync(full).size > 200_000_000) continue;
      counts.files += 1;
      for (const line of readFileSync(full, 'utf8').split(/\r?\n/u)) {
        if (!line.includes('rate_limit') && !line.includes('hit your')) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        counts.lines += 1;
        if (!record.isApiErrorMessage && record.error !== 'rate_limit') continue;
        counts.apiErrors += 1;
        if (record.error === 'rate_limit') counts.rateLimitErrors += 1;
        const key = Object.keys(record).sort().join(',');
        shapes[key] = (shapes[key] ?? 0) + 1;
        const quota = record.quotaLimits;
        const quotaKey = quota ? `${Object.keys(quota).sort().join(',')} | type ${quota.rateLimitType ?? '?'} | apiError ${record.apiError ?? '?'} | params ${Object.keys(record.apiErrorParams ?? {}).sort().join(',')}` : 'none';
        quotaShapes[quotaKey] = (quotaShapes[quotaKey] ?? 0) + 1;
        const text = (record.message?.content ?? []).map((block) => block.text ?? '').join(' ');
        // Times and places go; the sentence's form stays.
        const form = text.replace(/\d{1,2}(:\d{2})?\s*(am|pm)/giu, '<time>').replace(/\([A-Za-z_]+\/[A-Za-z_]+\)/gu, '(<zone>)').replace(/\b[A-Z][a-z]{2} \d{1,2}\b/gu, '<date>').slice(0, 100);
        textForms[`${record.error ?? 'none'} | ${record.apiErrorStatus ?? '?'} | ${form}`] = (textForms[`${record.error ?? 'none'} | ${record.apiErrorStatus ?? '?'} | ${form}`] ?? 0) + 1;
        versions[record.version ?? 'unknown'] = (versions[record.version ?? 'unknown'] ?? 0) + 1;
      }
    }
  };
  walk(projects);
  return { counts, shapes, quotaShapes, textForms, versions };
}

// ---------------------------------------------------------------------------
// Verdicts: what each scenario measured, and the claims the runs support

function scenarioVerdict(key, scenario) {
  if (scenario.error && !scenario.results) return { error: scenario.error };
  const group = key.split(':')[0];
  const results = scenario.afterReset?.results ?? scenario.results ?? [];
  const brief = (result) => ({ subtype: result.subtype, isError: result.isError, apiError: result.apiError, status: result.apiErrorStatus, terminal: result.terminalReason, turns: result.numTurns, uuids: result.userMessageUuids?.length ?? 0 });
  if (group === 'shape' || group === 'watchdog') {
    const rejected = scenario.rateLimits?.findLast?.((entry) => entry.info.status === 'rejected');
    return {
      results: results.map(brief), rejectedEvent: Boolean(rejected), hasResetsAt: typeof rejected?.info.resetsAt === 'number', windows: Object.keys(rejected?.info.unifiedWindows ?? {}),
      retries: scenario.retries?.length ?? 0, firstRetryDelayMs: scenario.retries?.[0]?.delayMs ?? null, mainCalls: scenario.calls?.filter((call) => call.main !== false).length ?? 0, finishedByItself: results.some((result) => result.isError === false),
    };
  }
  if (group === 'resume' || group === 'early') {
    return { promptRead: scenario.modelRead?.markerCounts?.prompt ?? 0, continueRead: scenario.modelRead?.markerCounts?.resume ?? 0, earlyRead: Object.entries(scenario.modelRead?.markerCounts ?? {}).filter(([name]) => name.startsWith('early')).length, limitTextRead: scenario.modelRead?.markerCounts?.limitText ?? 0, workKept: scenario.fileChangedBeforeReset === scenario.fileChangedAfterReset, finished: results.at(-1)?.isError === false };
  }
  if (group === 'uuid') return { secondSendRanACall: (scenario.calls ?? []).filter((call) => call.answer === 'text').length > (scenario.limited ? 0 : 1), secondSendGotAResult: scenario.second?.gotResult ?? null, lifecycleAfterSecond: scenario.second?.lifecycle?.map((entry) => entry.state).at(-1) ?? null };
  if (group === 'steer' || group === 'real') {
    return { results: (scenario.results ?? []).map(brief), landedOnCalls: scenario.steerLanded?.map((entry) => entry.index) ?? null, streamAborted: scenario.calls?.some((call) => call.clientAborted) ?? null, toolRanMs: scenario.toolCall?.ranMs ?? null, permissionAborted: scenario.permissionSignalAbortedAtMs !== undefined, fileChanged: scenario.fileChanged ?? null, steerLifecycle: scenario.lifecycle?.filter((entry) => entry.uuid === scenario.steerUuid).map((entry) => entry.state) ?? null };
  }
  if (group === 'race') return { rounds: scenario.rounds?.length ?? 0, neverOrTwice: scenario.neverOrTwice ?? null };
  return { results: results.map(brief), fileChanged: scenario.fileChanged ?? null, refusedAfterReset: scenario.refusedAfterReset ?? null };
}

/** Across a report: each claim with the scenarios behind it. */
function claims(verdicts) {
  const pick = (prefix) => Object.entries(verdicts).filter(([key]) => key.startsWith(prefix));
  const resume = pick('resume:');
  const check = (entries, test) => (entries.length ? { holds: entries.every(([, verdict]) => test(verdict)), runs: entries.length } : null);
  return {
    continueReadsThePromptOnce: check(resume.filter(([key]) => key.includes('-continue')), (verdict) => verdict.promptRead === 1 && verdict.continueRead === 1),
    resendingReadsThePromptTwice: check(resume.filter(([key]) => key.includes('-original')), (verdict) => verdict.promptRead === 2),
    partialWorkKept: check(resume, (verdict) => verdict.workKept && verdict.finished),
    aSecondSendWithTheSameUuidIsDropped: check(pick('uuid:'), (verdict) => !verdict.secondSendGotAResult),
    raceEveryMessageOnce: check(pick('race:'), (verdict) => verdict.neverOrTwice?.length === 0),
    nowInterrupts: check(pick('steer:').filter(([key]) => key.includes(':now')), (verdict) => verdict.results.length === 2),
    nextFoldsAtToolBoundary: check(pick('steer:').filter(([key]) => /steer:(between|tool|permission):next/u.test(key)), (verdict) => verdict.results.length === 1 && verdict.results[0].uuids === 2),
  };
}

// ---------------------------------------------------------------------------

function expandSteps(only) {
  const out = [];
  for (const step of only) {
    if (step === 'shape') out.push(...Object.keys(SHAPES).map((name) => `shape:${name}`));
    else if (step === 'resume') out.push(...Object.keys(RESUME).map((name) => `resume:${name}`));
    else if (step === 'uuid') out.push(...Object.keys(UUID_CASES).map((name) => `uuid:${name}`));
    else if (step === 'approval') out.push('approval:answered', 'approval:closed');
    else if (step === 'watchdog') out.push(...Object.keys(WATCHDOG_CASES).map((name) => `watchdog:${name}`));
    else if (step === 'early') out.push('early:1', 'early:3');
    else if (step === 'queued') out.push(...[...PRIORITIES, 'plain'].map((priority) => `queued:${priority}`));
    else if (step === 'steer') for (const where of STEER_WHERE) for (const priority of PRIORITIES) out.push(`steer:${where}:${priority}`);
    else if (step === 'race') out.push(...PRIORITIES.map((priority) => `race:${priority}`), 'race:plain');
    else if (step === 'real') out.push(...Object.keys(REAL_SCENARIOS).map((name) => `real:${name}`));
    else out.push(step);
  }
  return out;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  options.scratch = path.join(options.scratch, `claude-${stamp}`);
  await fs.mkdir(options.scratch, { recursive: true });
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const executable = options.claudeExecutable ?? resolveClaudeExecutable();
  const stub = await startAnthropicStub({ dummies: [DUMMY_API_KEY, DUMMY_OAUTH_TOKEN] });
  const proxy = await startDenyProxy();
  const slow = await startSlowToolServer();
  const telemetry = await startTelemetryReceiver();
  const file = path.join(options.out, `claude-${stamp}.json`);
  const report = {
    probe: 'claude-long-run', at: new Date().toISOString(),
    facts: {
      claudeSdk: JSON.parse(readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version,
      only: options.only, repeat: options.repeat, model: options.model ?? 'cli default',
    },
    scenarios: {},
  };
  const context = { query, executable, stub, proxy, slow, telemetry, options };
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
        if (group === 'shape') await run(key, () => runShape(uniqueContext, rest[0], SHAPES[rest[0]]));
        else if (group === 'resume') await run(key, () => runResume(uniqueContext, rest[0], RESUME[rest[0]]));
        else if (group === 'early') await run(key, () => runResume(uniqueContext, `early-${rest[0]}`, { position: 'later', how: 'same', message: 'continue', early: Number(rest[0]) }));
        else if (group === 'uuid') await run(key, () => runDuplicateUuid(uniqueContext, rest[0], UUID_CASES[rest[0]]));
        else if (group === 'approval') await run(key, () => runApproval(uniqueContext, rest[0], { close: rest[0] === 'closed' }));
        else if (group === 'watchdog') await run(key, () => runWatchdog(uniqueContext, rest[0], WATCHDOG_CASES[rest[0]]));
        else if (group === 'idle') await run(key, () => runIdle(uniqueContext));
        else if (group === 'child') await run(key, () => runChild(uniqueContext));
        else if (group === 'queued') await run(key, () => runQueued(uniqueContext, rest[0]));
        else if (group === 'two') await run(key, () => runTwo(uniqueContext));
        else if (group === 'steer') await run(key, () => runSteer(uniqueContext, rest.join(':'), { where: rest[0], priority: rest[1], replay: rest[2] === 'replay' }));
        else if (group === 'race') await run(key, () => runRace(uniqueContext, rest[0]));
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
    telemetry.server.close();
  }
  console.log(JSON.stringify({ file }));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
