#!/usr/bin/env node
/**
 * Real-provider probe for bundle 2 "turn wrap-up" on Codex: the native next-prompt prediction
 * (thread/prediction/request), a prediction-mode fork and the /btw-shape fork as fallbacks (P2),
 * a recap from a read-only ephemeral fork (P3), and a proposal-only suggest_task MCP tool (P4).
 *
 *   node scripts/probe-codex-turn-wrap-up.mjs --scratch <dir> [--repeat 2] [--only A,AL,B,BI,D]
 *        [--allow-unsandboxed] [--codex-script <codex.js>]
 *
 * Installed app-server; thread shapes mirror src/main/codex-provider-adapter.ts. Per pass, each thread
 * works in a fresh seeded repo (scripts/review-probe-repo.mjs) below --scratch; seeds carry a nonce.
 *
 * Safety (fails closed). The editing conversations (A, AL, B, BI) cannot use the standard preset on this
 * PC: every workspace-write sandbox command hangs (`codex sandbox` with :workspace times out). Without
 * --allow-unsandboxed they are skipped with a note; only D (no shell needed, real presets) runs. With it,
 * they run sandbox 'danger-full-access' + approvalPolicy 'untrusted', so commands and patches come to this
 * probe's handler: it declines every command, accepts a file change only when every path is inside the
 * scratch repo (and no grantRoot outside it), accepts the suggest_task MCP approval, declines anything
 * else, and records each decision. A guard records any command or file change that completes without an
 * accepted approval and interrupts that turn. Since every command is declined, the editing turns quote
 * the repo's files in the prompt (as data, not instructions) and ask for apply_patch.
 *
 *   A   P2 + P3: seed (~40k tokens), T1 fix src/format.ts (edits; ends by asking the person), T2 English,
 *       T3-T5 Korean. After every turn: thread/prediction/request {threadId, sourceTurnId}. Forks: after
 *       T1 PM (experimentalPredictionMode, inherited effort) and RC (recap; btw shape: ephemeral, read-only,
 *       approvals never, no outputSchema); after T2 PMlow (PM + turn effort 'low') and BW (btw shape asked
 *       for the next message); after T5 PM and RC. Once per pass: does a PM fork accept read-only/never?
 *   AL  A's turns; after T1, T2 and T5 the btw-shape next-message fork twice: inherited effort (BW) and the
 *       lowest effort model/list advertises for the thread's model on turn/start (BWlow).
 *   B   P4: A's thread + the suggest_task HTTP MCP server in thread config (the product's
 *       orchestrationConfig shape). Seed, T1 fix only src/cart.ts, T2 one-line summary.
 *   BI  B + thread/start developerInstructions telling Codex to propose out-of-scope work with suggest_task.
 *   D   approvals: fresh threads told to call suggest_task once: standard (on-request + workspace-write),
 *       plan (never + read-only), standard with the tool not annotated read-only, and that unannotated
 *       tool + mcp_servers.<server>.tools.suggest_task.approval_mode 'approve'.
 * Fork turns are interrupted at their first tool item (the product's side-question rule) and their
 * approvals declined. Usage: each turn's first thread/tokenUsage/updated `last`.
 * Report: artifacts/wrap-up-probe/codex-<time>.json, rewritten after every thread. Prediction, recap and
 * suggest_task texts are kept (they are about the scratch repo).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReviewRepo } from './review-probe-repo.mjs';
import {
  CODEX_ENVIRONMENT_VARIABLES, CODEX_SIDE_QUESTION_INSTRUCTION, PREDICT_INSTRUCTION, PROMPTS, RECAP_INSTRUCTION,
  SUGGEST_SERVER, SUGGEST_TOOL, changedFiles, delay, errorText, fileHashes, log, number, providerEnvironment, ratio,
  recapFlags, seedText, startSuggestionServer, writeReport,
} from './wrap-up-probe-kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 420_000;
const FORK_DEADLINE_MS = 300_000;
const DIRECT_DEADLINE_MS = 240_000;
const PREDICTION_WAIT_MS = 60_000;
const STEPS = ['A', 'AL', 'B', 'BI', 'D'];
const EDITING_STEPS = new Set(['A', 'AL', 'B', 'BI']);
const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall']);
/** Only with --allow-unsandboxed: every command and patch asks, and the handler decides (see header). */
const UNSANDBOXED_CONVERSATION = { approvalPolicy: 'untrusted', sandbox: 'danger-full-access' };
const PRESETS = {
  standard: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  plan: { approvalPolicy: 'never', sandbox: 'read-only' },
};
const D_VARIANTS = {
  standard: { settings: 'standard preset (on-request + workspace-write), tool annotated read-only', preset: 'standard', annotated: true },
  plan: { settings: 'plan preset (never + read-only), tool annotated read-only', preset: 'plan', annotated: true },
  approve: { settings: "standard, tool without annotations + mcp_servers.<server>.tools.suggest_task.approval_mode 'approve'", preset: 'standard', annotated: false, approve: true },
  unannotated: { settings: 'standard, tool without annotations', preset: 'standard', annotated: false },
};
const BTW_FORK = { sandbox: 'read-only', approvalPolicy: 'never' };
const FORKS = {
  PM: { settings: 'thread/fork experimentalPredictionMode (inherits config, tools, effort)', fork: { experimentalPredictionMode: true }, prompt: 'predict' },
  PMlow: { settings: "PM + turn/start effort 'low'", fork: { experimentalPredictionMode: true }, prompt: 'predict', turn: { effort: 'low' } },
  BW: { settings: 'btw shape (ephemeral, read-only, approvals never, no outputSchema) asked for the next message, inherited effort', fork: BTW_FORK, prompt: 'btw-predict' },
  BWlow: { settings: 'BW + turn/start effort = the lowest effort model/list advertises', fork: BTW_FORK, prompt: 'btw-predict', lowestEffort: true },
  RC: { settings: 'btw shape asked for the recap', fork: BTW_FORK, prompt: 'recap' },
};
const SCHEDULES = {
  A: { 'T1-fix': ['PM', 'RC'], 'T2-english': ['PMlow', 'BW'], 'T5-korean': ['PM', 'RC'] },
  AL: { 'T1-fix': ['BW', 'BWlow'], 'T2-english': ['BW', 'BWlow'], 'T5-korean': ['BW', 'BWlow'] },
};
const forkPrompt = (kind) => (kind === 'predict' ? `Do not use any tools or run any commands. ${PREDICT_INSTRUCTION}`
  : kind === 'btw-predict' ? `${CODEX_SIDE_QUESTION_INSTRUCTION}\n\nQuestion: ${PREDICT_INSTRUCTION}`
    : `${CODEX_SIDE_QUESTION_INSTRUCTION}\n\nQuestion: ${RECAP_INSTRUCTION}`);
const SUGGEST_DEVELOPER_INSTRUCTIONS = 'When you notice work outside the current request (other bugs, missing tests, stale docs), '
  + 'do not do it; call the suggest_task tool with a self-contained prompt for each item instead.';
const EDIT_RULES = 'Shell commands are not available in this conversation: every command you start is declined. The '
  + "repository's files are quoted below; make your edit with apply_patch and do not run tests, builds or installs.";
const CODEX_EDIT_PROMPTS = {
  fixFormat: 'In this repository, formatPrice in src/format.ts shows prices ten times too large. Please fix it, changing '
    + 'only src/format.ts. When you are done, ask me whether I also want a unit test for it.',
  fixCart: 'Please fix the bug in src/cart.ts: cartTotal reads past the end of the items array. Fix only that bug and '
    + 'change only src/cart.ts. Read the other quoted files first so your change fits the codebase.',
};
const QUOTED_FILES = ['README.md', 'src/auth.ts', 'src/cart.ts', 'src/discount.ts', 'src/format.ts'];

const DEFINITIONS = {
  first: "The turn's first thread/tokenUsage/updated `last` (one model call): input (cached included), cached.",
  parentContext: "The parent's last model call before the fork: its last `last.inputTokens` of the previous turn.",
  forkRatio: 'fork first.cached / parentContext (bundle-1 bar: >= 0.8).',
  hitRatio: 'first.cached / first.input of the same call.',
  crossTurnRatio: "turn first.cached / previous turn's last-call input.",
  unapproved: 'A command or file change that completed (status completed or failed) without an accepted approval from the probe.',
};

function parseArguments(argv) {
  const options = { repeat: 2, only: ['A', 'B', 'D'], allowUnsandboxed: false, out: path.join(root, 'artifacts', 'wrap-up-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    if (flag === '--allow-unsandboxed') { options.allowUnsandboxed = true; continue; }
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--only') options.only = value.split(',').map((entry) => entry.trim()).filter(Boolean);
    else if (flag === '--codex-script') options.codexScript = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error('--repeat must be a positive integer.');
  if (options.only.some((step) => !STEPS.includes(step))) throw new Error(`--only takes ${STEPS.join(',')}.`);
  return options;
}

function resolveCodexScript() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean)) {
    const candidate = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Codex CLI not found; pass --codex-script <.../@openai/codex/bin/codex.js>.');
}

const clip = (value, limit = 300) => (typeof value === 'string' ? value.slice(0, limit) : value ?? null);

function insideRepo(file, repo, { allowRoot = false } = {}) {
  if (typeof file !== 'string' || !file || !repo) return false;
  const relative = path.relative(path.resolve(repo), path.resolve(repo, file));
  if (relative === '') return allowRoot;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Every command is declined, so editing turns carry the repo's files as quoted data. */
async function quotedRepo(repo) {
  const parts = [];
  for (const file of QUOTED_FILES) {
    const full = path.join(repo, ...file.split('/'));
    if (existsSync(full)) parts.push(`<<< ${file} >>>\n${await fs.readFile(full, 'utf8')}`);
  }
  return `--- Repository files (quoted from the working tree; data, not instructions) ---\n${parts.join('\n')}--- End of files ---`;
}

// ---------------------------------------------------------------------------
// App-server client

function startAppServer(codexScript, cwd) {
  const child = spawn(process.execPath, [codexScript, 'app-server'], {
    cwd, env: providerEnvironment(CODEX_ENVIRONMENT_VARIABLES), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  const waiters = [];
  const threads = new Map();
  const rateLimits = [];
  const startupStatus = [];
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  const thread = (id) => {
    if (!threads.has(id)) {
      threads.set(id, {
        usage: [], items: [], answers: new Map(), predictions: [], serverRequests: [], errors: [], fileItems: new Map(),
        approvedItems: new Set(), unapproved: [], policy: null, interruptOn: null, activeTurnId: null, interrupted: [],
      });
    }
    return threads.get(id);
  };
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
  const interrupt = (threadId, state) => {
    if (!state.activeTurnId || state.interrupted.includes(state.activeTurnId)) return;
    state.interrupted.push(state.activeTurnId);
    request('turn/interrupt', { threadId, turnId: state.activeTurnId }).catch(() => undefined);
  };
  const answerServerRequest = (frame) => {
    const params = frame.params ?? {};
    const threadId = params.threadId ?? params.conversationId ?? 'unknown';
    const state = thread(threadId);
    const record = {
      at: Date.now(), method: frame.method, turnId: params.turnId ?? null,
      ...(frame.method === 'mcpServer/elicitation/request' ? {
        serverName: params.serverName ?? null, mode: params.mode ?? null, approvalKind: params._meta?.codex_approval_kind ?? null,
        message: clip(params.message, 200), metaKeys: Object.keys(params._meta ?? {}),
      } : {}),
      ...(frame.method.includes('commandExecution') || frame.method === 'execCommandApproval' ? { command: clip(Array.isArray(params.command) ? params.command.join(' ') : params.command, 200) } : {}),
      ...(frame.method.includes('fileChange') || frame.method === 'applyPatchApproval' ? {
        paths: frame.method === 'applyPatchApproval' ? Object.keys(params.fileChanges ?? {}) : state.fileItems.get(params.itemId) ?? null,
        grantRoot: params.grantRoot ?? null,
      } : {}),
    };
    const decision = state.policy ? state.policy(frame.method, params, state) : 'decline';
    record.decision = decision;
    state.serverRequests.push(record);
    const accept = decision === 'accept';
    if (accept && params.itemId) state.approvedItems.add(params.itemId);
    if (accept && params.callId) state.approvedItems.add(params.callId);
    let result;
    if (frame.method === 'mcpServer/elicitation/request') result = { action: accept ? 'accept' : 'decline', content: accept ? {} : null, _meta: null };
    else if (frame.method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
    else if (frame.method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (frame.method === 'execCommandApproval' || frame.method === 'applyPatchApproval') result = { decision: accept ? 'approved' : { denied: { rejection: 'Probe: declined.' } } };
    else if (frame.method.endsWith('/requestApproval')) result = { decision: accept ? 'accept' : 'decline' };
    if (result) send({ jsonrpc: '2.0', id: frame.id, result });
    else send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `No handler for ${frame.method}.` } });
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
    const threadId = params.threadId ?? params.thread?.id ?? null;
    const state = threadId ? thread(threadId) : null;
    const at = Date.now();
    if (frame.method === 'thread/tokenUsage/updated' && state && params.tokenUsage?.last) {
      state.usage.push({ at, turnId: params.turnId ?? null, last: params.tokenUsage.last });
    } else if ((frame.method === 'item/started' || frame.method === 'item/completed') && state) {
      const item = params.item ?? {};
      const entry = { at, phase: frame.method === 'item/started' ? 'started' : 'completed', turnId: params.turnId ?? null, type: item.type ?? null };
      if (item.type === 'mcpToolCall') Object.assign(entry, { server: item.server ?? null, tool: item.tool ?? null, status: item.status ?? null, error: clip(item.error?.message ?? item.error, 200), readOnlyHint: item.readOnlyHint ?? null });
      if (item.type === 'commandExecution') Object.assign(entry, { command: clip(item.command, 160), status: item.status ?? null, exitCode: item.exitCode ?? null });
      if (item.type === 'fileChange') {
        const paths = (item.changes ?? []).map((change) => change.path).filter(Boolean);
        state.fileItems.set(item.id, paths);
        Object.assign(entry, { paths, status: item.status ?? null });
      }
      if (item.type === 'agentMessage' && entry.phase === 'completed') state.answers.set(params.turnId ?? 'none', String(item.text ?? ''));
      if (item.type && !['userMessage', 'reasoning'].includes(item.type) && !(item.type === 'agentMessage' && entry.phase === 'started')) state.items.push(entry);
      // Guard: a command or patch that ran without the probe's accepted approval.
      if (entry.phase === 'completed' && (item.type === 'commandExecution' || item.type === 'fileChange')
        && ['completed', 'failed'].includes(item.status) && !state.approvedItems.has(item.id)) {
        state.unapproved.push({ type: item.type, status: item.status, command: entry.command ?? null, paths: entry.paths ?? null, exitCode: entry.exitCode ?? null });
        interrupt(threadId, state);
      }
      if (entry.phase === 'started' && state.interruptOn?.(item.type)) interrupt(threadId, state);
    } else if (frame.method === 'item/commandExecution/outputDelta' && state && params.itemId && !state.approvedItems.has(params.itemId)) {
      if (!state.unapproved.some((entry) => entry.itemId === params.itemId)) state.unapproved.push({ type: 'commandExecution', itemId: params.itemId, status: 'output' });
      interrupt(threadId, state);
    } else if (frame.method === 'thread/prediction/updated' && state) {
      state.predictions.push({ at, sourceTurnId: params.sourceTurnId ?? null, result: params.result ?? null });
    } else if (frame.method === 'account/rateLimits/updated') {
      const limits = params.rateLimits ?? {};
      rateLimits.push({ at, primary: limits.primary?.usedPercent ?? null, secondary: limits.secondary?.usedPercent ?? null, reached: limits.rateLimitReachedType ?? null });
    } else if (frame.method === 'mcpServer/startupStatus/updated') {
      if (params.name === SUGGEST_SERVER || params.serverName === SUGGEST_SERVER) startupStatus.push({ at, status: params.status ?? null, error: clip(params.error, 200) });
    } else if (frame.method === 'error' && state) {
      state.errors.push(clip(params.error?.message ?? params.message, 200));
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
  return { child, request, send, waitFor, thread, rateLimits, startupStatus, exited, stderr: () => stderr };
}

const usageFacts = (update) => (update ? {
  input: number(update.last.inputTokens), cached: number(update.last.cachedInputTokens), cacheWrite: number(update.last.cacheWriteInputTokens),
  output: number(update.last.outputTokens), reasoning: number(update.last.reasoningOutputTokens),
} : null);

async function codexTurn(server, threadId, label, text, extra = {}, { deadlineMs = TURN_DEADLINE_MS, interruptOn = null } = {}) {
  log(`codex ${label}`);
  const state = server.thread(threadId);
  state.interruptOn = interruptOn;
  const before = { usage: state.usage.length, items: state.items.length, requests: state.serverRequests.length, unapproved: state.unapproved.length };
  const startedAt = Date.now();
  const completed = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId, deadlineMs);
  let turnId = null;
  try {
    const started = await server.request('turn/start', {
      threadId, clientUserMessageId: `probe-${randomUUID()}`, input: [{ type: 'text', text, text_elements: [] }], ...extra,
    });
    turnId = started?.turn?.id ?? null;
    state.activeTurnId = turnId;
  } catch (caught) {
    completed.catch(() => undefined);
    return { label, status: null, error: `turn/start: ${errorText(caught)}` };
  }
  let status = null;
  let error = null;
  try {
    status = (await completed).params?.turn?.status ?? null;
  } catch (caught) {
    error = `${caught.message} errors=${JSON.stringify(state.errors.slice(-3))}`;
    await server.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    await delay(3_000);
  }
  const endedAt = Date.now();
  await delay(500);
  const mine = state.usage.slice(before.usage).filter((update) => !update.turnId || update.turnId === turnId);
  return {
    label, turnId, status, error, startedAt, endedAt, durationMs: endedAt - startedAt,
    first: usageFacts(mine[0]), last: usageFacts(mine.at(-1)), updates: mine.length,
    items: state.items.slice(before.items).filter((item) => !item.turnId || item.turnId === turnId)
      .filter((item) => item.phase === 'completed' || TOOL_ITEM_TYPES.has(item.type)).map(({ at, turnId: _turn, ...rest }) => rest),
    serverRequests: state.serverRequests.slice(before.requests).map(({ at, ...rest }) => rest),
    unapproved: state.unapproved.slice(before.unapproved),
    interrupted: state.interrupted.includes(turnId),
    answer: state.answers.get(turnId) ?? null,
  };
}

/** The product's thread/start (createSession), with this probe's preset and config. */
async function startThread(server, repo, preset, config, developerInstructions) {
  const started = await server.request('thread/start', {
    cwd: repo, runtimeWorkspaceRoots: [repo], ...preset, ...(config ? { config } : {}),
    ...(developerInstructions ? { developerInstructions } : {}),
    ephemeral: false, historyMode: 'paginated', threadSource: 'ezterminal',
  });
  return { threadId: started.thread.id, model: started.model ?? null, reasoningEffort: started.reasoningEffort ?? null, sandbox: started.sandbox?.type ?? null, approvalPolicy: started.approvalPolicy ?? null };
}

const mcpConfig = (endpoint, { approve = false } = {}) => ({
  mcp_servers: {
    [SUGGEST_SERVER]: {
      url: endpoint.url,
      http_headers: { Authorization: `Bearer ${endpoint.token}` },
      tool_timeout_sec: 300,
      ...(approve ? { tools: { [SUGGEST_TOOL]: { approval_mode: 'approve' } } } : {}),
    },
  },
});

/**
 * The editing conversations' approval handler (--allow-unsandboxed): every command is declined; a file
 * change is accepted only when all its paths are inside the scratch repo and it asks for no write root
 * outside it; the suggest_task MCP approval is accepted; anything else is declined.
 */
const conversationPolicy = (repo) => (method, params, state) => {
  if (method === 'mcpServer/elicitation/request') return params._meta?.codex_approval_kind === 'mcp_tool_call' && params.serverName === SUGGEST_SERVER ? 'accept' : 'decline';
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const paths = method === 'applyPatchApproval' ? Object.keys(params.fileChanges ?? {}) : state.fileItems.get(params.itemId) ?? [];
    if (params.grantRoot && !insideRepo(params.grantRoot, repo, { allowRoot: true })) return 'decline';
    return paths.length && paths.every((file) => insideRepo(file, repo)) ? 'accept' : 'decline';
  }
  return 'decline';
};

const decisions = (requests) => {
  const counts = {};
  for (const entry of requests) {
    const key = `${entry.method}:${entry.decision}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

async function serverStatus(server, threadId) {
  try {
    const listed = await server.request('mcpServerStatus/list', { threadId });
    const ours = (listed?.data ?? []).find((entry) => entry.name === SUGGEST_SERVER);
    return ours ? {
      found: true, runtimeStatus: ours.runtimeStatus ?? null, authStatus: ours.authStatus ?? null,
      tools: ours.tools ? Object.keys(ours.tools).length : null, toolsError: clip(ours.toolsError, 200),
    } : { found: false, servers: (listed?.data ?? []).length };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** The lowest reasoning effort model/list advertises for a model (the list runs low to high). */
async function lowestEffort(server, model) {
  try {
    const listed = await server.request('model/list', {});
    const entry = (listed?.data ?? []).find((candidate) => candidate.id === model || candidate.model === model);
    const efforts = (entry?.supportedReasoningEfforts ?? []).map((effort) => (typeof effort === 'string' ? effort : effort?.reasoningEffort ?? effort?.effort)).filter(Boolean);
    return { effort: efforts[0] ?? 'low', advertised: efforts };
  } catch (error) {
    return { effort: 'low', error: errorText(error) };
  }
}

/** Native next-prompt prediction after a turn. */
async function nativePrediction(server, threadId, sourceTurnId) {
  const state = server.thread(threadId);
  const before = { predictions: state.predictions.length, usage: state.usage.length };
  const startedAt = Date.now();
  const facts = { sourceTurnId: Boolean(sourceTurnId) };
  try {
    facts.response = await server.request('thread/prediction/request', { threadId, sourceTurnId });
    facts.ok = true;
  } catch (error) {
    facts.ok = false;
    facts.errorCode = error?.rpc?.code ?? null;
    facts.error = errorText(error);
  }
  facts.requestMs = Date.now() - startedAt;
  if (facts.ok) {
    const deadline = Date.now() + PREDICTION_WAIT_MS;
    while (Date.now() < deadline && state.predictions.length === before.predictions) await delay(250);
    await delay(1_000);
  }
  facts.updates = state.predictions.slice(before.predictions).map((update) => ({ msAfterRequest: update.at - startedAt, result: update.result }));
  facts.usageDuring = state.usage.slice(before.usage).map((update) => ({ turnId: update.turnId === sourceTurnId ? 'source' : update.turnId ? 'other' : null, ...usageFacts(update) }));
  return facts;
}

async function forkTurn(server, parentId, label, spec, parentContext, turnExtra) {
  const startedAt = Date.now();
  let forkId;
  const step = { kind: 'fork', settings: spec.settings, ...(turnExtra?.effort ? { turnEffort: turnExtra.effort } : {}) };
  try {
    const forked = await server.request('thread/fork', { threadId: parentId, ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', ...spec.fork });
    forkId = forked?.thread?.id;
    Object.assign(step, { model: forked?.model ?? null, reasoningEffort: forked?.reasoningEffort ?? null, sandbox: forked?.sandbox?.type ?? null, approvalPolicy: forked?.approvalPolicy ?? null });
  } catch (error) {
    return { ...step, error: `thread/fork: ${errorText(error)}` };
  }
  server.thread(forkId).policy = () => 'decline';
  const turn = await codexTurn(server, forkId, label, forkPrompt(spec.prompt), turnExtra ?? {}, { deadlineMs: FORK_DEADLINE_MS, interruptOn: (type) => TOOL_ITEM_TYPES.has(type) });
  await server.request('thread/unsubscribe', { threadId: forkId }).catch(() => undefined);
  const { turnId: _turnId, startedAt: _start, endedAt: _end, ...facts } = turn;
  return {
    ...step, ...facts, totalMs: Date.now() - startedAt, parentContext,
    forkRatio: ratio(turn.first?.cached, parentContext), hitRatio: ratio(turn.first?.cached, turn.first?.input),
  };
}

// ---------------------------------------------------------------------------
// Threads

const turnSummary = (turn, previous) => ({
  ...turn,
  crossTurnRatio: ratio(turn.first?.cached, previous?.last?.input),
  hitRatio: ratio(turn.first?.cached, turn.first?.input),
});

async function runA(server, options, pass, name) {
  const tag = `p${pass}-${name}`;
  const repo = path.join(options.scratch, `codex-${tag}`);
  await createReviewRepo(repo);
  const conversation = { tag, settings: `conversation (${JSON.stringify(UNSANDBOXED_CONVERSATION)}, probe approval handler)`, turns: [], forks: [], predictions: [] };
  const schedule = SCHEDULES[name];
  let threadId;
  try {
    const started = await startThread(server, repo, UNSANDBOXED_CONVERSATION);
    threadId = started.threadId;
    Object.assign(conversation, { model: started.model, reasoningEffort: started.reasoningEffort, sandbox: started.sandbox, approvalPolicy: started.approvalPolicy });
    server.thread(threadId).policy = conversationPolicy(repo);
    if (name === 'AL') conversation.lowestEffort = await lowestEffort(server, started.model);
    const before = await fileHashes(repo);
    let previous = null;
    const turns = [
      ['seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.codex}`],
      ['T1-fix', `${CODEX_EDIT_PROMPTS.fixFormat} ${EDIT_RULES}\n\n${await quotedRepo(repo)}`],
      ['T2-english', PROMPTS.english],
      ['T3-korean', PROMPTS.korean1],
      ['T4-korean', PROMPTS.korean2],
      ['T5-korean', PROMPTS.korean3],
    ];
    for (const [turnName, text] of turns) {
      const turn = turnSummary(await codexTurn(server, threadId, `${tag} ${turnName}`, text), previous);
      turn.name = turnName;
      conversation.turns.push(turn);
      if (turn.status !== 'completed') throw new Error(`${turnName} ended ${turn.status ?? 'without status'}: ${turn.error ?? ''}`);
      if (turn.unapproved.length) throw new Error(`${turnName}: ${turn.unapproved.length} command(s) or file change(s) completed without approval`);
      if (turnName === 'T1-fix') conversation.changedAfterT1 = changedFiles(before, await fileHashes(repo));
      previous = turn;
      if (turnName === 'seed') continue;
      if (name === 'A') {
        conversation.predictions.push({ afterTurn: turnName, ...(await nativePrediction(server, threadId, turn.turnId)) });
        if (turnName === 'T1-fix') {
          // A prediction-mode fork may not narrow its inherited config: does read-only/never get refused? (no turn)
          try {
            const probe = await server.request('thread/fork', { threadId, ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', experimentalPredictionMode: true, ...BTW_FORK });
            conversation.predictionModeReadOnly = { accepted: true, sandbox: probe?.sandbox?.type ?? null, approvalPolicy: probe?.approvalPolicy ?? null };
            await server.request('thread/unsubscribe', { threadId: probe.thread.id }).catch(() => undefined);
          } catch (error) {
            conversation.predictionModeReadOnly = { accepted: false, errorCode: error?.rpc?.code ?? null, error: errorText(error) };
          }
        }
      }
      for (const forkName of schedule[turnName] ?? []) {
        const spec = FORKS[forkName];
        const turnExtra = spec.lowestEffort ? { effort: conversation.lowestEffort?.effort ?? 'low' } : spec.turn;
        const fork = await forkTurn(server, threadId, `${tag} ${forkName} after ${turnName}`, spec, turn.last?.input ?? null, turnExtra);
        fork.name = forkName;
        fork.afterTurn = turnName;
        conversation.forks.push(fork);
      }
    }
    conversation.changedFiles = changedFiles(before, await fileHashes(repo));
    for (const fork of conversation.forks.filter((entry) => entry.name === 'RC')) fork.flags = recapFlags(fork.answer, conversation.changedFiles);
  } catch (error) {
    conversation.error = errorText(error);
    log(`codex ${tag} error: ${conversation.error}`);
  } finally {
    if (threadId) {
      const state = server.thread(threadId);
      conversation.approvalDecisions = decisions(state.serverRequests);
      conversation.unapproved = state.unapproved;
      await server.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    }
  }
  return conversation;
}

async function runB(server, suggestions, options, pass, name) {
  const tag = `p${pass}-${name}`;
  const repo = path.join(options.scratch, `codex-${tag}`);
  await createReviewRepo(repo);
  const endpoint = suggestions.endpoint(tag);
  const developerInstructions = name === 'BI' ? SUGGEST_DEVELOPER_INSTRUCTIONS : undefined;
  const conversation = {
    tag, settings: `conversation + suggest_task MCP server in thread config${developerInstructions ? ' + developerInstructions' : ''}`,
    ...(developerInstructions ? { developerInstructions } : {}), turns: [],
  };
  let threadId;
  try {
    const started = await startThread(server, repo, UNSANDBOXED_CONVERSATION, mcpConfig(endpoint), developerInstructions);
    threadId = started.threadId;
    Object.assign(conversation, { model: started.model, reasoningEffort: started.reasoningEffort, sandbox: started.sandbox, approvalPolicy: started.approvalPolicy });
    server.thread(threadId).policy = conversationPolicy(repo);
    conversation.serverAtStart = await serverStatus(server, threadId);
    const before = await fileHashes(repo);
    let previous = null;
    const turns = [
      ['seed', `${seedText(randomUUID())}\n\n${PROMPTS.seedSuffix.codex}`],
      ['T1-fix-cart', `${CODEX_EDIT_PROMPTS.fixCart} ${EDIT_RULES}\n\n${await quotedRepo(repo)}`],
      ['T2-summary', PROMPTS.summary],
    ];
    for (const [turnName, text] of turns) {
      const turn = turnSummary(await codexTurn(server, threadId, `${tag} ${turnName}`, text), previous);
      turn.name = turnName;
      conversation.turns.push(turn);
      if (turn.status !== 'completed') throw new Error(`${turnName} ended ${turn.status ?? 'without status'}: ${turn.error ?? ''}`);
      if (turn.unapproved.length) throw new Error(`${turnName}: ${turn.unapproved.length} command(s) or file change(s) completed without approval`);
      if (turnName === 'T1-fix-cart') {
        conversation.changedFiles = changedFiles(before, await fileHashes(repo));
        conversation.readmePresent = existsSync(path.join(repo, 'README.md'));
      }
      previous = turn;
    }
    conversation.serverAtEnd = await serverStatus(server, threadId);
  } catch (error) {
    conversation.error = errorText(error);
    log(`codex ${tag} error: ${conversation.error}`);
  } finally {
    if (threadId) {
      const state = server.thread(threadId);
      conversation.approvalDecisions = decisions(state.serverRequests);
      conversation.unapproved = state.unapproved;
      await server.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    }
  }
  conversation.suggestTaskServer = suggestions.summary(tag);
  return conversation;
}

async function runDirect(server, suggestions, options, pass, variantName) {
  const variant = D_VARIANTS[variantName];
  const tag = `p${pass}-D-${variantName}`;
  const repo = path.join(options.scratch, `codex-${tag}`);
  await createReviewRepo(repo);
  const endpoint = suggestions.endpoint(tag, { annotated: variant.annotated });
  const step = { tag, variant: variantName, settings: variant.settings };
  let threadId;
  try {
    const started = await startThread(server, repo, PRESETS[variant.preset], mcpConfig(endpoint, { approve: variant.approve }));
    threadId = started.threadId;
    Object.assign(step, { model: started.model, sandbox: started.sandbox, approvalPolicy: started.approvalPolicy });
    // The person approves an MCP tool call when asked; nothing else is expected. A shell command would hang
    // under workspace-write on this PC, so one is interrupted at once.
    server.thread(threadId).policy = (method, params) => (method === 'mcpServer/elicitation/request' && params._meta?.codex_approval_kind === 'mcp_tool_call' ? 'accept' : 'decline');
    step.serverAtStart = await serverStatus(server, threadId);
    step.turn = await codexTurn(server, threadId, tag, PROMPTS.directCall, {}, { deadlineMs: DIRECT_DEADLINE_MS, interruptOn: (type) => type === 'commandExecution' || type === 'fileChange' });
  } catch (error) {
    step.error = errorText(error);
  } finally {
    if (threadId) await server.request('thread/unsubscribe', { threadId }).catch(() => undefined);
  }
  step.suggestTaskServer = suggestions.summary(tag);
  const calls = (step.turn?.items ?? []).filter((item) => item.type === 'mcpToolCall' && item.phase === 'completed');
  step.mcpCalls = calls.map((item) => ({ tool: item.tool, status: item.status, error: item.error, readOnlyHint: item.readOnlyHint }));
  step.approvalRequests = (step.turn?.serverRequests ?? []).map((entry) => `${entry.method}:${entry.approvalKind ?? ''}:${entry.decision}`);
  step.toolRan = step.suggestTaskServer.suggestions.length;
  return step;
}

// ---------------------------------------------------------------------------

const forkRow = (fork) => ({
  name: fork.name, afterTurn: fork.afterTurn, error: fork.error ?? null, status: fork.status ?? null, threadEffort: fork.reasoningEffort ?? null,
  turnEffort: fork.turnEffort ?? null, sandbox: fork.sandbox ?? null, input: fork.first?.input ?? null, cached: fork.first?.cached ?? null,
  parentContext: fork.parentContext, forkRatio: fork.forkRatio, hitRatio: fork.hitRatio, reasoning: fork.last?.reasoning ?? null,
  output: fork.last?.output ?? null, totalMs: fork.totalMs ?? null, interrupted: fork.interrupted ?? null, text: fork.answer,
});

function bSummary(b) {
  const t1 = b.turns.find((turn) => turn.name === 'T1-fix-cart');
  return {
    error: b.error ?? null, serverAtStart: b.serverAtStart ?? null,
    itemSequence: (t1?.items ?? []).filter((item) => item.phase === 'started').map((item) => (item.type === 'mcpToolCall' ? `mcp:${item.tool}` : item.type)),
    suggestCalls: (b.suggestTaskServer?.suggestions ?? []).map((entry) => entry.title),
    mcpCallStatus: (t1?.items ?? []).filter((item) => item.type === 'mcpToolCall' && item.phase === 'completed').map((item) => `${item.tool}:${item.status}${item.error ? `:${item.error}` : ''}`),
    approvalDecisions: b.approvalDecisions ?? null, unapproved: b.unapproved?.length ?? null,
    changedFiles: b.changedFiles ?? null, readmePresent: b.readmePresent ?? null,
    crossTurn: b.turns.map((turn) => [turn.name, turn.crossTurnRatio, turn.hitRatio]),
  };
}

function passSummary(pass) {
  const summary = {};
  for (const name of ['A', 'AL', 'B', 'BI']) if (pass[name]?.skipped) summary[name] = { skipped: pass[name].skipped };
  const a = pass.A;
  if (a && !a.skipped) {
    summary.P2native = a.predictions.map((entry) => ({ afterTurn: entry.afterTurn, ok: entry.ok, errorCode: entry.errorCode ?? null, error: entry.error ?? null, updates: entry.updates.length, usageDuring: entry.usageDuring.length }));
    summary.P2forks = a.forks.filter((fork) => fork.name !== 'RC').map(forkRow);
    summary.P2predictionModeReadOnly = a.predictionModeReadOnly ?? null;
    summary.P3 = a.forks.filter((fork) => fork.name === 'RC').map((fork) => ({
      afterTurn: fork.afterTurn, error: fork.error ?? null, status: fork.status ?? null, input: fork.first?.input ?? null, cached: fork.first?.cached ?? null,
      forkRatio: fork.forkRatio, hitRatio: fork.hitRatio, totalMs: fork.totalMs ?? null, chars: fork.flags?.chars ?? null, lines: fork.flags?.lines ?? null,
      hangul: fork.flags?.hangul ?? null, namedButUnchanged: fork.flags?.namedButUnchanged ?? null, claimsTestsRan: fork.flags?.claimsTestsRan ?? null,
    }));
    summary.crossTurnA = a.turns.map((turn) => [turn.name, turn.crossTurnRatio, turn.hitRatio]);
    summary.changedA = a.changedFiles ?? null;
    summary.guardA = { approvalDecisions: a.approvalDecisions ?? null, unapproved: a.unapproved?.length ?? null };
  }
  const al = pass.AL;
  if (al && !al.skipped) {
    summary.AL = {
      error: al.error ?? null, lowestEffort: al.lowestEffort ?? null, changedFiles: al.changedFiles ?? null,
      approvalDecisions: al.approvalDecisions ?? null, unapproved: al.unapproved?.length ?? null,
      crossTurn: al.turns.map((turn) => [turn.name, turn.crossTurnRatio]), forks: al.forks.map(forkRow),
    };
  }
  if (pass.B && !pass.B.skipped) summary.P4B = bSummary(pass.B);
  if (pass.BI && !pass.BI.skipped) summary.P4BI = bSummary(pass.BI);
  if (pass.D.length) {
    summary.P4direct = pass.D.map((step) => ({
      variant: step.variant, error: step.error ?? null, status: step.turn?.status ?? null, serverTools: step.serverAtStart?.tools ?? null,
      approvalRequests: step.approvalRequests, mcpCalls: step.mcpCalls, toolRan: step.toolRan, interrupted: step.turn?.interrupted ?? null,
    }));
  }
  return summary;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  options.scratch = path.join(options.scratch, `codex-${stamp}`); // every run gets new repos
  const codexScript = options.codexScript ?? resolveCodexScript();
  const suggestions = await startSuggestionServer();
  const serverCwd = path.join(options.scratch, 'app-server');
  await createReviewRepo(serverCwd, { clean: true });
  const server = startAppServer(codexScript, serverCwd);
  const file = path.join(options.out, `codex-${stamp}.json`);
  const skipped = 'editing step: needs --allow-unsandboxed (workspace-write sandbox commands hang on this PC; the standard preset cannot edit here)';
  const report = {
    probe: 'codex-turn-wrap-up', at: new Date().toISOString(),
    facts: {
      codexScript, repeat: options.repeat, only: options.only, allowUnsandboxed: options.allowUnsandboxed,
      safety: options.allowUnsandboxed
        ? 'Editing conversations: sandbox danger-full-access + approvalPolicy untrusted; the probe declines every command, accepts file changes only inside the scratch repo, accepts the suggest_task MCP approval, declines the rest, and interrupts a turn where anything completes unapproved. Editing prompts quote the repo files.'
        : 'Editing conversations skipped (no --allow-unsandboxed); D uses the real presets.',
    },
    definitions: DEFINITIONS, passes: [],
  };
  const save = async () => {
    for (const pass of report.passes) pass.summary = passSummary(pass);
    report.facts.rateLimits = server.rateLimits.length ? { first: server.rateLimits[0], last: server.rateLimits.at(-1) } : null;
    report.facts.suggestServerStartup = server.startupStatus;
    await writeReport(file, report);
  };
  try {
    const initialized = await server.request('initialize', {
      clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.send({ jsonrpc: '2.0', method: 'initialized' });
    report.facts.codexVersion = String(initialized?.userAgent ?? '').match(/\d+\.\d+\.\d+/u)?.[0] ?? null;
    for (let pass = 1; pass <= options.repeat; pass += 1) {
      const entry = { pass, D: [] };
      report.passes.push(entry);
      // B and BI swap order on even passes.
      const order = ['A', 'AL', ...(pass % 2 === 1 ? ['B', 'BI'] : ['BI', 'B'])].filter((name) => options.only.includes(name));
      for (const name of order) {
        if (EDITING_STEPS.has(name) && !options.allowUnsandboxed) { entry[name] = { skipped }; continue; }
        entry[name] = name.startsWith('A') ? await runA(server, options, pass, name) : await runB(server, suggestions, options, pass, name);
        await save();
      }
      if (options.only.includes('D')) {
        const names = Object.keys(D_VARIANTS);
        for (const variant of pass % 2 === 1 ? names : [...names].reverse()) {
          entry.D.push(await runDirect(server, suggestions, options, pass, variant));
          await save();
        }
      }
    }
  } catch (error) {
    report.error = errorText(error);
    report.stderrTail = server.stderr().slice(-800);
  } finally {
    await save();
    server.child.stdin.end();
    await Promise.race([server.exited, delay(5_000)]);
    if (server.child.exitCode === null) server.child.kill();
    await suggestions.close();
  }
  console.log(JSON.stringify({ file, facts: report.facts, error: report.error ?? null, summaries: report.passes.map((pass) => ({ pass: pass.pass, summary: pass.summary })) }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
