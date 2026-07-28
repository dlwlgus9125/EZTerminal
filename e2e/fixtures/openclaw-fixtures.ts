import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

import {
  createRegisteredE2eTempDir,
  registerE2eResourceCloser,
} from '../test';

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
  const dir = createRegisteredE2eTempDir('ezterm-e2e-openclaw-');
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
 * and waits for its `READY <port>` stdout line. Uses `spawn` with the current
 * Node executable and an argv ARRAY (never a shell string) — no user input
 * crosses this boundary, `gatewayScript`/`statePath` are both paths this
 * module itself constructed.
 */
export async function startFakeGateway(statePath: string): Promise<FakeGatewayHandle> {
  const gatewayScript = path.resolve(__dirname, 'fake-openclaw-gateway.mjs');
  const proc = spawn(
    process.execPath,
    [gatewayScript, statePath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stopProcess = (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        proc.off('exit', onExit);
        proc.off('error', onError);
      };
      const onExit = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      proc.once('exit', onExit);
      proc.once('error', onError);
      try {
        if (!proc.kill() && proc.pid === undefined) {
          cleanup();
          resolve();
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  };

  let managedCloser: ReturnType<typeof registerE2eResourceCloser>;
  try {
    // Register immediately after spawn, before READY. A timed-out startup or a
    // later launchApp failure must still leave fixture teardown able to stop
    // this child.
    managedCloser = registerE2eResourceCloser({ close: stopProcess });
  } catch (error) {
    try {
      await stopProcess();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Fake OpenClaw gateway could not be registered or stopped',
      );
    }
    throw error;
  }

  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buf = '';
      const cleanup = (): void => {
        proc.stdout.off('data', onData);
        proc.off('exit', onExitBeforeReady);
        proc.off('error', onErrorBeforeReady);
      };
      const onExitBeforeReady = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        cleanup();
        reject(
          new Error(
            `fake OpenClaw gateway exited before READY (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      };
      const onErrorBeforeReady = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onData = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        const match = /READY (\d+)/.exec(buf);
        if (!match) return;
        cleanup();
        resolve(Number(match[1]));
      };
      proc.stdout.on('data', onData);
      proc.once('exit', onExitBeforeReady);
      proc.once('error', onErrorBeforeReady);
    });
    return {
      port,
      proc,
      stop: () => managedCloser.close(),
    };
  } catch (error) {
    try {
      await managedCloser.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Fake OpenClaw gateway failed before READY and could not be stopped',
      );
    }
    throw error;
  }
}
