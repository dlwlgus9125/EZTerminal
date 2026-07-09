import { describe, expect, it } from 'vitest';

import {
  InterpreterBroker,
  type BrokerInterpreter,
  type RemoteMessageChannel,
  type RemotePort,
} from './interpreter-broker';
import type { InterpreterToMain, MainToInterpreter, RunStartedInfo, SessionInfo } from '../shared/ipc';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A fake interpreter: real listener storage for 'message' (with a
 * `listenerCount` getter) + 'exit', a `postMessage` spy capturing {msg,
 * transfer}, and `emit`/`emitExit` helpers to drive the broker. */
class FakeInterpreter implements BrokerInterpreter {
  readonly posted: Array<{ msg: MainToInterpreter; transfer?: readonly RemotePort[] }> = [];
  private readonly messageListeners = new Set<(message: InterpreterToMain) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();

  postMessage(msg: MainToInterpreter, transfer?: readonly RemotePort[]): void {
    this.posted.push({ msg, transfer });
  }

  on(event: 'message' | 'exit', listener: never): void {
    if (event === 'message') this.messageListeners.add(listener as (message: InterpreterToMain) => void);
    else this.exitListeners.add(listener as (code?: number) => void);
  }

  off(_event: 'message', listener: (message: InterpreterToMain) => void): void {
    this.messageListeners.delete(listener);
  }

  /** Number of 'message' listeners attached (proves the broker's single #1 listener). */
  get listenerCount(): number {
    return this.messageListeners.size;
  }

  /** Test helper: simulate the interpreter replying to main. */
  emit(message: InterpreterToMain): void {
    for (const l of this.messageListeners) l(message);
  }

  /** Test helper: simulate the interpreter process exiting. */
  emitExit(code?: number): void {
    for (const l of this.exitListeners) l(code);
  }
}

/** A fake MessagePortMain — `peer` links port1<->port2 and delivery buffers
 * until `start()`, mirroring MessageChannelMain's buffer-until-start behavior.
 * The broker returns port1 UN-started and never calls its methods; this shape
 * exists so the fake channel is a faithful `RemoteMessageChannel`. */
class FakePort implements RemotePort {
  started = false;
  closed = false;
  peer: FakePort | null = null;
  readonly posted: unknown[] = [];
  private readonly queue: unknown[] = [];
  private readonly messageHandlers: Array<(event: { data: unknown }) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.posted.push(message);
    if (this.peer) this.peer.deliver(message);
  }

  private deliver(message: unknown): void {
    if (this.started) for (const h of this.messageHandlers) h({ data: message });
    else this.queue.push(message);
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as (event: { data: unknown }) => void);
    else this.closeHandlers.push(listener as () => void);
  }

  start(): void {
    this.started = true;
    const buffered = this.queue.splice(0);
    for (const message of buffered) for (const h of this.messageHandlers) h({ data: message });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
}

function makeFakeChannel(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

function makeBroker(): {
  broker: InterpreterBroker;
  interpreter: FakeInterpreter;
  channels: Array<{ port1: FakePort; port2: FakePort }>;
} {
  const interpreter = new FakeInterpreter();
  const channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  let idCounter = 0;
  const broker = new InterpreterBroker({
    interpreter,
    createMessageChannel: (): RemoteMessageChannel => {
      const channel = makeFakeChannel();
      channels.push(channel);
      return channel;
    },
    newId: () => `id-${++idCounter}`,
  });
  return { broker, interpreter, channels };
}

/** Resolve after one macrotask so SessionDirectory's setImmediate-deferred
 * `onSessionAdded`/`onSessionRemoved` fan-out has run. */
const afterMacrotask = () => new Promise((resolve) => setImmediate(resolve));

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InterpreterBroker — createSession', () => {
  it('posts create-session and resolves with the session on the matching reply; onSessionAdded fires once', async () => {
    const { broker, interpreter } = makeBroker();
    const added: SessionInfo[] = [];
    broker.onSessionAdded((s) => added.push(s));

    const p = broker.createSession('/tmp');
    expect(interpreter.posted).toHaveLength(1);
    expect(interpreter.posted[0].msg).toEqual({ type: 'create-session', requestId: 'id-1', cwd: '/tmp' });

    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await expect(p).resolves.toEqual({ sessionId: 'sess-1', cwd: '/tmp' });

    await afterMacrotask();
    expect(added).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('ADR C6: the createSession promise resolves BEFORE the onSessionAdded broadcast fires', async () => {
    const { broker, interpreter } = makeBroker();
    const order: string[] = [];
    broker.onSessionAdded(() => order.push('added'));

    const p = broker.createSession().then(() => order.push('resolved'));
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/x' });

    await p;
    await afterMacrotask(); // let the deferred add broadcast run
    expect(order).toEqual(['resolved', 'added']);
  });

  it('a session-created for an unknown requestId is ignored and leaves the pending create untouched', async () => {
    const { broker, interpreter } = makeBroker();
    const p = broker.createSession();

    expect(() =>
      interpreter.emit({ type: 'session-created', requestId: 'not-mine', sessionId: 'x', cwd: '/x' }),
    ).not.toThrow();

    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await expect(p).resolves.toEqual({ sessionId: 'sess-1', cwd: '/tmp' });
  });
});

describe('InterpreterBroker — listRuns + onRunStarted', () => {
  it('posts list-runs and resolves with the runs from the run-list reply', async () => {
    const { broker, interpreter } = makeBroker();
    const p = broker.listRuns();
    expect(interpreter.posted[0].msg).toEqual({ type: 'list-runs', requestId: 'id-1' });

    const runs: RunStartedInfo[] = [{ sessionId: 'sess-1', runId: 'run-1', commandText: 'ls' }];
    interpreter.emit({ type: 'run-list', requestId: 'id-1', runs });
    await expect(p).resolves.toEqual(runs);
  });

  it('a run-list for an unknown requestId is ignored and leaves the pending list untouched', async () => {
    const { broker, interpreter } = makeBroker();
    const p = broker.listRuns();

    expect(() => interpreter.emit({ type: 'run-list', requestId: 'not-mine', runs: [] })).not.toThrow();

    const runs: RunStartedInfo[] = [{ sessionId: 'sess-1', runId: 'run-1', commandText: 'ls' }];
    interpreter.emit({ type: 'run-list', requestId: 'id-1', runs });
    await expect(p).resolves.toEqual(runs);
  });

  it('onRunStarted fires on run-started; the returned unsubscribe stops further calls', () => {
    const { broker, interpreter } = makeBroker();
    const seen: RunStartedInfo[] = [];
    const unsub = broker.onRunStarted((info) => seen.push(info));

    interpreter.emit({ type: 'run-started', sessionId: 'sess-1', runId: 'run-1', commandText: 'ls' });
    expect(seen).toEqual([{ sessionId: 'sess-1', runId: 'run-1', commandText: 'ls' }]);

    unsub();
    interpreter.emit({ type: 'run-started', sessionId: 'sess-1', runId: 'run-2', commandText: 'pwd' });
    expect(seen).toHaveLength(1);
  });
});

describe('InterpreterBroker — run/attach port brokering', () => {
  it('runCommand returns port1 and posts run with [port2] transferred', () => {
    const { broker, interpreter, channels } = makeBroker();
    const port1 = broker.runCommand('sess-1', 'run-1', 'ls');

    expect(channels).toHaveLength(1);
    expect(port1).toBe(channels[0].port1);
    expect(interpreter.posted[0].msg).toEqual({ type: 'run', commandText: 'ls', sessionId: 'sess-1', runId: 'run-1' });
    expect(interpreter.posted[0].transfer).toEqual([channels[0].port2]);
  });

  it('attachRun returns port1 and posts attach-run with [port2] transferred', () => {
    const { broker, interpreter, channels } = makeBroker();
    const port1 = broker.attachRun('run-1');

    expect(port1).toBe(channels[0].port1);
    expect(interpreter.posted[0].msg).toEqual({ type: 'attach-run', runId: 'run-1' });
    expect(interpreter.posted[0].transfer).toEqual([channels[0].port2]);
  });
});

describe('InterpreterBroker — destroySession', () => {
  it('removes from the directory and posts destroy-session while alive', async () => {
    const { broker, interpreter } = makeBroker();
    const p = broker.createSession('/tmp');
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await p;

    broker.destroySession('sess-1');
    expect(broker.listSessions()).toEqual([]);
    expect(interpreter.posted.map((x) => x.msg)).toContainEqual({ type: 'destroy-session', sessionId: 'sess-1' });
  });

  it('after exit still removes locally but posts nothing to the interpreter', () => {
    const { broker, interpreter } = makeBroker();
    interpreter.emitExit(0);
    const before = interpreter.posted.length;

    expect(() => broker.destroySession('sess-1')).not.toThrow();
    expect(interpreter.posted).toHaveLength(before);
  });
});

describe('InterpreterBroker — listener wiring', () => {
  it('attaches exactly one interpreter message listener', () => {
    const { interpreter } = makeBroker();
    expect(interpreter.listenerCount).toBe(1);
  });

  it('ignores script-host / known-host messages (main handles those, not the broker)', () => {
    const { broker, interpreter } = makeBroker();
    const seen: RunStartedInfo[] = [];
    broker.onRunStarted((i) => seen.push(i));

    expect(() => {
      interpreter.emit({ type: 'spawn-script-host', hostId: 'h1', scriptPath: '/s', args: [], cwd: '/' });
      interpreter.emit({ type: 'kill-script-host', hostId: 'h1' });
      interpreter.emit({ type: 'known-host-check', requestId: 'r', host: 'h', port: 22, keyType: 'rsa', fingerprint: 'fp' });
      interpreter.emit({ type: 'known-host-add', host: 'h', port: 22, keyType: 'rsa', fingerprint: 'fp' });
    }).not.toThrow();

    expect(seen).toHaveLength(0);
  });
});

describe('InterpreterBroker — dead-interpreter contract', () => {
  it('after exit: createSession rejects, listRuns resolves [], runCommand/attachRun return null', async () => {
    const { broker, interpreter } = makeBroker();
    interpreter.emitExit(0);

    await expect(broker.createSession()).rejects.toThrow('interpreter not running');
    await expect(broker.listRuns()).resolves.toEqual([]);
    expect(broker.runCommand('sess-1', 'run-1', 'ls')).toBeNull();
    expect(broker.attachRun('run-1')).toBeNull();
  });

  it('an in-flight createSession/listRuns rejects with "interpreter exited" when exit arrives mid-flight', async () => {
    const { broker, interpreter } = makeBroker();
    const createP = broker.createSession();
    const listP = broker.listRuns();

    interpreter.emitExit(1);

    await expect(createP).rejects.toThrow('interpreter exited');
    await expect(listP).rejects.toThrow('interpreter exited');
  });
});
