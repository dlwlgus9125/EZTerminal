#!/usr/bin/env node
/**
 * Real-provider probe for /btw on Claude: does `Query.askSideQuestion()` read the
 * live conversation's prompt cache, write nothing to the cache or the session
 * transcript, and run beside a running turn?
 *
 *   node scripts/probe-claude-side-question-cache.mjs --scratch <dir> [--idle-minutes 6] [--skip-idle]
 *
 * Token numbers come from Claude Code's own OpenTelemetry `api_request` events,
 * received by a local OTLP/HTTP JSON endpoint (the SDK does not return usage for
 * side questions). Only token counts, query sources and timings are written to
 * artifacts/side-question-probe/; no prompts, answers or account attributes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors scripts/capture-provider-fixtures.mjs (and provider-process-security.ts).
const REQUIRED_OS_ENVIRONMENT_VARIABLES = [
  'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'TERM',
  'COLORTERM', 'NO_COLOR',
];
const CLAUDE_ENVIRONMENT_VARIABLES = ['PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];
const KEPT_ATTRIBUTES = new Set([
  'event.name', 'event.timestamp', 'query_source', 'query_source_safe', 'model', 'input_tokens', 'output_tokens',
  'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'speed', 'effort', 'agent_id',
]);

function parseArguments(argv) {
  const options = { idleMinutes: 6, skipIdle: false, out: path.join(root, 'artifacts', 'side-question-probe') };
  for (let index = 0; index < argv.length; index += 1) {
    const [flag, inline] = argv[index].split('=', 2);
    if (flag === '--skip-idle') { options.skipIdle = true; continue; }
    const value = inline ?? argv[++index];
    if (flag === '--scratch') options.scratch = path.resolve(value);
    else if (flag === '--idle-minutes') options.idleMinutes = Number(value);
    else if (flag === '--claude-executable') options.claudeExecutable = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!options.scratch) throw new Error('--scratch <dir> is required; the provider only ever runs below it.');
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

/** OTLP/HTTP JSON logs receiver: keeps only api_request token facts. */
function startTelemetryReceiver() {
  const events = [];
  const value = (any) => any?.stringValue ?? (any?.intValue !== undefined ? Number(any.intValue) : undefined)
    ?? any?.doubleValue ?? any?.boolValue;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        for (const resourceLogs of body.resourceLogs ?? []) {
          for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
            for (const record of scopeLogs.logRecords ?? []) {
              const attributes = {};
              for (const attribute of record.attributes ?? []) {
                if (KEPT_ATTRIBUTES.has(attribute.key)) attributes[attribute.key] = value(attribute.value);
              }
              const name = attributes['event.name'] ?? value(record.body);
              if (name === 'api_request' || name === 'claude_code.api_request') {
                events.push({ receivedAt: Date.now(), ...attributes });
              }
            }
          }
        }
      } catch {
        // Ignore a malformed export; the probe reports missing events instead.
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, events, port: server.address().port }));
  });
}

async function findSessionFile(sessionId) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  for (const directory of await fs.readdir(projects).catch(() => [])) {
    const candidate = path.join(projects, directory, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function fileFacts(file) {
  if (!file) return { exists: false };
  const content = await fs.readFile(file);
  return {
    exists: true,
    sha256: createHash('sha256').update(content).digest('hex'),
    lines: content.toString('utf8').split('\n').filter(Boolean).length,
  };
}

function seedText() {
  const words = ['amber', 'basalt', 'cobalt', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper',
    'kelp', 'lumen', 'meadow', 'nickel', 'onyx', 'pylon', 'quartz', 'raven', 'sierra', 'tundra'];
  const lines = [];
  for (let index = 1; index <= 900; index += 1) {
    const word = words[(index * 7) % words.length];
    const other = words[(index * 11 + 3) % words.length];
    lines.push(`Module ${String(index).padStart(4, '0')}: code name ${word}-${index}; owner team ${other}; `
      + `depends on module ${String(((index * 13) % 900) + 1).padStart(4, '0')}; status ${index % 3 === 0 ? 'stable' : 'beta'}; `
      + `notes: keeps a ${word} cache and reports to the ${other} board every ${index % 7 + 1} days.`);
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const executable = options.claudeExecutable ?? resolveClaudeExecutable();
  const workspace = path.join(options.scratch, 'claude-side-question');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(options.out, { recursive: true });
  const telemetry = await startTelemetryReceiver();

  const sessionId = randomUUID();
  const input = new AsyncQueue();
  const abortController = new AbortController();
  const steps = [];
  const mainMessages = [];
  const results = [];
  let resultWaiter;
  let firstTextDeltaWaiter;

  const session = query({
    prompt: input,
    options: {
      abortController,
      cwd: workspace,
      pathToClaudeCodeExecutable: executable,
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
      canUseTool: async (_toolName, _toolInput, toolOptions) => ({ behavior: 'deny', message: 'Probe: no tools.', toolUseID: toolOptions.toolUseID }),
      includePartialMessages: true,
      persistSession: true,
      sessionId,
      settingSources: [],
      env: providerEnvironment(CLAUDE_ENVIRONMENT_VARIABLES, {
        CLAUDE_AGENT_SDK_CLIENT_APP: 'ezterminal/2',
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'none',
        OTEL_TRACES_EXPORTER: 'none',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${telemetry.port}/v1/logs`,
        OTEL_LOGS_EXPORT_INTERVAL: '1000',
      }),
    },
  });

  const iterate = (async () => {
    for await (const message of session) {
      mainMessages.push({ at: Date.now(), type: message.type, subtype: message.subtype ?? message.event?.type });
      if (message.type === 'result') {
        results.push({ at: Date.now(), subtype: message.subtype, usage: message.usage ? {
          input_tokens: message.usage.input_tokens,
          cache_read_input_tokens: message.usage.cache_read_input_tokens,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
          output_tokens: message.usage.output_tokens,
        } : undefined });
        resultWaiter?.();
      }
      if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') {
        firstTextDeltaWaiter?.();
        firstTextDeltaWaiter = undefined;
      }
    }
  })();
  iterate.catch((error) => steps.push({ name: 'stream-error', error: String(error?.message ?? error) }));

  const turn = async (name, text, { waitForResult = true } = {}) => {
    const startedAt = Date.now();
    const done = new Promise((resolve) => { resultWaiter = resolve; });
    input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId });
    if (waitForResult) {
      await done;
      steps.push({ name, kind: 'turn', startedAt, endedAt: Date.now() });
    }
    return { startedAt, done };
  };

  const ask = async (name, question, askOptions = {}) => {
    const startedAt = Date.now();
    const messageIndex = mainMessages.length;
    try {
      const answer = await session.askSideQuestion(question, askOptions);
      const endedAt = Date.now();
      steps.push({
        name, kind: 'side-question', startedAt, endedAt, ok: true,
        answerNull: answer === null, synthetic: answer?.synthetic ?? null, answerChars: answer?.response?.length ?? 0,
        mainStreamDuringAsk: mainMessages.slice(messageIndex).map((entry) => `${entry.type}/${entry.subtype ?? ''}`),
      });
      return answer;
    } catch (error) {
      steps.push({ name, kind: 'side-question', startedAt, endedAt: Date.now(), ok: false, error: String(error?.message ?? error).slice(0, 200) });
      return undefined;
    }
  };

  const facts = { cli: executable, sdk: JSON.parse(readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version };
  try {
    await session.initializationResult();
    await turn('main-1-seed', `${seedText()}\n\nThe list above is reference data for later questions. Do not use any tools. Reply with exactly: OK`);
    await turn('main-2', 'Without tools: what is the code name of module 0017? Answer in one short line.');
    await delay(3_000);
    const sessionFile = await findSessionFile(sessionId);
    facts.sessionFileFound = Boolean(sessionFile);
    const before = await fileFacts(sessionFile);

    const first = await ask('side-1', 'What is the code name of module 0042? One word.');
    await ask('side-2-history', 'And which team owns that module? One word.', first?.response
      ? { history: [{ question: 'What is the code name of module 0042? One word.', response: first.response }] }
      : {});
    await delay(3_000);
    const after = await fileFacts(sessionFile);

    // Overlap: a side question while a main turn is streaming.
    const long = await turn('main-3-long', 'Without tools: list modules 0001 to 0060 with their code names, one per line.', { waitForResult: false });
    await new Promise((resolve) => { firstTextDeltaWaiter = resolve; });
    await ask('side-3-during-turn', 'How many modules are in the reference list? Number only.');
    await long.done;
    steps.push({ name: 'main-3-long', kind: 'turn', startedAt: long.startedAt, endedAt: Date.now() });

    // A main-turn interrupt while a side question is in flight.
    const interruptedTurn = await turn('main-4-interrupted', 'Without tools: list modules 0100 to 0200 with their owner teams, one per line.', { waitForResult: false });
    await new Promise((resolve) => { firstTextDeltaWaiter = resolve; });
    const pendingAsk = ask('side-4-interrupt', 'What is the status of module 0003? One word.');
    await delay(300);
    const interruptAt = Date.now();
    await session.interrupt().catch(() => undefined);
    await pendingAsk;
    await Promise.race([interruptedTurn.done, delay(20_000)]);
    steps.push({ name: 'main-4-interrupted', kind: 'turn', startedAt: interruptedTurn.startedAt, endedAt: Date.now(), interruptAt });

    // Abort: the signal cancels the control request.
    const abort = new AbortController();
    const aborted = ask('side-5-aborted', 'Summarise the reference list in two sentences.', { signal: abort.signal });
    await delay(800);
    abort.abort();
    await aborted;

    // Warm the main thread once more, then idle past the 5-minute TTL.
    await turn('main-5-warm', 'Without tools: what is the code name of module 0500? One short line.');
    if (!options.skipIdle) {
      const idleMs = Math.round(options.idleMinutes * 60_000);
      steps.push({ name: 'idle', kind: 'idle', startedAt: Date.now(), idleMs });
      await delay(idleMs);
      await ask('side-6-after-idle', 'What is the code name of module 0777? One word.');
    }
    await delay(4_000);
    const afterAll = await fileFacts(sessionFile);
    facts.transcript = { before, afterSideQuestions: after, afterAll };
  } finally {
    input.close();
    session.close();
    await Promise.race([iterate.catch(() => undefined), delay(5_000)]);
    await delay(2_500);
    telemetry.server.close();
  }

  // Attribute each api_request (timestamped when the request ends) to the latest-started step
  // whose window holds it; side questions only to side steps, main requests only to turns.
  const attributed = telemetry.events.map((event) => {
    const at = Date.parse(event['event.timestamp'] ?? '') || event.receivedAt;
    const side = String(event.query_source ?? event.query_source_safe ?? '').includes('side');
    const step = steps
      .filter((entry) => entry.kind === (side ? 'side-question' : 'turn') && at >= entry.startedAt - 250 && at <= (entry.endedAt ?? entry.startedAt) + 300)
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    return { ...event, at, step: step?.name ?? null };
  });
  const forStep = (name) => attributed.filter((event) => event.step === name);
  const sideEvents = (name) => forStep(name).filter((event) => String(event.query_source ?? event.query_source_safe ?? '').includes('side'));
  const lastMain = (name) => forStep(name).filter((event) => !String(event.query_source ?? event.query_source_safe ?? '').includes('side')).at(-1);
  const evaluate = (sideName, mainName) => {
    const side = sideEvents(sideName).at(-1) ?? forStep(sideName).at(-1);
    const main = lastMain(mainName);
    if (!side || !main) return { sideName, mainName, verdict: 'missing-telemetry', side, main };
    const mainContext = Number(main.cache_read_tokens ?? 0) + Number(main.cache_creation_tokens ?? 0);
    const read = Number(side.cache_read_tokens ?? 0);
    const created = Number(side.cache_creation_tokens ?? 0);
    const pass = read >= 0.9 * mainContext && created <= Math.max(1_024, 0.01 * read);
    return { sideName, mainName, mainContext, sideCacheRead: read, sideCacheCreation: created, sideInput: Number(side.input_tokens ?? 0), querySource: side.query_source ?? side.query_source_safe, verdict: pass ? 'pass' : 'fail' };
  };
  const transcript = facts.transcript;
  const verdicts = {
    side1: evaluate('side-1', 'main-2'),
    side2: evaluate('side-2-history', 'main-2'),
    side3DuringTurn: evaluate('side-3-during-turn', 'main-2'),
    side6AfterIdle: options.skipIdle ? 'skipped' : evaluate('side-6-after-idle', 'main-5-warm'),
    transcriptUnchanged: transcript?.before?.exists ? transcript.before.sha256 === transcript.afterSideQuestions.sha256 : 'no-session-file',
    mainStreamQuietDuringSideQuestions: steps.filter((step) => step.kind === 'side-question' && step.name !== 'side-3-during-turn' && step.name !== 'side-4-interrupt')
      .every((step) => (step.mainStreamDuringAsk ?? []).every((entry) => entry.startsWith('system/'))),
  };
  const report = { probe: 'claude-side-question-cache', at: new Date().toISOString(), facts, steps, results, telemetry: attributed, verdicts };
  const file = path.join(options.out, `claude-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ file, verdicts }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
