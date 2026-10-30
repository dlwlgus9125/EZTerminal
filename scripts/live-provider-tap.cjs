/*
 * Test-only preload for scripts/verify-ux-live.mjs (`electron -r`). It watches the real providers from outside the
 * product: nothing in src/ knows about it, and the product's environment allow-list stays as it is.
 *
 * - Each `codex app-server` and each Claude stream-json process gets its stdio teed to EZ_LIVE_TAP_DIR/provider-tap.jsonl
 *   (requests sent, notifications received). Ephemeral Codex forks write no rollout, so the JSON-RPC stream is the
 *   only place their token usage exists.
 * - A Claude process also gets OTLP telemetry pointed at EZ_LIVE_TAP_OTLP, tagged with its session id: the same
 *   `api_request` events the probes read.
 * - `conversation-viewing:report` is logged, so a run can say what the window told the host.
 * - The OS login item is stubbed in memory: a scenario may need "start at login" on, and no test run may register one.
 * Two switches change what passes through, for one run at a time: EZ_LIVE_TAP_HIDE_LIMITS hides real usage readings from
 * the host (a forced pause would otherwise last seconds), and EZ_LIVE_TAP_KEEP_FORKS makes Codex forks leave a rollout.
 *
 * Streaming deltas are dropped and long prompts cut; launch arguments and the session's MCP token are not logged.
 */
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { StringDecoder } = require('node:string_decoder');

const directory = process.env.EZ_LIVE_TAP_DIR;
const otlp = process.env.EZ_LIVE_TAP_OTLP;
const hideLimits = process.env.EZ_LIVE_TAP_HIDE_LIMITS === '1';
const keepForks = process.env.EZ_LIVE_TAP_KEEP_FORKS === '1';

const MAX_LINE = 24_000;
const MAX_INPUT_TEXT = 1_500;

function write(record) {
  fs.appendFileSync(path.join(directory, 'provider-tap.jsonl'), `${JSON.stringify({ at: Date.now(), ...record })}\n`);
}

/** A Codex `turn/start` keeps its fields; only the person's words, which a seed can make huge, are cut. */
function trimmed(message) {
  const input = message?.params?.input;
  if (Array.isArray(input)) {
    for (const part of input) if (typeof part?.text === 'string' && part.text.length > MAX_INPUT_TEXT) part.text = `${part.text.slice(0, MAX_INPUT_TEXT)}…`;
  }
  // The session's MCP bearer token travels in `thread/start`.
  for (const server of Object.values(message?.params?.config?.mcp_servers ?? {})) if (server?.http_headers) server.http_headers = '(hidden)';
  return message;
}

const NOISE = /delta|textDelta|rawResponseItem|reasoning\/|itemStreaming/iu;
const CLAUDE_NOISE = new Set(['stream_event', 'assistant', 'user', 'tool_progress']);

function keep(provider, message) {
  if (provider === 'codex') return !NOISE.test(String(message?.method ?? ''));
  return !CLAUDE_NOISE.has(message?.type);
}

function teeLine(provider, pid, direction, line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!keep(provider, message)) return;
  let data = JSON.stringify(trimmed(message));
  if (data.length > MAX_LINE) data = JSON.stringify({ truncated: data.length, method: message.method, type: message.type, subtype: message.subtype, id: message.id, head: data.slice(0, 4_000) });
  write({ provider, pid, direction, data: JSON.parse(data) });
}

function lineReader(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
      onLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
  };
}

function providerOf(command, args) {
  const words = [String(command), ...(Array.isArray(args) ? args.map(String) : [])];
  const joined = words.join(' ');
  // cross-spawn wraps a .cmd shim in cmd.exe with escaped arguments, so the words are not whole.
  if (/codex/iu.test(joined) && joined.includes('app-server')) return 'codex';
  if (/claude/iu.test(joined) && words.includes('--output-format')) return 'claude';
  return undefined;
}

const argumentValue = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function claudeTelemetry(tag) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_TRACES_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${otlp}/${tag}/v1/logs`,
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
  };
}

/**
 * --force-pause: real readings would replace the forced one within seconds, so the host does not see them in that run.
 * These are the only three ways a reading reaches it: Claude's event and Codex's read and update, which share a key.
 */
function withoutLimits(chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  if (!text.includes('rate_limit_event') && !text.includes('rateLimits')) return chunk;
  const hidden = text.replaceAll('"rate_limit_event"', '"rate_limit_hidden"').replaceAll('"rateLimits"', '"rateLimitsHidden"');
  return typeof chunk === 'string' ? hidden : Buffer.from(hidden, 'utf8');
}

function tee(child, provider) {
  const pid = child.pid;
  const fromProvider = lineReader((line) => teeLine(provider, pid, 'out', line));
  const emit = child.stdout.emit;
  // Listening on `emit` leaves the stream's flow alone: the product decides when it starts reading.
  child.stdout.emit = function tappedEmit(event, chunk, ...rest) {
    if (event !== 'data') return emit.call(this, event, chunk, ...rest);
    fromProvider(chunk);
    return emit.call(this, event, hideLimits ? withoutLimits(chunk) : chunk, ...rest);
  };
  const toProvider = lineReader((line) => teeLine(provider, pid, 'in', line));
  const stdinWrite = child.stdin.write;
  child.stdin.write = function tappedWrite(chunk, ...rest) {
    toProvider(chunk);
    // EZ_LIVE_TAP_KEEP_FORKS: a diagnostic run, so a fork leaves a rollout that shows what Codex really sent it.
    const kept = keepForks && provider === 'codex' && String(chunk).includes('"thread/fork"') ? String(chunk).replace('"ephemeral":true', '"ephemeral":false') : chunk;
    return stdinWrite.call(this, kept, ...rest);
  };
  child.once('exit', (code, signal) => write({ provider, pid, exit: code ?? signal }));
}

if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  const spawn = childProcess.spawn;
  childProcess.spawn = function tappedSpawn(command, args, options) {
    const provider = providerOf(command, args);
    if (!provider) return spawn.apply(this, arguments);
    const list = Array.isArray(args) ? args.map(String) : [];
    const session = argumentValue(list, '--session-id') ?? argumentValue(list, '--resume');
    const tag = session ?? `claude-${Date.now().toString(36)}`;
    const launch = provider === 'claude' && otlp ? { ...options, env: { ...options?.env, ...claudeTelemetry(tag) } } : options;
    const child = spawn.call(this, command, args, launch);
    write({ provider, pid: child.pid, spawn: true, session, tag, resumed: list.includes('--resume'), promptSuggestions: list.includes('--enable-prompt-suggestions') || undefined });
    if (child.stdout && child.stdin) tee(child, provider);
    return child;
  };
  syncBuiltinESMExports();
  try {
    const { app, ipcMain } = require('electron');
    ipcMain.on('conversation-viewing:report', (event, _clientId, sessionIds) => write({ viewing: sessionIds, sender: event.sender.id }));
    // Heartbeats need "start at login" on. That setting must not reach Windows from a test run: it stays in memory here.
    let loginItem = { openAtLogin: false };
    app.getLoginItemSettings = () => ({ ...loginItem, executableWillLaunchAtLogin: loginItem.openAtLogin, launchItems: [] });
    app.setLoginItemSettings = (settings) => {
      loginItem = { ...settings };
      write({ loginItemStubbed: settings.openAtLogin === true });
    };
    app.on('browser-window-focus', () => write({ windowFocus: true }));
    app.on('browser-window-blur', () => write({ windowFocus: false }));
  } catch {
    // Not in Electron's main process: nothing to watch.
  }
}
