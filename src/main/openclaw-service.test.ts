/**
 * OpenClawService unit tests (openclaw-management M1). Every DI seam is faked
 * — no live gateway, no real `openclaw` CLI is ever spawned. `env.PATH`
 * points at a temp dir holding a dummy `openclaw.cmd` (same fixture style as
 * command-resolver.test.ts) so `CommandResolver`'s real PATHEXT probing
 * exercises install detection without touching the machine's real PATH.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { OpenClawService, parseLogLine, type ChildProcessLike, type OpenClawWsLike, type SpawnFn } from './openclaw-service';
import type { EnvLike } from '../interpreter/external/command-resolver';
import type { OpenClawLogLine } from '../shared/openclaw';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let cliDir: string;
let cliEnv: EnvLike;

beforeAll(() => {
  cliDir = mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-cli-'));
  writeFileSync(path.join(cliDir, 'openclaw.cmd'), '');
  cliEnv = { PATH: cliDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
});

afterAll(() => {
  rmSync(cliDir, { recursive: true, force: true });
});

const noTokenReadFile = async (): Promise<string> => {
  throw new Error('ENOENT');
};

// ── Fake spawn helpers ───────────────────────────────────────────────────

/** A spawn fake that resolves its child's 'close' event on the next microtask
 * with a fixed exit code/stdout/stderr — good for one-shot CLI calls
 * (config get/set) where the test doesn't need to control timing. */
function makeExitSpawn(code: number, stdout = '', stderr = ''): { spawn: SpawnFn; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawn: SpawnFn = (file, args) => {
    calls.push({ file, args: [...args] });
    return {
      stdout: { on: (event: string, cb: (chunk: Buffer) => void) => { if (event === 'data' && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on: (event: string, cb: (chunk: Buffer) => void) => { if (event === 'data' && stderr) cb(Buffer.from(stderr)); } },
      on: (event: string, cb: (code: number | null) => void) => {
        if (event === 'close') queueMicrotask(() => cb(code));
      },
    } as unknown as ChildProcessLike;
  };
  return { spawn, calls };
}

/** A spawn fake whose children stay open until the test explicitly closes
 * them (in spawn order) — used to prove `runLifecycle` serializes. */
function makeControllableSpawn(): {
  spawn: SpawnFn;
  calls: Array<{ file: string; args: string[] }>;
  closeNth: (index: number, code: number) => void;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const closers: Array<(code: number) => void> = [];
  const spawn: SpawnFn = (file, args) => {
    calls.push({ file, args: [...args] });
    let onClose: ((code: number | null) => void) | undefined;
    closers.push((code) => onClose?.(code));
    return {
      stdout: { on: () => undefined },
      stderr: { on: () => undefined },
      on: (event: string, cb: (code: number | null) => void) => {
        if (event === 'close') onClose = cb;
      },
    } as unknown as ChildProcessLike;
  };
  return { spawn, calls, closeNth: (index, code) => closers[index]?.(code) };
}

// ── Fake WS ──────────────────────────────────────────────────────────────

interface SentEnvelope {
  readonly type: string;
  readonly id?: string;
  readonly method?: string;
  readonly params?: unknown;
}

class FakeOpenClawWs implements OpenClawWsLike {
  readonly sent: SentEnvelope[] = [];
  closed = false;
  private readonly messageHandlers: Array<(data: { toString(): string }) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  private readonly errorHandlers: Array<(err: unknown) => void> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentEnvelope);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
  on(event: 'message' | 'close' | 'error', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
    else if (event === 'close') this.closeHandlers.push(listener as never);
    else this.errorHandlers.push(listener as never);
  }
  /** Test helper: simulate a server-sent frame. */
  serverSend(msg: unknown): void {
    const data = { toString: () => JSON.stringify(msg) };
    for (const h of this.messageHandlers) h(data);
  }
}

async function completeHandshake(ws: FakeOpenClawWs): Promise<void> {
  await flush();
  ws.serverSend({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } });
  await flush();
  const connectReq = ws.sent.find((m) => m.method === 'connect');
  expect(connectReq).toBeTruthy();
  ws.serverSend({
    type: 'res',
    id: 'connect',
    ok: true,
    payload: { type: 'hello-ok', protocol: 4, auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] } },
  });
  await flush();
}

function makeWsFactory(): { wsFactory: () => FakeOpenClawWs; sockets: FakeOpenClawWs[] } {
  const sockets: FakeOpenClawWs[] = [];
  return { wsFactory: () => { const s = new FakeOpenClawWs(); sockets.push(s); return s; }, sockets };
}

// ── getStatus ────────────────────────────────────────────────────────────

describe('OpenClawService — getStatus', () => {
  it('reports not-installed when the CLI does not resolve on PATH', async () => {
    const service = new OpenClawService({ env: { PATH: '' }, httpGet: async () => ({ ok: true }) });
    expect(await service.getStatus()).toEqual({ state: 'not-installed', port: 18789 });
  });

  it('reports stopped when installed but the HTTP liveness probe fails (connection refused)', async () => {
    const service = new OpenClawService({ env: cliEnv, httpGet: async () => ({ ok: false }) });
    expect(await service.getStatus()).toEqual({ state: 'stopped', port: 18789 });
  });

  it('reports unknown when the liveness probe itself throws unexpectedly', async () => {
    const service = new OpenClawService({
      env: cliEnv,
      httpGet: async () => {
        throw new Error('boom');
      },
    });
    expect(await service.getStatus()).toEqual({ state: 'unknown', port: 18789 });
  });

  it('reports running + enriches version via WS RPC status when alive', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({
      env: cliEnv,
      httpGet: async () => ({ ok: true }),
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });
    const promise = service.getStatus();
    await flush();
    const ws = sockets[0];
    await completeHandshake(ws);
    await flush();
    const statusReq = ws.sent.find((m) => m.method === 'status');
    expect(statusReq).toBeTruthy();
    ws.serverSend({ type: 'res', id: statusReq!.id, ok: true, payload: { runtimeVersion: '2026.6.11' } });
    const status = await promise;
    expect(status).toEqual({ state: 'running', port: 18789, version: '2026.6.11' });
  });

  it('force=true re-probes installed status rather than trusting the cache', async () => {
    let path = '';
    const service = new OpenClawService({ env: new Proxy({}, { get: (_t, k) => (k === 'PATH' ? path : undefined) }), httpGet: async () => ({ ok: false }) });
    expect((await service.getStatus()).state).toBe('not-installed');
    path = cliDir;
    expect((await service.getStatus()).state).toBe('not-installed'); // still cached
    expect((await service.getStatus(true)).state).toBe('stopped'); // forced re-probe finds it now
  });
});

// ── runLifecycle ─────────────────────────────────────────────────────────

describe('OpenClawService — runLifecycle', () => {
  it('spawns `openclaw gateway <action>` and reports ok on exit 0', async () => {
    const { spawn, calls } = makeExitSpawn(0);
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });
    const result = await service.runLifecycle('start');
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.args).toEqual(['gateway', 'start']);
  });

  it('reports stderr on a non-zero exit', async () => {
    const { spawn } = makeExitSpawn(1, '', 'gateway already stopped');
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });
    const result = await service.runLifecycle('stop');
    expect(result).toEqual({ ok: false, stderr: 'gateway already stopped' });
  });

  it('serializes overlapping calls — the second never starts until the first closes', async () => {
    const { spawn, calls, closeNth } = makeControllableSpawn();
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });

    const p1 = service.runLifecycle('start');
    const p2 = service.runLifecycle('stop');
    await flush();
    expect(calls).toHaveLength(1); // second is queued behind the first, not interleaved

    closeNth(0, 0);
    await flush();
    expect(calls).toHaveLength(2);

    closeNth(1, 0);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['gateway', 'start'], ['gateway', 'stop']]);
  });
});

// ── runAutostart (task #9) ───────────────────────────────────────────────

describe('OpenClawService — runAutostart', () => {
  it('spawns `openclaw gateway install` with no extra flags and reports ok on exit 0', async () => {
    const { spawn, calls } = makeExitSpawn(0);
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });
    const result = await service.runAutostart('install');
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.args).toEqual(['gateway', 'install']);
  });

  it('spawns `openclaw gateway uninstall` and reports ok on exit 0', async () => {
    const { spawn, calls } = makeExitSpawn(0);
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });
    const result = await service.runAutostart('uninstall');
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.args).toEqual(['gateway', 'uninstall']);
  });

  it('reports stderr on a non-zero exit', async () => {
    const { spawn } = makeExitSpawn(1, '', 'not installed');
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });
    const result = await service.runAutostart('uninstall');
    expect(result).toEqual({ ok: false, stderr: 'not installed' });
  });

  it('serializes on the SAME lane as runLifecycle — never races a concurrent start/stop/restart', async () => {
    const { spawn, calls, closeNth } = makeControllableSpawn();
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });

    const p1 = service.runLifecycle('start');
    const p2 = service.runAutostart('install');
    await flush();
    expect(calls).toHaveLength(1); // autostart queued behind the in-flight lifecycle call

    closeNth(0, 0);
    await flush();
    expect(calls).toHaveLength(2);

    closeNth(1, 0);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['gateway', 'start'], ['gateway', 'install']]);
  });
});

// ── listAgentSessions ────────────────────────────────────────────────────

describe('OpenClawService — listAgentSessions', () => {
  it('correlates the sessions.list request by id and maps known fields', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({
      env: cliEnv,
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });
    const promise = service.listAgentSessions();
    await flush();
    const ws = sockets[0];
    await completeHandshake(ws);
    await flush();
    const req = ws.sent.find((m) => m.method === 'sessions.list');
    expect(req).toBeTruthy();
    ws.serverSend({
      type: 'res',
      id: req!.id,
      ok: true,
      payload: {
        sessions: [
          { key: 'agent:main:main', sessionId: 's1', status: 'done', model: 'gpt-5.5', modelProvider: 'openai', hasActiveRun: false, estimatedCostUsd: 0.08 },
          { notAValidEntry: true }, // missing required key/sessionId — dropped, not crashed on
        ],
      },
    });
    const sessions = await promise;
    expect(sessions).toEqual([
      { key: 'agent:main:main', sessionId: 's1', status: 'done', model: 'gpt-5.5', modelProvider: 'openai', hasActiveRun: false, estimatedCostUsd: 0.08 },
    ]);
  });

  it('resolves to an empty array (not a rejection) when the RPC call fails entirely', async () => {
    const service = new OpenClawService({ env: cliEnv, wsFactory: () => { throw new Error('no socket'); } });
    await expect(service.listAgentSessions()).resolves.toEqual([]);
  });
});

// ── getCoreConfig / setCoreConfig ────────────────────────────────────────

describe('OpenClawService — core config', () => {
  it('maps an exit-1 "not found" response to the unset sentinel, not an error', async () => {
    const { spawn } = makeExitSpawn(1, '', 'Config path not found: gateway.port. Run openclaw config validate to inspect config shape.');
    const service = new OpenClawService({ env: cliEnv, spawn });
    const config = await service.getCoreConfig();
    expect(config['gateway.port']).toBe('unset');
    expect(config['agents.defaults.model']).toBe('unset');
  });

  it('parses a --json string value on exit 0', async () => {
    const { spawn } = makeExitSpawn(0, '"openai/gpt-5.5"\n');
    const service = new OpenClawService({ env: cliEnv, spawn });
    const config = await service.getCoreConfig();
    expect(config['agents.defaults.model']).toBe('openai/gpt-5.5');
  });

  it('rejects a non-allowlisted key before ever spawning', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('must not spawn for a rejected key');
    };
    const service = new OpenClawService({ env: cliEnv, spawn });
    await expect(service.setCoreConfig('gateway.auth.token', 'x')).rejects.toThrow(/allowlist/);
  });

  it('setCoreConfig reports restartRequired:true on success (M0: no live reload)', async () => {
    const { spawn } = makeExitSpawn(0, 'Updated gateway.port. Restart the gateway to apply.');
    const service = new OpenClawService({ env: cliEnv, spawn });
    const result = await service.setCoreConfig('gateway.port', '19099');
    expect(result).toEqual({ ok: true, restartRequired: true });
  });

  it('setCoreConfig surfaces stderr and restartRequired:false on failure', async () => {
    const { spawn } = makeExitSpawn(1, '', 'invalid value');
    const service = new OpenClawService({ env: cliEnv, spawn });
    const result = await service.setCoreConfig('gateway.port', 'not-a-port');
    expect(result).toEqual({ ok: false, restartRequired: false, error: 'invalid value' });
  });
});

// ── getChatToken / getChatUrl — token secrecy ────────────────────────────

describe('OpenClawService — chat token', () => {
  const FAKE_TOKEN = 'abc123-fake-secret-token-value';

  it('extracts the token from the config file directly (never via the CLI)', async () => {
    const spawn: SpawnFn = () => {
      throw new Error('must not spawn — token retrieval never uses the CLI (M0: CLI always redacts)');
    };
    const service = new OpenClawService({
      env: cliEnv,
      spawn,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: FAKE_TOKEN } } }),
    });
    expect(await service.getChatToken()).toBe(FAKE_TOKEN);
    expect(await service.getChatUrl()).toBe(`http://127.0.0.1:18789/#token=${FAKE_TOKEN}`);
  });

  it('returns null when the config file is unreadable, rather than throwing', async () => {
    // Config-path resolution falls back to `openclaw config file` when the
    // default path read fails — fake that exit-1 too, so this stays hermetic
    // (no real child process, matching the "readFile always fails" premise).
    const { spawn } = makeExitSpawn(1, '', 'not found');
    const service = new OpenClawService({ env: cliEnv, spawn, readFile: noTokenReadFile });
    expect(await service.getChatToken()).toBeNull();
    expect(await service.getChatUrl()).toBeNull();
  });

  it('never surfaces the token through getStatus(), even while running with WS enrichment', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({
      env: cliEnv,
      httpGet: async () => ({ ok: true }),
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: FAKE_TOKEN } } }),
    });
    const promise = service.getStatus();
    await flush();
    await completeHandshake(sockets[0]);
    await flush();
    const statusReq = sockets[0].sent.find((m) => m.method === 'status');
    sockets[0].serverSend({ type: 'res', id: statusReq!.id, ok: true, payload: { runtimeVersion: '1.0' } });
    const status = await promise;
    expect(JSON.stringify(status)).not.toContain(FAKE_TOKEN);
    // The connect request itself legitimately carries the token (that's how
    // auth works) — but nothing returned to a caller ever does.
    const connectReq = sockets[0].sent.find((m) => m.method === 'connect');
    expect(JSON.stringify(connectReq?.params)).toContain(FAKE_TOKEN);
  });
});

// ── parseLogLine ─────────────────────────────────────────────────────────

describe('parseLogLine', () => {
  it('parses a tslog JSON entry and strips embedded ANSI codes from the message', () => {
    const raw = JSON.stringify({
      time: '2026-07-12T11:15:44.793+09:00',
      message: '\x1b[93m⇄\x1b[39m \x1b[1mres\x1b[22m status',
      _meta: { logLevelName: 'INFO' },
    });
    const line = parseLogLine(raw, () => 0);
    expect(line).toEqual({ time: '2026-07-12T11:15:44.793+09:00', level: 'INFO', message: '⇄ res status' });
  });

  it('falls back to the raw text (ANSI-stripped) for a non-JSON line', () => {
    const line = parseLogLine('plain text line', () => 1_700_000_000_000);
    expect(line.message).toBe('plain text line');
    expect(line.level).toBe('INFO');
    expect(line.time).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

// ── subscribeLogs — refcount + polling ───────────────────────────────────

describe('OpenClawService — subscribeLogs', () => {
  it('shares ONE RPC connection across multiple listeners and tears it down at zero subscribers', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({
      env: cliEnv,
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });
    const linesA: OpenClawLogLine[] = [];
    const linesB: OpenClawLogLine[] = [];
    const unsubA = service.subscribeLogs((l) => linesA.push(l));
    const unsubB = service.subscribeLogs((l) => linesB.push(l));

    expect(linesA[0]?.message).toMatch(/Connecting/);
    expect(linesB[0]?.message).toMatch(/Connecting/);

    await flush();
    expect(sockets).toHaveLength(1); // one shared connection, not one per subscriber

    await completeHandshake(sockets[0]);
    await flush();
    const req = sockets[0].sent.find((m) => m.method === 'logs.tail');
    expect(req).toBeTruthy();
    sockets[0].serverSend({
      type: 'res',
      id: req!.id,
      ok: true,
      payload: { cursor: 100, size: 100, truncated: false, reset: false, lines: [JSON.stringify({ message: 'hello', _meta: { logLevelName: 'INFO' } })] },
    });
    await flush();
    expect(linesA.at(-1)?.message).toBe('hello');
    expect(linesB.at(-1)?.message).toBe('hello');

    unsubA();
    expect(sockets[0].closed).toBe(false); // one subscriber remains
    unsubB();
    expect(sockets[0].closed).toBe(true); // refcount hit zero — connection closed
  });
});

// ── dispose ──────────────────────────────────────────────────────────────

describe('OpenClawService — dispose', () => {
  it('is idempotent and never spawns a lifecycle CLI call itself', () => {
    const spawn: SpawnFn = () => {
      throw new Error('dispose must never touch the gateway');
    };
    const service = new OpenClawService({ env: cliEnv, spawn });
    expect(() => service.dispose()).not.toThrow();
    expect(() => service.dispose()).not.toThrow();
  });

  it('closes an active RPC connection and clears subscribers', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({ env: cliEnv, wsFactory, readFile: async () => JSON.stringify({ gateway: { auth: { token: 't' } } }) });
    service.subscribeStatus(() => undefined);
    await flush();
    expect(sockets[0]?.closed).toBe(false);
    service.dispose();
    expect(sockets[0]?.closed).toBe(true);
  });
});

// ── Real `ws` server — end-to-end handshake + reconnect-with-backoff ─────
// Per the assignment: a fake ws server via `ws` on an ephemeral port is
// local-test-owned, not the live gateway, so this is still a "no live
// gateway" unit test — it just exercises the real `ws` client/server pair
// instead of a hand-rolled fake for the reconnect path specifically.

describe('OpenClawService — real ws server (reconnect-with-backoff)', () => {
  let wss: WebSocketServer;
  let port: number;

  afterEach(() => {
    wss.close();
  });

  it('reconnects and resumes serving RPC calls after the connection drops', async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    port = (wss.address() as AddressInfo).port;

    let connectionCount = 0;
    wss.on('connection', (socket) => {
      connectionCount += 1;
      socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }));
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { id?: string; method?: string };
        if (msg.method === 'connect') {
          socket.send(JSON.stringify({ type: 'res', id: 'connect', ok: true, payload: { type: 'hello-ok' } }));
        } else if (msg.method === 'status') {
          socket.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { runtimeVersion: 'v-test' } }));
        }
      });
    });

    const service = new OpenClawService({
      env: { ...cliEnv, EZTERMINAL_OPENCLAW_URL: `http://127.0.0.1:${port}` },
      httpGet: async () => ({ ok: true }),
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });

    const pushed: string[] = [];
    const unsubscribe = service.subscribeStatus((status) => pushed.push(status.state));

    // Wait for the first successful status push (real timers — the loop's
    // first tick is scheduled at delay 0).
    await new Promise<void>((resolve) => {
      const check = (): void => { if (pushed.length > 0) resolve(); else setTimeout(check, 20); };
      check();
    });
    expect(pushed.at(-1)).toBe('running');
    expect(connectionCount).toBe(1);

    // Force the connection closed from the server side — the client must
    // reconnect on its own (backoff starts at 500ms).
    for (const client of wss.clients) client.close();

    await new Promise<void>((resolve) => {
      const check = (): void => { if (connectionCount >= 2) resolve(); else setTimeout(check, 50); };
      check();
    });
    expect(connectionCount).toBe(2);

    unsubscribe();
  }, 15_000);
});
