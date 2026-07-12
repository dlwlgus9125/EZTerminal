import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';

/** The fake gateway/CLI's shared JSON state file shape — see the fixture
 * scripts' own docs for exactly which fields each side reads/writes. */
export interface OpenClawFixtureState {
  running: boolean;
  version: string;
  /** Must match the `token` field in the fake `openclaw.json` config
   * (`writeFakeConfig` below) — the fake gateway's WS `connect` handler
   * rejects any other token. */
  token: string;
  config: Record<string, string>;
  sessions: Array<{
    key: string;
    sessionId: string;
    status?: string;
    model?: string;
    modelProvider?: string;
    updatedAt?: number;
    hasActiveRun?: boolean;
    lastChannel?: string;
    estimatedCostUsd?: number;
    totalTokens?: number;
  }>;
  /** Pre-scripted `logs.tail` lines — each a JSON-ENCODED STRING (tslog's
   * on-disk shape, see openclaw-service.ts's `parseLogLine` doc), not a
   * plain object. */
  logLines: string[];
  cliCalls: Array<{ argv: string[]; at: number }>;
}

const FAKE_TOKEN = 'e2e-fake-token';

/** One ready-to-use canned log line in the double-encoded shape `logs.tail`
 * actually returns (see openclaw-service.ts's module doc). */
export function fakeLogLine(message: string, level = 'INFO', time = new Date().toISOString()): string {
  return JSON.stringify({ time, message, _meta: { logLevelName: level } });
}

/** Build a fresh fixture state with sane defaults — tests override only
 * what they care about (running/config/sessions/logLines). */
export function buildFixtureState(overrides: Partial<OpenClawFixtureState> = {}): OpenClawFixtureState {
  return {
    running: true,
    version: '2026.6.11',
    token: FAKE_TOKEN,
    config: { 'agents.defaults.model': 'openai/gpt-5.5' },
    sessions: [],
    logLines: [],
    cliCalls: [],
    ...overrides,
  };
}

/** Writes the state file + a fake `~/.openclaw/openclaw.json`-shaped config
 * (only the `gateway.auth.token` field OpenClawService.getChatToken reads)
 * into a fresh temp dir. Returns both paths plus the dir (for the .cmd
 * shim). */
export function writeFixtureFiles(state: OpenClawFixtureState): {
  dir: string;
  statePath: string;
  configPath: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-e2e-openclaw-'));
  const statePath = path.join(dir, 'state.json');
  const configPath = path.join(dir, 'openclaw.json');
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(configPath, JSON.stringify({ gateway: { auth: { token: state.token } } }));
  return { dir, statePath, configPath };
}

/** Generates a `.cmd` shim (Windows-only repo — see command-resolver.ts)
 * pointing `EZTERMINAL_OPENCLAW_CLI` at the checked-in fake CLI script. An
 * absolute path is resolved by `CommandResolver` directly (no PATH search),
 * so the shim can live in a scratch temp dir per test. */
export function writeFakeCliShim(dir: string): string {
  const cliScript = path.resolve(__dirname, 'fake-openclaw-cli.mjs');
  const shimPath = path.join(dir, 'openclaw.cmd');
  writeFileSync(shimPath, `@echo off\r\nnode "${cliScript}" %*\r\n`);
  return shimPath;
}

export interface FakeGatewayHandle {
  readonly port: number;
  readonly proc: ChildProcessByStdio<null, Readable, Readable>;
  stop(): Promise<void>;
}

/**
 * Spawns the fake gateway (fake-openclaw-gateway.mjs) on an ephemeral port
 * and waits for its `READY <port>` stdout line. Uses `spawn` with a fixed
 * `node` executable and an argv ARRAY (never a shell string) — no user input
 * crosses this boundary, `gatewayScript`/`statePath` are both paths this
 * module itself constructed.
 */
export function startFakeGateway(statePath: string): Promise<FakeGatewayHandle> {
  const gatewayScript = path.resolve(__dirname, 'fake-openclaw-gateway.mjs');
  const proc = spawn('node', [gatewayScript, statePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const match = /READY (\d+)/.exec(buf);
      if (!match) return;
      proc.stdout.off('data', onData);
      resolve({
        port: Number(match[1]),
        proc,
        stop: () =>
          new Promise<void>((res) => {
            proc.once('exit', () => res());
            proc.kill();
          }),
      });
    };
    proc.stdout.on('data', onData);
    proc.once('error', reject);
  });
}
