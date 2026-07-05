import { describe, expect, it } from 'vitest';

import {
  attachConnection,
  AUTH_CLOSE_CODE,
  type RemoteBridgeOptions,
  type RemoteInterpreter,
  type RemoteMessageChannel,
  type RemotePort,
  type RemoteWs,
} from './remote-bridge';
import { SessionDirectory } from './session-directory';
import type { InterpreterToMain, MainToInterpreter } from '../shared/ipc';
import type { ServerToClientMessage } from '../shared/remote-protocol';

const TOKEN = 'the-secret-token';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeWs implements RemoteWs {
  readyState = 1; // OPEN, matches WS_OPEN
  readonly sent: ServerToClientMessage[] = [];
  closeCode: number | undefined;
  private readonly messageHandlers: Array<(data: { toString(): string }, isBinary: boolean) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerToClientMessage);
  }

  close(code?: number): void {
    if (this.readyState !== 1) return;
    this.readyState = 3; // CLOSED
    this.closeCode = code;
    for (const h of this.closeHandlers) h();
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
    else this.closeHandlers.push(listener as never);
  }

  /** Test helper: simulate a client sending a JSON envelope. */
  clientSend(msg: unknown): void {
    const data = { toString: () => JSON.stringify(msg) };
    for (const h of this.messageHandlers) h(data, false);
  }
}

class FakeInterpreter implements RemoteInterpreter {
  readonly posted: Array<{ message: MainToInterpreter; transfer?: readonly RemotePort[] }> = [];
  private readonly listeners = new Set<(message: InterpreterToMain) => void>();

  postMessage(message: MainToInterpreter, transfer?: readonly RemotePort[]): void {
    this.posted.push({ message, transfer });
  }

  on(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Test helper: simulate the interpreter replying to main. */
  emit(message: InterpreterToMain): void {
    for (const l of this.listeners) l(message);
  }
}

/** A fake MessagePortMain pair — `peer` links port1<->port2 so postMessage on
 * one side delivers to the other's 'message' listeners, mirroring the real
 * entangled-port behavior a MessageChannelMain provides. */
class FakePort implements RemotePort {
  closed = false;
  started = false;
  readonly posted: unknown[] = [];
  peer: FakePort | null = null;
  private readonly messageHandlers: Array<(event: { data: unknown }) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.posted.push(message);
    if (this.peer && !this.peer.closed) {
      for (const h of this.peer.messageHandlers) h({ data: message });
    }
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
    else this.closeHandlers.push(listener as never);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
}

function makeFakeChannel(): RemoteMessageChannel {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

function makeOptions(overrides: Partial<RemoteBridgeOptions> = {}): {
  options: RemoteBridgeOptions;
  interpreter: FakeInterpreter;
  sessionDirectory: SessionDirectory;
  channels: Array<{ port1: FakePort; port2: FakePort }>;
} {
  const interpreter = new FakeInterpreter();
  const sessionDirectory = new SessionDirectory();
  const channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  let idCounter = 0;

  const options: RemoteBridgeOptions = {
    port: 0,
    getToken: () => TOKEN,
    interpreter,
    sessionDirectory,
    createMessageChannel: () => {
      const channel = makeFakeChannel() as { port1: FakePort; port2: FakePort };
      channels.push(channel);
      return channel;
    },
    newId: () => `id-${++idCounter}`,
    ...overrides,
  };
  return { options, interpreter, sessionDirectory, channels };
}

async function authed(ws: FakeWs, options: RemoteBridgeOptions): Promise<void> {
  attachConnection(ws, options);
  ws.clientSend({ kind: 'auth', token: TOKEN });
  await flush();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RemoteBridge — auth gate', () => {
  it('rejects a wrong token: sends auth-fail and closes with AUTH_CLOSE_CODE', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);
    ws.clientSend({ kind: 'auth', token: 'wrong' });
    await flush();
    expect(ws.sent).toContainEqual({ kind: 'auth-fail' });
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('accepts the correct token: sends auth-ok and does not close', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    await authed(ws, options);
    expect(ws.sent).toContainEqual({ kind: 'auth-ok' });
    expect(ws.closeCode).toBeUndefined();
  });

  it('closes immediately (AUTH_CLOSE_CODE) if the FIRST message is not auth', () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    attachConnection(ws, options);
    ws.clientSend({ kind: 'list-sessions' });
    expect(ws.closeCode).toBe(AUTH_CLOSE_CODE);
  });

  it('ignores any request sent before auth succeeds', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    attachConnection(ws, options);
    // Wrong-kind-first closes synchronously above; here simulate a slow auth
    // in flight by using an async token and sending a second message meanwhile.
    ws.clientSend({ kind: 'auth', token: TOKEN });
    ws.clientSend({ kind: 'list-sessions' });
    await flush();
    // list-sessions racing auth resolution before authed=true must not process —
    // once auth completes, only 'auth-ok' should have been sent, no session-list.
    expect(ws.sent.filter((m) => m.kind === 'session-list')).toHaveLength(0);
    expect(interpreter.posted).toHaveLength(0);
  });
});

describe('RemoteBridge — session directory + create/destroy round trip', () => {
  it('create-session posts to the interpreter and relays session-created back with the CLIENT requestId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, sessionDirectory } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'create-session', requestId: 'client-req-1', cwd: '/tmp' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({
      type: 'create-session',
      requestId: 'id-1',
      cwd: '/tmp',
    });

    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });

    expect(ws.sent).toContainEqual({
      kind: 'session-created',
      requestId: 'client-req-1',
      session: { sessionId: 'sess-1', cwd: '/tmp' },
    });
    expect(sessionDirectory.list()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('a session-created reply for a DIFFERENT (unmatched) requestId is ignored by this connection', async () => {
    const ws = new FakeWs();
    const { options, interpreter } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'create-session', requestId: 'client-req-1' });

    // Some other connection's create-session round trip.
    interpreter.emit({ type: 'session-created', requestId: 'not-mine', sessionId: 'sess-x', cwd: '/x' });

    expect(ws.sent.some((m) => m.kind === 'session-created')).toBe(false);
  });

  it('list-sessions returns the current directory contents', async () => {
    const ws = new FakeWs();
    const { options, sessionDirectory } = makeOptions();
    sessionDirectory.add({ sessionId: 'existing', cwd: '/existing' });
    await authed(ws, options);

    ws.clientSend({ kind: 'list-sessions' });

    expect(ws.sent).toContainEqual({
      kind: 'session-list',
      sessions: [{ sessionId: 'existing', cwd: '/existing' }],
    });
  });

  it('destroy-session removes it from the directory and posts to the interpreter', async () => {
    const ws = new FakeWs();
    const { options, interpreter, sessionDirectory } = makeOptions();
    sessionDirectory.add({ sessionId: 'sess-1', cwd: '/tmp' });
    await authed(ws, options);

    ws.clientSend({ kind: 'destroy-session', sessionId: 'sess-1' });

    expect(sessionDirectory.list()).toEqual([]);
    expect(interpreter.posted).toContainEqual({
      message: { type: 'destroy-session', sessionId: 'sess-1' },
      transfer: undefined,
    });
  });
});

describe('RemoteBridge — run-command frame/control multiplexing', () => {
  it('relays an interpreter frame to the WS tagged with the correct runId', async () => {
    const ws = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].message).toEqual({ type: 'run', commandText: 'ls', sessionId: 'sess-1' });
    expect(channels).toHaveLength(1);
    expect(channels[0].port1.started).toBe(true);

    channels[0].port2.postMessage({ type: 'start', commandText: 'ls', cwd: '/tmp' });

    expect(ws.sent).toContainEqual({
      kind: 'frame',
      runId: 'run-1',
      frame: { type: 'start', commandText: 'ls', cwd: '/tmp' },
    });
  });

  it('encodes a pty-data frame as base64 on relay', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: '!bash' });

    channels[0].port2.postMessage({ type: 'pty-data', data: new Uint8Array([104, 105]) }); // "hi"

    const frameMsg = ws.sent.find((m) => m.kind === 'frame') as {
      kind: 'frame';
      runId: string;
      frame: { type: string; data: string };
    };
    expect(frameMsg.frame.type).toBe('pty-data');
    expect(typeof frameMsg.frame.data).toBe('string');
    expect(frameMsg.frame.data).not.toBeInstanceOf(Uint8Array);
  });

  it('relays a WS control message to the run\'s port', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });

    ws.clientSend({ kind: 'control', runId: 'run-1', control: { type: 'cancel' } });

    expect(channels[0].port1.posted).toContainEqual({ type: 'cancel' });
  });

  it('a control for an unknown runId is a silent no-op', async () => {
    const ws = new FakeWs();
    const { options } = makeOptions();
    await authed(ws, options);
    expect(() => ws.clientSend({ kind: 'control', runId: 'no-such-run', control: { type: 'cancel' } })).not.toThrow();
  });

  it('a close control closes the port and stops further relays for that runId', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);
    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });

    ws.clientSend({ kind: 'control', runId: 'run-1', control: { type: 'close' } });

    expect(channels[0].port1.posted).toContainEqual({ type: 'close' });
    expect(channels[0].port1.closed).toBe(true);

    // Interpreter side is closed too (peer), so a post-close frame from the
    // interpreter is dropped rather than relayed.
    const sentBefore = ws.sent.length;
    channels[0].port2.postMessage({ type: 'cancelled' });
    expect(ws.sent.length).toBe(sentBefore);
  });

  it('two concurrent runs never cross runIds', async () => {
    const ws = new FakeWs();
    const { options, channels } = makeOptions();
    await authed(ws, options);

    ws.clientSend({ kind: 'run-command', runId: 'run-a', sessionId: 'sess-1', commandText: 'ls' });
    ws.clientSend({ kind: 'run-command', runId: 'run-b', sessionId: 'sess-1', commandText: 'pwd' });
    expect(channels).toHaveLength(2);

    channels[0].port2.postMessage({ type: 'start', commandText: 'ls', cwd: '/a' });
    channels[1].port2.postMessage({ type: 'start', commandText: 'pwd', cwd: '/b' });

    const frames = ws.sent.filter((m) => m.kind === 'frame') as Array<{
      kind: 'frame';
      runId: string;
      frame: { commandText: string };
    }>;
    expect(frames.find((f) => f.runId === 'run-a')?.frame.commandText).toBe('ls');
    expect(frames.find((f) => f.runId === 'run-b')?.frame.commandText).toBe('pwd');

    // A control for run-a must only reach run-a's port.
    ws.clientSend({ kind: 'control', runId: 'run-a', control: { type: 'cancel' } });
    expect(channels[0].port1.posted).toContainEqual({ type: 'cancel' });
    expect(channels[1].port1.posted).not.toContainEqual({ type: 'cancel' });
  });
});

describe('RemoteBridge — connection teardown', () => {
  it('closing the WS closes every open run port and detaches the interpreter listener', async () => {
    const ws = new FakeWs();
    const { options, interpreter, channels } = makeOptions();
    await authed(ws, options);
    expect(interpreter.listenerCount).toBe(1);

    ws.clientSend({ kind: 'run-command', runId: 'run-1', sessionId: 'sess-1', commandText: 'ls' });
    ws.clientSend({ kind: 'run-command', runId: 'run-2', sessionId: 'sess-1', commandText: 'pwd' });
    expect(channels.every((c) => !c.port1.closed)).toBe(true);

    ws.close();

    expect(channels.every((c) => c.port1.closed)).toBe(true);
    expect(interpreter.listenerCount).toBe(0);
  });
});
