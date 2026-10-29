#!/usr/bin/env node
/**
 * Real-provider probe: what MCP do the review loop's Codex threads get, and can a per-thread
 * override take it away without costing the fork's prompt cache?
 *
 *   node scripts/probe-codex-review-mcp.mjs --scratch <dir> [--codex-script <codex.js>] [--skip-model]
 *
 * Steps (installed app-server; thread shapes mirror src/main/codex-provider-adapter.ts):
 *   A  a reviewer-shaped thread (ephemeral, sandbox read-only, approvalPolicy never): its MCP servers
 *      (mcpServerStatus/list with its threadId).
 *   B  A + config { mcp_servers: {} }.
 *   C  A + config { mcp_servers: { <each configured server of A>: { enabled: false } }, apps: { _default: { enabled: false } } }
 *      (only when B kept servers; `codex_apps` is the apps connector, switched through `apps`).
 *   D  A + a probe MCP server added through config (a local stdio server whose tools record that they
 *      ran: touch_marker annotated destructive, read_marker annotated read-only): one turn asks the model
 *      to call both. Which ran without approval?
 *   E  a persisted parent (standard preset; seed + warm turn) and two review-shaped forks of it: with the
 *      override that removed the servers (B or C) first, then without. Their servers, and each fork's
 *      first-call cached input tokens against the parent's warm turn (the review fork's cache).
 * `--skip-model` runs A–C only (no model call, no tokens); `--only-tool` runs A–D (no E).
 * MCP server names are reported as short hashes; no paths or answers are kept. The report goes to
 * artifacts/review-findings-probe/.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURN_DEADLINE_MS = 420_000;
const STARTUP_WAIT_MS = 25_000;

// Mirrors scripts/capture-provider-fixtures.mjs (and provider-process-security.ts).
const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TERM',
  'COLORTERM', 'NO_COLOR',
];
const CODEX_ENVIRONMENT_VARIABLES = ['PATH', 'CODEX_HOME', 'OPENAI_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];
const REVIEW_THREAD = { sandbox: 'read-only', approvalPolicy: 'never' };
const STANDARD = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
const SEED_LINES = 600;
const FORK_QUESTION = 'Without tools: what is the code name of module 0017? Answer in one short line.';

function parseArguments(argv) {
  const options = { skipModel: false, onlyTool: false, out: path.join(root, 'artifacts', 'review-findings-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    if (flag === '--skip-model') { options.skipModel = true; continue; }
    if (flag === '--only-tool') { options.onlyTool = true; continue; }
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--codex-script') options.codexScript = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
  return options;
}

function resolveCodexScript() {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean)) {
    const candidate = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Codex CLI not found; pass --codex-script <.../@openai/codex/bin/codex.js>.');
}

function providerEnvironment() {
  const environment = {};
  for (const name of new Set([...REQUIRED_OS_ENVIRONMENT_VARIABLES, ...CODEX_ENVIRONMENT_VARIABLES])) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashName = (name) => createHash('sha256').update(String(name)).digest('hex').slice(0, 8);
const log = (text) => console.error(`[probe] ${new Date().toISOString()} ${text}`);

/** A stdio MCP server with one destructive tool that writes `marker` when called. */
const PROBE_MCP_SERVER = `
const fs = require('node:fs');
const marker = process.argv[2];
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf('\\n'); newline >= 0; newline = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ezprobe', version: '1.0.0' } } });
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
        name: 'touch_marker', description: 'Writes the probe marker file. Takes no arguments.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: true },
      }, {
        name: 'read_marker', description: 'Reads nothing; reports the probe status. Takes no arguments.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false },
      }] } });
    } else if (message.method === 'tools/call') {
      fs.appendFileSync(marker, String(message.params?.name ?? '') + '\\n');
      send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'Marker written.' }] } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});
`;

function startAppServer(codexScript, workspace) {
  const child = spawn(process.execPath, [codexScript, 'app-server'], {
    cwd: workspace, env: providerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map();
  const waiters = [];
  const usage = new Map();
  const requests = new Map();
  const startup = new Map();
  const toolCalls = new Map();
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
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Timed out waiting for a notification.')); }, ms);
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
      // A server request (approval, elicitation): recorded and declined, like a review fork does.
      const threadId = frame.params?.threadId ?? frame.params?.conversationId ?? 'unknown';
      requests.set(threadId, [...(requests.get(threadId) ?? []), frame.method]);
      const legacy = frame.method === 'execCommandApproval' || frame.method === 'applyPatchApproval';
      send({ jsonrpc: '2.0', id: frame.id, ...(frame.method === 'mcpServer/elicitation/request'
        ? { result: { action: 'decline' } }
        : frame.method.includes('pproval')
          ? { result: legacy ? { decision: { denied: { rejection: 'Probe: read-only review.' } } } : { decision: 'decline' } }
          : { error: { code: -32601, message: `No handler for ${frame.method}.` } }) });
      return;
    }
    if (frame.method === 'mcpServer/startupStatus/updated') {
      const threadId = frame.params?.threadId ?? 'global';
      startup.set(threadId, [...(startup.get(threadId) ?? []), `${hashName(frame.params?.name)}:${frame.params?.status}`]);
    }
    if (frame.method === 'item/completed' && frame.params?.item?.type === 'mcpToolCall') {
      const item = frame.params.item;
      const threadId = frame.params?.threadId ?? 'unknown';
      toolCalls.set(threadId, [...(toolCalls.get(threadId) ?? []), {
        server: hashName(item.server), tool: String(item.tool ?? ''), status: item.status ?? null,
        error: item.error ? String(item.error?.message ?? item.error).slice(0, 200) : null,
      }]);
    }
    if (frame.method === 'thread/tokenUsage/updated') {
      const { threadId, turnId, tokenUsage } = frame.params ?? {};
      if (threadId && tokenUsage?.last) usage.set(threadId, [...(usage.get(threadId) ?? []), { turnId: turnId ?? null, last: tokenUsage.last }]);
    }
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame); }
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
  return { child, request, send, waitFor, usage, requests, startup, toolCalls, exited, stderr: () => stderr };
}

/** A thread's MCP servers once none is still starting: hashed names, status and tool count. */
async function serversOf(server, threadId) {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  let servers = [];
  for (;;) {
    const listed = await server.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly' }).catch((error) => ({ error: String(error?.message ?? error) }));
    if (listed.error) return { error: listed.error.slice(0, 200) };
    servers = (listed.data ?? []).map((entry) => ({
      name: hashName(entry.name), status: entry.runtimeStatus ?? null,
      tools: Array.isArray(entry.tools) ? entry.tools.length : Object.keys(entry.tools ?? {}).length,
    }));
    if (!servers.some((entry) => entry.status === 'starting') || Date.now() > deadline) break;
    await delay(1_000);
  }
  return {
    count: servers.length,
    live: servers.filter((entry) => !['disabled', 'failed', 'cancelled', 'notStarted'].includes(entry.status)).length,
    tools: servers.reduce((total, entry) => total + (entry.status === 'disabled' ? 0 : entry.tools), 0),
    servers,
  };
}

async function reviewThread(server, workspace, config) {
  const started = await server.request('thread/start', {
    cwd: workspace, runtimeWorkspaceRoots: [workspace], ...REVIEW_THREAD, ...(config ? { config } : {}),
    ephemeral: true, historyMode: 'paginated', threadSource: 'ezterminal',
  });
  return started.thread.id;
}

async function turn(server, threadId, text) {
  const completed = server.waitFor((frame) => frame.method === 'turn/completed' && frame.params?.threadId === threadId, TURN_DEADLINE_MS);
  let turnId = null;
  try {
    turnId = (await server.request('turn/start', { threadId, clientUserMessageId: `probe-${randomUUID()}`, input: [{ type: 'text', text, text_elements: [] }] }))?.turn?.id ?? null;
  } catch (error) {
    completed.catch(() => undefined);
    return { status: null, error: String(error?.message ?? error).slice(0, 200) };
  }
  let status = null;
  try {
    status = (await completed).params?.turn?.status ?? null;
  } catch (error) {
    await server.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
    return { status: null, error: String(error?.message ?? error).slice(0, 200) };
  }
  await delay(500);
  const mine = (server.usage.get(threadId) ?? []).filter((update) => !turnId || update.turnId === turnId || update.turnId === null);
  const first = mine[0]?.last;
  return { status, firstInput: first?.inputTokens ?? null, firstCached: first?.cachedInputTokens ?? null };
}

const unsubscribe = (server, threadId) => server.request('thread/unsubscribe', { threadId }).catch(() => undefined);

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const codexScript = options.codexScript ?? resolveCodexScript();
  const workspace = path.join(options.scratch, `codex-review-mcp-${Date.now()}`);
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(options.out, { recursive: true });
  const server = startAppServer(codexScript, workspace);
  const report = { probe: 'codex-review-mcp', at: new Date().toISOString(), steps: {}, errors: [] };
  try {
    const initialized = await server.request('initialize', {
      clientInfo: { name: 'ezterminal', title: 'EZTerminal', version: '2' }, capabilities: { experimentalApi: true, requestAttestation: false },
    });
    server.send({ jsonrpc: '2.0', method: 'initialized' });
    report.codexVersion = String(initialized?.userAgent ?? '').match(/\d+\.\d+\.\d+/u)?.[0] ?? null;

    log('A: reviewer-shaped thread, no override');
    const a = await reviewThread(server, workspace);
    const aServers = await serversOf(server, a);
    report.steps.A = { settings: 'ephemeral, read-only, approvals never', ...aServers };
    const names = [];
    const listedA = await server.request('mcpServerStatus/list', { threadId: a, detail: 'toolsAndAuthOnly' }).catch(() => ({ data: [] }));
    for (const entry of listedA.data ?? []) if (typeof entry.name === 'string') names.push(entry.name);
    await unsubscribe(server, a);

    log('B: mcp_servers = {}');
    const overrideB = { mcp_servers: {} };
    const b = await reviewThread(server, workspace, overrideB);
    report.steps.B = { settings: 'A + config { mcp_servers: {} }', ...(await serversOf(server, b)) };
    await unsubscribe(server, b);

    let override = report.steps.B.live === 0 && report.steps.B.tools === 0 ? overrideB : undefined;
    // The best override found, even when some server stays (E measures what it costs the fork's cache).
    let candidate = override;
    if (!override && names.length) {
      log('C: each configured server enabled = false, apps off');
      const configured = names.filter((name) => name !== 'codex_apps');
      const overrideC = { mcp_servers: Object.fromEntries(configured.map((name) => [name, { enabled: false }])), apps: { _default: { enabled: false } } };
      try {
        const c = await reviewThread(server, workspace, overrideC);
        report.steps.C = { settings: 'A + config { mcp_servers.<each configured>.enabled = false, apps._default.enabled = false }', ...(await serversOf(server, c)) };
        await unsubscribe(server, c);
        if (report.steps.C.live === 0 && report.steps.C.tools === 0) override = overrideC;
        if ((report.steps.C.live ?? Infinity) < (report.steps.A.live ?? 0)) candidate = overrideC;
      } catch (error) {
        report.steps.C = { error: String(error?.message ?? error).slice(0, 300) };
      }
    }
    report.workingOverride = override === overrideB ? 'mcp_servers = {}' : override ? 'mcp_servers.<each configured>.enabled = false + apps._default.enabled = false' : null;

    if (!options.skipModel) {
      log('D: probe MCP tool under read-only + never');
      const serverScript = path.join(workspace, 'ezprobe-mcp.cjs');
      const marker = path.join(workspace, 'ezprobe-marker.txt');
      await fs.writeFile(serverScript, PROBE_MCP_SERVER);
      const d = await reviewThread(server, workspace, { mcp_servers: { ezprobe: { command: process.execPath, args: [serverScript, marker] } } });
      const dServers = await serversOf(server, d);
      const dTurn = await turn(server, d, 'This is a test of tool permissions. Call the MCP tool read_marker of the ezprobe server once, then call its tool touch_marker once, both with no arguments, even if you expect one to fail. Do not run shell commands. Then reply with exactly: DONE');
      const ran = existsSync(marker) ? (await fs.readFile(marker, 'utf8')).split(/\r?\n/u).filter(Boolean) : [];
      report.steps.D = {
        settings: 'A + a probe stdio MCP server: touch_marker (destructive) and read_marker (read-only) each record that they ran',
        probeServerListed: dServers.servers?.some((entry) => entry.name === hashName('ezprobe')) ?? false,
        turn: dTurn.status, toolRan: ran.includes('touch_marker'), readOnlyToolRan: ran.includes('read_marker'),
        toolCalls: server.toolCalls.get(d) ?? [], serverRequests: server.requests.get(d) ?? [],
      };
      await unsubscribe(server, d);
      if (options.onlyTool) throw new Error('only-tool: stopping before E');

      log('E: parent + review forks');
      const parent = (await server.request('thread/start', {
        cwd: workspace, runtimeWorkspaceRoots: [workspace], ...STANDARD, ephemeral: false, historyMode: 'paginated', threadSource: 'ezterminal',
      })).thread.id;
      const nonce = randomUUID();
      const seed = Array.from({ length: SEED_LINES }, (_, index) => `Module ${String(index + 1).padStart(4, '0')}: code name ${createHash('sha256').update(`${nonce}:${index}`).digest('hex').slice(0, 10)}.`).join('\n');
      const p1 = await turn(server, parent, `${nonce}\n${seed}\n\nThe list above is reference data for later questions. Do not run commands or read files. Reply with exactly: OK`);
      const p2 = await turn(server, parent, 'Without running commands: what is the code name of module 0003? Answer in one short line.');
      report.steps.E = { parent: { seed: p1, warm: p2 }, forks: {} };
      const forkCases = [
        ...(candidate ? [['withOverride', candidate]] : []),
        ['withoutOverride', undefined],
      ];
      for (const [label, config] of forkCases) {
        const forked = await server.request('thread/fork', {
          threadId: parent, ephemeral: true, excludeTurns: true, threadSource: 'ezterminal', ...REVIEW_THREAD, ...(config ? { config } : {}),
        });
        const forkId = forked.thread.id;
        const servers = await serversOf(server, forkId);
        const result = await turn(server, forkId, FORK_QUESTION);
        report.steps.E.forks[label] = {
          live: servers.live ?? null, tools: servers.tools ?? null, ...result,
          cacheRatio: p2.firstCached && result.firstCached !== null ? Number((result.firstCached / p2.firstCached).toFixed(3)) : null,
        };
        await unsubscribe(server, forkId);
      }
      await unsubscribe(server, parent);
    }
  } catch (error) {
    report.errors.push(String(error?.stack ?? error).slice(0, 800));
    log(`error: ${report.errors.at(-1)}\n${server.stderr().slice(-1_000)}`);
  } finally {
    server.child.stdin.end();
    await Promise.race([server.exited, delay(5_000)]);
    if (server.child.exitCode === null) server.child.kill();
  }
  report.verdicts = {
    reviewThreadsInheritMcp: (report.steps.A?.live ?? 0) > 0,
    emptyTableRemovesServers: report.steps.B ? report.steps.B.live === 0 && report.steps.B.tools === 0 : null,
    perServerDisableRemovesServers: report.steps.C ? report.steps.C.live === 0 && report.steps.C.tools === 0 : null,
    mcpToolRanWithoutApproval: report.steps.D ? report.steps.D.toolRan && !(report.steps.D.serverRequests ?? []).length : null,
    readOnlyMcpToolRan: report.steps.D?.readOnlyToolRan ?? null,
    forkCacheWithOverride: report.steps.E?.forks?.withOverride?.cacheRatio ?? null,
    forkCacheWithoutOverride: report.steps.E?.forks?.withoutOverride?.cacheRatio ?? null,
  };
  const file = path.join(options.out, `codex-mcp-${report.at.replace(/[:.]/gu, '-')}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ file, workingOverride: report.workingOverride ?? null, verdicts: report.verdicts, errors: report.errors }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
