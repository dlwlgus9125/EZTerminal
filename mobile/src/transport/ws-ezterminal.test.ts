import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WsEzTerminalTransport, type CreateSocket, type WsLike } from './ws-ezterminal';
import { BlockController } from '../../../src/renderer/block-controller';
import type { SystemStatsSnapshot } from '../../../src/shared/ipc';
import { uint8ArrayToBase64, type RemotePacketFrame } from '../../../src/shared/remote-protocol';

// ── Fake socket ──────────────────────────────────────────────────────────────

type Handler = (...args: never[]) => void;

class FakeSocket implements WsLike {
  readonly sent: string[] = [];
  closed = false;
  private readonly handlers: Record<'open' | 'message' | 'close' | 'error', Handler[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void {
    this.handlers[type].push(listener as Handler);
  }

  triggerOpen(): void {
    for (const h of this.handlers.open) h();
  }

  triggerMessage(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const h of this.handlers.message) h({ data } as never);
  }

  triggerClose(): void {
    for (const h of this.handlers.close) h();
  }

  lastSent(): unknown {
    return JSON.parse(this.sent.at(-1)!);
  }
}

function makeCreateSocket(): { createSocket: CreateSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const createSocket: CreateSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { createSocket, sockets };
}

/** Captures the `_ezPort` window message TerminalPane.tsx listens for, mirroring
 * its exact contract (source===window, data._ezPort===runId, ports[0]). */
function captureEzPort(runId: string): { readonly port: MessagePort | undefined; stop: () => void } {
  let port: MessagePort | undefined;
  const onMessage = (ev: MessageEvent): void => {
    if (!ev.data || (ev.data as { _ezPort?: string })._ezPort !== runId) return;
    expect(ev.source).toBe(window);
    port = ev.ports[0];
  };
  window.addEventListener('message', onMessage);
  return {
    get port() {
      return port;
    },
    stop: () => window.removeEventListener('message', onMessage),
  };
}

/** Captures the `_ezPacketPort` window message `subscribePackets()` dispatches
 * (module doc's "same mechanics as runCommand's `_ezPort` handoff"). */
function captureEzPacketPort(): { readonly port: MessagePort | undefined; stop: () => void } {
  let port: MessagePort | undefined;
  const onMessage = (ev: MessageEvent): void => {
    if (!ev.data || (ev.data as { _ezPacketPort?: boolean })._ezPacketPort !== true) return;
    expect(ev.source).toBe(window);
    port = ev.ports[0];
  };
  window.addEventListener('message', onMessage);
  return {
    get port() {
      return port;
    },
    stop: () => window.removeEventListener('message', onMessage),
  };
}

describe('WsEzTerminalTransport — auth handshake', () => {
  it('sends an auth envelope with the configured token once the socket opens', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok-123', createSocket });
    sockets[0].triggerOpen();
    expect(sockets[0].lastSent()).toEqual({ kind: 'auth', token: 'tok-123' });
  });

  it('isAuthed flips true on auth-ok and false on auth-fail', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    expect(transport.isAuthed).toBe(false);
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    expect(transport.isAuthed).toBe(true);
    sockets[0].triggerMessage({ kind: 'auth-fail' });
    expect(transport.isAuthed).toBe(false);
  });

  it('onAuthChange replays the current state immediately, then fires on every transition', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const seen: boolean[] = [];
    const unsub = transport.onAuthChange((authed) => seen.push(authed));
    expect(seen).toEqual([false]); // immediate replay of current state

    sockets[0].triggerMessage({ kind: 'auth-ok' });
    sockets[0].triggerMessage({ kind: 'auth-ok' }); // repeat — must NOT re-fire (no transition)
    sockets[0].triggerMessage({ kind: 'auth-fail' });
    expect(seen).toEqual([false, true, false]);

    unsub();
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    expect(seen).toEqual([false, true, false]); // no further calls after unsubscribe
  });
});

describe('WsEzTerminalTransport — createSession / destroySession / listSessions', () => {
  it('createSession() sends create-session and resolves on the matching session-created reply', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      newId: () => 'req-1',
    });

    const promise = transport.createSession('/tmp');
    expect(sockets[0].lastSent()).toEqual({ kind: 'create-session', requestId: 'req-1', cwd: '/tmp' });

    sockets[0].triggerMessage({
      kind: 'session-created',
      requestId: 'req-1',
      session: { sessionId: 'sess-1', cwd: '/tmp' },
    });

    await expect(promise).resolves.toEqual({ sessionId: 'sess-1', cwd: '/tmp' });
  });

  it('destroySession() sends a destroy-session envelope', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    transport.destroySession('sess-1');
    expect(sockets[0].lastSent()).toEqual({ kind: 'destroy-session', sessionId: 'sess-1' });
  });

  it('listSessions() resolves concurrent calls FIFO against unrelated session-list replies', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const first = transport.listSessions();
    const second = transport.listSessions();
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'list-sessions')).toHaveLength(2);

    sockets[0].triggerMessage({ kind: 'session-list', sessions: [{ sessionId: 'a', cwd: '/a' }] });
    sockets[0].triggerMessage({ kind: 'session-list', sessions: [{ sessionId: 'b', cwd: '/b' }] });

    await expect(first).resolves.toEqual([{ sessionId: 'a', cwd: '/a' }]);
    await expect(second).resolves.toEqual([{ sessionId: 'b', cwd: '/b' }]);
  });
});

describe('WsEzTerminalTransport — runCommand: _ezPort handoff + frame delivery to a REAL BlockController', () => {
  it('delivers InterpreterFrames from the WS to a real BlockController via the reproduced _ezPort message', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzPort('run-1');
    await transport.runCommand('ls', 'run-1', 'sess-1');
    capture.stop();

    expect(sockets[0].lastSent()).toEqual({
      kind: 'run-command',
      runId: 'run-1',
      sessionId: 'sess-1',
      commandText: 'ls',
    });
    expect(capture.port).toBeDefined();

    const controller = new BlockController('ls', capture.port!);

    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'schema', columns: [{ name: 'a', type: 'string' }], shape: 'table' },
    });
    expect(controller.getSnapshot().shape).toBe('table');

    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'chunk', start: 0, rows: [{ a: 'x' }] },
    });
    expect(controller.getRow(0)).toEqual({ a: 'x' });

    sockets[0].triggerMessage({ kind: 'frame', runId: 'run-1', frame: { type: 'end', cwd: '/tmp' } });
    expect(controller.getSnapshot().status).toBe('done');
  });

  it('decodes a base64 pty-data frame back to a Uint8Array before delivery', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzPort('run-pty');
    await transport.runCommand('!bash', 'run-pty', 'sess-1');
    capture.stop();

    const controller = new BlockController('!bash', capture.port!);
    const payload = new Uint8Array([104, 105]); // "hi"
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-pty',
      frame: { type: 'pty-data', data: uint8ArrayToBase64(payload) },
    });

    expect(controller.getPtyFlow().received).toBe(2);
  });

  it('relays a control posted to the fake port as {kind:control, runId, control}', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzPort('run-1');
    await transport.runCommand('ls', 'run-1', 'sess-1');
    capture.stop();

    capture.port!.postMessage({ type: 'cancel' });

    expect(sockets[0].lastSent()).toEqual({ kind: 'control', runId: 'run-1', control: { type: 'cancel' } });
  });

  it('demuxes two concurrent runs — frames never cross runIds', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const captureA = captureEzPort('run-a');
    await transport.runCommand('ls', 'run-a', 'sess-1');
    captureA.stop();
    const captureB = captureEzPort('run-b');
    await transport.runCommand('pwd', 'run-b', 'sess-1');
    captureB.stop();

    const controllerA = new BlockController('ls', captureA.port!);
    const controllerB = new BlockController('pwd', captureB.port!);

    sockets[0].triggerMessage({ kind: 'frame', runId: 'run-a', frame: { type: 'start', commandText: 'ls', cwd: '/a' } });
    sockets[0].triggerMessage({ kind: 'frame', runId: 'run-b', frame: { type: 'start', commandText: 'pwd', cwd: '/b' } });

    expect(controllerA.getSnapshot().startCwd).toBe('/a');
    expect(controllerB.getSnapshot().startCwd).toBe('/b');

    controllerA.cancel();
    expect(sockets[0].lastSent()).toEqual({ kind: 'control', runId: 'run-a', control: { type: 'cancel' } });
  });
});

describe('WsEzTerminalTransport — disconnect / reconnect with backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reconnects after the initial backoff and re-authenticates', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    expect(sockets).toHaveLength(1); // not yet — backoff hasn't elapsed

    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerOpen();
    expect(sockets[1].lastSent()).toEqual({ kind: 'auth', token: 'tok' });
    sockets[1].triggerMessage({ kind: 'auth-ok' });
  });

  it('doubles the backoff on each successive disconnect, capped at maxBackoffMs', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 300,
    });

    sockets[0].triggerClose(); // 1st disconnect: reconnect scheduled at 100ms
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerClose(); // 2nd disconnect: backoff doubled to 200ms
    vi.advanceTimersByTime(199);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2].triggerClose(); // 3rd disconnect: would double to 400ms, capped at 300ms
    vi.advanceTimersByTime(300);
    expect(sockets).toHaveLength(4);
  });

  it('a fully successful reconnect (auth-ok) resets the backoff back to the initial value', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100); // backoff now 200ms for the NEXT disconnect
    sockets[1].triggerMessage({ kind: 'auth-ok' }); // resets backoff to 100ms

    sockets[1].triggerClose();
    vi.advanceTimersByTime(99);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('after a successful reconnect, createSession works again on the NEW socket', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerOpen();
    sockets[1].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.createSession();
    expect(sockets[1].lastSent()).toEqual({ kind: 'create-session', requestId: 'req-1', cwd: undefined });
    sockets[1].triggerMessage({
      kind: 'session-created',
      requestId: 'req-1',
      session: { sessionId: 'new-sess', cwd: '/' },
    });
    await expect(promise).resolves.toEqual({ sessionId: 'new-sess', cwd: '/' });
  });

  it('disconnect() stops further reconnect attempts', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
    });
    transport.disconnect();
    expect(sockets[0].closed).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // no reconnect scheduled after an explicit stop
  });

  it('delivers an error frame to open ports when the connection drops', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzPort('run-1');
    await transport.runCommand('ls', 'run-1', 'sess-1');
    capture.stop();

    const received: unknown[] = [];
    capture.port!.addEventListener('message', (e) => received.push((e as MessageEvent).data));

    sockets[0].triggerClose();

    expect(received).toContainEqual({ type: 'error', message: expect.any(String) });
  });
});

describe('WsEzTerminalTransport — auth watchdog (self-heals a stuck attempt)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons and retries a socket that never opens (auth never reached)', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000); // watchdog fires: abandons socket 0, schedules reconnect
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(100); // backoff elapses
    expect(sockets).toHaveLength(2); // a fresh attempt, self-healed
  });

  it('abandons and retries a HALF-OPEN socket (opened + auth sent, but no auth-ok and no close)', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    sockets[0].triggerOpen();
    expect(sockets[0].lastSent()).toEqual({ kind: 'auth', token: 'tok' });
    // No auth-ok, no close — the exact stall that used to hang "Connecting…" forever.
    vi.advanceTimersByTime(1000 + 100);
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1].triggerOpen();
    expect(sockets[1].lastSent()).toEqual({ kind: 'auth', token: 'tok' });
    sockets[1].triggerMessage({ kind: 'auth-ok' }); // the retry authenticates cleanly
  });

  it('auth-ok clears the watchdog — no spurious reconnect', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    sockets[0].triggerOpen();
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    vi.advanceTimersByTime(10_000); // long past the watchdog — must NOT fire on a live connection
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(false);
  });

  it('a watchdog abandon followed by a LATE real close does not double-schedule a reconnect', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    vi.advanceTimersByTime(1000); // watchdog abandons socket 0
    sockets[0].triggerClose(); // its real 'close' arrives late — must be a no-op (idempotent)
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2); // exactly ONE reconnect, not two
  });

  it('disconnect() also clears the watchdog', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      authTimeoutMs: 1000,
      initialBackoffMs: 100,
    });
    transport.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // no watchdog-driven reconnect after an explicit stop
  });
});

describe('WsEzTerminalTransport — onSessionDead', () => {
  it('fires registered listeners on a session-dead message, and unsubscribe works', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const calls: Array<{ logPath?: string | null } | undefined> = [];
    const unsub = transport.onSessionDead((info) => calls.push(info));

    sockets[0].triggerMessage({ kind: 'session-dead', logPath: '/logs/main.log' });
    expect(calls).toEqual([{ logPath: '/logs/main.log' }]);

    unsub();
    sockets[0].triggerMessage({ kind: 'session-dead', logPath: '/logs/main.log' });
    expect(calls).toHaveLength(1); // no further calls after unsubscribe
  });
});

describe('WsEzTerminalTransport — desktop-only EzTerminalApi stubs', () => {
  it('getRemoteToken() resolves with the token this transport actually connected with', async () => {
    const { createSocket } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'my-token', createSocket });
    await expect(transport.getRemoteToken()).resolves.toBe('my-token');
  });
});

// ── Stats (M2) ───────────────────────────────────────────────────────────────

function makeSnapshot(at: number): SystemStatsSnapshot {
  return {
    at,
    cpu: { loadPct: 10, cores: [10, 20] },
    mem: { usedBytes: 100, totalBytes: 200 },
    memDetail: null,
    net: null,
    disks: null,
    procs: null,
    conns: null,
  };
}

describe('WsEzTerminalTransport — stats', () => {
  it('setStatsPanelVisible(true) sends a stats-visible envelope once authed; repeats do not crash', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    transport.setStatsPanelVisible(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'stats-visible', visible: true });

    transport.setStatsPanelVisible(true);
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'stats-visible')).toHaveLength(2);
  });

  it('does not send stats-visible before auth-ok — only records the desired state for later replay', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    transport.setStatsPanelVisible(true);
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'stats-visible')).toHaveLength(0);
  });

  it('fans out stats-update to multiple listeners; unsubscribe stops delivery', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const seenA: SystemStatsSnapshot[] = [];
    const seenB: SystemStatsSnapshot[] = [];
    const unsubA = transport.onStatsUpdate((s) => seenA.push(s));
    const unsubB = transport.onStatsUpdate((s) => seenB.push(s));

    const snap1 = makeSnapshot(1);
    sockets[0].triggerMessage({ kind: 'stats-update', snapshot: snap1 });
    expect(seenA).toEqual([snap1]);
    expect(seenB).toEqual([snap1]);

    unsubA();
    const snap2 = makeSnapshot(2);
    sockets[0].triggerMessage({ kind: 'stats-update', snapshot: snap2 });
    expect(seenA).toEqual([snap1]); // unsubscribed — no further delivery
    expect(seenB).toEqual([snap1, snap2]);

    unsubB();
  });

  it('getStatsHistory() resolves concurrent calls FIFO against unrelated stats-history replies', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const first = transport.getStatsHistory();
    const second = transport.getStatsHistory();
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'stats-history')).toHaveLength(2);

    const snapA = makeSnapshot(1);
    const snapB = makeSnapshot(2);
    sockets[0].triggerMessage({ kind: 'stats-history', snapshots: [snapA] });
    sockets[0].triggerMessage({ kind: 'stats-history', snapshots: [snapB] });

    await expect(first).resolves.toEqual([snapA]);
    await expect(second).resolves.toEqual([snapB]);
  });
});

describe('WsEzTerminalTransport — stats reconnect replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays stats-visible:true on the reconnect auth-ok when stats were enabled beforehand', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });
    transport.setStatsPanelVisible(true);
    expect(sockets[0].lastSent()).toEqual({ kind: 'stats-visible', visible: true });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].lastSent()).toEqual({ kind: 'stats-visible', visible: true });
  });

  it('does not replay stats-visible on reconnect if it was never enabled', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].sent.filter((s) => JSON.parse(s).kind === 'stats-visible')).toHaveLength(0);
  });
});

// ── Packets (M3) ─────────────────────────────────────────────────────────────

describe('WsEzTerminalTransport — packets', () => {
  it('subscribePackets() sends packets-subscribe once authed and dispatches the _ezPacketPort handoff', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    expect(sockets[0].lastSent()).toEqual({ kind: 'packets-subscribe' });
    expect(capture.port).toBeDefined();
  });

  it('does not send packets-subscribe before auth — only records the desired state for later replay', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    transport.subscribePackets();

    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'packets-subscribe')).toHaveLength(0);
  });

  it('delivers packet-frame batch and status frames to the handed-off port', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    const received: RemotePacketFrame[] = [];
    capture.port!.addEventListener('message', (e) => received.push((e as MessageEvent).data));

    sockets[0].triggerMessage({ kind: 'packet-frame', frame: { type: 'status', status: 'capturing' } });
    sockets[0].triggerMessage({
      kind: 'packet-frame',
      frame: { type: 'packets', rows: [{ at: 1, src: '1.1.1.1', dst: '2.2.2.2', proto: 'TCP', len: 60 }] },
    });

    expect(received).toEqual([
      { type: 'status', status: 'capturing' },
      { type: 'packets', rows: [{ at: 1, src: '1.1.1.1', dst: '2.2.2.2', proto: 'TCP', len: 60 }] },
    ]);
  });

  it('delivers an idle status frame the same way as any other status', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    const received: RemotePacketFrame[] = [];
    capture.port!.addEventListener('message', (e) => received.push((e as MessageEvent).data));

    sockets[0].triggerMessage({ kind: 'packet-frame', frame: { type: 'status', status: 'idle' } });

    expect(received).toEqual([{ type: 'status', status: 'idle' }]);
  });

  it('unsubscribePackets() sends packets-unsubscribe and closes the port', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const capture = captureEzPacketPort();
    transport.subscribePackets();
    capture.stop();

    transport.unsubscribePackets();

    expect(sockets[0].lastSent()).toEqual({ kind: 'packets-unsubscribe' });
    expect((capture.port as unknown as { isDisposed: boolean }).isDisposed).toBe(true);
  });
});

describe('WsEzTerminalTransport — packets reconnect replay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays packets-subscribe on the reconnect auth-ok WITHOUT a second _ezPacketPort handoff', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    let handoffs = 0;
    const onHandoff = (ev: MessageEvent): void => {
      if (ev.data && (ev.data as { _ezPacketPort?: boolean })._ezPacketPort === true) handoffs++;
    };
    window.addEventListener('message', onHandoff);

    transport.subscribePackets();
    expect(sockets[0].lastSent()).toEqual({ kind: 'packets-subscribe' });
    expect(handoffs).toBe(1);

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].lastSent()).toEqual({ kind: 'packets-subscribe' });
    expect(handoffs).toBe(1); // same FakeMessagePort reused — no second handoff

    window.removeEventListener('message', onHandoff);
  });

  it('does not replay packets-subscribe on reconnect if it was never enabled', () => {
    const { createSocket, sockets } = makeCreateSocket();
    new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    sockets[0].triggerClose();
    vi.advanceTimersByTime(100);
    sockets[1].triggerMessage({ kind: 'auth-ok' });
    expect(sockets[1].sent.filter((s) => JSON.parse(s).kind === 'packets-subscribe')).toHaveLength(0);
  });
});
