/**
 * interpreter-process.ts — ExecutionSession port fanout + last-port-close
 * teardown (M2 T2.2b/c, Critic C3). A run may be observed by more than one
 * port: the INITIATING surface (desktop/mobile that sent `run`) plus any
 * number of non-initiating `attach-run` mirrors (T2.2f). Closing a mirror
 * must never kill the run out from under the initiator or another mirror —
 * only the LAST tracked port closing, or an explicit `{type:'close'}` control
 * from the PRIMARY port specifically, tears the run down.
 *
 * `ExecutionSession` itself is not exported (and interpreter-process.ts has a
 * top-level `process.parentPort.on('message', ...)` bootstrap that requires a
 * real utilityProcess), so this drives the REAL production code through its
 * actual wire protocol instead: stub `process.parentPort` BEFORE importing
 * (same pattern as packet-capture-host.test.ts, the established precedent in
 * this codebase for testing a utilityProcess entry file), capture the
 * registered message handler, and send it `create-session`/`run`/`attach-run`
 * messages with fake ports — exactly what main.ts's real IPC handlers do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InterpreterFrame } from '../shared/ipc';

type MessageHandler = (event: { data: unknown; ports: readonly unknown[] }) => void;

const sessionIdsByRunId = new Map<string, string>();
function sessionForRun(runId: string): string {
  const sessionId = sessionIdsByRunId.get(runId);
  if (!sessionId) throw new Error(`test session for ${runId} was not recorded`);
  return sessionId;
}

/** A fake `MessagePortMain`: tracks posted frames, lets a test fire 'close'
 * (simulating the transport disconnecting) and 'message' (simulating a
 * control sent from the other side) — mirrors remote-bridge.test.ts's FakePort. */
class FakePort {
  closed = false;
  readonly posted: unknown[] = [];
  private readonly messageHandlers: Array<(event: { data: unknown }) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  on(event: 'message' | 'close', listener: never): void {
    if (event === 'message') this.messageHandlers.push(listener as never);
    else this.closeHandlers.push(listener as never);
  }

  start(): void {
    /* not exercised here */
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }

  /** Test helper: simulate the OTHER side sending a control message. */
  send(data: unknown): void {
    for (const h of this.messageHandlers) h({ data });
  }
}

/** Stubs `process.parentPort` and re-imports interpreter-process.ts fresh,
 * returning the message handler it registers + everything it has posted
 * BACK to main (session-created replies, run-started announcements, ...). */
async function importInterpreter(): Promise<{ handler: MessageHandler; posted: unknown[] }> {
  vi.resetModules();
  const posted: unknown[] = [];
  let messageHandler: MessageHandler | undefined;
  (process as unknown as { parentPort: { on: (event: string, cb: MessageHandler) => void; postMessage: (msg: unknown) => void } }).parentPort = {
    on: (event, cb) => {
      if (event === 'message') messageHandler = cb;
    },
    postMessage: (msg: unknown) => posted.push(msg),
  };
  await import('./interpreter-process');
  expect(messageHandler).toBeDefined();
  return { handler: messageHandler!, posted };
}

/** Create a session and start a run in it, returning the sessionId + the
 * primary port. Uses `gen-rows` — a pure, in-process builtin (no external
 * process, no PTY) so the run's port-lifecycle can be tested deterministically. */
function beginRun(
  handler: MessageHandler,
  posted: unknown[],
  runId: string,
): { sessionId: string; primary: FakePort } {
  handler({ data: { type: 'create-session', requestId: 'req-1' }, ports: [] });
  const created = posted.find(
    (m): m is { type: 'session-created'; sessionId: string } =>
      (m as { type?: string }).type === 'session-created',
  );
  if (!created) throw new Error('session-created reply never arrived');
  const { sessionId } = created;

  const primary = new FakePort();
  handler({
    data: { type: 'run', runId, sessionId, commandText: 'gen-rows 3' },
    ports: [primary],
  });
  sessionIdsByRunId.set(runId, sessionId);
  return { sessionId, primary };
}

describe('interpreter-process — ExecutionSession port fanout (M2 T2.2b, Critic C3)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('an attach-run mirrors the run to a second, non-initiating port', async () => {
    const { handler, posted } = await importInterpreter();
    const { sessionId, primary } = beginRun(handler, posted, 'run-1');
    expect(primary.posted.some((f) => (f as InterpreterFrame).type === 'start')).toBe(true);

    const attach = new FakePort();
    handler({
      data: { type: 'attach-run', requestId: 'attach-ok', sessionId, runId: 'run-1' },
      ports: [attach],
    });

    // The attach port learns at least that the block has started (T2.2d replay).
    expect(attach.posted.some((f) => (f as InterpreterFrame).type === 'start')).toBe(true);
    expect(posted).toContainEqual({ type: 'run-attach-result', requestId: 'attach-ok', accepted: true });
  });

  it('replays a mobile worktree-open intent with the same id after an attach', async () => {
    const { handler, posted } = await importInterpreter();
    handler({ data: { type: 'create-session', requestId: 'req-wt' }, ports: [] });
    const created = posted.find(
      (message): message is { type: 'session-created'; sessionId: string } =>
        (message as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');

    const primary = new FakePort();
    handler({
      data: {
        type: 'run',
        runId: 'run-wt',
        sessionId: created.sessionId,
        commandText: 'worktree open wt-1',
        requestOrigin: 'mobile',
      },
      ports: [primary],
    });
    sessionIdsByRunId.set('run-wt', created.sessionId);
    primary.send({ type: 'requestRows', start: 0, count: 20 });
    await waitFor(
      () => posted.some((message) => (message as { type?: string }).type === 'worktree-action-request'),
      'worktree action request',
    );
    const request = posted.find(
      (message): message is { type: 'worktree-action-request'; requestId: string } =>
        (message as { type?: string }).type === 'worktree-action-request',
    );
    if (!request) throw new Error('worktree action request never arrived');
    const worktree = {
      worktreeId: 'wt-1',
      repoId: 'repo-1',
      path: '/safe/feature',
      branch: 'feature',
      head: 'abc123',
      main: false,
      locked: false,
      managed: true,
      prunable: false,
    } as const;
    handler({
      data: {
        type: 'worktree-action-response',
        requestId: request.requestId,
        result: { ok: true, action: 'open', worktrees: [worktree], opened: worktree },
      },
      ports: [],
    });
    await waitFor(
      () => primary.posted.some((frame) => (frame as InterpreterFrame).type === 'worktree-open'),
      'primary worktree-open frame',
    );
    const openFrame = primary.posted.find(
      (frame): frame is Extract<InterpreterFrame, { type: 'worktree-open' }> =>
        (frame as InterpreterFrame).type === 'worktree-open',
    );
    expect(openFrame?.intentId).toEqual(expect.any(String));

    const reconnectAttach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: created.sessionId, runId: 'run-wt' }, ports: [reconnectAttach] });
    expect(reconnectAttach.posted).toContainEqual(openFrame);

    primary.send({ type: 'close' });
  });

  it('an attach-run for an unknown/already-ended runId is rejected (error frame), never resurrected', async () => {
    const { handler, posted } = await importInterpreter();
    const { sessionId } = beginRun(handler, posted, 'run-1');

    const attach = new FakePort();
    handler({
      data: { type: 'attach-run', requestId: 'attach-missing', sessionId, runId: 'no-such-run' },
      ports: [attach],
    });

    expect(attach.posted).toEqual([{ type: 'error', message: 'run no-such-run does not exist' }]);
    expect(attach.closed).toBe(true);
    expect(posted).toContainEqual({
      type: 'run-attach-result',
      requestId: 'attach-missing',
      accepted: false,
      reason: 'run-not-found',
    });
  });

  it('rejects duplicate run ids and cross-session attach without disturbing the owner', async () => {
    const { handler, posted } = await importInterpreter();
    const owner = beginRun(handler, posted, 'shared-run-id');
    handler({ data: { type: 'create-session', requestId: 'req-other' }, ports: [] });
    const sessions = posted.filter(
      (message): message is { type: 'session-created'; sessionId: string } =>
        (message as { type?: string }).type === 'session-created',
    );
    const otherSessionId = sessions.at(-1)?.sessionId;
    if (!otherSessionId) throw new Error('second session was not created');

    const duplicate = new FakePort();
    handler({
      data: {
        type: 'run',
        runId: 'shared-run-id',
        sessionId: otherSessionId,
        commandText: 'gen-rows 1',
      },
      ports: [duplicate],
    });
    expect(duplicate.posted).toEqual([{ type: 'error', message: 'run id already exists' }]);

    const wrongSession = new FakePort();
    handler({
      data: {
        type: 'attach-run',
        requestId: 'attach-wrong-session',
        sessionId: otherSessionId,
        runId: 'shared-run-id',
      },
      ports: [wrongSession],
    });
    expect(wrongSession.posted).toEqual([
      { type: 'error', message: 'run shared-run-id does not exist' },
    ]);
    expect(posted).toContainEqual({
      type: 'run-attach-result',
      requestId: 'attach-wrong-session',
      accepted: false,
      reason: 'session-mismatch',
    });

    const ownerAttach = new FakePort();
    handler({
      data: { type: 'attach-run', sessionId: owner.sessionId, runId: 'shared-run-id' },
      ports: [ownerAttach],
    });
    expect(ownerAttach.posted.some((frame) => (frame as InterpreterFrame).type === 'start')).toBe(true);
    owner.primary.send({ type: 'close' });
  });

  it('closing the ATTACH port does NOT dispose the run — the primary stays open', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    attach.close(); // the mirror's transport disconnects

    expect(primary.closed).toBe(false);
    // The run is still tracked — a fresh attach-run for the same runId still succeeds.
    const attach2 = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach2] });
    expect(attach2.posted.some((f) => (f as { type?: string }).type === 'error')).toBe(false);
  });

  it('the PRIMARY port disconnecting (transport close, not a control) while an attach remains open does NOT dispose the run', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    primary.close();

    expect(attach.closed).toBe(false);
  });

  it('the LAST remaining port closing tears the run down — a later attach-run is then rejected', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    attach.close(); // one port left (primary) — not yet disposed
    primary.close(); // now zero — last-port-close disposes

    const late = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [late] });
    expect(late.posted).toEqual([{ type: 'error', message: 'run run-1 does not exist' }]);
  });

  it('a {type:"close"} CONTROL on the PRIMARY port disposes unconditionally, closing every attach port too, even though they never disconnected', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    primary.send({ type: 'close' });

    expect(primary.closed).toBe(true);
    expect(attach.closed).toBe(true);
    const late = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [late] });
    expect(late.posted).toEqual([{ type: 'error', message: 'run run-1 does not exist' }]);
  });

  it('a {type:"close"} CONTROL on an ATTACH port only detaches that one port — the run and primary stay alive', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    attach.send({ type: 'close' });

    expect(attach.closed).toBe(true); // detached
    expect(primary.closed).toBe(false); // run untouched

    const late = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [late] });
    expect(late.posted.some((f) => (f as { type?: string }).type === 'error')).toBe(false); // still alive
  });
});

/** Polls until `predicate` is true, matching the established pattern for
 * waiting on real (non-fake-spawned) async process output in this codebase
 * (see external-command-pty.test.ts's sibling, process-runner.test.ts). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe('interpreter-process — pty-resize gate + pty-dims mirroring (mobile mirroring fix, D2/D3)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  /** Same shape as `beginRun` above, but `!cmd` forces a real interactive PTY
   * (no fake-spawn seam exists at this layer — same real-ConPTY precedent as
   * the `list-runs` describe block below). */
  function beginPtyRun(
    handler: MessageHandler,
    posted: unknown[],
    runId: string,
  ): { sessionId: string; primary: FakePort } {
    handler({ data: { type: 'create-session', requestId: 'req-1' }, ports: [] });
    const created = posted.find(
      (m): m is { type: 'session-created'; sessionId: string } =>
        (m as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');
    const { sessionId } = created;

    const primary = new FakePort();
    handler({
      data: { type: 'run', runId, sessionId, commandText: '!cmd' },
      ports: [primary],
    });
    sessionIdsByRunId.set(runId, sessionId);
    return { sessionId, primary };
  }

  it('an ATTACH port sending pty-resize is gated out — no NEW pty-dims fans out anywhere', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginPtyRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });
    const attach2 = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach2] });

    // Both attach ports already got ONE pty-dims frame from their own attach-time
    // replay (the initial 80x24 dims) — count those before the gated attempt so
    // the assertion below isolates whether the resize itself triggered a fanout.
    const dimsCount = (p: FakePort): number =>
      p.posted.filter((f) => (f as InterpreterFrame).type === 'pty-dims').length;
    const before = { attach: dimsCount(attach), attach2: dimsCount(attach2) };

    attach.send({ type: 'pty-resize', cols: 40, rows: 10 }); // a MIRROR trying to resize — must be ignored

    expect(dimsCount(attach)).toBe(before.attach);
    expect(dimsCount(attach2)).toBe(before.attach2);

    primary.send({ type: 'close' }); // tear down the real cmd.exe child
  });

  it('a PRIMARY pty-resize delivers pty-dims to an already-attached mirror port', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginPtyRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    primary.send({ type: 'pty-resize', cols: 100, rows: 30 });

    expect(attach.posted).toContainEqual({ type: 'pty-dims', cols: 100, rows: 30 });

    primary.send({ type: 'close' });
  });

  it('a FRESH attach after a primary resize replays pty-dims BEFORE the replayed ring pty-data', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginPtyRun(handler, posted, 'run-1');

    // Wait for the real cmd.exe child to actually emit its startup output so
    // the ring has bytes to replay — no fake-spawn seam at this layer.
    await waitFor(
      () => primary.posted.some((f) => (f as InterpreterFrame).type === 'pty-data'),
      'first pty-data from the real cmd.exe child',
    );

    primary.send({ type: 'pty-resize', cols: 100, rows: 30 });

    const late = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [late] });

    const dimsIndex = late.posted.findIndex((f) => (f as InterpreterFrame).type === 'pty-dims');
    const dataIndex = late.posted.findIndex((f) => (f as InterpreterFrame).type === 'pty-data');
    expect(dimsIndex).toBeGreaterThanOrEqual(0);
    expect(dataIndex).toBeGreaterThanOrEqual(0);
    expect(dimsIndex).toBeLessThan(dataIndex);
    expect(late.posted[dataIndex]).toMatchObject({
      type: 'pty-data',
      suppressSideEffects: true,
    });

    primary.send({ type: 'close' });
  });
});

describe('interpreter-process — control handoff (M8a)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  /** Same shape as the sibling describe block's helper above (duplicated
   * because it's declared in that block's closure, not module scope). */
  function beginPtyRun(
    handler: MessageHandler,
    posted: unknown[],
    runId: string,
  ): { sessionId: string; primary: FakePort } {
    handler({ data: { type: 'create-session', requestId: 'req-1' }, ports: [] });
    const created = posted.find(
      (m): m is { type: 'session-created'; sessionId: string } =>
        (m as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');
    const { sessionId } = created;

    const primary = new FakePort();
    handler({
      data: { type: 'run', runId, sessionId, commandText: '!cmd' },
      ports: [primary],
    });
    sessionIdsByRunId.set(runId, sessionId);
    return { sessionId, primary };
  }

  it('an attach-run CLAIMS control: both ports are notified, and resize authority moves to the claimer', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginPtyRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    attach.send({ type: 'pty-claim-control' });

    expect(attach.posted).toContainEqual({ type: 'pty-control', hasControl: true });
    expect(primary.posted).toContainEqual({ type: 'pty-control', hasControl: false });

    // The claimer's resize now applies — the (former primary) authority is fanned the new dims.
    attach.send({ type: 'pty-resize', cols: 100, rows: 30 });
    expect(primary.posted).toContainEqual({ type: 'pty-dims', cols: 100, rows: 30 });

    // The demoted former authority's own resize is now ignored — no new pty-dims anywhere.
    const dimsCount = (p: FakePort): number =>
      p.posted.filter((f) => (f as InterpreterFrame).type === 'pty-dims').length;
    const before = { primary: dimsCount(primary), attach: dimsCount(attach) };

    primary.send({ type: 'pty-resize', cols: 40, rows: 10 });

    expect(dimsCount(primary)).toBe(before.primary);
    expect(dimsCount(attach)).toBe(before.attach);

    primary.send({ type: 'close' });
  });

  it('control reverts to the primary once the claiming attacher\'s port closes', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginPtyRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    attach.send({ type: 'pty-claim-control' });
    attach.close(); // the claiming mirror's transport disconnects

    expect(primary.posted).toContainEqual({ type: 'pty-control', hasControl: true });

    // The primary's resize applies again now that authority reverted to it —
    // verified via a fresh attach replaying the dims it just set.
    primary.send({ type: 'pty-resize', cols: 100, rows: 30 });
    const late = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [late] });
    expect(late.posted).toContainEqual({ type: 'pty-dims', cols: 100, rows: 30 });

    primary.send({ type: 'close' });
  });

  it('a fresh attach receives pty-control{false} in its replay sequence, after the pty-dims replay', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginPtyRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', sessionId: sessionForRun('run-1'), runId: 'run-1' }, ports: [attach] });

    expect(attach.posted).toContainEqual({ type: 'pty-control', hasControl: false });
    const dimsIndex = attach.posted.findIndex((f) => (f as InterpreterFrame).type === 'pty-dims');
    const controlIndex = attach.posted.findIndex((f) => (f as InterpreterFrame).type === 'pty-control');
    expect(dimsIndex).toBeGreaterThanOrEqual(0);
    expect(controlIndex).toBeGreaterThan(dimsIndex);

    primary.send({ type: 'close' });
  });
});

describe('interpreter-process — guarded session destroy', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('fails closed if the foreground run set changed, then destroys on an exact match', async () => {
    const { handler, posted } = await importInterpreter();
    handler({ data: { type: 'create-session', requestId: 'req-destroy' }, ports: [] });
    const created = posted.find(
      (message): message is { type: 'session-created'; sessionId: string } =>
        (message as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');

    const primary = new FakePort();
    handler({
      data: { type: 'run', runId: 'run-guarded', sessionId: created.sessionId, commandText: '!cmd' },
      ports: [primary],
    });
    handler({
      data: {
        type: 'destroy-session',
        requestId: 'destroy-stale',
        sessionId: created.sessionId,
        expectedActiveRunIds: [],
      },
      ports: [],
    });
    expect(posted).toContainEqual({
      type: 'session-destroy-result',
      requestId: 'destroy-stale',
      sessionIds: [created.sessionId],
      destroyed: false,
    });

    handler({ data: { type: 'list-runs', requestId: 'still-live' }, ports: [] });
    expect(posted).toContainEqual({
      type: 'run-list',
      requestId: 'still-live',
      runs: [{
        sessionId: created.sessionId,
        runId: 'run-guarded',
        commandText: '!cmd',
        executionKind: 'local',
      }],
    });

    handler({
      data: {
        type: 'destroy-session',
        requestId: 'destroy-current',
        sessionId: created.sessionId,
        expectedActiveRunIds: ['run-guarded'],
      },
      ports: [],
    });
    expect(posted).toContainEqual({
      type: 'session-destroy-result',
      requestId: 'destroy-current',
      sessionIds: [created.sessionId],
      destroyed: true,
    });
    expect(primary.closed).toBe(true);
  });

  it('treats an already-absent session as idempotent success', async () => {
    const { handler, posted } = await importInterpreter();
    handler({
      data: {
        type: 'destroy-session',
        requestId: 'destroy-missing',
        sessionId: 'missing-session',
        expectedActiveRunIds: [],
      },
      ports: [],
    });
    expect(posted).toContainEqual({
      type: 'session-destroy-result',
      requestId: 'destroy-missing',
      sessionIds: ['missing-session'],
      destroyed: true,
    });
  });

  it('never treats a half-specified guarded message as unconditional teardown', async () => {
    const { handler, posted } = await importInterpreter();
    handler({ data: { type: 'create-session', requestId: 'req-half' }, ports: [] });
    const created = posted.find(
      (message): message is { type: 'session-created'; sessionId: string } =>
        (message as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');

    handler({
      data: {
        type: 'destroy-session',
        sessionId: created.sessionId,
        expectedActiveRunIds: [],
      },
      ports: [],
    });
    handler({
      data: {
        type: 'destroy-session',
        requestId: 'request-only',
        sessionId: created.sessionId,
      },
      ports: [],
    });
    expect(posted).toContainEqual({
      type: 'session-destroy-result',
      requestId: 'request-only',
      sessionIds: [created.sessionId],
      destroyed: false,
    });

    const primary = new FakePort();
    handler({
      data: { type: 'run', runId: 'run-after-half-guard', sessionId: created.sessionId, commandText: '!cmd' },
      ports: [primary],
    });
    handler({ data: { type: 'list-runs', requestId: 'half-still-live' }, ports: [] });
    const live = posted.find(
      (message): message is { type: 'run-list'; requestId: string; runs: unknown[] } =>
        (message as { requestId?: string }).requestId === 'half-still-live',
    );
    expect(live?.runs).toHaveLength(1);
    primary.send({ type: 'close' });
  });

  it('validates every session before atomically destroying a guarded batch', async () => {
    const { handler, posted } = await importInterpreter();
    handler({ data: { type: 'create-session', requestId: 'create-a' }, ports: [] });
    handler({ data: { type: 'create-session', requestId: 'create-b' }, ports: [] });
    const created = posted.filter(
      (message): message is { type: 'session-created'; sessionId: string } =>
        (message as { type?: string }).type === 'session-created',
    );
    const [first, second] = created;
    if (!first || !second) throw new Error('sessions were not created');
    const primary = new FakePort();
    handler({
      data: { type: 'run', runId: 'run-b', sessionId: second.sessionId, commandText: '!cmd' },
      ports: [primary],
    });

    handler({
      data: {
        type: 'destroy-sessions-guarded',
        requestId: 'batch-stale',
        sessions: [
          { sessionId: first.sessionId, expectedActiveRunIds: [] },
          { sessionId: second.sessionId, expectedActiveRunIds: [] },
        ],
        deadlineAt: Date.now() + 1_000,
      },
      ports: [],
    });
    expect(posted).toContainEqual({
      type: 'session-destroy-result',
      requestId: 'batch-stale',
      sessionIds: [first.sessionId, second.sessionId],
      destroyed: false,
    });

    const firstPort = new FakePort();
    handler({ data: { type: 'run', runId: 'first-still-live', sessionId: first.sessionId, commandText: '!cmd' }, ports: [firstPort] });
    expect(firstPort.posted.some((frame) => (frame as { type?: string }).type === 'start')).toBe(true);
    primary.send({ type: 'close' });
    firstPort.send({ type: 'close' });
  });
});

describe('interpreter-process — list-runs (M1 mirror-active-runs)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns [] when no run is active', async () => {
    const { handler, posted } = await importInterpreter();

    handler({ data: { type: 'list-runs', requestId: 'lr-idle' }, ports: [] });

    expect(posted).toContainEqual({ type: 'run-list', requestId: 'lr-idle', runs: [] });
  });

  it('reports an in-flight `!cmd` run as active, then [] again once it closes', async () => {
    const { handler, posted } = await importInterpreter();
    handler({ data: { type: 'create-session', requestId: 'req-1' }, ports: [] });
    const created = posted.find(
      (m): m is { type: 'session-created'; sessionId: string } =>
        (m as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');
    const { sessionId } = created;

    // `!cmd` forces an interactive PTY — real ConPTY spawn, since this test
    // drives the full interpreter bootstrap (no fake-spawn injection seam
    // exists at this layer, unlike pty-session.test.ts's fake PtyHandle).
    // The run has no terminal frame until explicitly closed below, so it
    // stays "running" long enough to observe via list-runs.
    const primary = new FakePort();
    handler({
      data: { type: 'run', runId: 'run-pty-1', sessionId, commandText: '!cmd' },
      ports: [primary],
    });

    handler({ data: { type: 'list-runs', requestId: 'lr-live' }, ports: [] });
    expect(posted).toContainEqual({
      type: 'run-list',
      requestId: 'lr-live',
      runs: [{ sessionId, runId: 'run-pty-1', commandText: '!cmd', executionKind: 'local' }],
    });

    primary.send({ type: 'close' }); // primary's own close disposes — kills the real process

    handler({ data: { type: 'list-runs', requestId: 'lr-after-close' }, ports: [] });
    expect(posted).toContainEqual({ type: 'run-list', requestId: 'lr-after-close', runs: [] });
  });
});

describe('interpreter-process — SSH late attach policy', () => {
  afterEach(() => {
    vi.doUnmock('./ssh-session');
    vi.resetModules();
  });

  it('warns then rejects the mirror while leaving the primary SSH run alive', async () => {
    vi.doMock('./ssh-session', async () => {
      const actual = await vi.importActual<typeof import('./ssh-session')>('./ssh-session');
      const runSshSession: typeof actual.runSshSession = (
        _data,
        emit,
        _signal,
        _deps,
        _cols,
        _rows,
        connectionId = 'ssh-test',
      ) => {
        emit({ type: 'schema', columns: [], shape: 'pty' });
        return {
          connectionId,
          ready: true,
          handlePromptResponse() {},
          write() {},
          resize() {},
          ack() {},
          openForward: async () => {
            throw new Error('not used');
          },
          dispose() {},
        };
      };
      return { ...actual, runSshSession };
    });

    const { handler, posted } = await importInterpreter();
    handler({ data: { type: 'create-session', requestId: 'req-ssh' }, ports: [] });
    const created = posted.find(
      (message): message is { type: 'session-created'; sessionId: string } =>
        (message as { type?: string }).type === 'session-created',
    );
    if (!created) throw new Error('session-created reply never arrived');

    const primary = new FakePort();
    handler({
      data: {
        type: 'run',
        runId: 'run-ssh',
        sessionId: created.sessionId,
        commandText: 'ssh-connect alice@example.com',
      },
      ports: [primary],
    });
    const mirror = new FakePort();
    handler({
      data: {
        type: 'attach-run',
        requestId: 'attach-ssh',
        sessionId: created.sessionId,
        runId: 'run-ssh',
      },
      ports: [mirror],
    });

    expect(mirror.posted).toEqual([
      {
        type: 'pty-restore-warning',
        reason: 'ssh-late-attach-unsupported',
        fallback: 'none',
      },
      { type: 'error', message: 'Late attach is not supported for SSH runs' },
    ]);
    expect(mirror.closed).toBe(true);
    expect(primary.closed).toBe(false);
    expect(posted).toContainEqual({
      type: 'run-attach-result',
      requestId: 'attach-ssh',
      accepted: false,
      reason: 'ssh-unsupported',
    });

    handler({ data: { type: 'list-runs', requestId: 'ssh-still-live' }, ports: [] });
    const live = posted.find(
      (message): message is { type: 'run-list'; requestId: string; runs: unknown[] } =>
        (message as { requestId?: string }).requestId === 'ssh-still-live',
    );
    expect(live?.runs).toHaveLength(1);
    primary.send({ type: 'close' });
  });
});
