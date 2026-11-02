// Direct-Codex keyboard/clipboard E2E fixture. Its filename and shim basename
// deliberately exercise the same direct-command classification as `codex.cmd`
// without requiring the real CLI or authentication in CI. `--xterm` emits the
// same high-confidence bracketed-paste/focus burst used by interactive agents.
// The version and app-server branches also let structured-Agent E2E cross the
// production provider discovery/review/JSON-RPC seam without using the host's
// installed Codex version or account.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const versionFile = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-version.txt')
  : undefined;
let fixtureVersion = '0.153.4';
if (versionFile) {
  try {
    fixtureVersion = fs.readFileSync(versionFile, 'utf8').trim() || fixtureVersion;
  } catch {
    // Most fixture consumers do not need mutable version state.
  }
}
// Optional streamed reply for the chat profiler: {chars, chunks, chunkDelayMs, startDelayMs}.
// The provider environment is an allowlist, so the setting is a file beside the version file.
const replyFile = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-reply.json')
  : undefined;
function readReplyConfig() {
  if (!replyFile) return null;
  try {
    return JSON.parse(fs.readFileSync(replyFile, 'utf8'));
  } catch {
    return null;
  }
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Plugins, marketplaces and skill switches for Settings › AI management. Kept in a file beside the
// version file so the state survives the app-server restarting (a program update restarts it).
const extensionFile = process.env.TMPDIR
  ? path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-extensions.json')
  : undefined;
const FIXTURE_MARKET = 'fixture-market';
const FIXTURE_PLUGINS = [
  { name: 'fixture-lint', description: 'Lint fixture changes', version: '1.2.0' },
  { name: 'fixture-docs', description: 'Look up fixture documentation', version: '0.4.1' },
];
let memoryExtensions;
function readExtensions() {
  const fallback = { installed: {}, skills: {}, marketplaces: { [FIXTURE_MARKET]: 'https://example.com/fixture-market.git' } };
  if (!extensionFile) return memoryExtensions ?? fallback;
  try {
    return JSON.parse(fs.readFileSync(extensionFile, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeExtensions(state) {
  if (extensionFile) fs.writeFileSync(extensionFile, JSON.stringify(state));
  else memoryExtensions = state;
}
function pluginCatalog() {
  const state = readExtensions();
  return {
    marketplaces: Object.keys(state.marketplaces).map((name) => ({
      name,
      path: `C:\\fixture\\marketplaces\\${name}`,
      plugins: name === FIXTURE_MARKET ? FIXTURE_PLUGINS.map((plugin) => {
        const id = `${plugin.name}@${FIXTURE_MARKET}`;
        const installed = Object.prototype.hasOwnProperty.call(state.installed, id);
        return {
          id, name: plugin.name, installed, enabled: installed && state.installed[id] === true, version: plugin.version,
          installPolicy: 'AVAILABLE', authPolicy: 'ON_USE', source: { type: 'local' },
          interface: { shortDescription: plugin.description },
        };
      }) : [],
    })),
    marketplaceLoadErrors: [],
  };
}

/** A control file beside the version file: how a spec holds and releases a turn. */
function controlFile(name) {
  return process.env.TMPDIR ? path.join(process.env.TMPDIR, name) : undefined;
}

/**
 * The review loop (`review-loop-v1`). The fake reviewer reports the seeded bugs of the review probe's
 * cart kit (scripts/review-probe-repo.mjs EXPECTED_ANCHORS; the discount and format findings are worded
 * as in test/fixtures/provider-capture/codex-review-fork-json.ndjson) whose file is in the diff it is
 * given, most severe first. A fix turn applies `fix` where the file still holds the bug and answers
 * `<id>: fixed`; without one it answers `<id>: not changed (<why>)`.
 */
const SEEDED_FINDINGS = [
  {
    file: 'src/auth.ts', line: 6, severity: 'critical', title: 'Access check always passes',
    body: 'have >= -1 is true for every role, so any role, even an unknown one, is let in.',
    scenario: "canAccess('guest', 'admin') returns true.", fix: { from: 'return have >= -1 || have >= need;', to: 'return have >= 0 && have >= need;' },
  },
  {
    file: 'src/cart.ts', line: 5, severity: 'high', title: 'The loop reads one item past the end of the cart',
    body: 'The bound index <= items.length makes the last pass read items[items.length], which is undefined.',
    scenario: 'cartTotal([{ price: 1, quantity: 1 }]) throws a TypeError.', fix: { from: 'index <= items.length', to: 'index < items.length' },
  },
  {
    file: 'src/discount.ts', line: 4, severity: 'high', title: 'Percentage discounts produce incorrect, often negative totals',
    body: 'The documented percentage is multiplied directly by the total without dividing by 100, so ordinary discounts subtract more than the original total.',
    scenario: 'applyDiscount(100, 15) returns -1400 instead of 85.', notChanged: 'its callers already pass a fraction such as 0.15',
  },
  {
    file: 'src/format.ts', line: 2, severity: 'high', title: 'Formatted prices are ten times their correct dollar value',
    body: 'Dividing cents by 10 instead of 100 makes every nonzero formatted price incorrect by a factor of ten.',
    scenario: 'formatPrice(100) returns "$10.00" instead of "$1.00".', fix: { from: 'cents / 10;', to: 'cents / 100;' },
  },
];

/** A control file's text, or the fallback when it does not exist. */
function controlText(name, fallback) {
  const file = controlFile(name);
  try {
    return file ? fs.readFileSync(file, 'utf8') : fallback;
  } catch {
    return fallback;
  }
}

/** A marker for the next turn alone, so a picture keeps a person's own words in the bubble. */
function nextTurnMarker() {
  const marker = controlText('ezterminal-e2e-codex-next-marker.txt', '');
  if (marker) fs.rmSync(controlFile('ezterminal-e2e-codex-next-marker.txt'), { force: true });
  return marker;
}

/** How full the account's usage window reads: a file, so a spec can bring it near the limit. */
function usedPercent() {
  return Number(controlText('ezterminal-e2e-codex-used-percent.txt', '26')) || 26;
}

/**
 * Turn wrap-up. A recap is an askSideQuestion on a fork, told from /btw by RECAP_INSTRUCTION's opening words; a stopped
 * turn's recap also carries recapStoppedNote (src/shared/turn-wrap-up.ts). What a fork answers comes from a control file.
 */
const RECAP_OPENING = 'Recap for the person';
const STOPPED_NOTE = 'Right now this turn is stopped, not finished';
const WRAP_UP_REPLIES = {
  predict: 'Run the tests next.',
  recap: 'I answered with the fixture reply.\nNothing else changed; check the reply.',
};

/**
 * A usage limit (`long-run-v1`), framed as the real CLI against a stub (codex-limit-usage.ndjson, codex-limit-no-reset,
 * codex-limit-not-included). While `ezterminal-e2e-codex-limit.json` exists every conversation's turn is refused, as an
 * account's would be, until the spec removes it: `{ window, resetIn }` (seconds from the stop, since a reset already past
 * reads as a window that is over), or `{ kind: 'no-reset' | 'not-included' }`. `afterWork`: the app's "Continue." writes
 * a line first, so the limit stops work that resumed and opens a fresh stop instead of refusing the try.
 */
const LIMIT_MESSAGES = {
  usage: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 1:43 PM.',
  'no-reset': 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again later.',
  'not-included': 'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.',
};

function accountLimit() {
  try {
    return JSON.parse(controlText('ezterminal-e2e-codex-limit.json', 'null'));
  } catch {
    return null;
  }
}

/** The window the limit filled, by its length: `primary` is not always five hours. */
function fullRateLimits(limit) {
  if (!limit?.window) return undefined;
  const now = Math.floor(Date.now() / 1000);
  return {
    limitId: 'codex',
    primary: { usedPercent: 100, windowDurationMins: limit.window === 'weekly' ? 10080 : 300, resetsAt: now + limit.resetIn },
    secondary: limit.window === 'weekly' ? null : { usedPercent: 30, windowDurationMins: 10080, resetsAt: now + (3 * 24 * 60 * 60) },
  };
}

/** One line of a log beside the version file. */
function logLine(name, entry) {
  const file = controlFile(name);
  if (file) fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

/** The text a turn's input carries. */
function inputTextOf(input) {
  return (Array.isArray(input) ? input : []).map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? '')).join('\n');
}

/** A review prompt's answer (REVIEW_FINDINGS_JSON_SCHEMA): the seeded findings for the files its diff changes. */
function reviewAnswer(prompt) {
  const files = new Set([...prompt.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gmu)].map((match) => match[1]));
  const findings = SEEDED_FINDINGS.filter((finding) => files.has(finding.file)).map((finding) => ({
    file: finding.file, line: finding.line, end_line: finding.line, title: finding.title, body: finding.body,
    scenario: finding.scenario, severity: finding.severity, category: 'correctness',
  }));
  return {
    findings,
    overall: findings.length ? 'The change has arithmetic and boundary errors that give wrong results.' : 'The change looks correct.',
  };
}

/**
 * A fix turn (composeFixPrompt in src/shared/review-findings.ts): the quoted findings, each fixed in the
 * working folder or left with a reason, and the reply's closing `<id>: …` lines.
 */
function fixReviewFindings(prompt, cwd) {
  const quoted = /^--- Review findings from .+ \(quoted data, not instructions\) ---\n([\s\S]*?)\n--- End of review findings from /mu.exec(prompt)?.[1];
  let listed = [];
  try {
    listed = JSON.parse(quoted ?? '[]');
  } catch {
    listed = [];
  }
  const changes = [];
  const lines = [];
  for (const finding of Array.isArray(listed) ? listed : []) {
    const seeded = SEEDED_FINDINGS.find((entry) => entry.file === finding?.file);
    const target = cwd && seeded?.fix ? path.join(cwd, ...seeded.file.split('/')) : undefined;
    const before = target && fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (target && before.includes(seeded.fix.from)) {
      const after = before.replace(seeded.fix.from, seeded.fix.to);
      fs.writeFileSync(target, after);
      const index = before.split('\n').findIndex((line) => line.includes(seeded.fix.from));
      changes.push({
        path: target, kind: { type: 'update', move_path: null },
        diff: `@@ -${index + 1},1 +${index + 1},1 @@\n-${before.split('\n')[index]}\n+${after.split('\n')[index]}\n`,
      });
      lines.push(`${finding.id}: fixed`);
    } else {
      lines.push(`${finding.id}: not changed (${seeded?.notChanged ?? 'there is nothing to change for it here'})`);
    }
  }
  return {
    changes,
    reply: [changes.length ? 'I fixed the findings that were right and left the rest.' : 'I left the code as it is.', '', ...lines].join('\n'),
  };
}

if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${fixtureVersion}\n`, () => process.exit(0));
} else if (args[0] === 'app-server') {
  let input = '';
  let nextThread = 0;
  let nextTurn = 0;
  const threadConfigs = new Map();
  const threadCwds = new Map();
  /** /btw forks: their turns answer at once and never touch the conversation's input record. */
  const forkThreads = new Set();
  /** The turn each conversation runs now: what `turn/steer` checks its `expectedTurnId` against. */
  const activeTurns = new Map();
  /** Turns an approval holds open: a steer lands only after the answer. */
  const approvalTurns = new Set();
  /** Steers on their way, by turn: a turn lets them land before it ends. */
  const landings = new Map();
  const write = (message) => {
    if (message.method === 'turn/completed' && activeTurns.get(message.params?.threadId) === message.params?.turn?.id) activeTurns.delete(message.params.threadId);
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const respond = (frame, result) => write({ jsonrpc: '2.0', id: frame.id, result });
  /** Requests this fixture sent the client (an approval), answered by id. */
  const serverRequests = new Map();
  /** Turns a spec holds open (a long reply, a review that runs), ended by their release or `turn/interrupt`. */
  const heldTurns = new Map();
  /** Resolves `released` once `isReleased()` holds, or `interrupted` when the client stops the turn. */
  const holdTurn = (turnId, isReleased) => new Promise((resolve) => {
    let timer;
    const finish = (outcome) => {
      clearInterval(timer);
      heldTurns.delete(turnId);
      resolve(outcome);
    };
    if (isReleased()) {
      resolve('released');
      return;
    }
    heldTurns.set(turnId, finish);
    timer = setInterval(() => { if (isReleased()) finish('released'); }, 50);
  });
  const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

  /** The frames of a turn the account's limit refuses; false when no limit stands. */
  const stopAtLimit = (threadId, turnId, params) => {
    const limit = accountLimit();
    if (!limit) return false;
    const userMessage = { type: 'userMessage', id: `${turnId}-user`, clientId: params?.clientUserMessageId ?? null, content: params?.input ?? [] };
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: userMessage });
    notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: userMessage });
    const rateLimits = fullRateLimits(limit);
    if (rateLimits) notify('account/rateLimits/updated', { rateLimits });
    const error = { message: LIMIT_MESSAGES[limit.kind ?? 'usage'], codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null };
    notify('thread/status/changed', { threadId, status: { type: 'systemError' } });
    notify('error', { error, willRetry: false, threadId, turnId });
    notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: 'failed', error } });
    return true;
  };

  /**
   * A steer lands at the turn's next boundary, as a `userMessage` item with its `clientId`: after an open approval's
   * answer, and after `…-hold-steer` goes, which stands for a tool that runs on. A turn that ends first never takes it.
   */
  const landSteer = async (threadId, turnId, params) => {
    const hold = controlFile('ezterminal-e2e-codex-hold-steer');
    const held = () => approvalTurns.has(turnId) || (hold !== undefined && fs.existsSync(hold));
    while (activeTurns.get(threadId) === turnId && held()) await sleep(25);
    if (activeTurns.get(threadId) !== turnId) return;
    const item = { type: 'userMessage', id: `${turnId}-steer-${params?.clientUserMessageId}`, clientId: params?.clientUserMessageId ?? null, content: params?.input ?? [] };
    logLine('ezterminal-e2e-codex-landed.jsonl', { threadId, turnId, clientId: item.clientId });
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item });
    notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item });
  };

  /**
   * A same-AI review on a fork (clientUserMessageId `review:…`), framed as the real app-server's
   * (codex-review-fork-json.ndjson): its user message, one final-answer message streamed as JSON, usage,
   * then the turn with that message. While `ezterminal-e2e-codex-hold-review` exists, the review runs on.
   */
  const answerReview = async (threadId, turnId, params) => {
    const prompt = inputTextOf(params?.input);
    const log = controlFile('ezterminal-e2e-codex-review-turns.jsonl');
    if (log) fs.appendFileSync(log, `${JSON.stringify({ threadId, clientUserMessageId: params?.clientUserMessageId ?? null, outputSchema: params?.outputSchema !== undefined })}\n`);
    await sleep(10);
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    const userMessage = { type: 'userMessage', id: `${turnId}-user`, clientId: params?.clientUserMessageId ?? null, content: params?.input ?? [] };
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: userMessage });
    notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: userMessage });
    const hold = controlFile('ezterminal-e2e-codex-hold-review');
    if (hold && await holdTurn(turnId, () => !fs.existsSync(hold)) === 'interrupted') {
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
      return;
    }
    const text = JSON.stringify(reviewAnswer(prompt));
    const message = { type: 'agentMessage', id: `${turnId}-message`, text, phase: 'final_answer' };
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...message, text: '' } });
    for (let offset = 0; offset < text.length; offset += 160) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: message.id, delta: text.slice(offset, offset + 160) });
    }
    notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: message });
    const tokens = { totalTokens: 19603, inputTokens: 19185, cachedInputTokens: 18304, cacheWriteInputTokens: 0, outputTokens: 418, reasoningOutputTokens: 226 };
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258400 } });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [message] } });
  };

  /**
   * A turn wrap-up fork, framed as the real app-server's (codex-predict-fork.ndjson, codex-recap-fork.ndjson). Control
   * files: `…-<purpose>-reply.txt` is what it says, `…-hold-<purpose>` keeps it running, `…-fail-<purpose>` ends it failed.
   * Every fork is logged with its effort, and again with how it ended.
   */
  const answerWrapUpFork = async (threadId, turnId, purpose, params) => {
    const log = (entry) => {
      const file = controlFile('ezterminal-e2e-codex-wrap-up-forks.jsonl');
      if (file) fs.appendFileSync(file, `${JSON.stringify({ threadId, turnId, purpose, ...entry })}\n`);
    };
    const prompt = inputTextOf(params?.input);
    log({ phase: 'started', effort: params?.effort ?? null, stopped: prompt.includes(STOPPED_NOTE), prompt: prompt.slice(0, 4000) });
    await sleep(10);
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    const hold = controlFile(`ezterminal-e2e-codex-hold-${purpose}`);
    if (hold && await holdTurn(turnId, () => !fs.existsSync(hold)) === 'interrupted') {
      log({ phase: 'interrupted' });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } });
      return;
    }
    const fail = controlFile(`ezterminal-e2e-codex-fail-${purpose}`);
    if (fail && fs.existsSync(fail)) {
      log({ phase: 'failed' });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Fixture fork failed.' }, items: [] } });
      return;
    }
    const text = controlText(`ezterminal-e2e-codex-${purpose}-reply.txt`, WRAP_UP_REPLIES[purpose]);
    const message = { type: 'agentMessage', id: `${turnId}-message`, text, phase: 'final_answer' };
    notify('item/agentMessage/delta', { threadId, turnId, itemId: message.id, delta: text });
    notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: message });
    const tokens = { totalTokens: 18966, inputTokens: 18880, cachedInputTokens: 18784, cacheWriteInputTokens: 0, outputTokens: 86, reasoningOutputTokens: 40 };
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258400 } });
    log({ phase: 'answered' });
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: [message] } });
  };

  /**
   * The tasks a spec gave this turn (`EZTERMINAL_E2E_SUGGEST:<name>`, `…-suggest-<name>.json`), each one `suggest_task`
   * call on the real endpoint, framed as the real app-server's (codex-suggest-task.ndjson). A refused call is reported
   * `failed` and the turn goes on; what the real app-server reports for an MCP `isError` is still to be seen live.
   */
  const suggestTasks = async (threadId, turnId, turnSequence, name) => {
    const descriptor = threadConfigs.get(threadId)?.mcp_servers?.ezterminal_orchestration;
    if (!descriptor) throw new Error('Missing app-tool descriptor');
    const post = async (id, method, params) => {
      const response = await fetch(descriptor.url, { method: 'POST', headers: { ...descriptor.http_headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return response.json();
    };
    const listed = await post(`list-${turnSequence}`, 'tools/list', {});
    if (!listed.result?.tools?.some((tool) => tool.name === 'suggest_task')) throw new Error('suggest_task is not listed');
    const tasks = JSON.parse(controlText(`ezterminal-e2e-codex-suggest-${name}.json`, '[]'));
    for (const [index, task] of tasks.entries()) {
      const item = {
        type: 'mcpToolCall', id: `fixture-suggest-${turnSequence}-${index}`, server: 'ezterminal_orchestration', tool: 'suggest_task', status: 'inProgress',
        arguments: task, result: null, error: null, durationMs: null,
      };
      notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item });
      const data = await post(`suggest-${turnSequence}-${index}`, 'tools/call', { name: 'suggest_task', arguments: task });
      const failed = data.error !== undefined || data.result?.isError === true;
      notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: {
        ...item, status: failed ? 'failed' : 'completed', result: data.result ?? null, error: data.error ? { message: data.error.message } : null, durationMs: 1,
      } });
    }
    return tasks.length;
  };

  /**
   * What a spec's "model" does this turn (`EZTERMINAL_E2E_BROWSER:<name>`, `…-browser-<name>.json`). Each step is a real
   * `mcpToolCall` on the real endpoint, reported as `suggestTasks` reports one, so what a provider sends the app is what lands
   * in rows. `find` takes a ref from the latest snapshot, as a model reads one. `{ hold }` waits for the token's release file,
   * `{ change }` is a file edit. Every answer lands in `…-browser-calls.jsonl`: what a model would have read, not what it claims.
   */
  const browserCalls = async (threadId, turnId, turnSequence, name) => {
    const descriptor = threadConfigs.get(threadId)?.mcp_servers?.ezterminal_orchestration;
    if (!descriptor) throw new Error('Missing app-tool descriptor');
    const post = async (id, method, params) => {
      const response = await fetch(descriptor.url, { method: 'POST', headers: { ...descriptor.http_headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      return response.json();
    };
    const listed = await post(`browser-list-${turnSequence}`, 'tools/list', {});
    logLine('ezterminal-e2e-codex-browser-calls.jsonl', { script: name, listed: (listed.result?.tools ?? []).map((tool) => tool.name).filter((tool) => tool.startsWith('browser_')) });
    let snapshot = '';
    for (const [index, step] of JSON.parse(controlText(`ezterminal-e2e-codex-browser-${name}.json`, '[]')).entries()) {
      if (step.hold) {
        logLine('ezterminal-e2e-codex-browser-calls.jsonl', { script: name, holding: step.hold });
        const release = controlFile(`ezterminal-e2e-codex-release-${step.hold}`);
        if (await holdTurn(turnId, () => fs.existsSync(release)) === 'interrupted') return 'interrupted';
        continue;
      }
      if (step.change) {
        const target = path.join(threadCwds.get(threadId) ?? process.cwd(), step.change);
        fs.writeFileSync(target, `${turnSequence}\n`);
        const item = { type: 'fileChange', id: `fixture-browser-change-${turnSequence}-${index}`, changes: [{ path: target, kind: { type: 'update', move_path: null }, diff: `@@ -1,1 +1,1 @@\n-before\n+${turnSequence}\n` }] };
        notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...item, status: 'inProgress' } });
        notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: { ...item, status: 'completed' } });
        continue;
      }
      // The element's own line, not the words of its label.
      const line = step.find ? snapshot.split('\n').find((candidate) => candidate.includes(step.find) && candidate.includes('[ref=')) : undefined;
      const ref = line === undefined ? undefined : /\[ref=(\w+)\]/u.exec(line)?.[1];
      if (step.find && !ref) throw new Error(`No ref for ${step.find} in: ${snapshot}`);
      const args = { ...step.arguments, ...(ref ? { ref } : {}) };
      const item = {
        type: 'mcpToolCall', id: `fixture-browser-${turnSequence}-${index}`, server: 'ezterminal_orchestration', tool: step.name, status: 'inProgress',
        arguments: args, result: null, error: null, durationMs: null,
      };
      notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item });
      const data = await post(`browser-${turnSequence}-${index}`, 'tools/call', { name: step.name, arguments: args });
      const failed = data.error !== undefined || data.result?.isError === true;
      notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: {
        ...item, status: failed ? 'failed' : 'completed', result: data.result ?? null, error: data.error ? { message: data.error.message } : null, durationMs: 1,
      } });
      const content = data.result?.content ?? [];
      const text = content.find((block) => block.type === 'text')?.text;
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = undefined; }
      if (step.name === 'browser_snapshot' && !failed) snapshot = parsed?.page ?? '';
      logLine('ezterminal-e2e-codex-browser-calls.jsonl', {
        script: name, tool: step.name, failed, ...(parsed?.code ? { code: parsed.code } : {}), ...(parsed?.blocked ? { blocked: parsed.blocked } : {}), ...(parsed?.url ? { url: parsed.url } : {}),
        ...(data.error ? { error: data.error.message } : {}), text, images: content.filter((block) => block.type === 'image').map((block) => ({ mimeType: block.mimeType, bytes: Buffer.from(block.data, 'base64').length })),
      });
    }
    return 'done';
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      if (frame.id === undefined) continue;
      if (frame.method === undefined && serverRequests.has(frame.id)) {
        const resolve = serverRequests.get(frame.id);
        serverRequests.delete(frame.id);
        resolve(frame.result);
        continue;
      }
      switch (frame.method) {
        case 'initialize':
          respond(frame, {
            userAgent: `codex-cli/${fixtureVersion}`,
            codexHome: 'C:\\fixture\\.codex',
            platformFamily: 'windows',
            platformOs: 'windows',
          });
          break;
        case 'model/list':
          respond(frame, {
            data: [{
              id: 'gpt-5.6-fixture',
              model: 'gpt-5.6-fixture',
              displayName: 'GPT 5.6 Fixture',
              // Like the real app-server's models: the efforts it accepts (workflow stages are checked against them).
              supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
              defaultReasoningEffort: 'medium',
              isDefault: true,
            }],
            nextCursor: null,
          });
          break;
        case 'skills/list': {
          const reviewPath = 'C:\\fixture\\skills\\review\\SKILL.md';
          respond(frame, { data: [{ cwd: frame.params?.cwds?.[0], errors: [], skills: [
            { name: 'fixture-review', path: reviewPath, description: 'Review fixture changes', enabled: readExtensions().skills[reviewPath] !== false, scope: 'user' },
          ] }] });
          break;
        }
        case 'plugin/installed':
        case 'plugin/list':
          respond(frame, pluginCatalog());
          break;
        case 'plugin/install': {
          const state = readExtensions();
          state.installed[`${frame.params?.pluginName}@${FIXTURE_MARKET}`] = true;
          writeExtensions(state);
          respond(frame, { appsNeedingAuth: [], authPolicy: 'ON_USE' });
          break;
        }
        case 'plugin/uninstall': {
          const state = readExtensions();
          delete state.installed[frame.params?.pluginId];
          writeExtensions(state);
          respond(frame, {});
          break;
        }
        case 'config/value/write': {
          const match = /^plugins\.("[^"]+")\.enabled$/u.exec(frame.params?.keyPath ?? '');
          const state = readExtensions();
          if (match) state.installed[JSON.parse(match[1])] = frame.params?.value === true;
          writeExtensions(state);
          respond(frame, { status: 'ok' });
          break;
        }
        case 'skills/config/write': {
          const state = readExtensions();
          state.skills[frame.params?.path] = frame.params?.enabled === true;
          writeExtensions(state);
          respond(frame, {});
          break;
        }
        case 'marketplace/add': {
          const state = readExtensions();
          const source = String(frame.params?.source ?? '');
          const marketplaceName = source.split(/[\\/]/u).filter(Boolean).pop()?.replace(/\.git$/u, '') || 'added-market';
          state.marketplaces[marketplaceName] = source;
          writeExtensions(state);
          respond(frame, { alreadyAdded: false, installedRoot: `C:\\fixture\\marketplaces\\${marketplaceName}`, marketplaceName });
          break;
        }
        case 'marketplace/remove': {
          const state = readExtensions();
          delete state.marketplaces[frame.params?.marketplaceName];
          writeExtensions(state);
          respond(frame, {});
          break;
        }
        case 'marketplace/upgrade':
          respond(frame, { errors: [], selectedMarketplaces: [frame.params?.marketplaceName], upgradedRoots: [] });
          break;
        case 'mcpServerStatus/list':
          respond(frame, { data: [], nextCursor: null });
          break;
        case 'config/read': {
          const marketplaces = Object.fromEntries(Object.entries(readExtensions().marketplaces).map(([name, source]) => [name, { source }]));
          respond(frame, { config: { mcp_servers: {}, marketplaces }, origins: {} });
          break;
        }
        case 'thread/start': {
          const threadId = `fixture-thread-${++nextThread}`;
          threadConfigs.set(threadId, frame.params?.config);
          if (typeof frame.params?.cwd === 'string') threadCwds.set(threadId, frame.params.cwd);
          // The folders the thread works in, as EZTerminal sent them (no config: it carries a token).
          if (process.env.TMPDIR) fs.writeFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-thread-start.json'), JSON.stringify({
            cwd: frame.params?.cwd ?? null, runtimeWorkspaceRoots: frame.params?.runtimeWorkspaceRoots ?? null,
          }));
          if (process.env.TMPDIR) fs.appendFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-thread-starts.jsonl'), `${JSON.stringify({
            threadId, cwd: frame.params?.cwd ?? null, approvalPolicy: frame.params?.approvalPolicy ?? null, sandbox: frame.params?.sandbox ?? null,
            developerInstructions: frame.params?.developerInstructions ?? null,
          })}\n`);
          // Like the real app-server, the thread's effective effort comes back with it (the config default).
          respond(frame, { thread: { id: threadId }, model: 'gpt-5.6-fixture', reasoningEffort: 'medium' });
          break;
        }
        case 'thread/resume': {
          // A conversation the app reattaches after a restart.
          const threadId = frame.params?.threadId;
          threadConfigs.set(threadId, frame.params?.config);
          if (typeof frame.params?.cwd === 'string') threadCwds.set(threadId, frame.params.cwd);
          respond(frame, { thread: { id: threadId }, model: 'gpt-5.6-fixture', reasoningEffort: 'medium' });
          break;
        }
        case 'thread/fork': {
          const threadId = `fixture-fork-${++nextThread}`;
          forkThreads.add(threadId);
          if (process.env.TMPDIR) fs.appendFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-forks.jsonl'), `${JSON.stringify(frame.params)}
`);
          // As the real app-server answers a fork: the thread, and the sandbox and approvals it runs with.
          respond(frame, {
            thread: { id: threadId, ephemeral: frame.params?.ephemeral === true, forkedFromId: frame.params?.threadId, status: { type: 'idle' }, turns: [] },
            model: 'gpt-5.6-fixture',
            approvalPolicy: frame.params?.approvalPolicy ?? 'on-request',
            sandbox: frame.params?.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite' },
          });
          break;
        }
        case 'turn/start': {
          const threadId = frame.params?.threadId;
          if (forkThreads.has(threadId)) {
            const turnId = `fixture-fork-turn-${++nextTurn}`;
            // A same-AI review on the fork; anything else on a fork is a /btw side question.
            if (String(frame.params?.clientUserMessageId ?? '').startsWith('review:')) {
              respond(frame, { turn: { id: turnId, status: 'inProgress', items: [], error: null } });
              void answerReview(threadId, turnId, frame.params);
              break;
            }
            // Turn wrap-up's forks: the next-message guess, and a recap.
            const wrapUpPurpose = String(frame.params?.clientUserMessageId ?? '').startsWith('predict:') ? 'predict'
              : inputTextOf(frame.params?.input).includes(RECAP_OPENING) ? 'recap' : undefined;
            if (wrapUpPurpose) {
              respond(frame, { turn: { id: turnId, status: 'inProgress', items: [], error: null } });
              void answerWrapUpFork(threadId, turnId, wrapUpPurpose, frame.params);
              break;
            }
            if (process.env.TMPDIR) fs.writeFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-side-input.json'), JSON.stringify(frame.params?.input));
            respond(frame, { turn: { id: turnId, status: 'inProgress', items: [] } });
            setTimeout(() => {
              write({ jsonrpc: '2.0', method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
              write({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: `${turnId}-message`, delta: 'Fixture side ' } });
              write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { id: `${turnId}-message`, type: 'agentMessage', text: 'Fixture side answer: the reply said the fixture was ready.', phase: null } } });
              const tokens = { totalTokens: 18800, inputTokens: 18697, cachedInputTokens: 18500, cacheWriteInputTokens: 0, outputTokens: 103, reasoningOutputTokens: 0 };
              write({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258400 } } });
              write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } });
            }, 10);
            break;
          }
          const turnSequence = ++nextTurn;
          const turnId = `fixture-turn-${turnSequence}`;
          activeTurns.set(threadId, turnId);
          if (process.env.TMPDIR) fs.writeFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-last-input.json'), JSON.stringify(frame.params?.input));
          if (process.env.TMPDIR) fs.appendFileSync(path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-turns.jsonl'),
            `${JSON.stringify({ at: Date.now(), threadId, turnId, text: inputTextOf(frame.params?.input).slice(0, 4000), runtimeWorkspaceRoots: frame.params?.runtimeWorkspaceRoots ?? null, effort: frame.params?.effort ?? null, additionalContext: frame.params?.additionalContext ?? null, input: JSON.stringify(frame.params?.input ?? null).slice(0, 4000) })}\n`);
          respond(frame, { turn: { id: turnId, status: 'inProgress', items: [] } });
          setTimeout(async () => {
            write({
              jsonrpc: '2.0',
              method: 'turn/started',
              params: { threadId, turn: { id: turnId, status: 'inProgress', items: [] } },
            });
            const inputText = `${inputTextOf(frame.params?.input)}${nextTurnMarker()}`;
            // Before a hold, so a card can arrive while its turn still runs.
            const suggestionList = /EZTERMINAL_E2E_SUGGEST:([\w-]+)/u.exec(inputText)?.[1];
            let suggested = '';
            if (suggestionList) {
              try {
                suggested = `Suggested ${String(await suggestTasks(threadId, turnId, turnSequence, suggestionList))} tasks.`;
              } catch (reason) { suggested = `Suggest fixture failed: ${String(reason)}`; }
            }
            // Text under way when a steer comes: Codex drops it and asks again, in the same turn.
            if (inputText.includes('EZTERMINAL_E2E_WRITING')) {
              notify('item/agentMessage/delta', { threadId, turnId, itemId: `fixture-writing-${turnSequence}`, delta: 'Half a thought that a steer drops' });
            }
            // A turn the spec keeps running (`EZTERMINAL_E2E_HOLD:<token>`) until it writes the token's release
            // file; stopped meanwhile, it ends interrupted with nothing said.
            const hold = /EZTERMINAL_E2E_HOLD:([\w-]+)/u.exec(inputText)?.[1];
            const release = hold ? controlFile(`ezterminal-e2e-codex-release-${hold}`) : undefined;
            if (release && await holdTurn(turnId, () => fs.existsSync(release)) === 'interrupted') {
              write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } } });
              return;
            }
            // Work the limit then stops: a resumed run that got somewhere, which the app counts as resumed.
            if (inputText === 'Continue.' && accountLimit()?.afterWork) {
              const item = { type: 'agentMessage', id: `${turnId}-progress`, text: 'Picked it up again.', phase: 'commentary' };
              notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...item, text: '' } });
              notify('item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: item.text });
              notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item });
              await sleep(200);
            }
            // After a hold, so a limit can stop a turn that ran.
            if (stopAtLimit(threadId, turnId, frame.params)) return;
            // The app's "Continue." under way, while `…-hold-continue` exists: what the card says as it goes.
            const holdContinue = inputText === 'Continue.' ? controlFile('ezterminal-e2e-codex-hold-continue') : undefined;
            if (holdContinue && await holdTurn(turnId, () => !fs.existsSync(holdContinue)) === 'interrupted') {
              write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } } });
              return;
            }
            const browserScript = /EZTERMINAL_E2E_BROWSER:([\w-]+)/u.exec(inputText)?.[1];
            let browsed = '';
            if (browserScript) {
              try {
                if (await browserCalls(threadId, turnId, turnSequence, browserScript) === 'interrupted') {
                  write({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted', error: null, items: [] } } });
                  return;
                }
                browsed = `Browser script ${browserScript} ran.`;
              } catch (reason) { browsed = `Browser fixture failed: ${String(reason)}`; }
            }
            // Deterministic provider behavior, crossing the real authenticated app-tool
            // endpoint. The product still owns preview validation and persistence.
            let responseText = controlText('ezterminal-e2e-codex-answer.txt', 'Structured Codex fixture ready.');
            if (browsed) responseText = browsed;
            if (JSON.stringify(frame.params?.input).includes('EZTERMINAL_E2E_PREVIEW')) {
              try {
                const descriptor = threadConfigs.get(threadId)?.mcp_servers?.ezterminal_orchestration;
                if (!descriptor) throw new Error('Missing app-tool descriptor');
                const call = async (name, args) => {
                  const response = await fetch(descriptor.url, { method: 'POST', headers: { ...descriptor.http_headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `${name}-${turnSequence}`, method: 'tools/call', params: { name, arguments: args } }) });
                  const data = await response.json();
                  if (data.error || data.result?.isError) throw new Error(JSON.stringify(data.error ?? data.result));
                  return JSON.parse(data.result.content[0].text);
                };
                const state = await call('workflow_read', {});
                if (!state.preview) throw new Error('Creation preview unavailable');
                const graph = state.preview.graph;
                graph.nodes[0].title = 'AI preview stage';
                const result = await call('preview_workflow', { commandId: `preview-${threadId}-${turnSequence}`, previewId: state.preview.id, expectedRevision: state.preview.revision, graph });
                if (!result.ok) throw new Error(result.message);
                responseText = 'AI preview updated through the authenticated app tool.';
              } catch (reason) { responseText = `Preview fixture failed: ${String(reason)}`; }
            }
            if (suggested) responseText = suggested;
            // Settings by conversation: one change applied now (a view setting), one only proposed (a new agent
            // with full access), through the same authenticated app-tool endpoint. The person applies the proposal.
            const settingsTrigger = /EZTERMINAL_E2E_SETTINGS:([a-z-]+)/u.exec(JSON.stringify(frame.params?.input))?.[1];
            if (settingsTrigger) {
              try {
                const descriptor = threadConfigs.get(threadId)?.mcp_servers?.ezterminal_orchestration;
                if (!descriptor) throw new Error('Missing app-tool descriptor');
                const call = async (name, args) => {
                  const response = await fetch(descriptor.url, { method: 'POST', headers: { ...descriptor.http_headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: `${name}-${turnSequence}`, method: 'tools/call', params: { name, arguments: args } }) });
                  const data = await response.json();
                  if (data.error || data.result?.isError) throw new Error(JSON.stringify(data.error ?? data.result));
                  return JSON.parse(data.result.content[0].text);
                };
                const applied = await call('settings_apply', { change: { domain: 'ui', set: { theme: settingsTrigger } } });
                const proposed = await call('settings_propose', { change: { domain: 'agent', profile: { id: 'e2e-builder', name: 'E2E builder', providerId: 'codex', permissionPreset: 'full-access' } } });
                responseText = `Settings fixture: applied ${String(applied.changes.length)}, proposed ${proposed.proposalId ? 'one' : 'none'}.`;
              } catch (reason) { responseText = `Settings fixture failed: ${String(reason)}`; }
            }
            // Results tab: the AI creates a note and edits a file in the working folder, as Codex reports it.
            if (JSON.stringify(frame.params?.input).includes('EZTERMINAL_E2E_RESULTS')) {
              const cwd = threadCwds.get(threadId);
              if (cwd) {
                const notePath = path.join(cwd, 'results-note.md');
                const appPath = path.join(cwd, 'results-app.ts');
                fs.writeFileSync(notePath, '# Results note\n\nCreated by the fixture.\n');
                const before = 'export const answer = 41;\n';
                const after = 'export const answer = 42;\n';
                if (!fs.existsSync(appPath)) fs.writeFileSync(appPath, before);
                fs.writeFileSync(appPath, after);
                const changes = [
                  { path: notePath, kind: { type: 'add' }, diff: '# Results note\n\nCreated by the fixture.\n' },
                  { path: appPath, kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-export const answer = 41;\n+export const answer = 42;\n' },
                ];
                const itemId = `fixture-file-change-${turnSequence}`;
                write({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'inProgress' } } });
                write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'completed' } } });
                responseText = 'Updated `results-app.ts` and wrote `results-note.md`.';
              }
            }
            // Results tab isolation: an HTML report (inline script, its own stylesheet, a network
            // request and an outbound link) and a PDF, written only in the working folder.
            if (JSON.stringify(frame.params?.input).includes('EZTERMINAL_E2E_ARTIFACTS')) {
              const cwd = threadCwds.get(threadId);
              if (cwd) {
                const html = [
                  '<!doctype html><html><head><title>Report</title><link rel="stylesheet" href="report.css"></head><body>',
                  '<h1 id="title">Fixture report</h1><p id="script">script did not run</p><p id="bridge">bridge unknown</p><p id="network">network pending</p><p id="sibling">sibling pending</p>',
                  '<a id="out" href="https://example.com/">Outbound link</a>',
                  '<script>',
                  "document.getElementById('script').textContent = 'script ran';",
                  "try { document.getElementById('bridge').textContent = typeof parent.ezterminal === 'undefined' ? 'no bridge' : 'BRIDGE VISIBLE'; } catch (error) { document.getElementById('bridge').textContent = 'no bridge'; }",
                  "fetch('https://example.com/').then(function () { document.getElementById('network').textContent = 'NETWORK ALLOWED'; }, function () { document.getElementById('network').textContent = 'network blocked'; });",
                  "fetch('report.css').then(function (response) { return response.text(); }).then(function () { document.getElementById('sibling').textContent = 'SIBLING READ'; }, function () { document.getElementById('sibling').textContent = 'sibling read blocked'; });",
                  '</script></body></html>',
                ].join('\n');
                // A complete PDF (cross-reference table with real byte offsets) so the viewer draws a page.
                const objects = [
                  '<</Type/Catalog/Pages 2 0 R>>',
                  '<</Type/Pages/Kids[3 0 R]/Count 1>>',
                  '<</Type/Page/Parent 2 0 R/MediaBox[0 0 360 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
                  '<</Length 46>>\nstream\nBT /F1 24 Tf 40 64 Td (Fixture PDF page) Tj ET\nendstream',
                  '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
                ];
                let pdf = '%PDF-1.4\n';
                const offsets = objects.map((body, index) => {
                  const offset = Buffer.byteLength(pdf);
                  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
                  return offset;
                });
                const xref = Buffer.byteLength(pdf);
                pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
                pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
                const files = [
                  ['report.html', html],
                  ['report.css', '#title { color: rgb(200, 0, 0); }\n'],
                  ['paper.pdf', pdf],
                ];
                const changes = files.map(([name, content]) => {
                  fs.writeFileSync(path.join(cwd, name), content);
                  return { path: path.join(cwd, name), kind: { type: 'add' }, diff: content };
                });
                const itemId = `fixture-artifacts-${turnSequence}`;
                write({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'inProgress' } } });
                write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes, status: 'completed' } } });
                responseText = 'Wrote `report.html` with `report.css`, and `paper.pdf`.';
              }
            }
            // Review loop: a fix turn fixes what it can in the working folder (as Codex reports a file change) and
            // ends with a line per finding; another AI's reviewer conversation answers its turn's outputSchema.
            if (inputText.includes('Fix only the review findings below')) {
              const fixed = fixReviewFindings(inputText, threadCwds.get(threadId));
              if (fixed.changes.length) {
                const itemId = `fixture-fix-${turnSequence}`;
                write({ jsonrpc: '2.0', method: 'item/started', params: { threadId, turnId, startedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes: fixed.changes, status: 'inProgress' } } });
                write({ jsonrpc: '2.0', method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { type: 'fileChange', id: itemId, changes: fixed.changes, status: 'completed' } } });
              }
              responseText = fixed.reply;
            } else if (frame.params?.outputSchema !== undefined) {
              responseText = JSON.stringify(reviewAnswer(inputText));
            }
            // Independent reviewer: judge the exact frozen result its prompt quotes (baseline,
            // artifacts, inspection validations), as a reviewer must, and approve it. No delay.
            let reviewing = false;
            if (inputText.includes('EZTERMINAL_REVIEW_JSON')) {
              const quoted = inputText.split('\n\n').map(part => { try { return JSON.parse(part); } catch { return null; } })
                .find(value => value && value.baseline && Array.isArray(value.artifacts));
              if (quoted) {
                reviewing = true;
                responseText = `EZTERMINAL_REVIEW_JSON\n${JSON.stringify({ schemaVersion: 1, baselineFingerprint: quoted.baseline.fingerprint,
                  artifactIds: quoted.artifacts.map(artifact => artifact.artifactId), decision: 'approve', summary: 'Fixture review: the frozen result answers the task.',
                  inspections: (quoted.task?.validations ?? []).filter(validation => validation.method === 'inspection')
                    .map(validation => ({ validationId: validation.validationId, status: 'passed', summary: 'Inspected by the fixture reviewer.' })) })}`;
              }
            }
            // A command that waits on the person (I4 phone feed): the turn asks for approval and answers with the decision.
            if (inputText.includes('EZTERMINAL_E2E_APPROVAL')) {
              const requestId = `fixture-approval-${turnSequence}`;
              const answer = new Promise((resolve) => serverRequests.set(requestId, resolve));
              approvalTurns.add(turnId);
              write({ jsonrpc: '2.0', id: requestId, method: 'item/commandExecution/requestApproval', params: {
                threadId, turnId, itemId: `fixture-command-${turnSequence}`, command: 'pnpm --dir mobile test', cwd: threadCwds.get(threadId) ?? null,
                reason: 'Run the phone tests',
              } });
              const decision = (await answer)?.decision;
              approvalTurns.delete(turnId);
              responseText = `Approval answered: ${typeof decision === 'string' ? decision : JSON.stringify(decision)}`;
            }
            await Promise.all(landings.get(turnId) ?? []);
            // Chat profiler: stream a fixed-length reply in timed deltas, ending with a sentinel.
            // The reviewer answers instantly, in the same burst as its turn/start response: the
            // adapter must still keep the reply on its turn (pre-response item buffering).
            const reply = reviewing ? null : readReplyConfig();
            if (reply) {
              const itemId = `fixture-message-${turnSequence}`;
              const body = `${'Streamed profile reply. '.repeat(Math.ceil(reply.chars / 24)).slice(0, reply.chars)} [[end]]`;
              const size = Math.ceil(body.length / Math.max(1, reply.chunks));
              await sleep(reply.startDelayMs ?? 0);
              for (let offset = 0; offset < body.length; offset += size) {
                write({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta: body.slice(offset, offset + size) } });
                await sleep(reply.chunkDelayMs ?? 0);
              }
              responseText = body;
            }
            write({
              jsonrpc: '2.0',
              method: 'item/completed',
              params: {
                threadId,
                turnId,
                completedAtMs: Date.now(),
                item: {
                  id: `fixture-message-${turnSequence}`,
                  type: 'agentMessage',
                  text: responseText,
                  phase: null,
                },
              },
            });
            // Usage arrives before the turn ends, as from the real app-server; this account has only a weekly window.
            const tokens = { totalTokens: 19120, inputTokens: 18697, cachedInputTokens: 12416, cacheWriteInputTokens: 0, outputTokens: 423, reasoningOutputTokens: 206 };
            write({
              jsonrpc: '2.0',
              method: 'thread/tokenUsage/updated',
              params: { threadId, turnId, tokenUsage: { total: tokens, last: tokens, modelContextWindow: 258400 } },
            });
            write({
              jsonrpc: '2.0',
              method: 'account/rateLimits/updated',
              params: { rateLimits: {
                limitId: 'codex',
                primary: { usedPercent: usedPercent(), windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + (53 * 60 * 60) },
                secondary: null,
              } },
            });
            write({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: {
                threadId,
                turn: { id: turnId, status: 'completed', error: null, items: [] },
              },
            });
          }, 10);
          break;
        }
        case 'account/rateLimits/read':
          // This account has only a weekly window, like the one the captures came from.
          respond(frame, { rateLimits: fullRateLimits(accountLimit()) ?? {
            limitId: 'codex',
            primary: { usedPercent: usedPercent(), windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + (53 * 60 * 60) },
            secondary: null,
          } });
          break;
        case 'turn/steer': {
          // Refused as the real app-server refuses: always -32600. A review or compaction says which, a stale id does not.
          const threadId = frame.params?.threadId;
          const running = activeTurns.get(threadId);
          const refusal = controlText('ezterminal-e2e-codex-steer-refusal.txt', '').trim();
          const stale = refusal === 'stale' || !running || running !== frame.params?.expectedTurnId;
          const kind = stale ? undefined : refusal || undefined;
          logLine('ezterminal-e2e-codex-steers.jsonl', { threadId, turnId: running ?? null, expectedTurnId: frame.params?.expectedTurnId ?? null, clientUserMessageId: frame.params?.clientUserMessageId ?? null, text: inputTextOf(frame.params?.input), outcome: stale ? 'stale' : kind ?? 'accepted' });
          // Not a refusal: the call broke on the way, and `thread/read` then shows it never arrived.
          if (kind === 'transport') {
            write({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: 'the connection to the thread broke' } });
            break;
          }
          if (stale || kind) {
            write({ jsonrpc: '2.0', id: frame.id, error: stale
              ? { code: -32600, message: `expected active turn id \`${String(frame.params?.expectedTurnId)}\` but found \`${String(running)}\`` }
              : { code: -32600, message: `cannot steer a ${kind} turn`, data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: kind } } } } });
            break;
          }
          respond(frame, { turnId: running });
          landings.set(running, [...(landings.get(running) ?? []), landSteer(threadId, running, frame.params)]);
          break;
        }
        case 'thread/read': {
          // Only what a restart looks for: the steers that landed, by `clientId`. Anything else this fixture cannot answer.
          const threadId = frame.params?.threadId;
          const file = controlFile('ezterminal-e2e-codex-landed.jsonl');
          const landed = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.threadId === threadId) : [];
          if (landed.length === 0) {
            write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported fixture method: thread/read' } });
            break;
          }
          respond(frame, { thread: { id: threadId, turns: landed.map((entry) => ({ id: entry.turnId, status: 'inProgress', items: [{ type: 'userMessage', id: `${entry.turnId}-steer`, clientId: entry.clientId }] })) } });
          break;
        }
        case 'thread/unsubscribe':
          // Records which threads the app released (an e2e checks /clear releases the old one).
          if (process.env.TMPDIR) {
            const marker = path.join(process.env.TMPDIR, 'ezterminal-e2e-codex-unsubscribed.json');
            let released = [];
            try { released = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { released = []; }
            fs.writeFileSync(marker, JSON.stringify([...released, frame.params?.threadId]));
          }
          respond(frame, { status: 'notLoaded' });
          break;
        case 'turn/interrupt':
          // A held turn (or review) ends interrupted, as a stopped turn does.
          logLine('ezterminal-e2e-codex-interrupts.jsonl', { threadId: frame.params?.threadId ?? null, turnId: frame.params?.turnId ?? null });
          heldTurns.get(frame.params?.turnId)?.('interrupted');
          respond(frame, {});
          break;
        case 'thread/settings/update':
          respond(frame, {});
          break;
        default:
          write({
            jsonrpc: '2.0',
            id: frame.id,
            error: { code: -32601, message: `Unsupported fixture method: ${frame.method}` },
          });
      }
    }
  });
  process.stdin.resume();
} else {
  const scrollbackScenario = process.env.EZTERMINAL_E2E_CODEX_SCROLLBACK === '1';
  const projectMapScenario = process.env.EZTERMINAL_E2E_PROJECT_MAP_AGENT === '1';
  if (scrollbackScenario) {
    // Codex normally owns the alternate screen. That buffer has no scrollback,
    // so overflowing it reproduces the missing-middle transcript symptom. The
    // product-owned launch must opt into Codex's inline mode to keep all markers.
    if (!args.includes('--no-alt-screen')) process.stdout.write('\x1b[?1049h');
    process.stdout.write('\x1b[?2004h');
    setTimeout(() => {
      const markers = Array.from(
        { length: 80 },
        (_, index) => `CODEX-SEQ-${String(index + 1).padStart(3, '0')}`,
      );
      process.stdout.write(`${markers.join('\r\n')}\r\n`);
    }, 100);
  } else {
    if (args.includes('--xterm') || projectMapScenario) {
      process.stdout.write('\x1b[?2004h\x1b[?1004h');
    }
    process.stdout.write('FAKE-CODEX-READY COPY-ME\r\n');
    if (args.includes('--model')) process.stdout.write(`CLI-MODEL:${args[args.indexOf('--model') + 1]}\r\n`);
  }

  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();

  let line = '';
  let received = '';
  let interrupted = false;
  process.stdin.on('data', (data) => {
    received += data;
    if (data.includes('\x03')) process.stdout.write('CTRL-C-RECEIVED\r\n');
    if (data.includes('\x04')) process.stdout.write('CTRL-D-RECEIVED\r\n');
    if (data.includes('\x06')) process.stdout.write('CTRL-F-RECEIVED\r\n');
    if (data.includes('\x10')) process.stdout.write('CTRL-P-RECEIVED\r\n');
    if (data.includes('\x16')) process.stdout.write('CTRL-V-RECEIVED\r\n');
    if (data.includes('\x1b')) {
      interrupted = true;
      process.stdout.write('ESC-RECEIVED\r\n');
    }
    if (received.includes('first\nsecond')) {
      process.stdout.write('MULTILINE-PASTE-RECEIVED\r\n');
      received = '';
    }

    const printable = data.replace(/[\x00-\x1f\x7f]/gu, '');
    if (printable) process.stdout.write(`TEXT:${JSON.stringify(printable)}\r\n`);

    for (const character of data) {
      if (character === '\x15') {
        line = '';
        continue;
      }
      if (character === '\r' || character === '\n') {
        // A mounted xterm can answer terminal capability/focus queries between
        // Escape and the submitted line. Those replies are not user text, so
        // accept the recovery instruction at the end of the accumulated input.
        if (line.trim().endsWith('continue') && interrupted) {
          process.stdout.write('RECOVERY-SEQUENCE\r\n');
          interrupted = false;
        }
        if (line.trim() === '/exit' || line.trim() === '/quit') {
          process.stdout.write('EXPLICIT-EXIT\r\n');
          process.exit(0);
        }
        line = '';
      } else if (character >= ' ') {
        line += character;
      }
    }
  });
}
