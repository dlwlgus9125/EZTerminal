#!/usr/bin/env node
/**
 * Real-provider probe for bundle 2 "turn wrap-up" on Claude: next-prompt suggestions (P1), recap by
 * askSideQuestion (P3), a proposal-only suggest_task MCP tool (P4), a recap while a turn is stopped on
 * an open request (P5), the live suggestion switch (P7), suggestions after resume (P8) and late
 * suggestions (P9).
 *
 *   node scripts/probe-claude-turn-wrap-up.mjs --scratch <dir> [--repeat 2] [--start-pass 1]
 *        [--only A,B,BAL,D,P5,P7,P7env,P7clear,P7blank,P7envoff,P8,P9,P9ctrl]
 *        [--claude-executable <path>] [--post-wait-ms 60000]
 *
 * Installed CLI; session options mirror startSession in src/main/claude-provider-adapter.ts at the
 * standard preset (permissionMode 'default', settingSources user/project/local). Per pass, each
 * conversation gets a fresh seeded repo (scripts/review-probe-repo.mjs: bugs in cart.ts, auth.ts,
 * format.ts, discount.ts) below --scratch, and every seed starts with a new nonce:
 *   A    P1 + P3. Options + promptSuggestions. Seed (~40k tokens), T1 fix src/format.ts (edits, ends
 *        by asking the person), recap R1, T2 English, T3 Korean, T4 Korean in plan mode, T5 Korean
 *        back in default mode, recap R2. After each turn the probe waits (up to --post-wait-ms) for
 *        `prompt_suggestion` before sending the next message.
 *   B    P4. A's options + a suggest_task HTTP MCP server named like the product's session endpoint,
 *        as the product configures it (no alwaysLoad: deferred behind tool search). Seed, T1 fix only
 *        src/cart.ts, T2 one-line summary.
 *   BAL  B with alwaysLoad: true (the tool in the prompt from turn 1).
 *   D    approvals: fresh sessions (no seed) told to call suggest_task once: default mode, plan mode,
 *        default + the server's per-tool permission_policy 'always_allow' (bare and full tool name),
 *        default + allowedTools, and (meta) default + allowedTools with the tool's own
 *        _meta['anthropic/alwaysLoad'] instead of the server-level alwaysLoad. --variants picks D variants.
 *   P5   mid-turn recap: seed, a warm-up turn, then two turns (order swapped on even passes) that stop on
 *        a request the probe leaves unanswered: a permission (canUseTool held on the Edit of src/cart.ts)
 *        and an AskUserQuestion. While held: askSideQuestion with the recap, then a question for facts
 *        planted at each level (the turn's message, its text, a file it read, the open request). Then the
 *        request is answered and the turn must finish; a last turn checks the cache, and the session file
 *        is read for duplicates and leaked side questions.
 *   P7   live toggle: applyFlagSettings({ promptSuggestionEnabled }) between turns, starting from
 *        promptSuggestions true (P7on: on, off, on) and false (P7off: off, on, off). P7env: as P7on, through
 *        applyFlagSettings({ env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION } }), the variable the SDK says wins.
 *        P7clear: as P7env, but back on with applyFlagSettings({ env: null }) (setting it to true would also
 *        override the CLI's near-limit suppression). P7blank: back on with the variable set to ''.
 *        P7envoff: as P7off, through the variable.
 *   P8   after resume: a session with promptSuggestions, closed, then `resume` with the option passed
 *        again (P8flag) or left out (P8noflag).
 *   P9   late arrival: from R1 on the next message goes soon after `result` (1 s and 0.25 s in turn, swapped
 *        on odd passes after the first: suggestions took 0.8-7.9 s), before that turn's suggestion. Each
 *        turn ends by asking the person something, so a suggestion is due. Every prompt_suggestion and
 *        suggestion request is placed on the turn timeline afterwards. P9ctrl: the same turns, unhurried.
 * canUseTool plays the person: edits inside the repo and suggest_task are allowed (and recorded), the
 * shell and ExitPlanMode are denied. Token facts come from Claude Code's OpenTelemetry api_request
 * events (one OTLP/HTTP JSON endpoint path per session, attributed by time window and query_source).
 * Report: artifacts/wrap-up-probe/claude-<time>.json, rewritten after every conversation. Suggestion,
 * recap and suggest_task texts are kept (they are about the scratch repo); no account attributes.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createReviewRepo } from './review-probe-repo.mjs';
import {
  CLAUDE_ENVIRONMENT_VARIABLES, PROMPTS, RECAP_INSTRUCTION, SUGGEST_SERVER, SUGGEST_TOOL,
  changedFiles, delay, errorText, fileHashes, log, nonceWord, number, providerEnvironment, ratio, recapFlags, seedText,
  recapStoppedNote, startSuggestionServer, visibilityFlags, visibilityQuestion, withTimeout, writeReport,
} from './wrap-up-probe-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 420_000;
const SUGGEST_FULL_NAME = `mcp__${SUGGEST_SERVER}__${SUGGEST_TOOL}`;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const KEPT_ATTRIBUTES = new Set([
  'event.name', 'event.timestamp', 'query_source', 'query_source_safe', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'speed', 'effort', 'agent_id', 'error', 'status_code',
]);
const STEPS = ['A', 'B', 'BAL', 'D', 'P5', 'P7', 'P7env', 'P7clear', 'P7blank', 'P7envoff', 'P8', 'P9', 'P9ctrl'];
const DEFAULT_STEPS = ['A', 'B', 'BAL', 'D'];
const MID_TURN_ABORT_MS = 60_000;
const D_VARIANTS = {
  default: { settings: "permissionMode 'default' (standard preset)", permissionMode: 'default' },
  plan: { settings: "permissionMode 'plan' (plan preset)", permissionMode: 'plan' },
  policy: { settings: "default + server tools [{ name: 'suggest_task', permission_policy: 'always_allow' }]", permissionMode: 'default', policy: SUGGEST_TOOL },
  policyFull: { settings: `default + server tools [{ name: '${SUGGEST_FULL_NAME}', permission_policy: 'always_allow' }]`, permissionMode: 'default', policy: SUGGEST_FULL_NAME },
  allowedTools: { settings: `default + allowedTools ['${SUGGEST_FULL_NAME}']`, permissionMode: 'default', allowedTools: true },
  meta: {
    settings: `default + allowedTools ['${SUGGEST_FULL_NAME}'] + the tool's own _meta['anthropic/alwaysLoad'] (server alwaysLoad off)`,
    permissionMode: 'default', allowedTools: true, alwaysLoadMeta: true,
  },
};

const DEFINITIONS = {
  firstMain: "Earliest api_request ending inside the turn window with query_source 'sdk' (the main loop).",
  contextAtEnd: "The turn's last 'sdk' request: input + cache_read + cache_creation.",
  crossTurnRatio: "firstMain.cache_read / previous turn's contextAtEnd: how much of the conversation the next turn read from cache.",
  postResult: "Requests ending after the turn's result and before the next message was sent (suggestion window).",
  suggestionRatio: "Suggestion request cache_read / the same turn's contextAtEnd (bundle-1 bar: >= 0.8).",
  recapRatio: "side_question request cache_read / contextAtEnd of the turn before the recap (bundle-1 bar: >= 0.8).",
  midTurnRatio: "Mid-turn side_question request cache_read / the size of the last 'sdk' request that ended before it (the in-progress turn's context).",
};

function parseArguments(argv) {
  const options = { repeat: 2, startPass: 1, only: [...DEFAULT_STEPS], postWaitMs: 60_000, out: path.join(root, 'artifacts', 'wrap-up-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--start-pass') options.startPass = Number(value);
    else if (flag === '--only') options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--post-wait-ms') options.postWaitMs = Number(value);
    else if (flag === '--claude-executable') options.claudeExecutable = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else if (flag === '--variants') options.variants = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer.');
  if (options.only.some((step) => !STEPS.includes(step))) throw new Error(`--only takes ${STEPS.join(',')}.`);
  if (options.variants?.some((name) => !(name in D_VARIANTS))) throw new Error(`--variants takes ${Object.keys(D_VARIANTS).join(',')}.`);
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
// Telemetry

/** OTLP/HTTP JSON logs receiver: keeps only api_request token facts, tagged by endpoint path. */
function startTelemetryReceiver() {
  const events = [];
  const errors = [];
  const names = {};
  const value = (any) => any?.stringValue ?? (any?.intValue !== undefined ? Number(any.intValue) : undefined)
    ?? any?.doubleValue ?? any?.boolValue;
  const server = http.createServer((request, response) => {
    const pathTag = (request.url ?? '').split('/').filter(Boolean)[0];
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
              for (const attribute of record.attributes ?? []) {
                if (KEPT_ATTRIBUTES.has(attribute.key)) attributes[attribute.key] = value(attribute.value);
              }
              const name = attributes['event.name'] ?? value(record.body);
              names[name] = (names[name] ?? 0) + 1;
              if (name === 'api_request' || name === 'claude_code.api_request') {
                events.push({ receivedAt: Date.now(), tag: pathTag && pathTag !== 'v1' ? pathTag : null, ...attributes });
              } else if (name === 'api_error' || name === 'claude_code.api_error') {
                errors.push({ receivedAt: Date.now(), tag: pathTag && pathTag !== 'v1' ? pathTag : null, ...attributes });
              }
            }
          }
        }
      } catch {
        // A malformed export is reported as missing telemetry.
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, events, errors, names, port: server.address().port }));
  });
}

const telemetryEnvironment = (port, tag) => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/${tag}/v1/logs`,
  OTEL_LOGS_EXPORT_INTERVAL: '1000',
});

function requestFacts(event, origin) {
  const at = Date.parse(event['event.timestamp'] ?? '') || event.receivedAt;
  return {
    at, atMs: at - origin, source: event.query_source ?? event.query_source_safe ?? null, model: event.model ?? null,
    input: number(event.input_tokens), cacheRead: number(event.cache_read_tokens), cacheCreation: number(event.cache_creation_tokens),
    output: number(event.output_tokens), durationMs: number(event.duration_ms), agent: event.agent_id ?? null,
  };
}

const total = (request) => (request ? (request.input ?? 0) + (request.cacheRead ?? 0) + (request.cacheCreation ?? 0) : null);
const brief = (request) => (request ? { source: request.source, input: request.input, cacheRead: request.cacheRead, cacheCreation: request.cacheCreation, output: request.output, durationMs: request.durationMs } : null);

/**
 * Attaches a session's api_requests to its windows (turn, post-result, recap) and derives the cache
 * numbers. A request belongs to the window holding its end time; side questions only to recaps.
 */
function attribute(conversation, events, errors = []) {
  const requests = events.filter((event) => event.tag === conversation.tag).map((event) => requestFacts(event, conversation.origin))
    .sort((left, right) => left.at - right.at);
  conversation.telemetryErrors = errors.filter((event) => event.tag === conversation.tag).map((event) => ({
    atMs: (Date.parse(event['event.timestamp'] ?? '') || event.receivedAt) - conversation.origin,
    source: event.query_source ?? event.query_source_safe ?? null, statusCode: event.status_code ?? null, error: String(event.error ?? '').slice(0, 160),
  }));
  if (conversation.keepRequests) conversation.requests = requests.map((request) => ({ at: request.at, atMs: request.atMs, ...brief(request) }));
  // event.timestamp is when a request ended: the main loop's last request ends before `result` is sent.
  const windows = [];
  for (const turn of conversation.turns) {
    windows.push({ kind: 'turn', name: turn.name, start: turn.startedAt - 250, end: turn.resultAt + 250 });
    windows.push({ kind: 'post', name: turn.name, start: turn.resultAt + 250, end: turn.postEndAt + 1_500 });
  }
  for (const recap of conversation.recaps) windows.push({ kind: 'recap', name: recap.name, start: recap.startedAt - 250, end: recap.endedAt + 1_500 });
  const owner = (request) => {
    const side = String(request.source ?? '').includes('side');
    return windows.find((window) => (side ? window.kind === 'recap' : window.kind !== 'recap')
      && request.at >= window.start && request.at <= window.end) ?? null;
  };
  const byWindow = new Map();
  const unattributed = [];
  for (const request of requests) {
    const window = owner(request);
    if (!window) { unattributed.push(brief(request)); continue; }
    const key = `${window.kind}:${window.name}`;
    byWindow.set(key, [...(byWindow.get(key) ?? []), request]);
  }
  let previousContext = null;
  for (const turn of conversation.turns) {
    const mine = byWindow.get(`turn:${turn.name}`) ?? [];
    const main = mine.filter((request) => request.source === 'sdk');
    const firstMain = main[0] ?? mine.find((request) => request.source !== 'generate_session_title') ?? null;
    const lastMain = main.at(-1) ?? null;
    const post = byWindow.get(`post:${turn.name}`) ?? [];
    const suggestion = post.find((request) => /suggest/iu.test(String(request.source ?? ''))) ?? null;
    turn.telemetry = {
      requests: mine.length,
      sources: [...new Set(mine.map((request) => request.source))],
      firstMain: brief(firstMain),
      contextAtEnd: total(lastMain),
      crossTurnRatio: ratio(firstMain?.cacheRead, previousContext),
      postResult: post.map((request) => ({ ...brief(request), endMsAfterResult: request.at - turn.resultAt })),
      suggestionRequest: brief(suggestion),
      suggestionRatio: ratio(suggestion?.cacheRead, total(lastMain)),
    };
    if (lastMain) previousContext = total(lastMain);
  }
  for (const recap of conversation.recaps) {
    const mine = byWindow.get(`recap:${recap.name}`) ?? [];
    const before = conversation.turns.filter((turn) => turn.resultAt <= recap.startedAt).at(-1);
    const first = mine[0] ?? null;
    const lastMainBefore = requests.filter((request) => request.source === 'sdk' && request.at <= recap.startedAt).at(-1) ?? null;
    recap.telemetry = {
      requests: mine.length,
      first: first ? { ...brief(first), model: first.model } : null,
      contextBefore: before?.telemetry?.contextAtEnd ?? null,
      recapRatio: ratio(first?.cacheRead, before?.telemetry?.contextAtEnd),
      contextJustBefore: total(lastMainBefore),
      midTurnRatio: ratio(first?.cacheRead, total(lastMainBefore)),
    };
  }
  conversation.unattributedRequests = unattributed;
}

// ---------------------------------------------------------------------------
// Sessions

function insideRepo(file, repo) {
  if (typeof file !== 'string' || !file) return false;
  const relative = path.relative(path.resolve(repo), path.resolve(repo, file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The person, as a policy: allows edits inside the repo and suggest_task; records every request. */
function personPolicy(repo, approvals) {
  return async (toolName, toolInput, toolOptions) => {
    const file = toolInput?.file_path ?? toolInput?.notebook_path ?? null;
    const entry = { at: Date.now(), toolName, file: insideRepo(file, repo) ? path.relative(repo, path.resolve(repo, file)).replace(/\\/gu, '/') : file ? '(outside repo)' : null, agent: toolOptions?.agentID ?? null };
    let result;
    if (toolName === SUGGEST_FULL_NAME) result = { behavior: 'allow', updatedInput: toolInput };
    else if (EDIT_TOOLS.has(toolName) && insideRepo(file, repo)) result = { behavior: 'allow', updatedInput: toolInput };
    else if (toolName === 'ExitPlanMode') result = { behavior: 'deny', message: 'Probe: stay in plan mode and answer in text.' };
    else if (toolName === 'Bash' || toolName === 'PowerShell') result = { behavior: 'deny', message: 'Probe: no shell in this conversation; read and edit files directly.' };
    else result = { behavior: 'deny', message: 'Probe: this tool is not available here.' };
    entry.decision = result.behavior;
    approvals.push(entry);
    return { ...result, toolUseID: toolOptions?.toolUseID };
  };
}

/** The person walks away: the next tool request matching `arm` stays unanswered until `release`. */
function createHold() {
  let armed = null;
  let current = null;
  let waiter = null;
  return {
    arm(match) { armed = match; current = null; },
    take(toolName, toolInput) {
      if (!armed?.(toolName, toolInput)) return null;
      armed = null;
      let release;
      const answered = new Promise((resolve) => { release = resolve; });
      current = { at: Date.now(), toolName, toolInput, release, answered };
      waiter?.(current);
      waiter = null;
      return current;
    },
    wait: () => (current ? Promise.resolve(current) : new Promise((resolve) => { waiter = resolve; })),
  };
}

/** personPolicy, except that a held request answers when released (`release(null)`: as personPolicy would). */
function holdingPolicy(repo, approvals, hold) {
  const person = personPolicy(repo, approvals);
  return async (toolName, toolInput, toolOptions) => {
    const held = hold.take(toolName, toolInput);
    if (!held) return person(toolName, toolInput, toolOptions);
    approvals.push({ at: held.at, toolName, held: true, agent: toolOptions?.agentID ?? null });
    const answer = await held.answered;
    return answer ? { ...answer, toolUseID: toolOptions?.toolUseID } : person(toolName, toolInput, toolOptions);
  };
}

function openClaude(query, options, sessionId) {
  const input = new AsyncQueue();
  const session = query({ prompt: input, options });
  const state = { init: null, results: [], calls: [], messages: [], suggestions: [], rateLimits: [], toolUses: [], assistantUuids: [], streamError: null };
  const seenCalls = new Set();
  const seenTools = new Set();
  let checks = [];
  const notify = () => { for (const check of [...checks]) check(); };
  const waitUntil = (predicate, ms) => new Promise((resolve) => {
    if (predicate()) { resolve(true); return; }
    let timer;
    const done = (value) => { clearTimeout(timer); checks = checks.filter((entry) => entry !== check); resolve(value); };
    const check = () => { if (predicate()) done(true); };
    timer = setTimeout(() => done(false), ms);
    checks.push(check);
  });
  const iterate = (async () => {
    for await (const message of session) {
      const at = Date.now();
      const kind = message.type === 'system' ? `system/${message.subtype}` : message.type;
      if (message.type !== 'stream_event') state.messages.push({ at, kind, ...(message.state ? { state: message.state } : {}) });
      if (kind === 'system/init') {
        state.init = {
          at, model: message.model ?? null, version: message.claude_code_version ?? null, permissionMode: message.permissionMode ?? null,
          toolCount: message.tools?.length ?? null, hasSuggestTool: (message.tools ?? []).includes(SUGGEST_FULL_NAME),
          mcpServers: (message.mcp_servers ?? []).map((server) => ({ ours: server.name === SUGGEST_SERVER, status: server.status })),
        };
      } else if (message.type === 'prompt_suggestion') {
        state.suggestions.push({ at, text: String(message.suggestion ?? ''), uuid: message.uuid ?? null, sessionId: message.session_id ?? null, keys: Object.keys(message) });
      } else if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info ?? {};
        state.rateLimits.push({ at, status: info.status ?? null, type: info.rateLimitType ?? null, utilization: info.utilization ?? null, surpassedThreshold: info.surpassedThreshold ?? null, usingOverage: info.isUsingOverage ?? null });
      } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
        if (message.uuid) state.assistantUuids.push(message.uuid);
        const id = message.message?.id ?? `call-${state.calls.length}`;
        if (message.message?.usage && !seenCalls.has(id)) {
          seenCalls.add(id);
          const usage = message.message.usage;
          state.calls.push({ at, input: number(usage.input_tokens), cacheRead: number(usage.cache_read_input_tokens), cacheCreation: number(usage.cache_creation_input_tokens) });
        }
        for (const block of message.message?.content ?? []) {
          if (block?.type !== 'tool_use' || seenTools.has(block.id)) continue;
          seenTools.add(block.id);
          const toolInput = block.input ?? {};
          state.toolUses.push({ at, name: block.name, file: toolInput.file_path ?? toolInput.path ?? null, query: typeof toolInput.query === 'string' ? toolInput.query.slice(0, 120) : null });
        }
      } else if (message.type === 'result') {
        state.results.push({
          at, uuid: message.uuid ?? null, subtype: message.subtype ?? null, isError: message.is_error ?? null, numTurns: message.num_turns ?? null,
          stopReason: message.stop_reason ?? null, terminalReason: message.terminal_reason ?? null,
          permissionDenials: (message.permission_denials ?? []).map((denial) => denial.tool_name),
          text: typeof message.result === 'string' ? message.result.slice(0, 1_500) : null,
        });
      }
      notify();
    }
  })();
  iterate.catch((error) => { state.streamError = errorText(error); notify(); });

  const turn = async (name, text, { postWaitMs, deadlineMs = TURN_DEADLINE_MS } = {}) => {
    const before = { results: state.results.length, suggestions: state.suggestions.length, messages: state.messages.length, tools: state.toolUses.length, calls: state.calls.length };
    const startedAt = Date.now();
    log(`claude ${name}`);
    const userUuid = randomUUID();
    input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: userUuid, session_id: sessionId });
    await waitUntil(() => state.results.length > before.results || state.streamError, deadlineMs);
    const result = state.results[before.results] ?? null;
    const resultAt = result?.at ?? Date.now();
    if (result) await waitUntil(() => state.suggestions.length > before.suggestions || state.streamError, postWaitMs);
    const suggestion = state.suggestions[before.suggestions] ?? null;
    if (suggestion && postWaitMs > 0) await delay(3_000); // lets session_state_changed and the telemetry export land
    const postEndAt = Date.now();
    return {
      name, userUuid, startedAt, resultAt, postEndAt, finished: Boolean(result), durationMs: resultAt - startedAt,
      result, streamError: state.streamError,
      suggestion: suggestion ? { text: suggestion.text, msAfterResult: suggestion.at - resultAt } : null,
      waitedMsForSuggestion: suggestion ? null : postEndAt - resultAt,
      postResultSequence: state.messages.slice(before.messages).filter((entry) => entry.at >= resultAt)
        .map((entry) => `${entry.kind}${entry.state ? `:${entry.state}` : ''}@${entry.at - resultAt}`),
      toolUses: state.toolUses.slice(before.tools).map(({ name: tool, file, query: search }) => ({ name: tool, ...(file ? { file } : {}), ...(search ? { query: search } : {}) })),
      sdkCalls: state.calls.slice(before.calls).length,
    };
  };

  const ask = async (name, question, abortMs) => {
    const startedAt = Date.now();
    log(`claude ${name}`);
    try {
      const answer = await session.askSideQuestion(question, { signal: AbortSignal.timeout(abortMs) });
      return { name, startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt, ok: true, text: answer?.response ?? null, synthetic: answer?.synthetic ?? null, refusalFallback: Boolean(answer?.refusalFallback) };
    } catch (error) {
      return { name, startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt, ok: false, error: errorText(error) };
    }
  };
  const recap = (name) => ask(name, RECAP_INSTRUCTION, 180_000);

  const close = async () => {
    input.close();
    session.close();
    await Promise.race([iterate.catch(() => undefined), delay(5_000)]);
  };
  return { session, state, turn, ask, recap, close };
}

/** Our MCP server's tools as the session sees them: in context (isLoaded) or deferred behind tool search. */
async function suggestToolFacts(session) {
  const facts = {};
  try {
    const usage = await withTimeout(session.getContextUsage({ detail: 'summary' }), 20_000, 'getContextUsage');
    const tools = usage?.mcpTools ?? [];
    facts.suggestTool = tools.filter((tool) => tool.serverName === SUGGEST_SERVER).map((tool) => ({ name: tool.name, isLoaded: tool.isLoaded ?? null, tokens: tool.tokens }));
    facts.mcpToolsTotal = tools.length;
    facts.mcpToolsLoaded = tools.filter((tool) => tool.isLoaded !== false).length;
    facts.deferredCategory = (usage?.categories ?? []).filter((category) => category.isDeferred).map((category) => ({ name: category.name, tokens: category.tokens }));
  } catch (error) {
    facts.contextError = errorText(error);
  }
  try {
    const servers = await withTimeout(session.mcpServerStatus(), 20_000, 'mcpServerStatus');
    const ours = servers.find((server) => server.name === SUGGEST_SERVER);
    facts.serverStatus = ours ? { status: ours.status, tools: ours.tools?.length ?? null } : null;
  } catch (error) {
    facts.statusError = errorText(error);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Conversations

async function runConversation(context, pass, name) {
  const { query, executable, telemetry, suggestions, options } = context;
  const tag = `p${pass}-${name}`;
  const repo = path.join(options.scratch, `claude-${tag}`);
  await createReviewRepo(repo);
  const sessionId = randomUUID();
  const approvals = [];
  const withTool = name === 'B' || name === 'BAL';
  const endpoint = withTool ? suggestions.endpoint(tag) : null;
  const sessionOptions = {
    cwd: repo,
    pathToClaudeCodeExecutable: executable,
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    canUseTool: personPolicy(repo, approvals),
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    persistSession: true,
    promptSuggestions: true,
    env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      ...telemetryEnvironment(telemetry.port, tag),
    }),
    settingSources: ['user', 'project', 'local'],
    sessionId,
    ...(endpoint ? {
      mcpServers: {
        [SUGGEST_SERVER]: {
          type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, timeout: 300_000,
          ...(name === 'BAL' ? { alwaysLoad: true } : {}),
        },
      },
    } : {}),
  };
  const conversation = {
    tag, name, pass, origin: Date.now(),
    settings: name === 'A' ? 'product options + promptSuggestions'
      : name === 'B' ? 'A + suggest_task HTTP MCP server (product config, no alwaysLoad)'
        : 'B + alwaysLoad: true',
    turns: [], recaps: [], approvals,
  };
  const claude = openClaude(query, sessionOptions, sessionId);
  const run = async (turnName, text, postWaitMs = options.postWaitMs) => {
    const turn = await claude.turn(`${tag} ${turnName}`, text, { postWaitMs });
    turn.name = turnName;
    conversation.turns.push(turn);
    if (!turn.finished) throw new Error(`${turnName} did not finish: ${turn.streamError ?? 'deadline'}`);
    return turn;
  };
  try {
    const initialization = await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    conversation.init = { ...claude.state.init, version: claude.state.init?.version ?? initialization?.claude_code_version ?? null };
    if (withTool) conversation.toolFactsAtStart = await suggestToolFacts(claude.session);
    await run('seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.claude}`, Math.min(options.postWaitMs, 30_000));
    // system/init arrives with the first turn in streaming mode.
    conversation.init = { ...claude.state.init, version: claude.state.init?.version ?? conversation.init?.version ?? null };
    if (name === 'A') {
      const before = await fileHashes(repo);
      const t1 = await run('T1-fix', PROMPTS.fixFormat.claude);
      t1.changedFiles = changedFiles(before, await fileHashes(repo));
      conversation.changedFiles = [...t1.changedFiles];
      conversation.recaps.push({ ...(await claude.recap('R1')), afterTurn: 'T1-fix' });
      await run('T2-english', PROMPTS.english);
      await run('T3-korean', PROMPTS.korean1);
      await claude.session.setPermissionMode('plan');
      await run('T4-korean-plan', PROMPTS.korean2);
      await claude.session.setPermissionMode('default');
      await run('T5-korean-default', PROMPTS.korean3);
      conversation.recaps.push({ ...(await claude.recap('R2')), afterTurn: 'T5-korean-default' });
      conversation.changedFiles = changedFiles(before, await fileHashes(repo));
      for (const recap of conversation.recaps) recap.flags = recapFlags(recap.text, conversation.changedFiles);
    } else {
      const before = await fileHashes(repo);
      const t1 = await run('T1-fix-cart', PROMPTS.fixCart.claude);
      t1.changedFiles = changedFiles(before, await fileHashes(repo));
      conversation.changedFiles = [...t1.changedFiles];
      conversation.readmePresent = existsSync(path.join(repo, 'README.md'));
      conversation.toolFactsAfterT1 = await suggestToolFacts(claude.session);
      await run('T2-summary', PROMPTS.summary);
    }
  } catch (error) {
    conversation.error = errorText(error);
    log(`claude ${tag} error: ${conversation.error}`);
  } finally {
    await delay(3_000);
    await claude.close();
  }
  conversation.rateLimits = claude.state.rateLimits;
  conversation.suggestTaskServer = endpoint ? suggestions.summary(tag) : null;
  return conversation;
}

async function runDirectCall(context, pass, variantName) {
  const { query, executable, telemetry, suggestions, options } = context;
  const variant = D_VARIANTS[variantName];
  const tag = `p${pass}-D-${variantName}`;
  const repo = path.join(options.scratch, `claude-${tag}`);
  await createReviewRepo(repo);
  const sessionId = randomUUID();
  const approvals = [];
  const endpoint = suggestions.endpoint(tag, { alwaysLoadMeta: Boolean(variant.alwaysLoadMeta) });
  const sessionOptions = {
    cwd: repo,
    pathToClaudeCodeExecutable: executable,
    permissionMode: variant.permissionMode,
    allowDangerouslySkipPermissions: false,
    canUseTool: personPolicy(repo, approvals),
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    persistSession: true,
    env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      ...telemetryEnvironment(telemetry.port, tag),
    }),
    settingSources: ['user', 'project', 'local'],
    sessionId,
    mcpServers: {
      [SUGGEST_SERVER]: {
        type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, timeout: 300_000,
        ...(variant.policy ? { tools: [{ name: variant.policy, permission_policy: 'always_allow' }] } : {}),
      },
    },
    ...(variant.allowedTools ? { allowedTools: [SUGGEST_FULL_NAME] } : {}),
  };
  const step = { tag, variant: variantName, settings: variant.settings, origin: Date.now(), turns: [], recaps: [], approvals };
  const claude = openClaude(query, sessionOptions, sessionId);
  try {
    const initialization = await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    step.init = { ...claude.state.init, version: claude.state.init?.version ?? initialization?.claude_code_version ?? null };
    step.toolFactsAtStart = await suggestToolFacts(claude.session);
    const turn = await claude.turn(`${tag}`, PROMPTS.directCall, { postWaitMs: 1_000 });
    turn.name = 'direct';
    step.turns.push(turn);
    step.init = { ...claude.state.init, version: claude.state.init?.version ?? step.init?.version ?? null };
    step.toolFacts = await suggestToolFacts(claude.session);
  } catch (error) {
    step.error = errorText(error);
  } finally {
    await delay(3_000);
    await claude.close();
  }
  step.suggestTaskServer = suggestions.summary(tag);
  step.suggestApprovalRequests = approvals.filter((entry) => entry.toolName === SUGGEST_FULL_NAME).length;
  step.suggestCallsReceived = step.suggestTaskServer.suggestions.length;
  return step;
}

// ---------------------------------------------------------------------------
// P5, P7, P8, P9

/** The standard preset's session options (runConversation's), with the given policy. */
function standardOptions(context, { repo, tag, sessionId, canUseTool, promptSuggestions, resume }) {
  const { executable, telemetry } = context;
  return {
    cwd: repo,
    pathToClaudeCodeExecutable: executable,
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    canUseTool,
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    persistSession: true,
    ...(promptSuggestions === undefined ? {} : { promptSuggestions }),
    env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      ...telemetryEnvironment(telemetry.port, tag),
    }),
    settingSources: ['user', 'project', 'local'],
    ...(resume ? { resume: sessionId } : { sessionId }),
  };
}

/** What the session file holds: tool calls and results by id, and any side-question text that leaked in. */
function sessionFileFacts(sessionId, leaks) {
  const projects = path.join(homedir(), '.claude', 'projects');
  const directory = readdirSync(projects).find((entry) => existsSync(path.join(projects, entry, `${sessionId}.jsonl`)));
  if (!directory) return { found: false };
  const toolUses = new Map();
  const toolResults = new Map();
  const leaked = Object.fromEntries(Object.keys(leaks).map((name) => [name, 0]));
  let lines = 0;
  for (const line of readFileSync(path.join(projects, directory, `${sessionId}.jsonl`), 'utf8').split(/\r?\n/u)) {
    if (!line) continue;
    lines += 1;
    for (const [name, text] of Object.entries(leaks)) if (line.includes(text)) leaked[name] += 1;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!['user', 'assistant'].includes(entry.type) || entry.isSidechain) continue;
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block?.type === 'tool_use') toolUses.set(block.id, (toolUses.get(block.id) ?? 0) + 1);
      if (block?.type === 'tool_result') toolResults.set(block.tool_use_id, (toolResults.get(block.tool_use_id) ?? 0) + 1);
    }
  }
  return {
    found: true, lines, toolUses: toolUses.size, toolResults: toolResults.size,
    toolUsesRepeated: [...toolUses.values()].filter((count) => count > 1).length,
    toolResultsRepeated: [...toolResults.values()].filter((count) => count > 1).length,
    toolUsesWithoutResult: [...toolUses.keys()].filter((id) => !toolResults.has(id)).length,
    leaked,
  };
}

/** One turn that stops on a request nobody answers: recap and visibility check while held, then the answer. */
async function holdCycle({ claude, hold, repo, conversation, tag, name, text, match, facts, toolFact, answer }) {
  const before = await fileHashes(repo);
  hold.arm(match);
  const step = { name, facts };
  const running = claude.turn(`${tag} ${name}`, text, { postWaitMs: 15_000 });
  const held = await Promise.race([hold.wait(), running.then(() => null)]);
  step.held = Boolean(held);
  if (held) {
    step.heldTool = held.toolName;
    step.heldTarget = held.toolInput?.file_path ? path.basename(String(held.toolInput.file_path)) : held.toolInput?.questions?.[0]?.question ?? null;
    step.changedAtHold = changedFiles(before, await fileHashes(repo));
    const recap = await claude.ask(`${tag} ${name} recap`, RECAP_INSTRUCTION, MID_TURN_ABORT_MS);
    recap.flags = recapFlags(recap.text, step.changedAtHold);
    const check = await claude.ask(`${tag} ${name} check`, visibilityQuestion(toolFact), MID_TURN_ABORT_MS);
    check.sees = visibilityFlags(check.text, facts);
    const waiting = held.toolName === 'AskUserQuestion'
      ? `the person has not answered your question: "${step.heldTarget}".`
      : `the person has not answered your request to edit ${step.heldTarget}.`;
    const noted = await claude.ask(`${tag} ${name} noted`, `${recapStoppedNote(waiting)}\n\n${RECAP_INSTRUCTION}`, MID_TURN_ABORT_MS);
    noted.flags = recapFlags(noted.text, step.changedAtHold);
    conversation.recaps.push({ ...recap, name: `${name}-recap`, midTurn: true }, { ...check, name: `${name}-check`, midTurn: true }, { ...noted, name: `${name}-noted`, midTurn: true });
    step.messagesWhileHeld = claude.state.messages.filter((entry) => entry.at >= held.at).map((entry) => entry.kind);
    step.heldForMs = Date.now() - held.at;
    held.release(answer ? answer(held.toolInput) : null);
  }
  const turn = await running;
  turn.name = name;
  turn.changedFiles = changedFiles(before, await fileHashes(repo));
  conversation.turns.push(turn);
  conversation.holds.push(step);
  if (!turn.finished) throw new Error(`${name} did not finish: ${turn.streamError ?? 'deadline'}`);
}

async function runMidTurn(context, pass) {
  const { query, options } = context;
  const tag = `p${pass}-P5`;
  const repo = path.join(options.scratch, `claude-${tag}`);
  await createReviewRepo(repo);
  const notes = { build: nonceWord(), release: nonceWord() };
  await fs.writeFile(path.join(repo, 'BUILD_NOTES.md'), `# Build notes\n\nBuild tag: ${notes.build}\n`);
  await fs.writeFile(path.join(repo, 'RELEASE_NOTES.md'), `# Release notes\n\nRelease tag: ${notes.release}\n`);
  const sessionId = randomUUID();
  const approvals = [];
  const hold = createHold();
  const conversation = {
    tag, name: 'P5', pass, origin: Date.now(), settings: 'standard preset; canUseTool held on one request per stopped turn',
    turns: [], recaps: [], holds: [], approvals,
  };
  const claude = openClaude(query, standardOptions(context, { repo, tag, sessionId, canUseTool: holdingPolicy(repo, approvals, hold), promptSuggestions: true }), sessionId);
  const run = async (name, text, postWaitMs = 15_000) => {
    const turn = await claude.turn(`${tag} ${name}`, text, { postWaitMs });
    turn.name = name;
    conversation.turns.push(turn);
    if (!turn.finished) throw new Error(`${name} did not finish: ${turn.streamError ?? 'deadline'}`);
    return turn;
  };
  const permission = async () => {
    const facts = { ticket: `T-${nonceWord()}`, marker: nonceWord(), toolResult: notes.build };
    await holdCycle({
      claude, hold, repo, conversation, tag, name: 'H-permission', facts, toolFact: 'tag: the build tag in BUILD_NOTES.md.',
      match: (toolName, toolInput) => EDIT_TOOLS.has(toolName) && /cart\.ts$/u.test(String(toolInput?.file_path ?? '')),
      text: `Ticket ${facts.ticket}. cartTotal in src/cart.ts reads past the end of the items array. Work in this exact order, with no shell commands:\n`
        + `1. Write one short sentence that contains the exact words "plan marker ${facts.marker}".\n`
        + '2. Read BUILD_NOTES.md with the Read tool.\n3. Read src/cart.ts with the Read tool.\n'
        + '4. Fix the bug with the Edit tool, changing only src/cart.ts.\nThen reply with one line saying what you changed.',
    });
  };
  const question = async () => {
    const facts = { ticket: `T-${nonceWord()}`, marker: nonceWord(), toolResult: notes.release };
    await holdCycle({
      claude, hold, repo, conversation, tag, name: 'H-question', facts, toolFact: 'tag: the release tag in RELEASE_NOTES.md.',
      match: (toolName) => toolName === 'AskUserQuestion',
      answer: (toolInput) => ({
        behavior: 'allow',
        updatedInput: { ...toolInput, answers: Object.fromEntries((toolInput?.questions ?? []).map((entry) => [entry.question, entry.options?.at(-1)?.label ?? '($5.00)'])) },
      }),
      text: `Ticket ${facts.ticket}. Negative prices need a decision. Work in this exact order, with no shell commands:\n`
        + `1. Write one short sentence that contains the exact words "plan marker ${facts.marker}".\n`
        + '2. Read RELEASE_NOTES.md with the Read tool.\n3. Read src/format.ts with the Read tool.\n'
        + '4. Use the Edit tool to add the comment line "// checked for negative prices" at the top of src/format.ts.\n'
        + '5. Use the AskUserQuestion tool to ask me whether negative prices should show as -$5.00 or ($5.00), with those two options.\n'
        + '6. After my answer, change formatPrice in src/format.ts to show negative prices that way, and reply with one line saying what you changed.',
    });
  };
  try {
    await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    await run('seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.claude}`);
    conversation.init = { ...claude.state.init };
    await run('T1-warm', 'Without using any tools: what is the code name of module 0042 in the notes? One line.');
    const order = pass % 2 === 1 ? [permission, question] : [question, permission];
    for (const step of order) await step();
    await run('T-after', 'Without using any tools: in one line, name the files you changed in this conversation.');
    conversation.sessionFile = sessionFileFacts(sessionId, { recap: 'Recap for the person', check: 'Answer from this conversation only' });
  } catch (error) {
    conversation.error = errorText(error);
    log(`claude ${tag} error: ${conversation.error}`);
  } finally {
    await delay(3_000);
    await claude.close();
  }
  conversation.rateLimits = claude.state.rateLimits;
  return conversation;
}

const SUGGESTION_TURNS = [
  ['T1-fix', PROMPTS.fixFormat.claude],
  ['T2-english', PROMPTS.english],
  ['T3-korean', PROMPTS.korean1],
  ['T4-korean', PROMPTS.korean2],
  ['T5-korean', PROMPTS.korean3],
  ['T6-korean', '도구는 쓰지 말고: 이 저장소에 테스트를 추가한다면 어떤 파일부터 볼지 한 줄로 알려 주세요.'],
];

/** P7: `plan` is the flag value applied before each listed turn. */
async function runToggle(context, pass, name) {
  const { query, options } = context;
  const tag = `p${pass}-${name}`;
  const repo = path.join(options.scratch, `claude-${tag}`);
  await createReviewRepo(repo);
  const sessionId = randomUUID();
  const approvals = [];
  const startsOn = !['P7off', 'P7envoff'].includes(name);
  const throughEnv = name !== 'P7on' && name !== 'P7off';
  const flagFor = (value) => {
    if (!throughEnv) return { promptSuggestionEnabled: value };
    if (name === 'P7clear' && value) return { env: null };
    return { env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: name === 'P7blank' && value ? '' : String(value) } };
  };
  const plan = startsOn ? { 'T3-korean': false, 'T5-korean': true } : { 'T3-korean': true, 'T5-korean': false };
  const conversation = {
    tag, name, pass, origin: Date.now(), settings: `promptSuggestions ${startsOn} at start, then applyFlagSettings ${throughEnv ? 'env ' : ''}${JSON.stringify(plan)}`,
    turns: [], recaps: [], applies: [], approvals,
  };
  const claude = openClaude(query, standardOptions(context, { repo, tag, sessionId, canUseTool: personPolicy(repo, approvals), promptSuggestions: startsOn }), sessionId);
  try {
    await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    let enabled = startsOn;
    const run = async (turnName, text) => {
      if (turnName in plan) {
        enabled = plan[turnName];
        const applied = { beforeTurn: turnName, value: enabled };
        try {
          applied.sent = flagFor(enabled);
          await withTimeout(claude.session.applyFlagSettings(flagFor(enabled)), 30_000, 'applyFlagSettings');
          const read = await withTimeout(claude.session.getSettings(), 30_000, 'getSettings');
          applied.effective = (throughEnv ? read?.effective?.env?.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION : read?.effective?.promptSuggestionEnabled) ?? null;
        } catch (error) {
          applied.error = errorText(error);
        }
        conversation.applies.push(applied);
      }
      const turn = await claude.turn(`${tag} ${turnName}`, text, { postWaitMs: enabled ? 45_000 : 25_000 });
      turn.name = turnName;
      turn.flagExpected = enabled;
      conversation.turns.push(turn);
      if (!turn.finished) throw new Error(`${turnName} did not finish: ${turn.streamError ?? 'deadline'}`);
    };
    await run('seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.claude}`);
    conversation.init = { ...claude.state.init };
    for (const [turnName, text] of SUGGESTION_TURNS) await run(turnName, text);
  } catch (error) {
    conversation.error = errorText(error);
    log(`claude ${tag} error: ${conversation.error}`);
  } finally {
    await delay(3_000);
    await claude.close();
  }
  conversation.rateLimits = claude.state.rateLimits;
  return conversation;
}

/** P8: a session with suggestions, closed; then resume, with the option again or without it. */
async function runResumed(context, pass, name) {
  const { query, options } = context;
  const tag = `p${pass}-${name}`;
  const repo = path.join(options.scratch, `claude-${tag}`);
  await createReviewRepo(repo);
  const sessionId = randomUUID();
  const approvals = [];
  const conversation = {
    tag, name, pass, origin: Date.now(), settings: `promptSuggestions true, closed, resume with ${name === 'P8flag' ? 'promptSuggestions true' : 'the option left out'}`,
    turns: [], recaps: [], approvals,
  };
  const canUseTool = personPolicy(repo, approvals);
  const drive = async (claude, turns) => {
    await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    for (const [turnName, text, postWaitMs] of turns) {
      const turn = await claude.turn(`${tag} ${turnName}`, text, { postWaitMs });
      turn.name = turnName;
      conversation.turns.push(turn);
      if (!turn.finished) throw new Error(`${turnName} did not finish: ${turn.streamError ?? 'deadline'}`);
    }
  };
  const firstSession = openClaude(query, standardOptions(context, { repo, tag, sessionId, canUseTool, promptSuggestions: true }), sessionId);
  try {
    await drive(firstSession, [
      ['seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.claude}`, 25_000],
      ['T1-fix', PROMPTS.fixFormat.claude, 45_000],
      ['T2-english', PROMPTS.english, 45_000],
    ]);
    conversation.init = { ...firstSession.state.init };
    await delay(3_000);
    await firstSession.close();
    conversation.closedAt = Date.now();
    const resumed = openClaude(query, standardOptions(context, { repo, tag, sessionId, canUseTool, promptSuggestions: name === 'P8flag' ? true : undefined, resume: true }), sessionId);
    try {
      await drive(resumed, [
        ['R1-korean', PROMPTS.korean1, 45_000],
        ['R2-korean', PROMPTS.korean2, 45_000],
        ['R3-korean', PROMPTS.korean3, 45_000],
      ]);
    } finally {
      await delay(3_000);
      await resumed.close();
      conversation.rateLimits = resumed.state.rateLimits;
    }
  } catch (error) {
    conversation.error = errorText(error);
    log(`claude ${tag} error: ${conversation.error}`);
    await firstSession.close();
  }
  return conversation;
}

const raceTurn = (subject, first = false) => `${first ? '' : 'No, leave that for now. '}Without using any tools: in one line, name one risk in ${subject}, then ask me whether you should fix it.`;
const RACE_TURNS = [
  ['R1', raceTurn('formatPrice in src/format.ts', true)],
  ['R2', raceTurn('cartTotal in src/cart.ts')],
  ['R3', raceTurn('canAccess in src/auth.ts')],
  ['R4', raceTurn('applyDiscount in src/discount.ts')],
  ['R5', raceTurn('the README.md of this repository')],
  ['R6', raceTurn('the module notes I gave you at the start')],
  ['R7', raceTurn('how this repository tests its code')],
  ['R8', raceTurn('how this repository handles rounding')],
];

/** P9: the next message goes 1 s after each `result` from R1 on; the last turn waits for its suggestion. */
async function runLate(context, pass, control = false) {
  const { query, options } = context;
  const tag = `p${pass}-P9${control ? 'ctrl' : ''}`;
  const repo = path.join(options.scratch, `claude-${tag}`);
  await createReviewRepo(repo);
  const sessionId = randomUUID();
  const approvals = [];
  const conversation = { tag, name: control ? 'P9ctrl' : 'P9', pass, origin: Date.now(), settings: control ? 'the same turns, waiting for each suggestion' : 'next message 0.25 s or 1 s after result', turns: [], recaps: [], approvals, keepRequests: true };
  const claude = openClaude(query, standardOptions(context, { repo, tag, sessionId, canUseTool: personPolicy(repo, approvals), promptSuggestions: true }), sessionId);
  const run = async (name, text, postWaitMs) => {
    const turn = await claude.turn(`${tag} ${name}`, text, { postWaitMs });
    turn.name = name;
    conversation.turns.push(turn);
    if (!turn.finished) throw new Error(`${name} did not finish: ${turn.streamError ?? 'deadline'}`);
  };
  try {
    await withTimeout(claude.session.initializationResult(), 120_000, 'initialization');
    await run('seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.claude}`, 25_000);
    conversation.init = { ...claude.state.init };
    await run('T1-fix', PROMPTS.fixFormat.claude, 45_000);
    await run('T2-english', PROMPTS.english, 45_000);
    for (const [index, [name, text]] of RACE_TURNS.entries()) {
      const last = index === RACE_TURNS.length - 1;
      await run(name, text, last ? 45_000 : control ? 20_000 : 0);
      if (!last && !control) {
        const gap = (index + pass) % 2 === 0 ? 1_000 : 250;
        conversation.turns.at(-1).gapToNextMs = gap;
        await delay(gap);
      }
    }
  } catch (error) {
    conversation.error = errorText(error);
    log(`claude ${tag} error: ${conversation.error}`);
  } finally {
    await delay(5_000);
    await claude.close();
  }
  conversation.rateLimits = claude.state.rateLimits;
  conversation.suggestionsRaw = claude.state.suggestions;
  conversation.ids = {
    results: claude.state.results.map((result) => result.uuid), assistants: claude.state.assistantUuids, sessionId,
  };
  return conversation;
}

/** Every suggestion (and its request) placed against the turns: which turn ran when it arrived, which result it followed. */
function raceTimeline(conversation) {
  const turns = conversation.turns;
  const place = (at) => {
    const running = turns.find((turn) => at >= turn.startedAt && at <= turn.resultAt) ?? null;
    const lastResult = turns.filter((turn) => turn.resultAt <= at).at(-1) ?? null;
    const next = lastResult ? turns[turns.indexOf(lastResult) + 1] ?? null : null;
    return {
      runningTurn: running?.name ?? null, lastResultOf: lastResult?.name ?? null,
      msAfterThatResult: lastResult ? at - lastResult.resultAt : null,
      msAfterNextMessage: next && at >= next.startedAt ? at - next.startedAt : null,
      msBeforeRunningResult: running ? running.resultAt - at : null,
    };
  };
  const ids = conversation.ids ?? { results: [], assistants: [] };
  const users = turns.map((turn) => turn.userUuid);
  return {
    suggestions: (conversation.suggestionsRaw ?? []).map((entry) => ({
      ...place(entry.at), text: entry.text, keys: entry.keys,
      uuidMatches: { result: ids.results.includes(entry.uuid), assistant: ids.assistants.includes(entry.uuid), user: users.includes(entry.uuid) },
      sameSession: entry.sessionId === ids.sessionId,
    })),
    requests: (conversation.requests ?? []).filter((request) => request.source === 'prompt_suggestion').map((request) => ({ ...place(request.at), input: request.input, cacheRead: request.cacheRead, output: request.output, durationMs: request.durationMs })),
    errors: conversation.telemetryErrors ?? [],
    turnDurations: turns.map((turn) => [turn.name, turn.durationMs]),
    gaps: turns.filter((turn) => turn.gapToNextMs).map((turn) => [turn.name, turn.gapToNextMs]),
    endings: turns.map((turn) => [turn.name, String(turn.result?.text ?? '').slice(0, 90)]),
  };
}

// ---------------------------------------------------------------------------
// Verdicts

function passSummary(pass) {
  const summary = {};
  const a = pass.conversations.A;
  if (a?.turns?.length) {
    const turn = (name) => a.turns.find((entry) => entry.name === name);
    const ordinary = ['T1-fix', 'T2-english', 'T3-korean', 'T5-korean-default'].map(turn).filter(Boolean);
    summary.P1 = {
      seedSuggestion: Boolean(turn('seed')?.suggestion),
      ordinaryTurnsWithSuggestion: `${ordinary.filter((entry) => entry.suggestion).length}/${ordinary.length}`,
      planTurnSuggestion: turn('T4-korean-plan') ? Boolean(turn('T4-korean-plan').suggestion) : null,
      afterPlanBackToDefault: turn('T5-korean-default') ? Boolean(turn('T5-korean-default').suggestion) : null,
      msAfterResult: ordinary.map((entry) => entry.suggestion?.msAfterResult ?? null),
      suggestionRatios: ordinary.map((entry) => entry.telemetry?.suggestionRatio ?? null),
      suggestionSources: [...new Set(a.turns.flatMap((entry) => (entry.telemetry?.postResult ?? []).map((request) => request.source)))],
      koreanSuggestionsHaveHangul: ['T3-korean', 'T5-korean-default'].map(turn).filter((entry) => entry?.suggestion)
        .map((entry) => /[가-힣]/u.test(entry.suggestion.text)),
      rateLimitStatuses: [...new Set((a.rateLimits ?? []).map((entry) => `${entry.type}:${entry.status}:${entry.utilization ?? '?'}`))],
    };
    summary.P3 = a.recaps.map((recap) => ({
      name: recap.name, ok: recap.ok, durationMs: recap.durationMs, ratio: recap.telemetry?.recapRatio ?? null,
      cacheRead: recap.telemetry?.first?.cacheRead ?? null, cacheCreation: recap.telemetry?.first?.cacheCreation ?? null,
      chars: recap.flags?.chars ?? null, lines: recap.flags?.lines ?? null, hangul: recap.flags?.hangul ?? null,
      namedButUnchanged: recap.flags?.namedButUnchanged ?? null, claimsTestsRan: recap.flags?.claimsTestsRan ?? null,
    }));
    summary.crossTurnA = a.turns.map((entry) => [entry.name, entry.telemetry?.crossTurnRatio ?? null]);
  }
  for (const name of ['B', 'BAL']) {
    const b = pass.conversations[name];
    if (!b) continue;
    const t1 = b.turns.find((entry) => entry.name === 'T1-fix-cart');
    summary[`P4-${name}`] = {
      error: b.error ?? null,
      suggestToolAtStart: b.toolFactsAtStart?.suggestTool ?? null,
      suggestToolAfterT1: b.toolFactsAfterT1?.suggestTool ?? null,
      toolSearchUsed: (t1?.toolUses ?? []).some((use) => use.name === 'ToolSearch'),
      toolSequence: (t1?.toolUses ?? []).map((use) => use.name),
      suggestCalls: (b.suggestTaskServer?.suggestions ?? []).map((entry) => entry.title),
      suggestApprovalRequests: b.approvals.filter((entry) => entry.toolName === SUGGEST_FULL_NAME).length,
      approvalRequests: b.approvals.map((entry) => `${entry.toolName}:${entry.decision}`),
      changedFiles: b.changedFiles ?? null,
      readmePresent: b.readmePresent ?? null,
      crossTurn: b.turns.map((entry) => [entry.name, entry.telemetry?.crossTurnRatio ?? null, entry.telemetry?.firstMain?.cacheCreation ?? null]),
      suggestions: b.turns.map((entry) => [entry.name, entry.suggestion?.text ?? null]),
    };
  }
  const p5 = pass.conversations.P5;
  if (p5) {
    summary.P5 = {
      error: p5.error ?? null,
      holds: p5.holds.map((hold) => {
        const recap = p5.recaps.find((entry) => entry.name === `${hold.name}-recap`);
        const check = p5.recaps.find((entry) => entry.name === `${hold.name}-check`);
        const noted = p5.recaps.find((entry) => entry.name === `${hold.name}-noted`);
        const turn = p5.turns.find((entry) => entry.name === hold.name);
        return {
          name: hold.name, held: hold.held, heldTool: hold.heldTool ?? null, heldTarget: hold.heldTarget ?? null, heldForMs: hold.heldForMs ?? null,
          changedAtHold: hold.changedAtHold ?? null, changedAtEnd: turn?.changedFiles ?? null,
          recap: recap ? {
            ok: recap.ok, ms: recap.durationMs, error: recap.error ?? null, synthetic: recap.synthetic ?? null, midTurnRatio: recap.telemetry?.midTurnRatio ?? null,
            contextJustBefore: recap.telemetry?.contextJustBefore ?? null, first: recap.telemetry?.first ?? null, requests: recap.telemetry?.requests ?? null, text: recap.text ?? null,
          } : null,
          check: check ? { ok: check.ok, ms: check.durationMs, error: check.error ?? null, midTurnRatio: check.telemetry?.midTurnRatio ?? null, sees: check.sees ?? null, text: check.text ?? null } : null,
          noted: noted ? { ok: noted.ok, ms: noted.durationMs, error: noted.error ?? null, midTurnRatio: noted.telemetry?.midTurnRatio ?? null, text: noted.text ?? null } : null,
          messagesWhileHeld: hold.messagesWhileHeld ?? null,
          turnEnd: turn ? { finished: turn.finished, subtype: turn.result?.subtype ?? null, denials: turn.result?.permissionDenials ?? null, numTurns: turn.result?.numTurns ?? null, durationMs: turn.durationMs, tools: turn.toolUses.map((use) => use.name), text: turn.result?.text ?? null } : null,
        };
      }),
      crossTurn: p5.turns.map((turn) => [turn.name, turn.telemetry?.crossTurnRatio ?? null, turn.telemetry?.firstMain?.cacheCreation ?? null, turn.telemetry?.contextAtEnd ?? null]),
      sessionFile: p5.sessionFile ?? null, approvals: p5.approvals.map((entry) => `${entry.toolName}:${entry.held ? 'held' : entry.decision}`),
    };
  }
  for (const name of ['P7on', 'P7off', 'P7env', 'P7clear', 'P7blank', 'P7envoff', 'P8flag', 'P8noflag']) {
    const conversation = pass.conversations[name];
    if (!conversation) continue;
    summary[name] = {
      error: conversation.error ?? null, applies: conversation.applies ?? null,
      turns: conversation.turns.map((turn) => ({
        name: turn.name, flag: turn.flagExpected ?? null, suggestion: turn.suggestion?.text ?? null, msAfterResult: turn.suggestion?.msAfterResult ?? null,
        suggestionRequests: (turn.telemetry?.postResult ?? []).filter((request) => request.source === 'prompt_suggestion').length,
        postResultSources: (turn.telemetry?.postResult ?? []).map((request) => request.source),
        crossTurnRatio: turn.telemetry?.crossTurnRatio ?? null, cacheCreation: turn.telemetry?.firstMain?.cacheCreation ?? null, cacheRead: turn.telemetry?.firstMain?.cacheRead ?? null,
      })),
      rateLimitStatuses: [...new Set((conversation.rateLimits ?? []).map((entry) => `${entry.type}:${entry.status}:${entry.utilization ?? '?'}`))],
    };
  }
  const p9 = pass.conversations.P9;
  if (p9) summary.P9 = { error: p9.error ?? null, ...raceTimeline(p9) };
  const p9control = pass.conversations.P9ctrl;
  if (p9control) summary.P9 = { error: p9control.error ?? null, control: true, ...raceTimeline(p9control) };
  if (pass.direct.length) {
    summary.P4direct = pass.direct.map((step) => ({
      variant: step.variant, error: step.error ?? null, approvalRequested: step.suggestApprovalRequests, toolRan: step.suggestCallsReceived,
      result: step.turns[0]?.result?.subtype ?? null, permissionDenials: step.turns[0]?.result?.permissionDenials ?? null,
      toolSequence: (step.turns[0]?.toolUses ?? []).map((use) => use.name),
      suggestToolAtStart: step.toolFactsAtStart?.suggestTool ?? null,
      suggestTool: step.toolFacts?.suggestTool ?? null,
    }));
  }
  return summary;
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  options.scratch = path.join(options.scratch, `claude-${stamp}`); // every run gets new repos
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const executable = options.claudeExecutable ?? resolveClaudeExecutable();
  const telemetry = await startTelemetryReceiver();
  const suggestions = await startSuggestionServer();
  const file = path.join(options.out, `claude-${stamp}.json`);
  const report = {
    probe: 'claude-turn-wrap-up', at: new Date().toISOString(),
    facts: {
      claudeCli: executable,
      claudeSdk: JSON.parse(readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version,
      repeat: options.repeat, only: options.only, postWaitMs: options.postWaitMs,
      preset: "standard: permissionMode 'default', settingSources user/project/local (the person's settings, hooks and MCP servers load)",
    },
    definitions: DEFINITIONS, passes: [],
  };
  const context = { query, executable, telemetry, suggestions, options };
  const settle = async () => {
    await delay(2_500);
    for (const pass of report.passes) {
      for (const conversation of [...Object.values(pass.conversations), ...pass.direct]) attribute(conversation, telemetry.events, telemetry.errors);
      pass.summary = passSummary(pass);
    }
    report.facts.claudeVersion ??= report.passes.flatMap((pass) => [...Object.values(pass.conversations), ...pass.direct])
      .find((entry) => entry.init?.version)?.init.version ?? null;
    report.facts.model ??= report.passes.flatMap((pass) => [...Object.values(pass.conversations), ...pass.direct])
      .find((entry) => entry.init?.model)?.init.model ?? null;
    report.facts.telemetryEvents = telemetry.events.length;
    report.facts.telemetryEventNames = telemetry.names;
    await writeReport(file, report);
  };
  try {
    for (let pass = options.startPass; pass < options.startPass + options.repeat; pass += 1) {
      const entry = { pass, conversations: {}, direct: [] };
      report.passes.push(entry);
      for (const name of ['A', 'B', 'BAL']) {
        if (!options.only.includes(name)) continue;
        entry.conversations[name] = await runConversation(context, pass, name);
        await settle();
      }
      if (options.only.includes('D')) {
        const names = options.variants ?? Object.keys(D_VARIANTS);
        for (const variant of pass % 2 === 1 ? names : [...names].reverse()) {
          entry.direct.push(await runDirectCall(context, pass, variant));
          await settle();
        }
      }
      const order = (names) => (pass % 2 === 1 ? names : [...names].reverse());
      if (options.only.includes('P5')) {
        entry.conversations.P5 = await runMidTurn(context, pass);
        await settle();
      }
      if (options.only.includes('P7')) {
        for (const name of order(['P7on', 'P7off'])) {
          entry.conversations[name] = await runToggle(context, pass, name);
          await settle();
        }
      }
      for (const name of ['P7env', 'P7clear', 'P7blank', 'P7envoff']) {
        if (!options.only.includes(name)) continue;
        entry.conversations[name] = await runToggle(context, pass, name);
        await settle();
      }
      if (options.only.includes('P8')) {
        for (const name of order(['P8flag', 'P8noflag'])) {
          entry.conversations[name] = await runResumed(context, pass, name);
          await settle();
        }
      }
      if (options.only.includes('P9')) {
        entry.conversations.P9 = await runLate(context, pass);
        await settle();
      }
      if (options.only.includes('P9ctrl')) {
        entry.conversations.P9ctrl = await runLate(context, pass, true);
        await settle();
      }
    }
  } finally {
    await settle();
    telemetry.server.close();
    await suggestions.close();
  }
  console.log(JSON.stringify({ file, facts: report.facts, summaries: report.passes.map((pass) => ({ pass: pass.pass, summary: pass.summary })) }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
