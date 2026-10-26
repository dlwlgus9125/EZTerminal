#!/usr/bin/env node
/**
 * Real-provider probe for a Codex /btw: does an ephemeral `thread/fork` of a live
 * thread reuse the parent's prompt cache on its first turn?
 *
 *   node scripts/probe-codex-side-question-cache.mjs --scratch <dir> [--repeat 2] [--codex-script <codex.js>]
 *
 * Per pass: parent thread (persisted, standard preset) turn 1 (large seed) + turn 2 → P2;
 * fork B (ephemeral, read-only, approvals never — the shape a product /btw would use) → F1;
 * fork A (ephemeral, no overrides; diagnostic); fresh ephemeral thread → baseline.
 * Pass (fork B, every pass): F1.cached ≥ 0.8 × F1.input and
 * F1.cached − fresh.cached ≥ 0.5 × (P2.cached − fresh.cached).
 * Writes token counts only to artifacts/side-question-probe/ (never test/fixtures).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 420_000;

// Mirrors scripts/capture-provider-fixtures.mjs (and provider-process-security.ts).
const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TERM',
  'COLORTERM', 'NO_COLOR',
];
const CODEX_ENVIRONMENT_VARIABLES = ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
const SIDE_INSTRUCTION = 'This is a side question about the conversation so far. You have NO tools: do not run commands, '
  + 'read files or edit anything. Answer only from what is already in this conversation, in one short reply.';

function parseArguments(argv) {
  const options = { repeat: 2, out: path.join(root, 'artifacts', 'side-question-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    if (flag === '--mid-turn') { options.midTurn = true; continue; }
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--repeat') options.repeat = Number(value);
    else if (flag === '--codex-script') options.codexScript = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  return options;
}

function pathDirectories() {
  return (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean);
}

function resolveCodexScript() {
  for (const directory of pathDirectories()) {
    const candidate = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Codex CLI not found; pass --codex-script <.../@openai/codex/bin/codex.js>.');
}

function providerEnvironment(names) {
  const environment = {};
  for (const name of new Set([...REQUIRED_OS_ENVIRONMENT_VARIABLES, ...names])) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function seedText(pass) {
  const words = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper',
    'kelp', 'lumen', 'meadow', 'nickel', 'onyx', 'pylon', 'quartz', 'raven', 'sierra', 'tundra'];
  const lines = [`Reference set ${pass}-${randomUUID()}`];
  for (let index = 1; index <= 900; index += 1) {
    const word = words[(index * 7) % words.length];
    const other = words[(index * 11 + 3) % words.length];
    lines.push(`Module ${String(index).padStart(4, '0')}: code name ${word}-${index}; owner team ${other}; `
      + `depends on module ${String(((index * 13) % 900) + 1).padStart(4, '0')}; status ${index % 3 === 0 ? 'stable' : 'beta'}; `
      + `notes: keeps a ${word} cache and reports to the ${other} board every ${index % 7 + 1} days.`);
  }
  return lines.join('\n');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startAppServer(codexScript, workspace) {
  const child = spawn(process.execPath, [codexScript, 'app-server'], {
    cwd: workspace, env: providerEnvironment(CODEX_ENVIRONMENT_VARIABLES), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  const waiters = [];
  const usage = new Map(); // `${threadId}:${turnId}` -> last breakdown
  const toolItems = new Map(); // threadId -> started tool items
  const approvals = new Map(); // threadId -> approval requests declined
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
  const waitFor = (predicate, ms = TURN_DEADLINE_MS) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a notification.')), ms);
    waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
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
      if (threadId && turnId && tokenUsage?.last) usage.set(`${threadId}:${turnId}`, tokenUsage.last);
    }
    if (frame.method === 'item/started') {
      const type = frame.params?.item?.type;
      if (type && !['userMessage', 'agentMessage', 'reasoning'].includes(type)) {
        const threadId = frame.params?.threadId ?? 'unknown';
        toolItems.set(threadId, [...(toolItems.get(threadId) ?? []), type]);
      }
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
  return { child, request, send, waitFor, usage, toolItems, approvals, recent, exited, stderr: () => stderr };
}

async function runTurn(server, threadId, text, label = 'turn') {
  console.error(`[probe] ${new Date().toISOString()} ${label} start on ${threadId}`);
  const completed = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId)
    .catch((error) => { throw new Error(`${label}: ${error.message} recent=${JSON.stringify(server.recent.get(threadId) ?? [])} none=${JSON.stringify(server.recent.get('none') ?? [])}`); });
  const turn = await server.request('turn/start', {
    threadId, clientUserMessageId: `probe-${randomUUID()}`, input: [{ type: 'text', text, text_elements: [] }],
  });
  const turnId = turn.turn.id;
  const done = await completed;
  await delay(500);
  const last = server.usage.get(`${threadId}:${turnId}`);
  return {
    threadId, turnId, status: done.params?.turn?.status ?? null,
    input: last?.inputTokens ?? null, cached: last?.cachedInputTokens ?? null, output: last?.outputTokens ?? null,
  };
}

async function fork(server, threadId, overrides) {
  const forked = await server.request('thread/fork', {
    threadId, ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', ...overrides,
  });
  return forked.thread.id;
}

/** A side question forked while the parent's turn is still streaming. */
async function midTurn(server, workspace) {
  const started = await server.request('thread/start', {
    cwd: workspace, runtimeWorkspaceRoots: [workspace], approvalPolicy: 'on-request', sandbox: 'workspace-write',
    ephemeral: false, historyMode: 'paginated', threadSource: 'ezterminal',
  });
  const parentId = started.thread.id;
  const result = { mode: 'mid-turn', model: started.model };
  result.parent1 = await runTurn(server, parentId, `${seedText('mid')}\n\nThe list above is reference data for later questions. Do not run any commands or read files. Reply with exactly: OK`, 'mid-parent1');
  const streaming = server.waitFor((frame) => frame.method === 'item/agentMessage/delta' && frame.params?.threadId === parentId);
  const parentDone = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === parentId);
  await server.request('turn/start', { threadId: parentId, clientUserMessageId: `probe-${randomUUID()}`,
    input: [{ type: 'text', text: 'Without running commands: list modules 0001 to 0080 with their code names, one per line.', text_elements: [] }] });
  await streaming;
  result.forkStartedWhileStreaming = true;
  try {
    const forkId = await fork(server, parentId, { sandbox: 'read-only', approvalPolicy: 'never' });
    result.forkB = await runTurn(server, forkId, `${SIDE_INSTRUCTION}\n\nQuestion: what is the code name of module 0042? Also: what was the last thing I asked you to do?`, 'mid-forkB');
    result.forkB.toolItems = server.toolItems.get(forkId) ?? [];
    await server.request('thread/unsubscribe', { threadId: forkId }).catch(() => undefined);
  } catch (caught) {
    result.forkError = String(caught?.rpc?.message ?? caught?.message ?? caught).slice(0, 400);
  }
  const done = await parentDone;
  result.parentTurnStatus = done.params?.turn?.status ?? null;
  result.parentCompletedAfterFork = true;
  await server.request('thread/unsubscribe', { threadId: parentId }).catch(() => undefined);
  return result;
}

async function pass(server, workspace, index, order) {
  const standard = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  const started = await server.request('thread/start', {
    cwd: workspace, runtimeWorkspaceRoots: [workspace], ...standard,
    ephemeral: false, historyMode: 'paginated', threadSource: 'ezterminal',
  });
  const parentId = started.thread.id;
  const result = { pass: index, model: started.model, order };
  result.parent1 = await runTurn(server, parentId, `${seedText(index)}\n\nThe list above is reference data for later questions. Do not run any commands or read files. Reply with exactly: OK`, `pass${index}-parent1`);
  result.parent2 = await runTurn(server, parentId, 'Without running commands: what is the code name of module 0017? Answer in one short line.', `pass${index}-parent2`);
  const question = `${SIDE_INSTRUCTION}\n\nQuestion: what is the code name of module 0042?`;
  for (const variant of order) {
    const overrides = variant === 'B' ? { sandbox: 'read-only', approvalPolicy: 'never' } : {};
    const forkId = await fork(server, parentId, overrides);
    const turn = await runTurn(server, forkId, question, `pass${index}-fork${variant}`);
    result[`fork${variant}`] = { ...turn, overrides, toolItems: server.toolItems.get(forkId) ?? [], approvals: server.approvals.get(forkId) ?? 0 };
    await server.request('thread/unsubscribe', { threadId: forkId }).catch(() => undefined);
  }
  const fresh = await server.request('thread/start', {
    cwd: workspace, runtimeWorkspaceRoots: [workspace], ...standard, ephemeral: true, historyMode: 'paginated', threadSource: 'ezterminal',
  });
  result.fresh = await runTurn(server, fresh.thread.id, 'Without running commands: reply with exactly OK.', `pass${index}-fresh`);
  await server.request('thread/unsubscribe', { threadId: fresh.thread.id }).catch(() => undefined);
  await server.request('thread/unsubscribe', { threadId: parentId }).catch(() => undefined);

  const verdict = (entry) => {
    if (!entry || entry.cached === null || entry.input === null || result.parent2.cached === null || result.fresh.cached === null) return 'missing-usage';
    const ratio = entry.cached >= 0.8 * entry.input;
    const aboveBaseline = entry.cached - result.fresh.cached >= 0.5 * (result.parent2.cached - result.fresh.cached);
    const seedLarge = result.parent2.input >= 3 * result.fresh.cached;
    return ratio && aboveBaseline && seedLarge ? 'pass' : `fail(ratio=${ratio},aboveBaseline=${aboveBaseline},seedLarge=${seedLarge})`;
  };
  result.verdictB = verdict(result.forkB);
  result.verdictA = verdict(result.forkA);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const codexScript = options.codexScript ?? resolveCodexScript();
  const workspace = path.join(options.scratch, 'codex-side-question');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(options.out, { recursive: true });
  const server = startAppServer(codexScript, workspace);
  const passes = [];
  let error;
  try {
    const initialized = await server.request('initialize', {
      clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.send({ jsonrpc: '2.0', method: 'initialized' });
    if (options.midTurn) passes.push(await midTurn(server, workspace));
    else for (let index = 1; index <= options.repeat; index += 1) {
      passes.push(await pass(server, workspace, index, index % 2 === 1 ? ['B', 'A'] : ['A', 'B']));
    }
    passes.userAgent = initialized?.userAgent;
  } catch (caught) {
    error = String(caught?.message ?? caught);
    console.error(server.stderr().slice(-2_000));
  } finally {
    server.child.stdin.end();
    await Promise.race([server.exited, delay(5_000)]);
    if (server.child.exitCode === null) server.child.kill();
  }
  const shipCodex = passes.length === options.repeat && passes.every((entry) => entry.verdictB === 'pass');
  const report = { probe: 'codex-side-question-cache', at: new Date().toISOString(), codexScript, passes, error, shipCodex };
  const file = path.join(options.out, `codex-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ file, error, shipCodex, passes }, null, 2));
}

main().catch((caught) => {
  console.error(caught?.stack ?? String(caught));
  process.exitCode = 1;
});
