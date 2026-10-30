/**
 * Shared pieces of the turn wrap-up probes (scripts/probe-claude-turn-wrap-up.mjs,
 * scripts/probe-codex-turn-wrap-up.mjs): the provider environment allow-list, the bulk seed,
 * the conversation's prompts, the host-composed recap and next-message instructions, a
 * per-file hash of the scratch repo, and a local `suggest_task` MCP server shaped like the
 * product's session MCP endpoint (src/main/agent-orchestration-mcp-server.ts: loopback,
 * POST-only stateless JSON-RPC, one bearer token per `/mcp/<label>` path).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Mirrors scripts/capture-provider-fixtures.mjs (and provider-process-security.ts). EZTERMINAL_*
// stays out, so the installed app's agent-hook relay exits without reporting anything.
const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TERM',
  'COLORTERM', 'NO_COLOR',
];
export const CLAUDE_ENVIRONMENT_VARIABLES = ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];
export const CODEX_ENVIRONMENT_VARIABLES = ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

export function providerEnvironment(names, fixed = {}) {
  const environment = {};
  for (const name of new Set([...REQUIRED_OS_ENVIRONMENT_VARIABLES, ...names])) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...fixed };
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const errorText = (error) => String(error?.rpc?.message ?? error?.message ?? error).slice(0, 400);
export const log = (text) => console.error(`[probe] ${new Date().toISOString()} ${text}`);
export const number = (value) => (value === undefined || value === null || Number.isNaN(Number(value)) ? null : Number(value));
export const ratio = (part, whole) => (part === null || part === undefined || !whole ? null : Math.round((part / whole) * 1_000) / 1_000);

/** Rejects after `ms`; the timer is cleared either way so the process can exit. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** ~600 lines ≈ 40k tokens (900 lines measured ≈ 66k Claude cache writes, ≈ 57k Codex cached). */
export const SEED_LINES = 600;

export function seedText(nonce, lines = SEED_LINES) {
  const words = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper',
    'kelp', 'lumen', 'meadow', 'nickel', 'onyx', 'pylon', 'quartz', 'raven', 'sierra', 'tundra'];
  const out = [`Team module notes ${nonce}`];
  for (let index = 1; index <= lines; index += 1) {
    const word = words[(index * 7) % words.length];
    const other = words[(index * 11 + 3) % words.length];
    out.push(`Module ${String(index).padStart(4, '0')}: code name ${word}-${index}; owner team ${other}; `
      + `depends on module ${String(((index * 13) % lines) + 1).padStart(4, '0')}; status ${index % 3 === 0 ? 'stable' : 'beta'}; `
      + `notes: keeps a ${word} cache and reports to the ${other} board every ${index % 7 + 1} days.`);
  }
  return out.join('\n');
}

/** The conversation, per provider where the tool vocabulary differs. */
export const PROMPTS = {
  seedSuffix: {
    claude: 'The list above is reference notes for later questions. Do not use any tools. Reply with exactly: OK',
    codex: 'The list above is reference notes for later questions. Do not run any commands or read files. Reply with exactly: OK',
  },
  // P1/P2/P3 conversation (A): one editing turn that ends waiting on the person, then ordinary turns.
  // The Codex editing turns are composed in probe-codex-turn-wrap-up.mjs (commands are declined there).
  fixFormat: {
    claude: 'In this repository, formatPrice in src/format.ts shows prices ten times too large. Please fix it. You may read '
      + 'and edit files, but do not run shell commands, and change only src/format.ts. When you are done, ask me whether I '
      + 'also want a unit test for it.',
  },
  english: 'No test for now. Without using any tools: what else could go wrong in formatPrice, for example with negative '
    + 'or fractional cents? Three short bullets.',
  korean1: '이제부터는 한국어로 이야기할게요. 도구는 쓰지 말고: formatPrice가 지금 음수 금액을 어떻게 표시하는지 한 줄로 알려 주세요.',
  korean2: '도구는 쓰지 말고: 음수 금액을 괄호로 표시하도록 바꾸려면 무엇을 고쳐야 하는지 두 줄로 계획만 말해 주세요.',
  korean3: '좋아요, 아직 바꾸지는 마세요. 도구는 쓰지 말고: 지금까지 이 대화에서 바꾼 파일 이름만 한 줄로 알려 주세요.',
  // P4 conversation (B): fix one bug in a repo that has several.
  fixCart: {
    claude: 'Please fix the bug in src/cart.ts: cartTotal reads past the end of the items array. Fix only that bug and change '
      + 'only src/cart.ts. Skim the other files in src/ first so your change fits the codebase. Do not run shell commands.',
  },
  summary: 'Without using any tools: summarize your change in one line.',
  // Approval checks (D): the tool named outright, no seed.
  directCall: 'Use the suggest_task tool exactly once to propose this task: title "Add a unit test for formatPrice", prompt '
    + '"Write a unit test for formatPrice in src/format.ts that covers 0, 5 and 1999 cents.", rationale "formatPrice has no '
    + 'test." Do not do the task yourself and use no other tool except to find suggest_task. Then reply with exactly: DONE',
};

/** Host-composed; the product would send the same text to both providers. */
export const RECAP_INSTRUCTION = 'Recap for the person, who was not watching this conversation. In 2-4 short lines: what you '
  + 'did, what is waiting on them, and what they should check. State only what actually happened in this conversation; '
  + 'never claim an action, file change or test that did not happen. Write in the language the person has been using. No preamble.';
export const PREDICT_INSTRUCTION = "Predict the person's most likely next message to you in this conversation. Reply with "
  + 'that message only, exactly as they would type it, in their language, at most 20 words, with no quotes or explanation. '
  + 'If they are most likely done, reply with: (none)';
/** The product's Codex /btw prefix (SIDE_QUESTION_INSTRUCTION, src/main/codex-provider-adapter.ts). */
export const CODEX_SIDE_QUESTION_INSTRUCTION = 'This is a side question about the conversation so far. You have NO tools: do not run commands, '
  + 'read files, edit anything or start sub-agents. Answer only from what is already in this conversation, in one short reply.';

/**
 * P5: what a side question sees of a turn stopped mid-way, by asking for facts planted at each level:
 * the turn's user message (ticket), its assistant text (marker), a tool result of the turn (`toolFact`),
 * and the request that is still open (pending).
 */
export const visibilityQuestion = (toolFact) => 'Answer from this conversation only, in four short lines. Write "unknown" for '
  + 'anything you cannot see; do not guess.\n'
  + '1. ticket: the ticket number in my latest message.\n'
  + '2. marker: the plan marker you wrote in your latest reply.\n'
  + `3. ${toolFact}\n`
  + '4. pending: is a tool call or a question of yours waiting for my answer right now? If so, which tool, and which file or question.';

/** What the host adds to a mid-turn recap: it knows what is open; the fork may show that call as aborted. */
export const recapStoppedNote = (waiting) => `Right now this turn is stopped, not finished: ${waiting} It is still open and waiting for the `
  + 'person. If your history shows that call as aborted or interrupted, that is only how this side view shows it; nothing was aborted.';

export const nonceWord = () => randomBytes(4).toString('hex');
export const visibilityFlags = (text, facts) => Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, String(text ?? '').includes(value)]));

// ---------------------------------------------------------------------------
// Scratch repo facts

async function listFiles(root, relative = '') {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(root, next));
    else files.push(next);
  }
  return files.sort();
}

/** Relative path -> sha256 of every working-tree file (not .git). */
export async function fileHashes(directory) {
  const hashes = {};
  for (const file of await listFiles(directory)) {
    hashes[file] = createHash('sha256').update(await fs.readFile(path.join(directory, ...file.split('/')))).digest('hex').slice(0, 16);
  }
  return hashes;
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort();
}

const SEEDED_FILES = ['src/cart.ts', 'src/auth.ts', 'src/format.ts', 'src/discount.ts', 'README.md'];

/**
 * Flags for reading a recap against what happened: which seeded files it names, which of those the
 * conversation did not change (a recap may name them as noticed, not changed — read the text), and
 * whether a line speaks of tests having run without negating it (no test ran in these conversations).
 */
export function recapFlags(text, changed) {
  const value = String(text ?? '');
  const named = SEEDED_FILES.filter((file) => new RegExp(path.posix.basename(file).replace('.', '\\.'), 'iu').test(value));
  const testLines = value.split(/\r?\n|(?<=[.!?。])\s+/u)
    .filter((line) => /\btests?\b[^.\n]{0,40}\b(pass|passed|ran|run|green)\b|테스트[^.\n]{0,20}(통과|실행|돌)/iu.test(line));
  const negated = (line) => /\bno\b[^.\n]{0,20}\btests?\b|\bnot\b[^.\n]{0,20}\b(run|ran)\b|n't\b[^.\n]{0,10}\b(run|ran)\b|않았|않음|안 ?했/iu.test(line);
  return {
    chars: value.length,
    lines: value.split(/\r?\n/u).filter((line) => line.trim()).length,
    hangul: /[가-힣]/u.test(value),
    namedFiles: named,
    namedButUnchanged: named.filter((file) => !changed.includes(file)),
    claimsTestsRan: testLines.some((line) => !negated(line)),
  };
}

// ---------------------------------------------------------------------------
// suggest_task MCP server

export const SUGGEST_SERVER = 'ezterminal_orchestration';
export const SUGGEST_TOOL = 'suggest_task';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SERVER_INSTRUCTIONS = 'EZTerminal session tools. When you notice work outside what the person asked for, propose it '
  + 'with suggest_task instead of doing it; the person decides whether to start it.';
const SUGGEST_DESCRIPTION = 'Propose a follow-up task to the person instead of doing it. Use it when you notice work outside '
  + 'what the person asked for: another bug, a missing test, a risky pattern, a cleanup. The person sees each proposal as a '
  + 'card and decides whether to start it in a new conversation; calling this tool changes nothing and starts nothing. Do not '
  + 'use it for the work you were asked to do, and do not do the proposed work yourself. One call per task; write `prompt` as '
  + 'the complete instruction a new conversation would need.';
const SUGGEST_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'prompt', 'rationale'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120, description: 'Short imperative title, e.g. "Fix the always-true role check in src/auth.ts".' },
    prompt: { type: 'string', minLength: 1, maxLength: 4000, description: 'The full instruction a new conversation would start with: what to change, where, and how to check it.' },
    rationale: { type: 'string', minLength: 1, maxLength: 500, description: 'Why it is worth doing: what you saw, in one or two sentences.' },
    worktree: { type: 'boolean', description: 'true when the task should run in its own git worktree (it edits files this conversation is also changing, or it is large).' },
  },
};
const SUGGEST_ANNOTATIONS = { title: 'Suggest a task', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** `alwaysLoadMeta`: Claude Code's per-tool `_meta['anthropic/alwaysLoad']` (keeps this one tool out of tool search). */
const toolDefinition = (annotated, alwaysLoadMeta = false) => ({
  name: SUGGEST_TOOL,
  description: SUGGEST_DESCRIPTION,
  inputSchema: SUGGEST_INPUT_SCHEMA,
  ...(annotated ? { annotations: SUGGEST_ANNOTATIONS } : {}),
  ...(alwaysLoadMeta ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
});

function validSuggestion(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const extra = Object.keys(args).filter((key) => !['title', 'prompt', 'rationale', 'worktree'].includes(key));
  if (extra.length) return `unknown fields: ${extra.join(', ')}`;
  for (const [key, max] of [['title', 120], ['prompt', 4000], ['rationale', 500]]) {
    if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > max) return `${key} must be 1-${max} characters`;
  }
  if (args.worktree !== undefined && typeof args.worktree !== 'boolean') return 'worktree must be a boolean';
  return null;
}

/**
 * Starts the loopback server. `endpoint(label, { annotated })` registers `/mcp/<label>` with its own
 * bearer token; every request is kept in `requests` (tool arguments included: they are about the scratch repo).
 */
export async function startSuggestionServer() {
  const routes = new Map(); // label -> { token, annotated, alwaysLoadMeta }
  const requests = [];
  const server = http.createServer((request, response) => {
    const send = (status, value, headers = {}) => {
      const body = value === undefined ? '' : JSON.stringify(value);
      response.writeHead(status, { 'cache-control': 'no-store', ...(body ? { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) } : {}), ...headers });
      response.end(body);
    };
    const match = /^\/mcp\/([^/?#]+)$/u.exec(request.url ?? '');
    const label = match ? decodeURIComponent(match[1]) : null;
    const route = label ? routes.get(label) : undefined;
    if (request.method !== 'POST') {
      requests.push({ at: Date.now(), label, httpMethod: request.method, status: 405 });
      send(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Only POST is supported.' } }, { allow: 'POST' });
      return;
    }
    const presented = Buffer.from(String(request.headers.authorization ?? ''));
    const expected = Buffer.from(route ? `Bearer ${route.token}` : '');
    if (!route || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      requests.push({ at: Date.now(), label, status: 401 });
      send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid session capability.' } }, { 'www-authenticate': 'Bearer' });
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request.' } });
        return;
      }
      const entry = { at: Date.now(), label, method: message?.method ?? null };
      requests.push(entry);
      if (message?.id === undefined) {
        response.writeHead(202, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      const reply = (result) => send(200, { jsonrpc: '2.0', id: message.id, result });
      const fail = (code, text) => send(200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } });
      if (message.method === 'initialize') {
        const requested = String(message.params?.protocolVersion ?? '');
        entry.protocolVersion = requested;
        reply({
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'ezterminal-orchestration', version: '1.0.0' },
          instructions: SERVER_INSTRUCTIONS,
        });
      } else if (message.method === 'ping') {
        reply({});
      } else if (message.method === 'tools/list') {
        reply({ tools: [toolDefinition(route.annotated, route.alwaysLoadMeta)] });
      } else if (message.method === 'tools/call') {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        entry.tool = name;
        entry.arguments = args;
        if (name !== SUGGEST_TOOL) {
          entry.rejected = 'unknown tool';
          reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `Unknown tool ${String(name)}.` }) }], isError: true });
          return;
        }
        const problem = validSuggestion(args);
        if (problem) {
          entry.rejected = problem;
          reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: problem }) }], isError: true });
          return;
        }
        entry.suggestionId = `suggestion-${randomUUID().slice(0, 8)}`;
        reply({ content: [{ type: 'text', text: JSON.stringify({ ok: true, suggestionId: entry.suggestionId, shown: 'The person sees this as a suggested task card. Nothing was started.' }) }] });
      } else {
        fail(-32601, 'Method not found.');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    requests,
    endpoint(label, { annotated = true, alwaysLoadMeta = false } = {}) {
      const token = randomBytes(24).toString('hex');
      routes.set(label, { token, annotated, alwaysLoadMeta });
      return { url: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(label)}`, token };
    },
    /** What one endpoint saw: method counts and the suggest_task calls. */
    summary(label) {
      const mine = requests.filter((entry) => entry.label === label);
      const methods = {};
      for (const entry of mine) {
        const key = entry.method ?? `${entry.httpMethod ?? 'POST'}:${entry.status}`;
        methods[key] = (methods[key] ?? 0) + 1;
      }
      return {
        methods,
        suggestions: mine.filter((entry) => entry.method === 'tools/call').map((entry) => ({
          at: entry.at, tool: entry.tool, accepted: Boolean(entry.suggestionId), rejected: entry.rejected ?? null,
          title: entry.arguments?.title ?? null, rationale: entry.arguments?.rationale ?? null,
          worktree: entry.arguments?.worktree ?? null, promptChars: typeof entry.arguments?.prompt === 'string' ? entry.arguments.prompt.length : null,
          prompt: entry.arguments?.prompt ?? null,
        })),
      };
    },
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}

/** Writes the report now, so a later crash keeps the passes already run. */
export async function writeReport(file, report) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
}
