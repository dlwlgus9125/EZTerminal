import { describe, expect, it, vi } from 'vitest';

import {
  InterpreterBroker,
  type BrokerInterpreter,
  type RemoteMessageChannel,
  type RemotePort,
} from './interpreter-broker';
import type { InterpreterToMain, MainToInterpreter, RunStartedInfo, SessionInfo } from '../shared/ipc';
import { SessionWorktreeGuard } from './session-worktree-guard';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A fake interpreter: real listener storage for 'message' (with a
 * `listenerCount` getter) + 'exit', a `postMessage` spy capturing {msg,
 * transfer}, and `emit`/`emitExit` helpers to drive the broker. */
class FakeInterpreter implements BrokerInterpreter {
  readonly posted: Array<{ msg: MainToInterpreter; transfer?: readonly RemotePort[] }> = [];
  throwOnPost = false;
  private readonly messageListeners = new Set<(message: InterpreterToMain) => void>();
  private readonly exitListeners = new Set<(code?: number) => void>();

  postMessage(msg: MainToInterpreter, transfer?: readonly RemotePort[]): void {
    if (this.throwOnPost) throw new Error('interpreter unavailable');
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

function makeBroker(
  attachAckTimeoutMs?: number,
  destroyAckTimeoutMs?: number,
  destroyTombstoneTtlMs?: number,
  runGuard?: SessionWorktreeGuard,
): {
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
    attachAckTimeoutMs,
    destroyAckTimeoutMs,
    destroyTombstoneTtlMs,
    runGuard,
  });
  return { broker, interpreter, channels };
}

/** Resolve after one macrotask so SessionDirectory's setImmediate-deferred
 * `onSessionAdded`/`onSessionRemoved` fan-out has run. */
const afterMacrotask = () => new Promise((resolve) => setImmediate(resolve));

async function startAndCollect(port: RemotePort): Promise<unknown[]> {
  const frames: unknown[] = [];
  port.on('message', (event) => frames.push(event.data));
  port.start();
  await Promise.resolve();
  return frames;
}

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

  it('injects private session environment before createSession resolves', async () => {
    const interpreter = new FakeInterpreter();
    const broker = new InterpreterBroker({
      interpreter,
      createMessageChannel: makeFakeChannel,
      newId: () => 'request-1',
      sessionEnvironment: (sessionId) => ({ EZTERMINAL_SESSION_ID: sessionId, PRIVATE_DESCRIPTOR: 'secret' }),
    });
    const pending = broker.createSession();
    interpreter.emit({ type: 'session-created', requestId: 'request-1', sessionId: 'sess-1', cwd: '/tmp' });
    expect(interpreter.posted[1].msg).toEqual({
      type: 'set-session-environment',
      sessionId: 'sess-1',
      environment: { EZTERMINAL_SESSION_ID: 'sess-1', PRIVATE_DESCRIPTOR: 'secret' },
    });
    await expect(pending).resolves.toEqual({ sessionId: 'sess-1', cwd: '/tmp' });
  });

  it('revalidates an explicit cwd inside the mutation gate before posting create-session', async () => {
    const interpreter = new FakeInterpreter();
    const validateSessionCwd = vi.fn(async () => false);
    const broker = new InterpreterBroker({
      interpreter,
      createMessageChannel: makeFakeChannel,
      validateSessionCwd,
    });

    await expect(broker.createSession('/removed-worktree')).rejects.toThrow(/no longer an existing directory/);
    expect(validateSessionCwd).toHaveBeenCalledWith('/removed-worktree');
    expect(interpreter.posted).toEqual([]);
  });

  it('rejects if the interpreter exits while asynchronous cwd validation is in flight', async () => {
    const interpreter = new FakeInterpreter();
    let finishValidation!: (valid: boolean) => void;
    const validateSessionCwd = vi.fn(() => new Promise<boolean>((resolve) => {
      finishValidation = resolve;
    }));
    const broker = new InterpreterBroker({
      interpreter,
      createMessageChannel: makeFakeChannel,
      validateSessionCwd,
    });

    const pending = broker.createSession('/worktree');
    await Promise.resolve();
    interpreter.emitExit(1);
    finishValidation(true);

    await expect(pending).rejects.toThrow(/interpreter not running/);
    expect(interpreter.posted).toEqual([]);
  });

  it('removes the pending create and rejects when create-session postMessage throws', async () => {
    const { broker, interpreter } = makeBroker();
    interpreter.throwOnPost = true;

    await expect(broker.createSession('/tmp')).rejects.toThrow(/interpreter unavailable/);
    interpreter.throwOnPost = false;
    interpreter.emitExit(1);

    // A leaked entry would be rejected a second time by the exit handler and
    // can turn later request-id reuse into an unrelated settlement.
    expect(interpreter.posted).toEqual([]);
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

  it('preserves the additive execution kind in run-started notifications', () => {
    const { broker, interpreter } = makeBroker();
    const seen: RunStartedInfo[] = [];
    broker.onRunStarted((info) => seen.push(info));

    interpreter.emit({
      type: 'run-started',
      sessionId: 'sess-1',
      runId: 'run-ssh',
      commandText: 'ssh-connect prod',
      executionKind: 'ssh',
    });
    expect(seen[0]?.executionKind).toBe('ssh');
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
    const port1 = broker.attachRun('sess-1', 'run-1');

    expect(port1).toBe(channels[0].port1);
    expect(interpreter.posted[0].msg).toEqual({ type: 'attach-run', sessionId: 'sess-1', runId: 'run-1' });
    expect(interpreter.posted[0].transfer).toEqual([channels[0].port2]);
  });

  it('releases the run lease and refreshes the authoritative cwd on settle', async () => {
    const runGuard = new SessionWorktreeGuard();
    const { broker, interpreter } = makeBroker(undefined, undefined, undefined, runGuard);
    const created = broker.createSession('/initial');
    interpreter.emit({
      type: 'session-created',
      requestId: 'id-1',
      sessionId: 'sess-cwd',
      cwd: '/initial',
    });
    await created;

    expect(broker.runCommand('sess-cwd', 'run-cwd', 'cd child')).not.toBeNull();
    expect(runGuard.hasConflictingActiveRun()).toBe(true);
    interpreter.emit({
      type: 'session-run-settled',
      sessionId: 'sess-cwd',
      runId: 'run-cwd',
      cwd: '/initial/child',
    });

    expect(runGuard.hasConflictingActiveRun()).toBe(false);
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-cwd', cwd: '/initial/child' }]);
  });

  it('does not update cwd or release a lease for a mismatched settlement identity', async () => {
    const runGuard = new SessionWorktreeGuard();
    const { broker, interpreter } = makeBroker(undefined, undefined, undefined, runGuard);
    const created = broker.createSession('/initial');
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'owner', cwd: '/initial' });
    await created;
    expect(broker.runCommand('owner', 'run-cwd', 'cd child')).not.toBeNull();

    interpreter.emit({
      type: 'session-run-settled',
      sessionId: 'other-session',
      runId: 'run-cwd',
      cwd: '/attacker-controlled',
    });
    expect(runGuard.hasConflictingActiveRun()).toBe(true);
    expect(broker.listSessions()).toEqual([{ sessionId: 'owner', cwd: '/initial' }]);

    interpreter.emit({ type: 'session-run-settled', sessionId: 'owner', runId: 'run-cwd', cwd: '/initial/child' });
    expect(runGuard.hasConflictingActiveRun()).toBe(false);
    expect(broker.listSessions()).toEqual([{ sessionId: 'owner', cwd: '/initial/child' }]);
  });

  it('returns a terminal error port when a worktree removal barrier rejects a run', async () => {
    const runGuard = new SessionWorktreeGuard();
    const { broker, interpreter } = makeBroker(undefined, undefined, undefined, runGuard);
    let rejectedPort: RemotePort | null = null;

    await runGuard.withRemovalBarrier(() => {
      rejectedPort = broker.runCommand('sess-1', 'run-rejected', 'ls');
    });

    expect(rejectedPort).not.toBeNull();
    await expect(startAndCollect(rejectedPort!)).resolves.toEqual([{
      type: 'error',
      message: 'Run could not start while a worktree mutation is in progress',
    }]);
    expect(interpreter.posted).toEqual([]);
    expect(runGuard.hasConflictingActiveRun()).toBe(false);
  });

  it('releases the run lease and both ports if channel transfer throws', async () => {
    const runGuard = new SessionWorktreeGuard();
    const { broker, interpreter, channels } = makeBroker(undefined, undefined, undefined, runGuard);
    interpreter.throwOnPost = true;

    const rejectedPort = broker.runCommand('sess-1', 'run-throw', 'ls');
    expect(rejectedPort).toBe(channels[1].port1);
    await expect(startAndCollect(rejectedPort!)).resolves.toEqual([{
      type: 'error',
      message: 'The interpreter could not start this run',
    }]);
    expect(runGuard.hasConflictingActiveRun()).toBe(false);
    expect(channels[0].port1.closed).toBe(true);
    expect(channels[0].port2.closed).toBe(true);
  });

  it('releases the run lease if message-channel creation throws', () => {
    const runGuard = new SessionWorktreeGuard();
    const interpreter = new FakeInterpreter();
    const broker = new InterpreterBroker({
      interpreter,
      runGuard,
      createMessageChannel: () => {
        throw new Error('channel unavailable');
      },
    });

    expect(broker.runCommand('sess-1', 'run-channel-throw', 'ls')).toBeNull();
    expect(runGuard.hasConflictingActiveRun()).toBe(false);
  });

  it('keeps a destroy lease until authoritative settle, and clears all on exit', () => {
    const runGuard = new SessionWorktreeGuard();
    const { broker, interpreter } = makeBroker(undefined, undefined, undefined, runGuard);
    expect(broker.runCommand('sess-1', 'run-destroyed', 'ls')).not.toBeNull();
    broker.destroySession('sess-1');
    expect(runGuard.hasConflictingActiveRun()).toBe(true);
    interpreter.emit({
      type: 'session-run-settled',
      sessionId: 'sess-1',
      runId: 'run-destroyed',
    });
    expect(runGuard.hasConflictingActiveRun()).toBe(false);

    expect(broker.runCommand('sess-2', 'run-exited', 'ls')).not.toBeNull();
    interpreter.emitExit(1);
    expect(runGuard.hasConflictingActiveRun()).toBe(false);
  });

  it('attachRunChecked exposes a port only after the matching accepted ACK', async () => {
    const { broker, interpreter, channels } = makeBroker();
    const result = broker.attachRunChecked('sess-1', 'run-1');

    expect(interpreter.posted[0].msg).toEqual({
      type: 'attach-run',
      requestId: 'id-1',
      sessionId: 'sess-1',
      runId: 'run-1',
    });
    interpreter.emit({ type: 'run-attach-result', requestId: 'id-1', accepted: true });

    await expect(result).resolves.toEqual({ accepted: true, port: channels[0].port1 });
    expect(channels[0].port1.closed).toBe(false);
  });

  it('attachRunChecked closes the candidate port and preserves the rejection reason', async () => {
    const { broker, interpreter, channels } = makeBroker();
    const result = broker.attachRunChecked('sess-1', 'run-1');

    interpreter.emit({
      type: 'run-attach-result',
      requestId: 'id-1',
      accepted: false,
      reason: 'mirror-capacity',
    });

    await expect(result).resolves.toEqual({ accepted: false, reason: 'mirror-capacity' });
    expect(channels[0].port1.closed).toBe(true);
  });

  it('attachRunChecked times out a lost ACK and closes its candidate port', async () => {
    vi.useFakeTimers();
    try {
      const { broker, channels } = makeBroker(50);
      const result = broker.attachRunChecked('sess-1', 'run-1');

      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toEqual({ accepted: false, reason: 'transport-failed' });
      expect(channels[0].port1.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

  it('preserves the directory and contains a legacy destroy post failure', async () => {
    const { broker, interpreter } = makeBroker();
    const created = broker.createSession('/tmp');
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await created;
    interpreter.throwOnPost = true;

    expect(() => broker.destroySession('sess-1')).not.toThrow();
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('guarded destroy keeps the directory until the interpreter accepts the exact run snapshot', async () => {
    const { broker, interpreter } = makeBroker();
    const created = broker.createSession('/tmp');
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await created;

    const destroy = broker.destroySessionGuarded('sess-1', ['run-b', 'run-a', 'run-a']);
    expect(interpreter.posted.at(-1)?.msg).toEqual({
      type: 'destroy-session',
      sessionId: 'sess-1',
      requestId: 'id-2',
      expectedActiveRunIds: ['run-a', 'run-b'],
      deadlineAt: expect.any(Number),
    });
    expect(broker.listSessions()).toHaveLength(1);

    interpreter.emit({ type: 'session-destroy-result', requestId: 'id-2', sessionIds: ['sess-1'], destroyed: true });
    await expect(destroy).resolves.toEqual({ ok: true });
    expect(broker.listSessions()).toEqual([]);
  });

  it('guarded destroy fails closed and preserves the directory when session state changed', async () => {
    const { broker, interpreter } = makeBroker();
    const created = broker.createSession('/tmp');
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await created;

    const destroy = broker.destroySessionGuarded('sess-1', []);
    interpreter.emit({ type: 'session-destroy-result', requestId: 'id-2', sessionIds: ['sess-1'], destroyed: false });

    await expect(destroy).resolves.toEqual({ ok: false, reason: 'state-changed' });
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('rejects a correlated destroy ACK whose echoed session identities do not match', async () => {
    const { broker, interpreter } = makeBroker();
    for (const [requestId, sessionId] of [['id-1', 'sess-1'], ['id-2', 'sess-2']] as const) {
      const created = broker.createSession('/tmp');
      interpreter.emit({ type: 'session-created', requestId, sessionId, cwd: '/tmp' });
      await created;
    }

    const destroy = broker.destroySessionGuarded('sess-1', []);
    interpreter.emit({
      type: 'session-destroy-result',
      requestId: 'id-3',
      sessionIds: ['sess-2'],
      destroyed: true,
    });

    await expect(destroy).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(broker.listSessions()).toEqual([
      { sessionId: 'sess-1', cwd: '/tmp' },
      { sessionId: 'sess-2', cwd: '/tmp' },
    ]);
  });

  it('reconciles the directory when a successful destroy ACK arrives after timeout', async () => {
    vi.useFakeTimers();
    try {
      const { broker, interpreter } = makeBroker(undefined, 50, 500);
      const created = broker.createSession('/tmp');
      interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
      await created;

      const destroy = broker.destroySessionGuarded('sess-1', []);
      await vi.advanceTimersByTimeAsync(50);
      await expect(destroy).resolves.toEqual({ ok: false, reason: 'unavailable' });
      expect(broker.listSessions()).toHaveLength(1);

      interpreter.emit({
        type: 'session-destroy-result',
        requestId: 'id-2',
        sessionIds: ['sess-1'],
        destroyed: true,
      });
      expect(broker.listSessions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('posts one atomic guarded batch for multiple preset creator sessions', async () => {
    const { broker, interpreter } = makeBroker();
    for (const [requestId, sessionId] of [['id-1', 'sess-1'], ['id-2', 'sess-2']] as const) {
      const created = broker.createSession('/tmp');
      interpreter.emit({ type: 'session-created', requestId, sessionId, cwd: '/tmp' });
      await created;
    }

    const destroy = broker.destroySessionsGuarded([
      { sessionId: 'sess-1', expectedActiveRunIds: ['run-b', 'run-a'] },
      { sessionId: 'sess-2', expectedActiveRunIds: [] },
    ]);
    expect(interpreter.posted.at(-1)?.msg).toEqual(expect.objectContaining({
      type: 'destroy-sessions-guarded',
      requestId: 'id-3',
      sessions: [
        { sessionId: 'sess-1', expectedActiveRunIds: ['run-a', 'run-b'] },
        { sessionId: 'sess-2', expectedActiveRunIds: [] },
      ],
      deadlineAt: expect.any(Number),
    }));
    interpreter.emit({
      type: 'session-destroy-result',
      requestId: 'id-3',
      sessionIds: ['sess-1', 'sess-2'],
      destroyed: true,
    });
    await expect(destroy).resolves.toEqual({ ok: true });
    expect(broker.listSessions()).toEqual([]);
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
  it('restarts on a replacement interpreter and rehydrates stable session identities', async () => {
    const { broker, interpreter } = makeBroker();
    const created = broker.createSession('/workspace');
    interpreter.emit({
      type: 'session-created',
      requestId: 'id-1',
      sessionId: 'stable-session',
      cwd: '/workspace',
    });
    await created;
    interpreter.emitExit(1);

    const replacement = new FakeInterpreter();
    expect(broker.restart(replacement)).toBe(true);
    expect(replacement.listenerCount).toBe(1);
    expect(replacement.posted[0]?.msg).toEqual({
      type: 'restore-sessions',
      sessions: [{ sessionId: 'stable-session', cwd: '/workspace' }],
    });
    expect(broker.listSessions()).toEqual([{ sessionId: 'stable-session', cwd: '/workspace' }]);

    const next = broker.createSession('/next');
    expect(replacement.posted.at(-1)?.msg).toEqual({
      type: 'create-session',
      requestId: 'id-2',
      cwd: '/next',
    });
    replacement.emit({
      type: 'session-created',
      requestId: 'id-2',
      sessionId: 'next-session',
      cwd: '/next',
    });
    await expect(next).resolves.toEqual({ sessionId: 'next-session', cwd: '/next' });
  });

  it('after exit: createSession rejects, listRuns resolves [], runCommand returns an error port, attachRun returns null', async () => {
    const { broker, interpreter } = makeBroker();
    interpreter.emitExit(0);

    await expect(broker.createSession()).rejects.toThrow('interpreter not running');
    await expect(broker.listRuns()).resolves.toEqual([]);
    const rejectedPort = broker.runCommand('sess-1', 'run-1', 'ls');
    expect(rejectedPort).not.toBeNull();
    await expect(startAndCollect(rejectedPort!)).resolves.toEqual([{
      type: 'error',
      message: 'The interpreter is not running',
    }]);
    expect(broker.attachRun('sess-1', 'run-1')).toBeNull();
    await expect(broker.attachRunChecked('sess-1', 'run-1')).resolves.toEqual({
      accepted: false,
      reason: 'transport-failed',
    });
  });

  it('an in-flight createSession/listRuns rejects with "interpreter exited" when exit arrives mid-flight', async () => {
    const { broker, interpreter } = makeBroker();
    const createP = broker.createSession();
    const listP = broker.listRuns();

    interpreter.emitExit(1);

    await expect(createP).rejects.toThrow('interpreter exited');
    await expect(listP).rejects.toThrow('interpreter exited');
  });

  it('an in-flight checked attach closes and resolves transport-failed when the interpreter exits', async () => {
    const { broker, interpreter, channels } = makeBroker();
    const attach = broker.attachRunChecked('sess-1', 'run-1');

    interpreter.emitExit(1);

    await expect(attach).resolves.toEqual({ accepted: false, reason: 'transport-failed' });
    expect(channels[0].port1.closed).toBe(true);
  });

  it('an in-flight guarded destroy fails unavailable and preserves the directory on interpreter exit', async () => {
    const { broker, interpreter } = makeBroker();
    const created = broker.createSession('/tmp');
    interpreter.emit({ type: 'session-created', requestId: 'id-1', sessionId: 'sess-1', cwd: '/tmp' });
    await created;
    const destroy = broker.destroySessionGuarded('sess-1', []);

    interpreter.emitExit(1);

    await expect(destroy).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(broker.listSessions()).toEqual([{ sessionId: 'sess-1', cwd: '/tmp' }]);
  });

  it('reconciles a guarded batch locally when it starts after authoritative interpreter exit', async () => {
    const { broker, interpreter } = makeBroker();
    for (const [requestId, sessionId] of [['id-1', 'sess-1'], ['id-2', 'sess-2']] as const) {
      const created = broker.createSession('/tmp');
      interpreter.emit({ type: 'session-created', requestId, sessionId, cwd: '/tmp' });
      await created;
    }
    interpreter.emitExit(1);
    const postsAfterExit = interpreter.posted.length;

    await expect(broker.destroySessionsGuarded([
      { sessionId: 'sess-1', expectedActiveRunIds: [] },
      { sessionId: 'sess-2', expectedActiveRunIds: [] },
    ])).resolves.toEqual({ ok: true });
    expect(broker.listSessions()).toEqual([]);
    expect(interpreter.posted).toHaveLength(postsAfterExit);
  });
});
