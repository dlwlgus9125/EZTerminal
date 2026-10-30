#!/usr/bin/env node
/**
 * Real-provider probe for bundle 2 "turn wrap-up" on Claude: next-prompt suggestions (P1),
 * recap by askSideQuestion (P3) and a proposal-only suggest_task MCP tool (P4).
 *
 *   node scripts/probe-claude-turn-wrap-up.mjs --scratch <dir> [--repeat 2] [--only A,B,BAL,D]
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
 *        default + allowedTools.
 * canUseTool plays the person: edits inside the repo and suggest_task are allowed (and recorded), the
 * shell and ExitPlanMode are denied. Token facts come from Claude Code's OpenTelemetry api_request
 * events (one OTLP/HTTP JSON endpoint path per session, attributed by time window and query_source).
 * Report: artifacts/wrap-up-probe/claude-<time>.json, rewritten after every conversation. Suggestion,
 * recap and suggest_task texts are kept (they are about the scratch repo); no account attributes.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createReviewRepo } from './review-probe-repo.mjs';
import {
  CLAUDE_ENVIRONMENT_VARIABLES, PROMPTS, RECAP_INSTRUCTION, SUGGEST_SERVER, SUGGEST_TOOL,
  changedFiles, delay, errorText, fileHashes, log, number, providerEnvironment, ratio, recapFlags, seedText,
  startSuggestionServer, withTimeout, writeReport,
} from './wrap-up-probe-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 420_000;
const SUGGEST_FULL_NAME = `mcp__${SUGGEST_SERVER}__${SUGGEST_TOOL}`;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const KEPT_ATTRIBUTES = new Set([
  'event.name', 'event.timestamp', 'query_source', 'query_source_safe', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'speed', 'effort', 'agent_id',
]);
const STEPS = ['A', 'B', 'BAL', 'D'];
const D_VARIANTS = {
  default: { settings: "permissionMode 'default' (standard preset)", permissionMode: 'default' },
  plan: { settings: "permissionMode 'plan' (plan preset)", permissionMode: 'plan' },
  policy: { settings: "default + server tools [{ name: 'suggest_task', permission_policy: 'always_allow' }]", permissionMode: 'default', policy: SUGGEST_TOOL },
  policyFull: { settings: `default + server tools [{ name: '${SUGGEST_FULL_NAME}', permission_policy: 'always_allow' }]`, permissionMode: 'default', policy: SUGGEST_FULL_NAME },
  allowedTools: { settings: `default + allowedTools ['${SUGGEST_FULL_NAME}']`, permissionMode: 'default', allowedTools: true },
};

const DEFINITIONS = {
  firstMain: "Earliest api_request ending inside the turn window with query_source 'sdk' (the main loop).",
  contextAtEnd: "The turn's last 'sdk' request: input + cache_read + cache_creation.",
  crossTurnRatio: "firstMain.cache_read / previous turn's contextAtEnd: how much of the conversation the next turn read from cache.",
  postResult: "Requests ending after the turn's result and before the next message was sent (suggestion window).",
  suggestionRatio: "Suggestion request cache_read / the same turn's contextAtEnd (bundle-1 bar: >= 0.8).",
  recapRatio: "side_question request cache_read / contextAtEnd of the turn before the recap (bundle-1 bar: >= 0.8).",
};

function parseArguments(argv) {
  const options = { repeat: 2, only: [...STEPS], postWaitMs: 60_000, out: path.join(root, 'artifacts', 'wrap-up-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--only') options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--post-wait-ms') options.postWaitMs = Number(value);
    else if (flag === '--claude-executable') options.claudeExecutable = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer.');
  if (options.only.some((step) => !STEPS.includes(step))) throw new Error(`--only takes ${STEPS.join(',')}.`);
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
              if (name === 'api_request' || name === 'claude_code.api_request') {
                events.push({ receivedAt: Date.now(), tag: pathTag && pathTag !== 'v1' ? pathTag : null, ...attributes });
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
    server.listen(0, '127.0.0.1', () => resolve({ server, events, port: server.address().port }));
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
function attribute(conversation, events) {
  const requests = events.filter((event) => event.tag === conversation.tag).map((event) => requestFacts(event, conversation.origin))
    .sort((left, right) => left.at - right.at);
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
    recap.telemetry = {
      requests: mine.length,
      first: brief(first),
      contextBefore: before?.telemetry?.contextAtEnd ?? null,
      recapRatio: ratio(first?.cacheRead, before?.telemetry?.contextAtEnd),
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

function openClaude(query, options, sessionId) {
  const input = new AsyncQueue();
  const session = query({ prompt: input, options });
  const state = { init: null, results: [], calls: [], messages: [], suggestions: [], rateLimits: [], toolUses: [], streamError: null };
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
        state.suggestions.push({ at, text: String(message.suggestion ?? '') });
      } else if (message.type === 'rate_limit_event') {
        const info = message.rate_limit_info ?? {};
        state.rateLimits.push({ at, status: info.status ?? null, type: info.rateLimitType ?? null, utilization: info.utilization ?? null, surpassedThreshold: info.surpassedThreshold ?? null, usingOverage: info.isUsingOverage ?? null });
      } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
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
          at, subtype: message.subtype ?? null, isError: message.is_error ?? null, numTurns: message.num_turns ?? null,
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
    input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId });
    await waitUntil(() => state.results.length > before.results || state.streamError, deadlineMs);
    const result = state.results[before.results] ?? null;
    const resultAt = result?.at ?? Date.now();
    if (result) await waitUntil(() => state.suggestions.length > before.suggestions || state.streamError, postWaitMs);
    const suggestion = state.suggestions[before.suggestions] ?? null;
    if (suggestion) await delay(3_000); // lets session_state_changed and the telemetry export land
    const postEndAt = Date.now();
    return {
      name, startedAt, resultAt, postEndAt, finished: Boolean(result), durationMs: resultAt - startedAt,
      result, streamError: state.streamError,
      suggestion: suggestion ? { text: suggestion.text, msAfterResult: suggestion.at - resultAt } : null,
      waitedMsForSuggestion: suggestion ? null : postEndAt - resultAt,
      postResultSequence: state.messages.slice(before.messages).filter((entry) => entry.at >= resultAt)
        .map((entry) => `${entry.kind}${entry.state ? `:${entry.state}` : ''}@${entry.at - resultAt}`),
      toolUses: state.toolUses.slice(before.tools).map(({ name: tool, file, query: search }) => ({ name: tool, ...(file ? { file } : {}), ...(search ? { query: search } : {}) })),
      sdkCalls: state.calls.slice(before.calls).length,
    };
  };

  const recap = async (name) => {
    const startedAt = Date.now();
    log(`claude ${name}`);
    try {
      const answer = await session.askSideQuestion(RECAP_INSTRUCTION, { signal: AbortSignal.timeout(180_000) });
      return { name, startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt, ok: true, text: answer?.response ?? null, synthetic: answer?.synthetic ?? null, refusalFallback: Boolean(answer?.refusalFallback) };
    } catch (error) {
      return { name, startedAt, endedAt: Date.now(), durationMs: Date.now() - startedAt, ok: false, error: errorText(error) };
    }
  };

  const close = async () => {
    input.close();
    session.close();
    await Promise.race([iterate.catch(() => undefined), delay(5_000)]);
  };
  return { session, state, turn, recap, close };
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
  const endpoint = suggestions.endpoint(tag);
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
  if (pass.direct.length) {
    summary.P4direct = pass.direct.map((step) => ({
      variant: step.variant, error: step.error ?? null, approvalRequested: step.suggestApprovalRequests, toolRan: step.suggestCallsReceived,
      result: step.turns[0]?.result?.subtype ?? null, permissionDenials: step.turns[0]?.result?.permissionDenials ?? null,
      toolSequence: (step.turns[0]?.toolUses ?? []).map((use) => use.name),
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
      for (const conversation of [...Object.values(pass.conversations), ...pass.direct]) attribute(conversation, telemetry.events);
      pass.summary = passSummary(pass);
    }
    report.facts.claudeVersion ??= report.passes.flatMap((pass) => [...Object.values(pass.conversations), ...pass.direct])
      .find((entry) => entry.init?.version)?.init.version ?? null;
    report.facts.model ??= report.passes.flatMap((pass) => [...Object.values(pass.conversations), ...pass.direct])
      .find((entry) => entry.init?.model)?.init.model ?? null;
    report.facts.telemetryEvents = telemetry.events.length;
    await writeReport(file, report);
  };
  try {
    for (let pass = 1; pass <= options.repeat; pass += 1) {
      const entry = { pass, conversations: {}, direct: [] };
      report.passes.push(entry);
      for (const name of ['A', 'B', 'BAL']) {
        if (!options.only.includes(name)) continue;
        entry.conversations[name] = await runConversation(context, pass, name);
        await settle();
      }
      if (options.only.includes('D')) {
        const names = Object.keys(D_VARIANTS);
        for (const variant of pass % 2 === 1 ? names : [...names].reverse()) {
          entry.direct.push(await runDirectCall(context, pass, variant));
          await settle();
        }
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
