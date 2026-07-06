import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WsEzTerminalTransport, type CreateSocket, type WsLike } from './ws-ezterminal';
import { BlockController } from '../../../src/renderer/block-controller';
import type { RunStartedInfo, SessionInfo, SystemStatsSnapshot } from '../../../src/shared/ipc';
import { FILE_CHUNK_BYTES } from '../../../src/shared/files';
import { base64ToUint8Array, uint8ArrayToBase64, type RemotePacketFrame } from '../../../src/shared/remote-protocol';

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

/** Captures the `_ezAttachPort` window message TerminalPane.tsx/MobileSessionView.tsx
 * listen for when mirroring a run (M2) — same contract as `captureEzPort` above,
 * keyed by `_ezAttachPort` instead of `_ezPort`. */
function captureEzAttachPort(runId: string): { readonly port: MessagePort | undefined; stop: () => void } {
  let port: MessagePort | undefined;
  const onMessage = (ev: MessageEvent): void => {
    if (!ev.data || (ev.data as { _ezAttachPort?: string })._ezAttachPort !== runId) return;
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

describe('WsEzTerminalTransport — listRuns (M1 mirror-active-runs)', () => {
  it('listRuns() resolves concurrent calls FIFO against unrelated run-list replies', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const first = transport.listRuns();
    const second = transport.listRuns();
    expect(sockets[0].sent.filter((s) => JSON.parse(s).kind === 'list-runs')).toHaveLength(2);

    const runA: RunStartedInfo = { sessionId: 'a', runId: 'run-a', commandText: 'echo a' };
    const runB: RunStartedInfo = { sessionId: 'b', runId: 'run-b', commandText: 'echo b' };
    sockets[0].triggerMessage({ kind: 'run-list', runs: [runA] });
    sockets[0].triggerMessage({ kind: 'run-list', runs: [runB] });

    await expect(first).resolves.toEqual([runA]);
    await expect(second).resolves.toEqual([runB]);
  });

  it('a socket close resolves every in-flight listRuns() call with [] instead of leaving it pending forever', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const promise = transport.listRuns();
    sockets[0].triggerClose();

    await expect(promise).resolves.toEqual([]);
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

describe('WsEzTerminalTransport — session mirroring (M2)', () => {
  it('onSessionAdded/onSessionRemoved fire on the matching broadcast; unsubscribe stops delivery', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const added: SessionInfo[] = [];
    const removed: string[] = [];
    const unsubAdded = transport.onSessionAdded((s) => added.push(s));
    const unsubRemoved = transport.onSessionRemoved((id) => removed.push(id));

    sockets[0].triggerMessage({ kind: 'session-added', session: { sessionId: 'a', cwd: '/a' } });
    sockets[0].triggerMessage({ kind: 'session-removed', sessionId: 'a' });
    expect(added).toEqual([{ sessionId: 'a', cwd: '/a' }]);
    expect(removed).toEqual(['a']);

    unsubAdded();
    unsubRemoved();
    sockets[0].triggerMessage({ kind: 'session-added', session: { sessionId: 'b', cwd: '/b' } });
    sockets[0].triggerMessage({ kind: 'session-removed', sessionId: 'b' });
    expect(added).toHaveLength(1); // no further calls after unsubscribe
    expect(removed).toHaveLength(1);
  });

  it('onRunStarted fires with sessionId/runId/commandText on a run-started broadcast', () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const seen: RunStartedInfo[] = [];
    transport.onRunStarted((info) => seen.push(info));

    sockets[0].triggerMessage({
      kind: 'run-started',
      sessionId: 'sess-1',
      runId: 'run-9',
      commandText: 'ls',
    });

    expect(seen).toEqual([{ sessionId: 'sess-1', runId: 'run-9', commandText: 'ls' }]);
  });

  it('attachRun() sends attach-run and dispatches the _ezAttachPort handoff, delivering frames for that runId to a real BlockController', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzAttachPort('run-9');
    await transport.attachRun('sess-1', 'run-9');
    capture.stop();

    expect(sockets[0].lastSent()).toEqual({ kind: 'attach-run', sessionId: 'sess-1', runId: 'run-9' });
    expect(capture.port).toBeDefined();

    const controller = new BlockController('mirrored', capture.port!);
    sockets[0].triggerMessage({
      kind: 'frame',
      runId: 'run-9',
      frame: { type: 'start', commandText: 'ls', cwd: '/a' },
    });
    expect(controller.getSnapshot().startCwd).toBe('/a');
  });

  it('relays a control posted to an attached port as {kind:control, runId, control}', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });

    const capture = captureEzAttachPort('run-9');
    await transport.attachRun('sess-1', 'run-9');
    capture.stop();

    capture.port!.postMessage({ type: 'pty-input', data: 'hi' });

    expect(sockets[0].lastSent()).toEqual({
      kind: 'control',
      runId: 'run-9',
      control: { type: 'pty-input', data: 'hi' },
    });
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

describe('WsEzTerminalTransport — file explorer (M4)', () => {
  it('listFiles sends file-list and resolves with the reply result, correlated by requestId', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.listFiles('C:\\x');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-list', requestId: 'req-1', path: 'C:\\x' });

    const result = { ok: true, path: 'C:\\x', parent: null, entries: [] };
    sockets[0].triggerMessage({ kind: 'file-list-reply', requestId: 'req-1', result });
    await expect(promise).resolves.toEqual(result);
  });

  it('listFileRoots sends file-roots and resolves with a mutable copy of the roots array', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.listFileRoots();
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-roots', requestId: 'req-1' });

    sockets[0].triggerMessage({ kind: 'file-roots-reply', requestId: 'req-1', roots: ['C:\\', 'D:\\'] });
    await expect(promise).resolves.toEqual(['C:\\', 'D:\\']);
  });

  it('createFolder sends file-mkdir and resolves with the file-op-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.createFolder('C:\\x', 'new');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-mkdir', requestId: 'req-1', dirPath: 'C:\\x', name: 'new' });

    sockets[0].triggerMessage({ kind: 'file-op-reply', requestId: 'req-1', result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('renameFile sends file-rename and resolves with the file-op-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.renameFile('C:\\x\\a.txt', 'b.txt');
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-rename',
      requestId: 'req-1',
      path: 'C:\\x\\a.txt',
      newName: 'b.txt',
    });

    sockets[0].triggerMessage({ kind: 'file-op-reply', requestId: 'req-1', result: { ok: false, error: 'boom' } });
    await expect(promise).resolves.toEqual({ ok: false, error: 'boom' });
  });

  it('trashFile sends file-trash and resolves with the file-op-reply result', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.trashFile('C:\\x\\a.txt');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-trash', requestId: 'req-1', path: 'C:\\x\\a.txt' });

    sockets[0].triggerMessage({ kind: 'file-op-reply', requestId: 'req-1', result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('readTextFile streams meta + ack-gated chunks, reassembling exact bytes with correct ack offsets', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readTextFile('C:\\a.txt');
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-read', requestId: 'req-1', path: 'C:\\a.txt', mode: 'text' });

    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 5,
      sendBytes: 5,
      isText: true,
      truncated: false,
    });

    const chunk1 = uint8ArrayToBase64(new Uint8Array([104, 101, 108])); // 'hel'
    sockets[0].triggerMessage({ kind: 'file-read-chunk', requestId: 'req-1', offset: 0, data: chunk1, done: false });
    // The ack for chunk 1 must be sent before chunk 2 ever arrives (ack-gated streaming).
    expect(sockets[0].lastSent()).toEqual({ kind: 'file-read-ack', requestId: 'req-1', offset: 3 });

    const chunk2 = uint8ArrayToBase64(new Uint8Array([108, 111])); // 'lo'
    sockets[0].triggerMessage({ kind: 'file-read-chunk', requestId: 'req-1', offset: 3, data: chunk2, done: true });

    await expect(promise).resolves.toEqual({
      ok: true,
      isText: true,
      content: 'hello',
      truncated: false,
      fileSize: 5,
    });
  });

  it('readTextFile resolves isText:false without ever sending an ack (no chunk follows a binary meta)', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readTextFile('C:\\a.bin');
    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 10,
      sendBytes: 0,
      isText: false,
      truncated: false,
    });

    await expect(promise).resolves.toEqual({ ok: true, isText: false, fileSize: 10 });
    expect(sockets[0].sent.some((s) => (JSON.parse(s) as { kind: string }).kind === 'file-read-ack')).toBe(false);
  });

  it('readTextFile resolves ok:false when file-read-meta reports a failure', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.readTextFile('C:\\missing.txt');
    sockets[0].triggerMessage({ kind: 'file-read-meta', requestId: 'req-1', ok: false, error: 'ENOENT' });

    await expect(promise).resolves.toEqual({ ok: false, error: 'ENOENT' });
  });

  it('downloadFile (raw mode) reports progress after each chunk and resolves with the reassembled bytes', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const progress: Array<[number, number]> = [];
    const promise = transport.downloadFile('C:\\x\\photo.png', (received, total) =>
      progress.push([received, total]),
    );
    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-read',
      requestId: 'req-1',
      path: 'C:\\x\\photo.png',
      mode: 'raw',
    });

    sockets[0].triggerMessage({
      kind: 'file-read-meta',
      requestId: 'req-1',
      ok: true,
      fileSize: 5,
      sendBytes: 5,
      isText: true,
      truncated: false,
    });

    const chunk1 = new Uint8Array([1, 2, 3]);
    sockets[0].triggerMessage({
      kind: 'file-read-chunk',
      requestId: 'req-1',
      offset: 0,
      data: uint8ArrayToBase64(chunk1),
      done: false,
    });
    const chunk2 = new Uint8Array([4, 5]);
    sockets[0].triggerMessage({
      kind: 'file-read-chunk',
      requestId: 'req-1',
      offset: 3,
      data: uint8ArrayToBase64(chunk2),
      done: true,
    });

    const result = await promise;
    expect(result.name).toBe('photo.png');
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(progress).toEqual([
      [3, 5],
      [5, 5],
    ]);
  });

  it('downloadFile rejects when file-read-meta reports a failure', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.downloadFile('C:\\x\\gone.bin', () => undefined);
    sockets[0].triggerMessage({ kind: 'file-read-meta', requestId: 'req-1', ok: false, error: 'EPERM' });

    await expect(promise).rejects.toThrow('EPERM');
  });

  it('a socket close resolves every in-flight file request instead of leaving it pending forever', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const listPromise = transport.listFiles('C:\\x');
    const rootsPromise = transport.listFileRoots();
    const opPromise = transport.createFolder('C:\\x', 'y');
    const readPromise = transport.readTextFile('C:\\x\\a.txt');

    sockets[0].triggerClose();

    await expect(listPromise).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(rootsPromise).resolves.toEqual([]);
    await expect(opPromise).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(readPromise).resolves.toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('WsEzTerminalTransport — upload (M5)', () => {
  // Unlike the read path (purely reactive: an incoming chunk synchronously
  // triggers an ack send, both inside the SAME synchronous message-handler
  // call), `uploadFile` is an async function — its continuation after each
  // `await` only resumes on a microtask tick, not synchronously within
  // `triggerMessage`. Every step below that expects the transport to have
  // reacted (sent the next chunk/commit, or settled the promise) needs a
  // `flush()` first. A macrotask flush (not just one `Promise.resolve()`)
  // is used so this isn't sensitive to exactly how many microtask hops a
  // given `await` chain needs.
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function sentKinds(sockets: FakeSocket[]): string[] {
    return sockets[0].sent.map((s) => (JSON.parse(s) as { kind: string }).kind);
  }

  it('uploads in lockstep with acks (chunk N+1 only after ack N), with correct offsets and base64 payloads, and delivers finalName', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 10); // forces exactly 2 chunks
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const progress: number[] = [];
    const promise = transport.uploadFile('C:\\x', 'big.bin', bytes, (sent) => progress.push(sent));

    expect(sockets[0].lastSent()).toEqual({
      kind: 'file-upload-begin',
      requestId: 'req-1',
      dirPath: 'C:\\x',
      name: 'big.bin',
      size: bytes.length,
    });

    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'big.bin',
    });
    await flush();

    // First chunk sent immediately after the begin-reply — and ONLY the first.
    const chunk1 = sockets[0].lastSent() as { kind: string; uploadId: string; offset: number; data: string };
    expect(chunk1.kind).toBe('file-upload-chunk');
    expect(chunk1.uploadId).toBe('up-1');
    expect(chunk1.offset).toBe(0);
    expect(base64ToUint8Array(chunk1.data)).toEqual(bytes.subarray(0, FILE_CHUNK_BYTES));
    expect(sentKinds(sockets).filter((k) => k === 'file-upload-chunk')).toHaveLength(1);

    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: FILE_CHUNK_BYTES });
    await flush();
    expect(progress).toEqual([FILE_CHUNK_BYTES]);

    // Second (final) chunk only now — never before the first ack arrived.
    const chunk2 = sockets[0].lastSent() as { kind: string; uploadId: string; offset: number; data: string };
    expect(chunk2.kind).toBe('file-upload-chunk');
    expect(chunk2.offset).toBe(FILE_CHUNK_BYTES);
    expect(base64ToUint8Array(chunk2.data)).toEqual(bytes.subarray(FILE_CHUNK_BYTES));
    expect(sentKinds(sockets).filter((k) => k === 'file-upload-chunk')).toHaveLength(2);

    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: bytes.length });
    await flush();
    expect(progress).toEqual([FILE_CHUNK_BYTES, bytes.length]);

    expect(sockets[0].lastSent()).toEqual({ kind: 'file-upload-commit', uploadId: 'up-1' });

    sockets[0].triggerMessage({ kind: 'file-upload-done', uploadId: 'up-1', ok: true, finalName: 'big (1).bin' });

    await expect(promise).resolves.toEqual({ finalName: 'big (1).bin' });
  });

  it('rejects when file-upload-begin-reply reports failure, without ever sending a chunk', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerMessage({ kind: 'file-upload-begin-reply', requestId: 'req-1', ok: false, error: 'disk full' });

    await expect(promise).rejects.toThrow('disk full');
    expect(sentKinds(sockets)).not.toContain('file-upload-chunk');
  });

  it('an ok:false ack rejects and stops sending further chunks', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'req-1' });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 10); // would need 2 chunks if it kept going
    const promise = transport.uploadFile('C:\\x', 'big.bin', bytes, () => undefined);
    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'big.bin',
    });
    await flush(); // let the continuation register the ack listener + send chunk 1

    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: false, error: 'out-of-order chunk' });

    await expect(promise).rejects.toThrow('out-of-order chunk');
    expect(sentKinds(sockets).filter((k) => k === 'file-upload-chunk')).toHaveLength(1); // never the second
  });

  it('a socket close before file-upload-begin-reply arrives rejects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 100 });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerClose();

    await expect(promise).rejects.toThrow();
  });

  it('a socket close mid-upload (waiting on a chunk ack) rejects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'x.bin',
    });
    await flush(); // let it register the ack listener before closing

    sockets[0].triggerClose();

    await expect(promise).rejects.toThrow();
  });

  it('a socket close while waiting on file-upload-done rejects', async () => {
    const { createSocket, sockets } = makeCreateSocket();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x',
      token: 'tok',
      createSocket,
      initialBackoffMs: 100,
      newId: () => 'req-1',
    });
    sockets[0].triggerMessage({ kind: 'auth-ok' });

    const promise = transport.uploadFile('C:\\x', 'x.bin', new Uint8Array([1, 2, 3]), () => undefined);
    sockets[0].triggerMessage({
      kind: 'file-upload-begin-reply',
      requestId: 'req-1',
      ok: true,
      uploadId: 'up-1',
      finalName: 'x.bin',
    });
    await flush();
    sockets[0].triggerMessage({ kind: 'file-upload-ack', uploadId: 'up-1', ok: true, receivedBytes: 3 });
    await flush(); // let it register the done listener before closing

    sockets[0].triggerClose();

    await expect(promise).rejects.toThrow();
  });
});
