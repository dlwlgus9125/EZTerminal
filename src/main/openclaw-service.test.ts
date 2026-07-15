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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import {
  OpenClawService,
  parseLogLine,
  type ChildProcessLike,
  type HttpGetFn,
  type HttpGetResult,
  type OpenClawWsFactory,
  type OpenClawWsLike,
  type OpenClawServiceDeps,
  type SpawnFn,
} from './openclaw-service';
import type { EnvLike } from '../interpreter/external/command-resolver';
import type { OpenClawLogLine } from '../shared/openclaw';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let cliDir: string;
let cliEnv: EnvLike;

beforeAll(() => {
  cliDir = mkdtempSync(path.join(tmpdir(), 'ezterm-openclaw-cli-'));
  writeFileSync(path.join(cliDir, 'openclaw.cmd'), '');
  const configPath = path.join(cliDir, 'openclaw.json');
  writeFileSync(configPath, '{}');
  cliEnv = {
    PATH: cliDir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    EZTERMINAL_OPENCLAW_CONFIG_PATH: configPath,
  };
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

/** A queue-of-responses `httpGet` fake — each call pops the next queued
 * result (repeating the last one once exhausted), letting a test script a
 * probe sequence across successive `getStatus()` calls. */
function makeHttpGetQueue(...results: HttpGetResult[]): HttpGetFn {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
}

/** An `httpGet` fake whose FIRST call auto-resolves `{ok:true}` (so a test
 * can cheaply establish `wasRunning`) and every call after that stays
 * pending until the test calls `resolveFailure` — proving two concurrent
 * `getStatus()` callers land on the SAME in-flight probe (only one new
 * `httpGet` invocation) rather than each starting their own. */
function makeHttpGetWithDeferredFailure(): {
  httpGet: HttpGetFn;
  callCount: () => number;
  resolveFailure: (reason: 'timeout' | 'refused' | 'error') => void;
} {
  let count = 0;
  let resolveFn: ((result: HttpGetResult) => void) | undefined;
  const httpGet: HttpGetFn = () => {
    count += 1;
    if (count === 1) return Promise.resolve({ ok: true });
    return new Promise<HttpGetResult>((resolve) => {
      resolveFn = resolve;
    });
  };
  return {
    httpGet,
    callCount: () => count,
    resolveFailure: (reason) => resolveFn?.({ ok: false, reason }),
  };
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
  /** Test-only visibility into listener registration on the injected socket. */
  listenerCount(event: 'message' | 'close' | 'error'): number {
    if (event === 'message') return this.messageHandlers.length;
    if (event === 'close') return this.closeHandlers.length;
    return this.errorHandlers.length;
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

  it('fails closed when an HTTPS env override cannot be served by the HTTP-only mobile proxy', async () => {
    const httpGet = vi.fn(async (): Promise<HttpGetResult> => ({ ok: true }));
    const spawn = vi.fn(() => {
      throw new Error('unsupported endpoints must not spawn the CLI');
    }) as unknown as SpawnFn;
    const wsFactory = vi.fn(() => {
      throw new Error('unsupported endpoints must not open a socket');
    }) as unknown as OpenClawWsFactory;
    const readFile = vi.fn(async () => JSON.stringify({ gateway: { auth: { token: 'secret' } } }));
    const service = new OpenClawService({
      env: { ...cliEnv, EZTERMINAL_OPENCLAW_URL: 'https://gateway.example:443' },
      httpGet,
      spawn,
      wsFactory,
      readFile,
    });

    expect(service.getEndpoint()).toMatchObject({
      origin: 'http://127.0.0.1:18789',
      source: 'default',
    });
    await expect(service.getStatus()).resolves.toEqual({ state: 'unknown', port: 18789 });
    await expect(service.runLifecycle('start')).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      stderr: 'EZTERMINAL_OPENCLAW_URL must be a valid http origin',
    });
    await expect(service.runAutostart('install')).resolves.toEqual({
      ok: false,
      code: 'unavailable',
      stderr: 'EZTERMINAL_OPENCLAW_URL must be a valid http origin',
    });
    await expect(service.setCoreConfig('gateway.port', '19099')).resolves.toEqual({
      ok: false,
      restartRequired: false,
      code: 'unavailable',
      error: 'EZTERMINAL_OPENCLAW_URL must be a valid http origin',
    });
    await expect(service.getChatToken()).resolves.toBeNull();
    await expect(service.getChatUrl()).resolves.toBeNull();
    await expect(service.getInsecureAuthStatus()).resolves.toBe('error');
    await expect(service.listAgentSessions()).resolves.toEqual([]);

    expect(httpGet).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(wsFactory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    service.dispose();
  });
});

// ── isInstalled — M2 negative-cache TTL ─────────────────────────────────────

describe('OpenClawService — isInstalled negative-cache TTL (M2)', () => {
  it('re-checks a not-installed result after the TTL elapses and flips to installed', async () => {
    let currentTime = 0;
    let cliPath = '';
    const service = new OpenClawService({
      env: new Proxy({}, { get: (_t, k) => (k === 'PATH' ? cliPath : undefined) }),
      now: () => currentTime,
    });
    expect(await service.isInstalled()).toBe(false);
    cliPath = cliDir; // CLI appears on PATH mid-session
    currentTime += 29_999;
    expect(await service.isInstalled()).toBe(false); // still within the TTL window — cached
    currentTime += 1; // 30_000ms total — TTL elapsed
    expect(await service.isInstalled()).toBe(true); // re-resolved, finds it now
  });

  it('never re-resolves once installed — a positive result is sticky, no TTL', async () => {
    let currentTime = 0;
    let cliPath = cliDir;
    const service = new OpenClawService({
      env: new Proxy({}, { get: (_t, k) => (k === 'PATH' ? cliPath : undefined) }),
      now: () => currentTime,
    });
    expect(await service.isInstalled()).toBe(true);
    cliPath = ''; // CLI "disappears" from PATH
    currentTime += 1_000_000; // well past the negative-cache TTL
    expect(await service.isInstalled()).toBe(true); // sticky — never re-resolved
  });
});

// ── getStatus — M1 debounce (transient probe failures don't flip running ->
//    stopped; a `refused` failure still does, immediately) ────────────────

describe('OpenClawService — getStatus debounce (M1)', () => {
  // Every case here only cares about `state`, not the WS-enriched `version`
  // — fail the RPC connect synchronously so `running` results resolve
  // without any real socket I/O (same pattern as the listAgentSessions
  // "RPC call fails entirely" case below).
  const noWs = () => {
    throw new Error('no socket');
  };

  it('holds `running` through up to 2 consecutive timeout/error probe failures', async () => {
    const httpGet = makeHttpGetQueue({ ok: true }, { ok: false, reason: 'timeout' }, { ok: false, reason: 'timeout' });
    const service = new OpenClawService({ env: cliEnv, httpGet, wsFactory: noWs });
    expect((await service.getStatus()).state).toBe('running');
    expect((await service.getStatus()).state).toBe('running'); // 1st timeout — still running
    expect((await service.getStatus()).state).toBe('running'); // 2nd timeout — still running
  });

  it('flips to `stopped` on the 3rd consecutive timeout/error probe failure', async () => {
    const httpGet = makeHttpGetQueue(
      { ok: true },
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
    );
    const service = new OpenClawService({ env: cliEnv, httpGet, wsFactory: noWs });
    expect((await service.getStatus()).state).toBe('running');
    expect((await service.getStatus()).state).toBe('running');
    expect((await service.getStatus()).state).toBe('running');
    expect((await service.getStatus()).state).toBe('stopped');
  });

  it('treats a `refused` failure as definitive — flips to `stopped` immediately, no debounce grace', async () => {
    const httpGet = makeHttpGetQueue({ ok: true }, { ok: false, reason: 'refused' });
    const service = new OpenClawService({ env: cliEnv, httpGet, wsFactory: noWs });
    expect((await service.getStatus()).state).toBe('running');
    expect((await service.getStatus()).state).toBe('stopped');
  });

  it('resets the failure streak on a successful probe', async () => {
    const httpGet = makeHttpGetQueue(
      { ok: true },
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
      { ok: true },
      { ok: false, reason: 'timeout' },
      { ok: false, reason: 'timeout' },
    );
    const service = new OpenClawService({ env: cliEnv, httpGet, wsFactory: noWs });
    expect((await service.getStatus()).state).toBe('running');
    expect((await service.getStatus()).state).toBe('running'); // timeout 1/2
    expect((await service.getStatus()).state).toBe('running'); // timeout 2/2
    expect((await service.getStatus()).state).toBe('running'); // success — streak reset
    expect((await service.getStatus()).state).toBe('running'); // timeout 1/2 again
    expect((await service.getStatus()).state).toBe('running'); // timeout 2/2 again — would be `stopped` without the reset
  });

  it('reports `stopped` on the very first probe timeout when there is no prior running observation (cold start)', async () => {
    const httpGet = makeHttpGetQueue({ ok: false, reason: 'timeout' });
    const service = new OpenClawService({ env: cliEnv, httpGet, wsFactory: noWs });
    expect((await service.getStatus()).state).toBe('stopped');
  });

  it("runLifecycle('stop') resets the debounce state — the next probe timeout reports `stopped` immediately", async () => {
    const { spawn } = makeExitSpawn(0);
    const httpGet = makeHttpGetQueue({ ok: true }, { ok: false, reason: 'timeout' });
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet, wsFactory: noWs });
    expect((await service.getStatus()).state).toBe('running');
    expect(await service.runLifecycle('stop')).toEqual({ ok: true });
    expect((await service.getStatus()).state).toBe('stopped'); // would be `running` (streak 1/2) without the reset
  });

  it('coalesces concurrent getStatus() calls onto a single in-flight probe — a shared failure only advances the streak by 1', async () => {
    const { httpGet, callCount, resolveFailure } = makeHttpGetWithDeferredFailure();
    const service = new OpenClawService({ env: cliEnv, httpGet, wsFactory: noWs });

    // Establish `running` first (the fake's 1st call auto-resolves ok:true).
    expect((await service.getStatus()).state).toBe('running');
    expect(callCount()).toBe(1);

    // Two callers racing (e.g. the renderer's one-shot IPC getStatus landing
    // mid-poll-loop) must share ONE in-flight probe, not start two.
    const p1 = service.getStatus();
    const p2 = service.getStatus();
    // M2: isInstalled() is now itself async (a cached/positive result still
    // resolves via a microtask), so the shared probe's httpGet call lands one
    // tick later than the synchronous getStatus() calls above — flush lets it
    // fire before asserting the call count.
    await flush();
    expect(callCount()).toBe(2); // exactly one NEW httpGet call for both callers
    resolveFailure('timeout');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.state).toBe('running');
    expect(r2.state).toBe('running');

    // That shared failure must count as exactly ONE streak advance — 2 more
    // sequential failures are needed to flip to `stopped`, not 1.
    const p3 = service.getStatus();
    await flush(); // M2: same one-tick-later httpGet call as above
    resolveFailure('timeout');
    expect((await p3).state).toBe('running');
    expect(callCount()).toBe(3);

    const p4 = service.getStatus();
    await flush(); // M2: same one-tick-later httpGet call as above
    resolveFailure('timeout');
    expect((await p4).state).toBe('stopped');
    expect(callCount()).toBe(4);
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
    expect(result).toEqual({ ok: false, code: 'cli-failed', stderr: 'gateway already stopped' });
  });

  it('serializes overlapping calls — the second never starts until the first closes', async () => {
    const { spawn, calls, closeNth } = makeControllableSpawn();
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });

    const p1 = service.runLifecycle('start');
    await flush();
    const p2 = service.runLifecycle('stop');
    const r2 = await Promise.race([
      p2,
      new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 100)),
    ]);
    expect(r2).toEqual({ ok: false, code: 'busy', stderr: 'OpenClaw lifecycle operation is already running' });
    expect(calls).toHaveLength(1);

    closeNth(0, 0);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['gateway', 'start']]);
  });

  it('rejects a config mutation while lifecycle owns the global mutation gate, then recovers', async () => {
    const { spawn, calls, closeNth } = makeControllableSpawn();
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });

    const lifecycle = service.runLifecycle('start');
    await flush();
    const config = service.setCoreConfig('gateway.port', '19099');
    const configResult = await Promise.race([
      config,
      new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 25)),
    ]);

    for (let i = 0; i < calls.length; i += 1) closeNth(i, 0);
    await Promise.allSettled([lifecycle, config]);

    expect(configResult).toEqual({
      ok: false,
      restartRequired: false,
      code: 'busy',
      error: 'OpenClaw lifecycle operation is already running',
    });
    expect(calls).toHaveLength(1);

    const recovered = service.setCoreConfig('gateway.port', '19099');
    await flush();
    expect(calls).toHaveLength(2);
    closeNth(1, 0);
    await expect(recovered).resolves.toEqual({ ok: true, restartRequired: true });
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
    expect(result).toEqual({ ok: false, code: 'cli-failed', stderr: 'not installed' });
  });

  it('serializes on the SAME lane as runLifecycle — never races a concurrent start/stop/restart', async () => {
    const { spawn, calls, closeNth } = makeControllableSpawn();
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });

    const p1 = service.runLifecycle('start');
    await flush();
    const p2 = service.runAutostart('install');
    const r2 = await Promise.race([
      p2,
      new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 100)),
    ]);
    expect(r2).toEqual({ ok: false, code: 'busy', stderr: 'OpenClaw lifecycle operation is already running' });
    expect(calls).toHaveLength(1);

    closeNth(0, 0);
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['gateway', 'start']]);
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

  it('owns the global mutation gate against lifecycle and duplicate config calls, then releases it', async () => {
    const { spawn, calls, closeNth } = makeControllableSpawn();
    const service = new OpenClawService({ env: cliEnv, spawn, httpGet: async () => ({ ok: false }) });

    const configOwner = service.setCoreConfig('agents.defaults.model', 'openai/gpt-6');
    await flush();
    const lifecycleContender = service.runLifecycle('restart');
    const configContender = service.setCoreConfig('gateway.port', '19099');
    const [lifecycleResult, configResult] = await Promise.all([
      Promise.race([
        lifecycleContender,
        new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 25)),
      ]),
      Promise.race([
        configContender,
        new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 25)),
      ]),
    ]);

    for (let i = 0; i < calls.length; i += 1) closeNth(i, 0);
    await Promise.allSettled([configOwner, lifecycleContender, configContender]);

    expect(lifecycleResult).toEqual({
      ok: false,
      code: 'busy',
      stderr: 'OpenClaw lifecycle operation is already running',
    });
    expect(configResult).toEqual({
      ok: false,
      restartRequired: false,
      code: 'busy',
      error: 'OpenClaw lifecycle operation is already running',
    });
    expect(calls).toHaveLength(1);

    const recovered = service.runAutostart('install');
    await flush();
    expect(calls).toHaveLength(2);
    closeNth(1, 0);
    await expect(recovered).resolves.toEqual({ ok: true });
  });

  it('serializes model values as one strict JSON string argument', async () => {
    const { spawn, calls } = makeExitSpawn(0);
    const service = new OpenClawService({ env: cliEnv, spawn });

    await expect(service.setCoreConfig('agents.defaults.model', ' openai/gpt-6 ')).resolves.toEqual({
      ok: true,
      restartRequired: true,
    });
    expect(calls[0]?.args).toEqual([
      'config',
      'set',
      'agents.defaults.model',
      JSON.stringify('openai/gpt-6'),
      '--strict-json',
    ]);
  });

  it('rejects an invalid gateway port before spawning the CLI', async () => {
    const spawn = vi.fn<SpawnFn>();
    const service = new OpenClawService({ env: cliEnv, spawn });

    await expect(service.setCoreConfig('gateway.port', '65536')).resolves.toEqual({
      ok: false,
      restartRequired: false,
      code: 'invalid-value',
      error: 'gateway.port must be an integer between 1 and 65535',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('setCoreConfig surfaces stderr and restartRequired:false on CLI failure', async () => {
    const { spawn } = makeExitSpawn(1, '', 'invalid value');
    const service = new OpenClawService({ env: cliEnv, spawn });
    const result = await service.setCoreConfig('gateway.port', '19099');
    expect(result).toEqual({ ok: false, restartRequired: false, code: 'cli-failed', error: 'invalid value' });
  });

  it('bounds a stuck config command and terminates its process', async () => {
    let killed = false;
    const spawn: SpawnFn = () =>
      ({
        stdout: { on: () => undefined },
        stderr: { on: () => undefined },
        on: () => undefined,
      }) as unknown as ChildProcessLike;
    const service = new OpenClawService({
      env: cliEnv,
      spawn,
      cliTimeouts: { config: 5 },
      killProcess: () => {
        killed = true;
      },
    } as OpenClawServiceDeps);

    const result = await Promise.race([
      service.setCoreConfig('agents.defaults.model', 'openai/gpt-6'),
      new Promise<'did-not-settle'>((resolve) => setTimeout(() => resolve('did-not-settle'), 100)),
    ]);

    expect(result).toEqual({
      ok: false,
      restartRequired: false,
      code: 'timeout',
      error: 'OpenClaw config command timed out',
    });
    expect(killed).toBe(true);
  });
});

// ── getChatToken / getChatUrl — token secrecy ────────────────────────────

describe('OpenClawService — chat token', () => {
  const FAKE_TOKEN = 'abc123-fake-secret-token-value';

  it('discovers a configured non-default gateway port before the first status and chat calls', async () => {
    const httpGet = vi.fn(async (): Promise<HttpGetResult> => ({ ok: false, reason: 'refused' }));
    const spawn = vi.fn<SpawnFn>();
    const service = new OpenClawService({
      env: cliEnv,
      spawn,
      httpGet,
      readFile: async () => JSON.stringify({
        gateway: {
          port: 19099,
          auth: { token: FAKE_TOKEN },
        },
      }),
    });

    await expect(service.getStatus()).resolves.toEqual({ state: 'stopped', port: 19099 });
    expect(httpGet).toHaveBeenCalledWith('http://127.0.0.1:19099/');
    await expect(service.getChatUrl()).resolves.toBe(`http://127.0.0.1:19099/#token=${FAKE_TOKEN}`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('activates a staged gateway port only after a successful restart', async () => {
    const { spawn } = makeExitSpawn(0);
    const service = new OpenClawService({
      env: cliEnv,
      spawn,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: FAKE_TOKEN } } }),
      httpGet: async () => ({ ok: false, reason: 'refused' }),
    });
    const changed: number[] = [];
    const dynamic = service as OpenClawService & {
      getEndpoint(): { port: number; origin: string; generation: number };
      onEndpointChanged(listener: (endpoint: { port: number }) => void): () => void;
    };
    const unsubscribe = dynamic.onEndpointChanged((endpoint) => changed.push(endpoint.port));

    expect(dynamic.getEndpoint().port).toBe(18789);
    await expect(service.setCoreConfig('gateway.port', '19099')).resolves.toMatchObject({ ok: true });
    expect(dynamic.getEndpoint().port).toBe(18789);

    await expect(service.runLifecycle('restart')).resolves.toEqual({ ok: true });
    expect(dynamic.getEndpoint()).toMatchObject({ port: 19099, origin: 'http://127.0.0.1:19099', generation: 1 });
    expect(changed).toEqual([19099]);
    expect(await service.getChatUrl()).toBe(`http://127.0.0.1:19099/#token=${FAKE_TOKEN}`);

    unsubscribe();
  });

  it('isolates endpoint observers so one throw cannot reject restart or skip later observers', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { spawn } = makeExitSpawn(0);
      const service = new OpenClawService({
        env: cliEnv,
        spawn,
        readFile: async () => JSON.stringify({ gateway: { auth: { token: FAKE_TOKEN } } }),
        httpGet: async () => ({ ok: false, reason: 'refused' }),
      });
      const healthyObserver = vi.fn();
      service.onEndpointChanged(() => {
        throw new Error('observer failed');
      });
      service.onEndpointChanged(healthyObserver);

      await expect(service.setCoreConfig('gateway.port', '19099')).resolves.toMatchObject({ ok: true });
      await expect(service.runLifecycle('restart')).resolves.toEqual({ ok: true });

      expect(healthyObserver).toHaveBeenCalledOnce();
      expect(healthyObserver).toHaveBeenCalledWith(expect.objectContaining({ port: 19099 }));
      expect(consoleError).toHaveBeenCalledWith(
        '[OpenClawService] endpoint listener failed:',
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

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

  it('diagnoses insecure Control UI auth without mutating config', async () => {
    const spawn = vi.fn<SpawnFn>();
    const service = new OpenClawService({
      env: cliEnv,
      spawn,
      readFile: async () =>
        JSON.stringify({
          gateway: { auth: { token: FAKE_TOKEN }, controlUi: { allowInsecureAuth: false } },
        }),
    });
    const diagnostic = service as OpenClawService & { getInsecureAuthStatus(): Promise<string> };

    await expect(diagnostic.getInsecureAuthStatus()).resolves.toBe('disabled');
    expect(spawn).not.toHaveBeenCalled();
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

describe('OpenClawService status observer isolation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not let a throwing observer reject an otherwise successful lifecycle action', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { spawn } = makeExitSpawn(0);
    const service = new OpenClawService({
      env: cliEnv,
      spawn,
      readFile: async () => '{}',
      httpGet: async () => ({ ok: false, reason: 'refused' }),
      wsFactory: () => {
        throw new Error('no socket');
      },
    });
    const throwingObserver = vi.fn(() => {
      throw new Error('observer failed');
    });
    const healthyObserver = vi.fn();
    service.subscribeStatus(throwingObserver);
    service.subscribeStatus(healthyObserver);

    await expect(service.runLifecycle('start')).resolves.toEqual({ ok: true });
    expect(throwingObserver).toHaveBeenCalledTimes(1);
    expect(healthyObserver).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('continues notifying later observers and scheduling polls after one observer throws', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new OpenClawService({
      env: cliEnv,
      readFile: async () => '{}',
      httpGet: async () => ({ ok: false, reason: 'refused' }),
      wsFactory: () => {
        throw new Error('no socket');
      },
    });
    const throwingObserver = vi.fn(() => {
      throw new Error('observer failed');
    });
    const healthyObserver = vi.fn();
    service.subscribeStatus(throwingObserver);
    service.subscribeStatus(healthyObserver);

    await vi.advanceTimersByTimeAsync(0);
    expect(healthyObserver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(healthyObserver).toHaveBeenCalledTimes(2);
    service.dispose();
  });
});

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
    const { wsFactory: realWsFactory, sockets } = makeWsFactory();
    // M5 (S2): logTick now gates on `wasRunning` — seed it via a real status
    // probe first, using a wsFactory that fails FAST on that probe's own
    // (throwaway) enrichment connection so it never touches `sockets`, then
    // falls through to the real tracked factory for subscribeLogs below —
    // every `sockets[N]` index the rest of this test asserts on is
    // unaffected.
    let seeded = false;
    const wsFactory: OpenClawWsFactory = () => {
      if (!seeded) {
        seeded = true;
        throw new Error('seed status probe — no real socket needed');
      }
      return realWsFactory();
    };
    const service = new OpenClawService({
      env: cliEnv,
      httpGet: async () => ({ ok: true }),
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });
    expect((await service.getStatus()).state).toBe('running');

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

// ── subscribeLogs gated on running (M5) ──────────────────────────────────

describe('OpenClawService — log poll gated on running (M5)', () => {
  it('while the gateway has never been observed running, a log tick does not call logs.tail (even once the shared connection itself is up)', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({
      env: cliEnv,
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });

    service.subscribeLogs(() => undefined);
    await flush(); // the first tick (scheduled at delay 0) runs — wasRunning is still false
    await completeHandshake(sockets[0]);
    await flush();

    expect(sockets[0].sent.some((m) => m.method === 'logs.tail')).toBe(false);
  });

  it('once the gateway is known-running (a prior successful probe), a subsequent log tick DOES call logs.tail', async () => {
    const { wsFactory, sockets } = makeWsFactory();
    const service = new OpenClawService({
      env: cliEnv,
      httpGet: async () => ({ ok: true }),
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });

    // Establish `wasRunning` via an ordinary status probe BEFORE subscribing
    // to logs — that's the debounce flag logTick now gates on. No subscriber
    // exists yet, so this probe's own WS enrichment call is a THROWAWAY
    // connection (closed once it resolves) — a separate socket from the one
    // `subscribeLogs` opens below.
    const statusPromise = service.getStatus();
    await flush();
    await completeHandshake(sockets[0]);
    const statusReq = sockets[0].sent.find((m) => m.method === 'status');
    sockets[0].serverSend({ type: 'res', id: statusReq!.id, ok: true, payload: {} });
    expect((await statusPromise).state).toBe('running');

    service.subscribeLogs(() => undefined);
    await flush();
    await completeHandshake(sockets[1]);
    await flush();

    expect(sockets[1].sent.some((m) => m.method === 'logs.tail')).toBe(true);
  });
});

// ── dispose ──────────────────────────────────────────────────────────────

describe('OpenClawService — gateway-down soak', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds reconnects and keeps listener/timer counts flat over 60 simulated seconds', async () => {
    vi.useFakeTimers();
    const sockets: FakeOpenClawWs[] = [];
    const wsFactory = vi.fn(() => {
      const socket = new FakeOpenClawWs();
      sockets.push(socket);
      // The injected gateway accepts a socket and immediately drops it before
      // the challenge. This exercises the real persistent reconnect/backoff
      // path without relying on a live gateway or private service state.
      queueMicrotask(() => socket.close());
      return socket;
    });
    const httpGet = vi.fn(async (): Promise<HttpGetResult> => ({ ok: false, reason: 'refused' }));
    const statusListener = vi.fn();
    const logListener = vi.fn();
    const service = new OpenClawService({
      env: cliEnv,
      httpGet,
      wsFactory,
      readFile: async () => JSON.stringify({ gateway: { auth: { token: 'tok' } } }),
    });

    service.subscribeStatus(statusListener);
    service.subscribeLogs(logListener);

    let maxPendingTimers = 0;
    for (let elapsedMs = 0; elapsedMs <= 60_000; elapsedMs += 1000) {
      await vi.advanceTimersByTimeAsync(elapsedMs === 0 ? 0 : 1000);
      maxPendingTimers = Math.max(maxPendingTimers, vi.getTimerCount());
    }

    // Backoff attempts occur at 0, .5, 1.5, 3.5, 7.5, then at the capped
    // five-second cadence. A two-second log-poll reconnect storm would exceed
    // this ceiling well before the simulated minute ends.
    expect(wsFactory.mock.calls.length).toBeGreaterThan(1);
    expect(wsFactory.mock.calls.length).toBeLessThanOrEqual(15);
    expect(httpGet).toHaveBeenCalledTimes(16); // immediate status + 15 polls
    expect(statusListener).toHaveBeenCalledTimes(16);
    expect(logListener).toHaveBeenCalledTimes(1); // initial "Connecting" line only

    // Each replacement socket gets one fixed handler set; reconnects never
    // append duplicate handlers to a surviving socket.
    for (const socket of sockets) {
      expect(socket.listenerCount('message')).toBe(1);
      expect(socket.listenerCount('close')).toBe(1);
      expect(socket.listenerCount('error')).toBe(1);
    }
    expect(maxPendingTimers).toBeLessThanOrEqual(3); // status, log, reconnect
    expect(vi.getTimerCount()).toBe(3);

    const attemptsAtDispose = wsFactory.mock.calls.length;
    const statusPushesAtDispose = statusListener.mock.calls.length;
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(wsFactory).toHaveBeenCalledTimes(attemptsAtDispose);
    expect(statusListener).toHaveBeenCalledTimes(statusPushesAtDispose);
    expect(vi.getTimerCount()).toBe(0);
  });
});

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
