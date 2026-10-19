#!/usr/bin/env node
/**
 * Records raw provider protocol traffic from REAL Claude Agent SDK and Codex
 * app-server sessions and writes sanitized ndjson fixtures under
 * test/fixtures/provider-capture/. `src/main/test-fixtures/provider-replay.ts`
 * feeds those recordings back through the production adapters.
 *
 * Every run spends the user's provider tokens, so nothing in `pnpm test`
 * invokes this script. Each session runs inside a disposable git project
 * created below --scratch; providers never see this repository or $HOME.
 *
 * Capture-only deviations from the adapters' launch options (documented in
 * each fixture's meta line):
 *   - Claude: includePartialMessages true, persistSession false,
 *     settingSources [] (no user hooks/plugins), plansDirectory inside the
 *     scratch project, claude.ai connectors and auto-memory disabled.
 *   - Codex: ephemeral threads, so captures stay out of the user's history;
 *     per-scenario thread config / collaboration mode where a scenario says so.
 * The user's own Codex config (MCP servers, hooks.json) still loads; their
 * names and paths are masked in the fixture.
 *
 * Run:
 *   node scripts/capture-provider-fixtures.mjs --scratch <dir> \
 *     --provider claude|codex|all --scenario <name>|all
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_DEADLINE_MS = 180_000;
const TRAILING_FRAMES_MS = 1_500;
const INTERRUPT_AFTER_TEXT_DELTAS = 12;

// Mirrors REQUIRED_OS_ENVIRONMENT_VARIABLES in src/main/provider-process-security.ts.
const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TERM',
  'COLORTERM', 'NO_COLOR',
];
// Mirrors the adapters' disclosed variable sets (Claude claude.ai login path, Codex).
const CLAUDE_ENVIRONMENT_VARIABLES = ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];
const CODEX_ENVIRONMENT_VARIABLES = ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

/**
 * Capture-only: keep the account's claude.ai connectors out of a scratch
 * session and stop the model writing auto-memory under the user's ~/.claude.
 */
const CLAUDE_CAPTURE_ENVIRONMENT = {
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
};

const STOP_ON_DENIAL = 'If a tool call is denied or fails, stop immediately and say so in one sentence; do not retry or try alternatives.';

/**
 * `claude`/`codex` decide each approval. Claude decisions return a
 * PermissionResult; Codex decisions return 'accept' | 'decline'.
 */
const SCENARIOS = [
  {
    name: 'read-search',
    prompt: 'Read README.md and find where `greet` is defined; answer in one sentence.',
  },
  {
    name: 'command-ok-fail',
    prompt: 'Run `node --version`, then run `node -e "process.exit(3)"` as two separate shell commands. '
      + 'Report both results in one sentence. Do not run anything else.',
  },
  {
    name: 'edit-create',
    prompt: 'In src/app.ts rename the function `greet` to `greetUser` and update its call site, then create a new file '
      + 'notes.md containing exactly one line: `Renamed greet to greetUser.` Do nothing else.',
  },
  {
    name: 'approval-deny',
    prompt: {
      claude: `Delete README.md using a shell command. ${STOP_ON_DENIAL}`,
      // Codex's workspace-write sandbox never asks before deleting inside the
      // workspace; only an out-of-workspace target reaches an approval.
      codex: `Delete the file ../outside-codex-approval-deny.txt using a shell command. ${STOP_ON_DENIAL}`,
    },
    claude: () => ({ behavior: 'deny', message: 'Denied by the user.' }),
    codex: () => 'decline',
  },
  {
    name: 'file-approval',
    providers: ['codex'],
    // The scratch root sits under %TEMP%, which workspace-write treats as
    // writable; exclude it so the out-of-workspace patch needs approval.
    codexThreadConfig: { 'sandbox_workspace_write.exclude_tmpdir_env_var': true },
    prompt: 'Create the file ../outside-codex-file-approval.md containing exactly one line `hello` using your file '
      + `editing tool (apply_patch), not a shell command. ${STOP_ON_DENIAL}`,
  },
  {
    name: 'ask-question',
    providers: ['claude'],
    prompt: 'Before doing anything else, use the AskUserQuestion tool to ask me exactly one question: whether the '
      + 'greeting in src/app.ts should be formal or casual, with exactly two options labelled Formal and Casual. '
      + 'After I answer, reply with one sentence confirming my choice. Do not edit any files.',
    claude: (toolName, input) => {
      if (toolName !== 'AskUserQuestion') return { behavior: 'deny', message: 'Only the question was expected.' };
      const answers = Object.fromEntries((input.questions ?? []).map((question) => [
        question.question,
        question.options?.[1]?.label ?? question.options?.[0]?.label ?? 'Casual',
      ]));
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    },
  },
  {
    name: 'plan-mode',
    permissionMode: 'plan',
    codexPreset: 'plan',
    codexCollaborationMode: 'plan',
    prompt: {
      claude: 'Plan how to add a `farewell(name)` function next to `greet` in src/app.ts. Keep the plan to three short '
        + 'bullet points, then present it with ExitPlanMode. Do not implement it.',
      codex: 'Plan how to add a `farewell(name)` function next to `greet` in src/app.ts. Keep the plan to three short '
        + 'bullet points. Do not implement it.',
    },
    claude: (toolName) => toolName === 'ExitPlanMode'
      ? undefined
      : { behavior: 'deny', message: 'Plan review only; do not implement.' },
  },
  {
    // Codex plan mode asks through request_user_input; the scripted person picks the first option.
    name: 'plan-question',
    providers: ['codex'],
    codexPreset: 'plan',
    codexCollaborationMode: 'plan',
    prompt: 'I want to add a `farewell(name)` function next to `greet` in src/app.ts. First ask me with your '
      + 'request_user_input tool whether the farewell should say "Goodbye" or "See you". Then propose a plan of '
      + 'three short bullet points. Do not implement it.',
  },
  {
    name: 'todo',
    prompt: {
      claude: 'Use the TodoWrite tool to track these three steps and complete them in order, updating the list as you '
        + 'go: (1) read README.md, (2) read src/app.ts, (3) answer in one sentence what greet returns.',
      codex: 'Use your update_plan tool to track these three steps and complete them in order, updating the plan as '
        + 'you go: (1) read README.md, (2) read src/app.ts, (3) answer in one sentence what greet returns.',
    },
  },
  {
    // Neither provider exposes its todo/plan tool by default in these
    // versions: Claude Code 2.1.289 gates it behind an environment variable,
    // Codex 0.162.1 behind `tools.update_plan`.
    name: 'todo-enabled',
    claudeEnvironment: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    codexThreadConfig: { 'tools.update_plan': { enabled: true } },
    prompt: {
      claude: 'Use the TodoWrite tool to track these three steps and complete them in order, updating the list as you '
        + 'go: (1) read README.md, (2) read src/app.ts, (3) answer in one sentence what greet returns.',
      codex: 'Use your update_plan tool to track these three steps and complete them in order, updating the plan as '
        + 'you go: (1) read README.md, (2) read src/app.ts, (3) answer in one sentence what greet returns.',
    },
  },
  {
    name: 'markdown',
    prompt: 'Explain what a TypeScript union type is. Include a short markdown table with two rows, one TypeScript '
      + 'code block and one bash code block. Keep it under 200 words. Do not use any tools.',
  },
  {
    name: 'interrupt',
    interruptAfterTextDeltas: INTERRUPT_AFTER_TEXT_DELTAS,
    prompt: 'Write a detailed 600-word essay about the history of terminal emulators. Do not use any tools.',
  },
  {
    // Subagents next to non-agent background work: the adapter must project
    // only the Agent-tool tasks as child sessions, never the background shell.
    name: 'subagents',
    waitForTasks: true,
    deadlineMs: 300_000,
    codexEphemeral: false,
    prompt: {
      claude: 'Do these three things, then answer in two sentences. (1) Use the Agent tool to launch an Explore '
        + 'subagent that reads README.md and reports its title. (2) At the same time use the Agent tool with '
        + 'run_in_background set to true to launch a second Explore subagent that finds where `greet` is defined. '
        + '(3) Run `node -e "setTimeout(() => console.log(\'tick\'), 3000)"` as a background shell command '
        + '(run_in_background). Wait until both subagents and the background command have finished before answering.',
      codex: 'Spawn one sub-agent that reads README.md and reports its title, and a second sub-agent that finds where '
        + '`greet` is defined in src/app.ts. Wait for both sub-agents to finish, then answer in two sentences. '
        + 'Do not read the files yourself.',
    },
  },
  {
    // An approval raised inside a subagent (Claude: canUseTool agentID;
    // Codex: a server request on the child thread).
    name: 'subagent-approval',
    waitForTasks: true,
    deadlineMs: 300_000,
    codexEphemeral: false,
    codexThreadConfig: { 'sandbox_workspace_write.exclude_tmpdir_env_var': true },
    prompt: {
      // A read-only command (node --version) is auto-allowed; a delete reaches canUseTool.
      claude: 'Use the Agent tool to launch one general-purpose subagent that deletes README.md using a shell command '
        + `and reports what happened. Do not run any command yourself. ${STOP_ON_DENIAL}`,
      codex: 'Spawn one sub-agent that deletes the file ../outside-codex-subagent-approval.txt using a shell command, '
        + `wait for it, and report what happened. Do not run any command yourself. ${STOP_ON_DENIAL}`,
    },
    claude: (toolName) => toolName === 'Bash' ? { behavior: 'deny', message: 'Denied by the user.' } : undefined,
  },
  {
    name: 'web',
    prompt: {
      claude: 'Use the WebSearch tool to find the current Node.js LTS major version and answer in one sentence. '
        + 'Do not use any other tool.',
      codex: 'Search the web for the current Node.js LTS major version and answer in one sentence. '
        + 'Do not run shell commands.',
    },
  },
];

function parseArguments(argv) {
  const options = { provider: 'all', scenario: 'all', out: path.join(root, 'test', 'fixtures', 'provider-capture') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    const value = inline ?? argv[++index];
    if (flag === '--provider') options.provider = value;
    else if (flag === '--scenario') options.scenario = value;
    else if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else if (flag === '--claude-executable') options.claudeExecutable = path.resolve(value);
    else if (flag === '--codex-script') options.codexScript = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; providers only ever run below it.');
  return options;
}

function pathDirectories() {
  return (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean);
}

/** Same native target the adapter's resolveClaudeExecutable selects behind npm's .cmd shim. */
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

/** The script npm's codex.cmd shim runs (the repo spawns that shim via cross-spawn). */
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

function scenarioPrompt(scenario, provider) {
  return typeof scenario.prompt === 'string' ? scenario.prompt : scenario.prompt[provider];
}

async function seedProject(workspace, captureRoot, provider, scenario) {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), [
    '# Demo app',
    '',
    'A tiny demo project used for EZTerminal provider fixture capture.',
    'The `greet` helper lives in src/app.ts.',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'src', 'app.ts'), [
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export function main(): void {',
    "  console.log(greet('world'));",
    '}',
    '',
  ].join('\n'));
  await fs.writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({
    name: 'demo-app',
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: { start: 'node src/app.ts' },
  }, null, 2)}\n`);
  execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore', windowsHide: true });
  if (provider === 'codex' && scenario.name === 'approval-deny') {
    await fs.writeFile(path.join(captureRoot, 'outside-codex-approval-deny.txt'), 'Delete me only with approval.\n');
  }
  if (provider === 'codex' && scenario.name === 'subagent-approval') {
    await fs.writeFile(path.join(captureRoot, 'outside-codex-subagent-approval.txt'), 'Delete me only with approval.\n');
  }
}

// ---------------------------------------------------------------------------
// Sanitization

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Matches a Windows path with either separator, any drive-letter case, doubled
 * backslashes, and the POSIX-shell `/c/...` spelling.
 */
function pathPattern(absolute) {
  const parts = absolute.split(/[\\/]+/u).filter(Boolean).map((part, index) => {
    const drive = index === 0 ? part.match(/^([A-Za-z]):$/u) : null;
    return drive ? `(?:${drive[1]}:|/${drive[1]})` : escapeRegExp(part);
  });
  return new RegExp(parts.join('(?:\\\\{1,2}|/)'), 'giu');
}

const SECRET_KEYS = /^(?:email|e-mail|installation_?id|machine_?id|device_?id|account_?(?:id|uuid)|organization_?(?:id|uuid|name)|org_?(?:id|uuid)|user_?(?:id|uuid)|api_?key|access_?token|refresh_?token|id_?token|token|cookie|session_?cookie|authorization|password|secret)$/iu;
/**
 * Account plan tiers and balances describe the user's subscription. Keep them
 * non-empty (the Claude adapter's auth gate reads subscriptionType) but neutral.
 * API service tiers (service_tier/serviceTier) are request metadata and stay.
 */
const ACCOUNT_PLACEHOLDER_KEYS = [
  [/^(?:subscription_?type|plan_?type|account_?tier|org(?:anization)?_?tier|rate_?limit_?tier|billing_?tier)$/iu, '<PLAN>'],
  [/^(?:balance|credit_?balance)$/iu, '<BALANCE>'],
];
const SECRET_VALUES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, '<EMAIL>'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '<REDACTED>'],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}\b/gu, '<REDACTED>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '<REDACTED>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gu, 'Bearer <REDACTED>'],
];

function createSanitizer({ workspace, captureRoot }) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const replacements = [
    ...SECRET_VALUES,
    [pathPattern(workspace), '<WORKSPACE>'],
    [pathPattern(captureRoot), '<CAPTURE_ROOT>'],
    // Truncated paths (e.g. PowerShell's `Get-Location` column) only match up to the scratch root.
    [pathPattern(path.dirname(captureRoot)), '<SCRATCH>'],
    // Claude's per-project state directory name is the workspace path with
    // every non-alphanumeric character replaced by '-'.
    [new RegExp(escapeRegExp(workspace.replace(/[^A-Za-z0-9]/gu, '-')), 'giu'), '<WORKSPACE_KEY>'],
    [pathPattern(home), '<HOME>'],
    [new RegExp(`\\b${escapeRegExp(os.hostname())}\\b`, 'giu'), '<HOST>'],
    // git/GitHub handles that extend the account name (e.g. user1234).
    [new RegExp(`${escapeRegExp(user)}[A-Za-z0-9]*`, 'giu'), '<USER>'],
  ];
  const text = (value) => replacements.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), value);
  const visit = (value, key) => {
    if (typeof key === 'string' && SECRET_KEYS.test(key) && value !== null && value !== undefined && value !== '') {
      return '<REDACTED>';
    }
    const account = typeof key === 'string' && typeof value === 'string' && value !== ''
      ? ACCOUNT_PLACEHOLDER_KEYS.find(([pattern]) => pattern.test(key))
      : undefined;
    if (account) return account[1];
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map((entry) => visit(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [text(entryKey), visit(entry, entryKey)]));
    }
    return value;
  };
  const sanitize = (value) => visit(value);
  sanitize.text = text;
  return sanitize;
}

/**
 * Streaming deltas can split a path or name across chunks, where no per-chunk
 * pattern can see it. Sanitize each delta stream as one string, then cut the
 * result back into the same number of chunks at proportional offsets so the
 * accumulated text matches the sanitized final message.
 */
function sanitizeDeltaStreams(lines, sanitizeText) {
  const streams = new Map();
  const messageOrdinal = new Map();
  for (const line of lines) {
    let key;
    let holder;
    let field;
    if (line.dir === 'sdk' && line.msg?.type === 'stream_event') {
      const parent = line.msg.parent_tool_use_id ?? '';
      const event = line.msg.event;
      if (event?.type === 'message_start') messageOrdinal.set(parent, (messageOrdinal.get(parent) ?? 0) + 1);
      if (event?.type !== 'content_block_delta') continue;
      field = ['partial_json', 'text', 'thinking'].find((name) => typeof event.delta?.[name] === 'string');
      holder = event.delta;
      key = `claude:${parent}:${String(messageOrdinal.get(parent) ?? 0)}:${String(event.index)}`;
    } else if (line.dir === 'in' && typeof line.frame?.method === 'string' && typeof line.frame.params?.delta === 'string') {
      field = 'delta';
      holder = line.frame.params;
      key = `codex:${line.frame.method}:${String(line.frame.params.itemId ?? '')}`;
    }
    if (!field) continue;
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push({ holder, field });
  }
  for (const chunks of streams.values()) {
    const original = chunks.map(({ holder, field }) => holder[field]);
    const joined = original.join('');
    const sanitized = sanitizeText(joined);
    if (sanitized === joined) continue;
    let consumed = 0;
    let cut = 0;
    chunks.forEach(({ holder, field }, index) => {
      consumed += original[index].length;
      const next = index === chunks.length - 1
        ? sanitized.length
        : Math.round((consumed / joined.length) * sanitized.length);
      holder[field] = sanitized.slice(cut, next);
      cut = next;
    });
  }
}

/**
 * User-configured MCP server and account connector names reveal which
 * services and projects the user works with; keep a stable placeholder.
 */
function maskUserMcpServerNames(lines) {
  const names = new Map();
  const placeholder = (name) => {
    if (!names.has(name)) names.set(name, `user-mcp-server-${String(names.size + 1)}`);
    return names.get(name);
  };
  for (const line of lines) {
    const servers = line.dir === 'sdk' && line.msg?.type === 'system' ? line.msg.mcp_servers : undefined;
    if (Array.isArray(servers)) {
      for (const server of servers) {
        if (typeof server?.name === 'string') server.name = placeholder(server.name);
      }
    }
    const params = line.dir === 'in' && line.frame?.method?.startsWith('mcpServer/') ? line.frame.params : undefined;
    if (typeof params?.name === 'string') params.name = placeholder(params.name);
  }
}

// ---------------------------------------------------------------------------
// Recording

function createRecorder() {
  const started = performance.now();
  const lines = [];
  return {
    lines,
    push(line) {
      // Deep-copy at observation time: SDK objects can be mutated after yield.
      lines.push({ t: Math.round(performance.now() - started), ...structuredClone(line) });
    },
  };
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
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Follow-up turns (a task notification answered by the model) arrive after the settle point. */
async function waitForQuiet(context, quietMs = 8_000, limitMs = 90_000) {
  const until = Date.now() + limitMs;
  context.lastFrameAt ??= Date.now();
  while (Date.now() - context.lastFrameAt < quietMs && Date.now() < until) await delay(500);
}

function withDeadline(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        onTimeout();
        resolve('deadline');
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Claude Agent SDK

/** Keeps only the coarse account facts the adapter's authentication gate reads. */
function claudeInitializationFacts(result) {
  const account = result && typeof result === 'object' ? result.account : undefined;
  return {
    topLevelKeys: result && typeof result === 'object' ? Object.keys(result).sort() : [],
    account: account && typeof account === 'object' ? Object.fromEntries(
      ['apiProvider', 'apiKeySource', 'tokenSource', 'subscriptionType']
        .filter((key) => typeof account[key] === 'string')
        .map((key) => [key, account[key]]),
    ) : undefined,
  };
}

async function captureClaude(scenario, context) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { recorder, workspace } = context;
  const input = new AsyncQueue();
  const abortController = new AbortController();
  const sessionId = randomUUID();
  const userUuid = randomUUID();
  const decide = scenario.claude ?? (() => undefined);
  let resolveResult;
  const resultSeen = new Promise((resolve) => { resolveResult = resolve; });
  let textDeltas = 0;
  let interrupted = false;
  // waitForTasks: a background subagent or shell command can finish after the
  // first result; keep recording until every started task has notified.
  const openTasks = new Set();
  let results = 0;
  const settleIfDone = () => {
    if (results > 0 && openTasks.size === 0) resolveResult();
  };
  context.lastFrameAt = Date.now();

  const canUseTool = async (toolName, toolInput, options) => {
    // The AbortSignal is not serializable; everything else is the request as delivered.
    const requestOptions = { ...options };
    delete requestOptions.signal;
    // Same allow/deny shapes ClaudeProviderAdapter.resolveApproval returns.
    const scripted = decide(toolName, toolInput) ?? { behavior: 'allow', updatedInput: toolInput };
    const response = { ...scripted, toolUseID: options.toolUseID };
    recorder.push({ dir: 'canUseTool', toolName, input: toolInput, options: requestOptions, response });
    return response;
  };

  const environment = { ...CLAUDE_CAPTURE_ENVIRONMENT, ...scenario.claudeEnvironment };
  const options = {
    abortController,
    cwd: workspace,
    pathToClaudeCodeExecutable: context.claudeExecutable,
    permissionMode: scenario.permissionMode ?? 'default',
    allowDangerouslySkipPermissions: false,
    canUseTool,
    includePartialMessages: true,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    persistSession: false,
    env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, {
      CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
      ...environment,
    }),
    settingSources: [],
    settings: { plansDirectory: '.claude-plans' },
    sessionId,
  };
  context.meta.launch = {
    permissionMode: options.permissionMode,
    includePartialMessages: true,
    persistSession: false,
    settingSources: [],
    settings: options.settings,
    forwardSubagentText: true,
    agentProgressSummaries: true,
    environment,
  };
  context.meta.providerSessionId = sessionId;
  context.meta.clientUserMessageUuid = userUuid;

  const session = query({ prompt: input, options });
  const iterate = (async () => {
    for await (const message of session) {
      recorder.push({ dir: 'sdk', msg: message });
      context.lastFrameAt = Date.now();
      if (scenario.waitForTasks && message.type === 'system') {
        if (message.subtype === 'task_started' && message.ambient !== true && message.skip_transcript !== true) {
          openTasks.add(message.task_id);
        }
        if (message.subtype === 'task_notification') {
          openTasks.delete(message.task_id);
          settleIfDone();
        }
      }
      if (message.type === 'result') {
        results += 1;
        if (scenario.waitForTasks) settleIfDone();
        else resolveResult();
      }
      if (
        scenario.interruptAfterTextDeltas
        && !interrupted
        && message.type === 'stream_event'
        && message.event?.type === 'content_block_delta'
        && message.event.delta?.type === 'text_delta'
        && ++textDeltas >= scenario.interruptAfterTextDeltas
      ) {
        interrupted = true;
        recorder.push({ dir: 'control', op: 'interrupt' });
        session.interrupt().then(
          (receipt) => recorder.push({ dir: 'control', op: 'interrupt-result', result: receipt ?? null }),
          (error) => recorder.push({ dir: 'control', op: 'interrupt-result', error: String(error?.message ?? error) }),
        );
        // An interrupted turn may legitimately end without a result frame.
        setTimeout(resolveResult, 15_000).unref();
      }
    }
  })();
  iterate.catch(() => undefined);

  const initialization = await withDeadline(session.initializationResult(), 60_000, () => abortController.abort());
  if (initialization === 'deadline') throw new Error('Claude initialization timed out.');
  recorder.push({ dir: 'initializationResult', result: claudeInitializationFacts(initialization) });
  const userMessage = {
    type: 'user',
    message: { role: 'user', content: context.prompt },
    parent_tool_use_id: null,
    uuid: userUuid,
    session_id: sessionId,
  };
  recorder.push({ dir: 'prompt', msg: userMessage });
  input.push(userMessage);

  const outcome = await withDeadline(resultSeen, scenario.deadlineMs ?? SESSION_DEADLINE_MS, () => {
    context.meta.aborted = 'deadline';
    abortController.abort();
  });
  if (outcome !== 'deadline') await delay(TRAILING_FRAMES_MS);
  if (outcome !== 'deadline' && scenario.waitForTasks) await waitForQuiet(context);
  recorder.push({ dir: 'control', op: 'close' });
  input.close();
  session.close();
  await withDeadline(iterate.catch(() => undefined), 5_000, () => undefined);
}

// ---------------------------------------------------------------------------
// Codex app-server

// Mirrors permissionStartSettings in src/main/codex-provider-adapter.ts.
function codexPermissionSettings(preset) {
  switch (preset) {
    case 'plan': return { approvalPolicy: 'never', sandbox: 'read-only' };
    case 'full-access': return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    default: return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

const CODEX_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

// Mirrors CodexProviderAdapter.approvalResponse.
function codexApprovalResponse(method, params, decision) {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: decision === 'accept' ? 'approved' : { denied: { rejection: 'Denied by the user in EZTerminal.' } } };
  }
  if (method === 'item/permissions/requestApproval') {
    const requested = params?.permissions ?? {};
    return {
      permissions: decision === 'accept' ? {
        ...(requested.network ? { network: requested.network } : {}),
        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
      } : {},
      scope: 'turn',
    };
  }
  return { decision };
}

async function captureCodex(scenario, context) {
  const { recorder, workspace } = context;
  const child = spawn(process.execPath, [context.codexScript, 'app-server'], {
    cwd: workspace,
    env: providerEnvironment(CODEX_ENVIRONMENT_VARIABLES),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const decide = scenario.codex ?? (() => 'accept');
  const pending = new Map();
  const notificationWaiters = [];
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let agentDeltas = 0;
  let interruptSent = false;
  let threadId;
  let turnId;

  const send = (frame) => {
    recorder.push({ dir: 'out', frame });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { method, resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const waitForNotification = (predicate) => new Promise((resolve) => notificationWaiters.push({ predicate, resolve }));

  const handleFrame = (frame) => {
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
      // Server request: approvals get scripted decisions; anything else is
      // rejected exactly as CodexAppServerClient does for unhandled methods.
      if (CODEX_APPROVAL_METHODS.has(frame.method)) {
        send({ jsonrpc: '2.0', id: frame.id, result: codexApprovalResponse(frame.method, frame.params, decide(frame.method, frame.params)) });
      } else if (frame.method === 'item/tool/requestUserInput') {
        // Mirrors CodexProviderAdapter: answers by question id, the first option standing in for the person.
        const answers = Object.fromEntries((frame.params?.questions ?? []).flatMap((question) => (
          question?.id && question.options?.[0]?.label ? [[question.id, { answers: [question.options[0].label] }]] : [])));
        send({ jsonrpc: '2.0', id: frame.id, result: { answers } });
      } else {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `No EZTerminal handler is registered for ${frame.method}.` } });
      }
      return;
    }
    if (
      scenario.interruptAfterTextDeltas
      && !interruptSent
      && frame.method === 'item/agentMessage/delta'
      && ++agentDeltas >= scenario.interruptAfterTextDeltas
      && threadId
      && turnId
    ) {
      interruptSent = true;
      recorder.push({ dir: 'control', op: 'interrupt' });
      request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    }
    for (const waiter of [...notificationWaiters]) {
      if (waiter.predicate(frame)) {
        notificationWaiters.splice(notificationWaiters.indexOf(waiter), 1);
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
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        recorder.push({ dir: 'in-unparsed', line });
        continue;
      }
      recorder.push({ dir: 'in', frame });
      context.lastFrameAt = Date.now();
      handleFrame(frame);
    }
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  try {
    // Same initialize parameters as CodexAppServerClient.spawnAndInitialize.
    await request('initialize', {
      clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    send({ jsonrpc: '2.0', method: 'initialized' });
    const preset = scenario.codexPreset ?? 'standard';
    // Same thread/start parameters as CodexProviderAdapter.createSession, except ephemeral.
    const started = await request('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      ...codexPermissionSettings(preset),
      ...(scenario.codexThreadConfig ? { config: scenario.codexThreadConfig } : {}),
      // Sub-agent threads cannot load an ephemeral parent's context, so those
      // scenarios record a persisted thread (it lands in Codex history under the scratch root).
      ephemeral: scenario.codexEphemeral ?? true,
      historyMode: 'paginated',
      threadSource: 'ezterminal',
    });
    threadId = started.thread.id;
    const clientUserMessageId = `capture-${randomUUID()}`;
    context.meta.preset = preset;
    context.meta.launch = {
      ephemeral: scenario.codexEphemeral ?? true,
      ...(scenario.codexThreadConfig ? { threadConfig: scenario.codexThreadConfig } : {}),
      ...(scenario.codexCollaborationMode ? { collaborationMode: scenario.codexCollaborationMode } : {}),
    };
    context.meta.clientUserMessageId = clientUserMessageId;
    context.meta.providerSessionId = threadId;
    context.meta.model = started.model;
    const completed = waitForNotification((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId);
    const turn = await request('turn/start', {
      threadId,
      clientUserMessageId,
      input: [{ type: 'text', text: context.prompt, text_elements: [] }],
      ...(scenario.codexCollaborationMode ? {
        collaborationMode: {
          mode: scenario.codexCollaborationMode,
          settings: { model: started.model, reasoning_effort: null, developer_instructions: null },
        },
      } : {}),
    });
    turnId = turn.turn.id;
    const outcome = await withDeadline(completed, scenario.deadlineMs ?? SESSION_DEADLINE_MS, () => { context.meta.aborted = 'deadline'; });
    if (outcome === 'deadline' && turnId) await request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    await delay(TRAILING_FRAMES_MS);
    if (outcome !== 'deadline' && scenario.waitForTasks) await waitForQuiet(context);
    // Same teardown request as CodexProviderAdapter.disposeSession.
    await withDeadline(request('thread/unsubscribe', { threadId }), 10_000, () => undefined);
  } catch (error) {
    context.meta.error = String(error?.message ?? error);
    if (stderr.trim()) console.error(stderr.trim().slice(-4_000));
    throw error;
  } finally {
    recorder.push({ dir: 'control', op: 'close' });
    child.stdin.end();
    await withDeadline(exited, 5_000, () => child.kill());
  }
}

// ---------------------------------------------------------------------------

function cliVersion(command, argv) {
  try {
    return execFileSync(command, argv, { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
  } catch {
    return 'unknown';
  }
}

async function captureOne(provider, scenario, options, versions) {
  const captureRoot = path.join(options.scratch, 'provider-capture');
  const workspace = path.join(captureRoot, `${provider}-${scenario.name}`);
  await fs.mkdir(captureRoot, { recursive: true });
  await seedProject(workspace, captureRoot, provider, scenario);
  const recorder = createRecorder();
  const prompt = scenarioPrompt(scenario, provider);
  const meta = {
    dir: 'meta',
    provider,
    scenario: scenario.name,
    prompt,
    capturedAt: new Date().toISOString().slice(0, 10),
    capturedWith: versions[provider],
  };
  const context = {
    recorder,
    workspace,
    prompt,
    meta,
    claudeExecutable: options.claudeExecutable,
    codexScript: options.codexScript,
  };
  const started = Date.now();
  let failure;
  try {
    if (provider === 'claude') await captureClaude(scenario, context);
    else await captureCodex(scenario, context);
  } catch (error) {
    failure = error;
  }
  const sanitize = createSanitizer({ workspace, captureRoot });
  sanitizeDeltaStreams(recorder.lines, sanitize.text);
  maskUserMcpServerNames(recorder.lines);
  const lines = [meta, ...recorder.lines].map((line) => JSON.stringify(sanitize(line)));
  await fs.mkdir(options.out, { recursive: true });
  const target = path.join(options.out, `${provider}-${scenario.name}.ndjson`);
  await fs.writeFile(target, `${lines.join('\n')}\n`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${failure ? 'FAILED' : 'ok'}  ${provider}-${scenario.name}  ${recorder.lines.length} lines  ${seconds}s  -> ${path.relative(root, target)}`);
  if (failure) console.error(`  ${failure.stack ?? failure}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const providers = options.provider === 'all' ? ['claude', 'codex'] : [options.provider];
  const versions = {};
  if (providers.includes('claude')) {
    options.claudeExecutable ??= resolveClaudeExecutable();
    const sdk = JSON.parse(readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
    versions.claude = { agentSdk: sdk.version, cli: cliVersion(options.claudeExecutable, ['--version']) };
  }
  if (providers.includes('codex')) {
    options.codexScript ??= resolveCodexScript();
    versions.codex = { cli: cliVersion(process.execPath, [options.codexScript, '--version']) };
  }
  for (const provider of providers) {
    for (const scenario of SCENARIOS) {
      if (options.scenario !== 'all' && options.scenario !== scenario.name) continue;
      if (scenario.providers && !scenario.providers.includes(provider)) continue;
      await captureOne(provider, scenario, options, versions);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
