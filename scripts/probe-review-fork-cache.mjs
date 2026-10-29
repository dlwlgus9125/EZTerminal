#!/usr/bin/env node
/**
 * Real-provider probe: why does a review fork's first model call reuse none of the
 * conversation's prompt cache, when /btw (also a fork of the conversation) reuses nearly
 * all of it? Each fork case changes one setting; every step records its FIRST model call.
 *
 *   node scripts/probe-review-fork-cache.mjs --scratch <dir> [--repeat 1] [--only claude,codex]
 *        [--claude-lane product|isolated] [--claude-executable <path>] [--codex-script <codex.js>]
 *
 * Claude (installed CLI; options mirror startSession in src/main/claude-provider-adapter.ts):
 *   C   live conversation: seed turn (900-line reference list), then a short warm turn.
 *   B   C.askSideQuestion() — the /btw path.
 *   F0  fork of C (resume + forkSession, persistSession false) with C's options, tools denied by canUseTool.
 *   F1  F0 + outputFormat.   F2  F0 with tools ['Read', 'Grep', 'Glob'].
 *   F3  the review design: tools ['Read', 'Grep', 'Glob'] + outputFormat + permissionPrompts 'none'
 *       (+ disallowedTools Edit/Write/MultiEdit/NotebookEdit, as in the review-fork fixture).
 *   Forks run while C stays open. Numbers come from Claude Code's OpenTelemetry api_request
 *   events (one local OTLP/HTTP JSON endpoint path per process, so attribution needs no time
 *   windows across processes); the SDK's per-call assistant usage is kept as a cross-check.
 *   `--claude-lane isolated` runs the btw probe's lane instead (settingSources [], claude.ai
 *   MCP servers and auto memory off) — a second control if F0 misses in the product lane.
 *
 * Codex (installed app-server): parent P (standard preset; seed turn + warm turn), ephemeral
 *   forks of P — G0 read-only/never (the btw shape), G1 G0 + outputSchema, G2 no override,
 *   G3 G2 + outputSchema — and a fresh ephemeral thread. Numbers: the first
 *   thread/tokenUsage/updated `last` of each turn.
 *
 * Schemas are a tiny {answer_<case>_p<pass>: string}, not REVIEW_FINDINGS_JSON_SCHEMA; the
 * property name differs per case and pass so one schema case cannot read another's cache
 * writes. Each pass's seed starts with a nonce (1-hour caching would otherwise carry cache
 * across runs), so every pass is an independent replicate.
 * Writes token counts, step names and timings only to artifacts/review-findings-probe/.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 420_000;
const FORK_DEADLINE_MS = 300_000;
const SEED_LINES = 900;

// Mirrors scripts/capture-provider-fixtures.mjs (and provider-process-security.ts).
const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TERM',
  'COLORTERM', 'NO_COLOR',
];
const CLAUDE_ENVIRONMENT_VARIABLES = ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];
const CODEX_ENVIRONMENT_VARIABLES = ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
const KEPT_ATTRIBUTES = new Set([
  'event.name', 'event.timestamp', 'query_source', 'query_source_safe', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'speed', 'effort', 'agent_id',
]);

const REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];
const REVIEW_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const CLAUDE_SEED_SUFFIX = 'The list above is reference data for later questions. Do not use any tools. Reply with exactly: OK';
const CODEX_SEED_SUFFIX = 'The list above is reference data for later questions. Do not run any commands or read files. Reply with exactly: OK';
const CLAUDE_WARM = 'Without tools: what is the code name of module 0017? Answer in one short line.';
const CODEX_WARM = 'Without running commands: what is the code name of module 0017? Answer in one short line.';
const SIDE_QUESTION = 'What is the code name of module 0042? One word.';
const FORK_QUESTION = 'This is a side question about the conversation so far. Do not read files, run commands or edit anything: '
  + 'answer only from what is already in this conversation, in one short reply. Question: what is the code name of module 0042?';

const tinySchema = (property) => ({ type: 'object', additionalProperties: false, required: [property], properties: { [property]: { type: 'string' } } });

const CLAUDE_FORKS = {
  F0: { settings: 'same options as C', options: () => ({}) },
  F1: { settings: 'outputFormat only', options: (pass) => ({ outputFormat: { type: 'json_schema', schema: tinySchema(`answer_f1_p${pass}`) } }) },
  F2: { settings: "tools ['Read','Grep','Glob'] only", options: () => ({ tools: [...REVIEW_TOOLS] }) },
  F3: {
    settings: "review design: tools ['Read','Grep','Glob'] + disallowedTools + permissionPrompts 'none' + outputFormat",
    options: (pass) => ({
      tools: [...REVIEW_TOOLS], disallowedTools: [...REVIEW_WRITE_TOOLS], permissionPrompts: 'none',
      outputFormat: { type: 'json_schema', schema: tinySchema(`answer_f3_p${pass}`) },
    }),
  },
};
const CODEX_FORKS = {
  G0: { settings: "sandbox 'read-only' + approvalPolicy 'never' (btw shape)", fork: { sandbox: 'read-only', approvalPolicy: 'never' }, schema: null },
  G1: { settings: 'G0 + outputSchema', fork: { sandbox: 'read-only', approvalPolicy: 'never' }, schema: 'answer_g1' },
  G2: { settings: 'no override', fork: {}, schema: null },
  G3: { settings: 'no override + outputSchema', fork: {}, schema: 'answer_g3' },
};

const DEFINITIONS = {
  claudeFirstCall: "Earliest api_request (by event.timestamp) of the step with query_source 'sdk' ('side_question' for B), from the step's own process (forks) or turn window (C). Fallback: earliest non-title request, flagged in firstPickedBy.",
  claudeConversationCache: "C's warm turn, last api_request with query_source 'sdk': cache_read + cache_creation.",
  claudeRatio: 'first-call cache_read / claudeConversationCache.',
  claudeSdkCrossCheck: "The SDK's assistant-message usage of the step's first model call (parent_tool_use_id null); not available for B.",
  codexFirstCall: 'First thread/tokenUsage/updated `last` whose turnId is the step\'s turn.',
  codexConversationCache: "P2 (the parent's warm turn) first-call cached input tokens.",
  codexRatio: 'first-call cached / P2.cached.',
  codexConversationSpecific: '(case.cached - fresh.cached) / (P2.cached - fresh.cached): reuse beyond the prefix every new thread shares.',
  schema: 'Tiny {answer_<case>_p<pass>: string} schema (not REVIEW_FINDINGS_JSON_SCHEMA); the property name differs per case and pass.',
};

function parseArguments(argv) {
  const options = { repeat: 1, only: ['claude', 'codex'], claudeLane: 'product' };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--only') options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--claude-lane') options.claudeLane = value;
    else if (flag === '--claude-executable') options.claudeExecutable = path.resolve(value);
    else if (flag === '--codex-script') options.codexScript = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the providers only ever run below it.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer.');
  if (!['product', 'isolated'].includes(options.claudeLane)) throw new Error('--claude-lane is product or isolated.');
  return options;
}

function pathDirectories() {
  return (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean);
}

function resolveClaudeExecutable() {
  for (const directory of pathDirectories()) {
    for (const candidate of [
      path.join(directory, 'claude.exe'),
      path.join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Claude Code executable not found; pass --claude-executable.');
}

function resolveCodexScript() {
  for (const directory of pathDirectories()) {
    const candidate = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Codex CLI not found; pass --codex-script <.../@openai/codex/bin/codex.js>.');
}

function providerEnvironment(names, fixed = {}) {
  const environment = {};
  for (const name of new Set([...REQUIRED_OS_ENVIRONMENT_VARIABLES, ...names])) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...fixed };
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (error) => String(error?.rpc?.message ?? error?.message ?? error).slice(0, 400);
const log = (text) => console.error(`[probe] ${new Date().toISOString()} ${text}`);
const rotate = (list, by) => list.map((_, index) => list[(index + by) % list.length]);
const number = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Number(value));
const ratio = (part, whole) => (part === null || part === undefined || !whole ? null : Math.round((part / whole) * 1_000) / 1_000);

/** Rejects after `ms`; the timer is cleared either way so the process can exit. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function seedText(nonce) {
  const words = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper',
    'kelp', 'lumen', 'meadow', 'nickel', 'onyx', 'pylon', 'quartz', 'raven', 'sierra', 'tundra'];
  const out = [`Reference set ${nonce}`];
  for (let index = 1; index <= SEED_LINES; index += 1) {
    const word = words[(index * 7) % words.length];
    const other = words[(index * 11 + 3) % words.length];
    out.push(`Module ${String(index).padStart(4, '0')}: code name ${word}-${index}; owner team ${other}; `
      + `depends on module ${String(((index * 13) % 900) + 1).padStart(4, '0')}; status ${index % 3 === 0 ? 'stable' : 'beta'}; `
      + `notes: keeps a ${word} cache and reports to the ${other} board every ${index % 7 + 1} days.`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Claude

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
          const resourceTag = value((resourceLogs.resource?.attributes ?? []).find((entry) => entry.key === 'probe.step')?.value);
          for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
            for (const record of scopeLogs.logRecords ?? []) {
              const attributes = {};
              for (const attribute of record.attributes ?? []) {
                if (KEPT_ATTRIBUTES.has(attribute.key)) attributes[attribute.key] = value(attribute.value);
              }
              const name = attributes['event.name'] ?? value(record.body);
              if (name === 'api_request' || name === 'claude_code.api_request') {
                events.push({ receivedAt: Date.now(), tag: pathTag && pathTag !== 'v1' ? pathTag : resourceTag ?? null, ...attributes });
              }
            }
          }
        }
      } catch {
        // Ignore a malformed export; the probe reports missing telemetry instead.
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
  OTEL_RESOURCE_ATTRIBUTES: `probe.step=${tag}`,
});

/** Tools are denied; StructuredOutput is the outputFormat answer channel, not a tool use. */
const denyTools = async (toolName, toolInput, toolOptions) => (toolName === 'StructuredOutput'
  ? { behavior: 'allow', updatedInput: toolInput, toolUseID: toolOptions?.toolUseID }
  : { behavior: 'deny', message: 'Probe: no tools.', toolUseID: toolOptions?.toolUseID });

function openClaude(query, options) {
  const input = new AsyncQueue();
  const session = query({ prompt: input, options });
  const state = { results: [], calls: [], tools: null, streamError: null };
  const seen = new Set();
  let waiter;
  const iterate = (async () => {
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init' && Array.isArray(message.tools)) {
        state.tools = [...message.tools];
      } else if (message.type === 'assistant' && !message.parent_tool_use_id && message.message?.usage) {
        const id = message.message.id ?? `call-${state.calls.length}`;
        if (!seen.has(id)) {
          seen.add(id);
          const usage = message.message.usage;
          state.calls.push({
            input: number(usage.input_tokens), cacheRead: number(usage.cache_read_input_tokens), cacheCreation: number(usage.cache_creation_input_tokens),
          });
        }
      } else if (message.type === 'result') {
        state.results.push({
          subtype: message.subtype ?? null, numTurns: message.num_turns ?? null, hasStructuredOutput: message.structured_output !== undefined,
          permissionDenials: (message.permission_denials ?? []).map((denial) => denial.tool_name),
        });
        waiter?.();
      }
    }
  })();
  iterate.catch((error) => { state.streamError = errorText(error); waiter?.(); });
  const turn = async (text, sessionId, deadlineMs) => {
    const resultsBefore = state.results.length;
    const callsBefore = state.calls.length;
    const startedAt = Date.now();
    const done = new Promise((resolve) => {
      waiter = () => { if (state.results.length > resultsBefore || state.streamError) resolve(true); };
    });
    input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId });
    let finished = false;
    try {
      finished = await withTimeout(done, deadlineMs, 'turn');
    } catch {
      finished = false;
    }
    const result = state.results[resultsBefore] ?? null;
    return {
      startedAt, endedAt: Date.now(), finished: finished && Boolean(result),
      durationMs: Date.now() - startedAt, resultSubtype: result?.subtype ?? null, numTurns: result?.numTurns ?? null,
      hasStructuredOutput: result?.hasStructuredOutput ?? null, permissionDenials: result?.permissionDenials ?? [],
      sdkCalls: state.calls.slice(callsBefore), streamError: state.streamError,
    };
  };
  const close = async () => {
    input.close();
    session.close();
    await Promise.race([iterate.catch(() => undefined), delay(5_000)]);
  };
  return { session, state, turn, close };
}

function toolDiff(tools, reference) {
  if (!tools || !reference) return null;
  const mine = new Set(tools);
  const theirs = new Set(reference);
  return { removed: reference.filter((name) => !mine.has(name)), added: tools.filter((name) => !theirs.has(name)) };
}

const turnFacts = (turn) => Object.fromEntries(Object.entries(turn).filter(([key]) => key !== 'startedAt' && key !== 'endedAt'));

async function claudePass(context, pass, order) {
  const { query, executable, workspace, telemetry, options, facts } = context;
  const origin = Date.now();
  const conversationId = randomUUID();
  const isolated = options.claudeLane === 'isolated';
  const tag = (step) => `p${pass}-${step}`;
  const sessionOptions = (step, extra = {}) => ({
    cwd: workspace,
    pathToClaudeCodeExecutable: executable,
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
    canUseTool: denyTools,
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    persistSession: true,
    env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      ...(isolated ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } : {}),
      ...telemetryEnvironment(telemetry.port, tag(step)),
    }),
    settingSources: isolated ? [] : ['user', 'project', 'local'],
    ...extra,
  });
  const report = { pass, order, lane: options.claudeLane, steps: {} };
  const windows = [];
  const conversation = openClaude(query, sessionOptions('C', { sessionId: conversationId }));
  let conversationTools = null;
  try {
    const initialization = await withTimeout(conversation.session.initializationResult(), 120_000, 'C initialization');
    facts.claudeVersion ??= initialization?.claude_code_version ?? null;
    for (const [name, text] of [['seed', `${seedText(randomUUID())}\n\n${CLAUDE_SEED_SUFFIX}`], ['warm', CLAUDE_WARM]]) {
      log(`claude p${pass} ${name}`);
      const turn = await conversation.turn(text, conversationId, TURN_DEADLINE_MS);
      windows.push({ name, startedAt: turn.startedAt, endedAt: turn.endedAt });
      report.steps[name] = { kind: 'turn', settings: 'conversation C', ...turnFacts(turn) };
      if (!turn.finished) throw new Error(`C ${name} turn did not finish`);
      await delay(3_500);
    }
    conversationTools = conversation.state.tools;
    report.steps.seed.toolCount = conversationTools?.length ?? null;

    log(`claude p${pass} B`);
    const askedAt = Date.now();
    try {
      const answer = await conversation.session.askSideQuestion(SIDE_QUESTION, { signal: AbortSignal.timeout(180_000) });
      report.steps.B = { kind: 'side-question', settings: 'C.askSideQuestion (/btw)', ok: true, durationMs: Date.now() - askedAt, answered: Boolean(answer?.response), synthetic: answer?.synthetic ?? null };
    } catch (error) {
      report.steps.B = { kind: 'side-question', settings: 'C.askSideQuestion (/btw)', ok: false, durationMs: Date.now() - askedAt, error: errorText(error) };
    }
    await delay(3_500);

    for (const name of order) {
      log(`claude p${pass} ${name}`);
      const spec = CLAUDE_FORKS[name];
      const step = { kind: 'fork', settings: spec.settings };
      const fork = openClaude(query, sessionOptions(name, { resume: conversationId, forkSession: true, persistSession: false, ...spec.options(pass) }));
      try {
        await withTimeout(fork.session.initializationResult(), 120_000, `${name} initialization`);
        const turn = await fork.turn(FORK_QUESTION, conversationId, FORK_DEADLINE_MS);
        Object.assign(step, turnFacts(turn));
        if (!turn.finished) step.error = turn.streamError ?? 'fork turn did not finish';
        await delay(3_500); // The fork's telemetry exports every second; closing may not flush.
      } catch (error) {
        step.error = errorText(error);
      } finally {
        await fork.close();
      }
      step.toolCount = fork.state.tools?.length ?? null;
      step.sameToolsAsC = fork.state.tools && conversationTools
        ? fork.state.tools.length === conversationTools.length && toolDiff(fork.state.tools, conversationTools).added.length === 0
        : null;
      const diff = toolDiff(fork.state.tools, conversationTools);
      if (diff) log(`claude p${pass} ${name} tools vs C: removed ${JSON.stringify(diff.removed)} added ${JSON.stringify(diff.added)}`);
      report.steps[name] = step;
      await delay(1_500);
    }
  } catch (error) {
    report.error = errorText(error);
    log(`claude p${pass} error: ${report.error}`);
  } finally {
    await conversation.close();
  }
  return { pass, origin, windows, report };
}

function requestFacts(event, origin) {
  const at = Date.parse(event['event.timestamp'] ?? '') || event.receivedAt;
  return {
    atMs: at - origin, source: event.query_source ?? event.query_source_safe ?? null, model: event.model ?? null,
    input: number(event.input_tokens), cacheRead: number(event.cache_read_tokens), cacheCreation: number(event.cache_creation_tokens),
    output: number(event.output_tokens), durationMs: number(event.duration_ms),
  };
}

function pickFirst(requests, side) {
  const exact = requests.find((request) => (side ? String(request.source ?? '').includes('side') : request.source === 'sdk'));
  if (exact) return { first: exact, firstPickedBy: side ? 'query_source=side_question' : 'query_source=sdk' };
  const fallback = requests.find((request) => request.source !== 'generate_session_title');
  return fallback ? { first: fallback, firstPickedBy: 'fallback:first-non-title' } : { first: null, firstPickedBy: 'missing-telemetry' };
}

/** Attaches each pass's telemetry to its steps and builds the pass's table. */
function attributeClaude(entry, events) {
  const { pass, origin, windows, report } = entry;
  const prefix = `p${pass}-`;
  const byStep = new Map();
  for (const event of events.filter((candidate) => String(candidate.tag ?? '').startsWith(prefix))) {
    const owner = event.tag.slice(prefix.length);
    let name = owner;
    if (owner === 'C') {
      const at = Date.parse(event['event.timestamp'] ?? '') || event.receivedAt;
      if (String(event.query_source ?? event.query_source_safe ?? '').includes('side')) name = 'B';
      else name = windows.find((window) => at >= window.startedAt - 250 && at <= window.endedAt + 3_000)?.name ?? 'C-other';
    }
    byStep.set(name, [...(byStep.get(name) ?? []), requestFacts(event, origin)]);
  }
  for (const name of new Set([...Object.keys(report.steps), ...byStep.keys()])) {
    const step = report.steps[name] ?? (report.steps[name] = { kind: 'other' });
    const requests = (byStep.get(name) ?? []).sort((left, right) => left.atMs - right.atMs);
    step.requests = requests;
    Object.assign(step, pickFirst(requests, name === 'B'));
  }
  const warm = report.steps.warm;
  const lastMain = (warm?.requests ?? []).filter((request) => request.source === 'sdk').at(-1);
  const lastSdk = warm?.sdkCalls?.at(-1);
  report.conversationCache = lastMain ? (lastMain.cacheRead ?? 0) + (lastMain.cacheCreation ?? 0)
    : lastSdk ? (lastSdk.cacheRead ?? 0) + (lastSdk.cacheCreation ?? 0) : null;
  report.conversationCacheFrom = lastMain ? 'telemetry' : lastSdk ? 'sdk-usage' : 'missing';
  report.table = ['seed', 'warm', 'B', ...Object.keys(CLAUDE_FORKS)].filter((name) => report.steps[name]).map((name) => {
    const step = report.steps[name];
    const sdk = step.sdkCalls?.[0] ?? null;
    return {
      case: name, settings: step.settings, error: step.error ?? null,
      input: step.first?.input ?? null, cacheRead: step.first?.cacheRead ?? null, cacheCreation: step.first?.cacheCreation ?? null,
      ratio: ratio(step.first?.cacheRead, report.conversationCache), firstPickedBy: step.firstPickedBy, requests: step.requests.length,
      sdkFirstCall: sdk, sdkRatio: ratio(sdk?.cacheRead, report.conversationCache),
      toolCount: step.toolCount ?? null, sameToolsAsC: step.sameToolsAsC ?? null, hasStructuredOutput: step.hasStructuredOutput ?? null,
    };
  });
}

async function runClaude(options, facts) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const executable = options.claudeExecutable ?? resolveClaudeExecutable();
  facts.claudeCli = executable;
  facts.claudeSdk = JSON.parse(readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
  facts.claudeLane = options.claudeLane;
  const workspace = path.join(options.scratch, `claude-fork-cache-${options.claudeLane}`);
  await fs.mkdir(workspace, { recursive: true });
  const telemetry = await startTelemetryReceiver();
  const entries = [];
  try {
    for (let pass = 1; pass <= options.repeat; pass += 1) {
      entries.push(await claudePass({ query, executable, workspace, telemetry, options, facts }, pass, rotate(Object.keys(CLAUDE_FORKS), pass - 1)));
    }
  } finally {
    await delay(3_000);
    telemetry.server.close();
  }
  for (const entry of entries) attributeClaude(entry, telemetry.events);
  facts.claudeTelemetry = {
    events: telemetry.events.length,
    untagged: telemetry.events.filter((event) => !event.tag).length,
    tags: [...new Set(telemetry.events.map((event) => event.tag))],
  };
  return entries.map((entry) => entry.report);
}

// ---------------------------------------------------------------------------
// Codex

function startAppServer(codexScript, workspace) {
  const child = spawn(process.execPath, [codexScript, 'app-server'], {
    cwd: workspace, env: providerEnvironment(CODEX_ENVIRONMENT_VARIABLES), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  const waiters = [];
  const usage = new Map(); // threadId -> [{ at, turnId, last }] in arrival order
  const toolItems = new Map(); // threadId -> started tool item types
  const approvals = new Map(); // threadId -> approval requests declined
  const answers = new Map(); // threadId -> last agent message (kept in memory only)
  const recent = new Map(); // threadId -> last notification methods (diagnostics)
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const send = (frame) => child.stdin.write(`${JSON.stringify(frame)}\n`);
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const waitFor = (predicate, ms) => new Promise((resolve, reject) => {
    const waiter = { predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } };
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error('Timed out waiting for a notification.'));
    }, ms);
    waiters.push(waiter);
  });
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
    if (frame.id !== undefined && frame.id !== null) {
      const threadId = frame.params?.threadId ?? frame.params?.conversationId ?? 'unknown';
      approvals.set(threadId, (approvals.get(threadId) ?? 0) + 1);
      const legacy = frame.method === 'execCommandApproval' || frame.method === 'applyPatchApproval';
      send({ jsonrpc: '2.0', id: frame.id, ...(frame.method.includes('pproval')
        ? { result: legacy ? { decision: { denied: { rejection: 'Probe: no tools.' } } } : { decision: 'decline' } }
        : { error: { code: -32601, message: `No handler for ${frame.method}.` } }) });
      return;
    }
    const noted = frame.params?.threadId ?? frame.params?.thread?.id ?? 'none';
    recent.set(noted, [...(recent.get(noted) ?? []), frame.method === 'error' ? `error:${String(frame.params?.error?.message ?? frame.params?.message ?? '').slice(0, 160)}` : frame.method].slice(-25));
    if (frame.method === 'thread/tokenUsage/updated') {
      const { threadId, turnId, tokenUsage } = frame.params ?? {};
      if (threadId && tokenUsage?.last) usage.set(threadId, [...(usage.get(threadId) ?? []), { at: Date.now(), turnId: turnId ?? null, last: tokenUsage.last }]);
    }
    if (frame.method === 'item/started') {
      const type = frame.params?.item?.type;
      if (type && !['userMessage', 'agentMessage', 'reasoning'].includes(type)) {
        const threadId = frame.params?.threadId ?? 'unknown';
        toolItems.set(threadId, [...(toolItems.get(threadId) ?? []), type]);
      }
    }
    if (frame.method === 'item/completed' && frame.params?.item?.type === 'agentMessage') {
      answers.set(frame.params?.threadId ?? 'unknown', String(frame.params.item.text ?? ''));
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
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_192); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, request, send, waitFor, usage, toolItems, approvals, answers, recent, exited, stderr: () => stderr };
}

const codexUsage = (update) => (update ? {
  input: number(update.last.inputTokens), cached: number(update.last.cachedInputTokens), cacheWrite: number(update.last.cacheWriteInputTokens),
  output: number(update.last.outputTokens), reasoning: number(update.last.reasoningOutputTokens),
} : null);

async function codexTurn(server, threadId, label, text, extra, deadlineMs) {
  log(`codex ${label}`);
  const startedAt = Date.now();
  const completed = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId, deadlineMs);
  let turnId;
  try {
    const started = await server.request('turn/start', {
      threadId, clientUserMessageId: `probe-${randomUUID()}`, input: [{ type: 'text', text, text_elements: [] }], ...extra,
    });
    turnId = started?.turn?.id ?? null;
  } catch (caught) {
    completed.catch(() => undefined);
    return { status: null, error: `turn/start: ${errorText(caught)}` };
  }
  let status = null;
  let error = null;
  try {
    status = (await completed).params?.turn?.status ?? null;
  } catch (caught) {
    error = `${caught.message} recent=${JSON.stringify((server.recent.get(threadId) ?? []).slice(-10))}`;
    await server.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
  }
  await delay(500);
  const all = server.usage.get(threadId) ?? [];
  const mine = all.filter((update) => (turnId && update.turnId === turnId) || (!update.turnId && update.at >= startedAt));
  const answer = server.answers.get(threadId);
  let answerIsJson = null;
  if (extra.outputSchema && answer !== undefined) {
    try { answerIsJson = typeof JSON.parse(answer) === 'object'; } catch { answerIsJson = false; }
  }
  return {
    status, durationMs: Date.now() - startedAt, error,
    first: codexUsage(mine[0]), last: codexUsage(mine.at(-1)), updates: mine.length,
    preTurnUpdates: all.filter((update) => update.at < startedAt).length,
    toolItems: [...(server.toolItems.get(threadId) ?? [])], approvals: server.approvals.get(threadId) ?? 0,
    ...(extra.outputSchema ? { answerIsJson } : {}),
  };
}

async function codexPass(server, workspace, pass, order) {
  const standard = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  const report = { pass, order, steps: {} };
  const started = await server.request('thread/start', {
    cwd: workspace, runtimeWorkspaceRoots: [workspace], ...standard, ephemeral: false, historyMode: 'paginated', threadSource: 'ezterminal',
  });
  const parentId = started.thread.id;
  report.model = started.model ?? null;
  report.reasoningEffort = started.reasoningEffort ?? null;
  try {
    report.steps.P1 = { kind: 'turn', settings: 'parent P (standard)', ...(await codexTurn(server, parentId, `p${pass}-P1`,
      `${seedText(randomUUID())}\n\n${CODEX_SEED_SUFFIX}`, {}, TURN_DEADLINE_MS)) };
    report.steps.P2 = { kind: 'turn', settings: 'parent P (standard)', ...(await codexTurn(server, parentId, `p${pass}-P2`, CODEX_WARM, {}, TURN_DEADLINE_MS)) };
    if (report.steps.P1.status !== 'completed' || report.steps.P2.status !== 'completed') throw new Error('parent turns did not complete');
    for (const name of order) {
      const spec = CODEX_FORKS[name];
      try {
        const forked = await server.request('thread/fork', {
          threadId: parentId, ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', ...spec.fork,
        });
        const forkId = forked.thread.id;
        const turn = await codexTurn(server, forkId, `p${pass}-${name}`, FORK_QUESTION,
          spec.schema ? { outputSchema: tinySchema(`${spec.schema}_p${pass}`) } : {}, FORK_DEADLINE_MS);
        report.steps[name] = { kind: 'fork', settings: spec.settings, ...turn };
        await server.request('thread/unsubscribe', { threadId: forkId }).catch(() => undefined);
      } catch (caught) {
        report.steps[name] = { kind: 'fork', settings: spec.settings, error: errorText(caught) };
      }
    }
    try {
      const fresh = await server.request('thread/start', {
        cwd: workspace, runtimeWorkspaceRoots: [workspace], ...standard, ephemeral: true, historyMode: 'paginated', threadSource: 'ezterminal',
      });
      report.steps.fresh = { kind: 'fresh', settings: 'new ephemeral thread (standard)', ...(await codexTurn(server, fresh.thread.id, `p${pass}-fresh`,
        'Without running commands: reply with exactly OK.', {}, FORK_DEADLINE_MS)) };
      await server.request('thread/unsubscribe', { threadId: fresh.thread.id }).catch(() => undefined);
    } catch (caught) {
      report.steps.fresh = { kind: 'fresh', error: errorText(caught) };
    }
  } catch (caught) {
    report.error = errorText(caught);
    log(`codex p${pass} error: ${report.error}`);
  } finally {
    await server.request('thread/unsubscribe', { threadId: parentId }).catch(() => undefined);
  }
  const conversation = report.steps.P2?.first?.cached ?? null;
  const fresh = report.steps.fresh?.first?.cached ?? null;
  report.conversationCache = conversation;
  report.conversationInput = report.steps.P2?.first?.input ?? null;
  report.table = ['P1', 'P2', ...Object.keys(CODEX_FORKS), 'fresh'].filter((name) => report.steps[name]).map((name) => {
    const step = report.steps[name];
    const cached = step.first?.cached ?? null;
    return {
      case: name, settings: step.settings ?? null, status: step.status ?? null, error: step.error ?? null,
      input: step.first?.input ?? null, cached, ratio: ratio(cached, conversation),
      conversationSpecific: cached === null || fresh === null || conversation === null ? null : ratio(cached - fresh, conversation - fresh),
      updates: step.updates ?? null, toolItems: step.toolItems?.length ?? null, answerIsJson: step.answerIsJson ?? null,
    };
  });
  return report;
}

async function runCodex(options, facts) {
  const codexScript = options.codexScript ?? resolveCodexScript();
  facts.codexScript = codexScript;
  const workspace = path.join(options.scratch, 'codex-fork-cache');
  await fs.mkdir(workspace, { recursive: true });
  const server = startAppServer(codexScript, workspace);
  const passes = [];
  try {
    const initialized = await server.request('initialize', {
      clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.send({ jsonrpc: '2.0', method: 'initialized' });
    facts.codexVersion = String(initialized?.userAgent ?? '').match(/\d+\.\d+\.\d+/u)?.[0] ?? null;
    for (let pass = 1; pass <= options.repeat; pass += 1) {
      try {
        passes.push(await codexPass(server, workspace, pass, rotate(Object.keys(CODEX_FORKS), pass - 1)));
      } catch (caught) {
        passes.push({ pass, error: errorText(caught) });
      }
    }
  } catch (caught) {
    passes.push({ error: errorText(caught), stderrTail: server.stderr().slice(-600) });
  } finally {
    server.child.stdin.end();
    await Promise.race([server.exited, delay(5_000)]);
    if (server.child.exitCode === null) server.child.kill();
  }
  return passes;
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const out = path.join(root, 'artifacts', 'review-findings-probe');
  await fs.mkdir(options.scratch, { recursive: true });
  await fs.mkdir(out, { recursive: true });
  const report = {
    probe: 'review-fork-cache', at: new Date().toISOString(),
    facts: { repeat: options.repeat, seedLines: SEED_LINES }, definitions: DEFINITIONS, claude: [], codex: [], errors: [],
  };
  if (options.only.includes('claude')) {
    try { report.claude = await runClaude(options, report.facts); } catch (error) { report.errors.push({ provider: 'claude', error: errorText(error) }); }
  }
  if (options.only.includes('codex')) {
    try { report.codex = await runCodex(options, report.facts); } catch (error) { report.errors.push({ provider: 'codex', error: errorText(error) }); }
  }
  const file = path.join(out, `fork-cache-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    file, facts: report.facts, errors: report.errors,
    claude: report.claude.map((pass) => ({ pass: pass.pass, lane: pass.lane, error: pass.error, conversationCache: pass.conversationCache, conversationCacheFrom: pass.conversationCacheFrom, table: pass.table })),
    codex: report.codex.map((pass) => ({ pass: pass.pass, model: pass.model, error: pass.error, conversationCache: pass.conversationCache, conversationInput: pass.conversationInput, table: pass.table })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
