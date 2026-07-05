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
  return { sessionId, primary };
}

describe('interpreter-process — ExecutionSession port fanout (M2 T2.2b, Critic C3)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('an attach-run mirrors the run to a second, non-initiating port', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    expect(primary.posted.some((f) => (f as InterpreterFrame).type === 'start')).toBe(true);

    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach] });

    // The attach port learns at least that the block has started (T2.2d replay).
    expect(attach.posted.some((f) => (f as InterpreterFrame).type === 'start')).toBe(true);
  });

  it('an attach-run for an unknown/already-ended runId is rejected (error frame), never resurrected', async () => {
    const { handler, posted } = await importInterpreter();
    beginRun(handler, posted, 'run-1');

    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'no-such-run' }, ports: [attach] });

    expect(attach.posted).toEqual([{ type: 'error', message: 'run no-such-run does not exist' }]);
    expect(attach.closed).toBe(true);
  });

  it('closing the ATTACH port does NOT dispose the run — the primary stays open', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach] });

    attach.close(); // the mirror's transport disconnects

    expect(primary.closed).toBe(false);
    // The run is still tracked — a fresh attach-run for the same runId still succeeds.
    const attach2 = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach2] });
    expect(attach2.posted.some((f) => (f as { type?: string }).type === 'error')).toBe(false);
  });

  it('the PRIMARY port disconnecting (transport close, not a control) while an attach remains open does NOT dispose the run', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach] });

    primary.close();

    expect(attach.closed).toBe(false);
  });

  it('the LAST remaining port closing tears the run down — a later attach-run is then rejected', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach] });

    attach.close(); // one port left (primary) — not yet disposed
    primary.close(); // now zero — last-port-close disposes

    const late = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [late] });
    expect(late.posted).toEqual([{ type: 'error', message: 'run run-1 does not exist' }]);
  });

  it('a {type:"close"} CONTROL on the PRIMARY port disposes unconditionally, closing every attach port too, even though they never disconnected', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach] });

    primary.send({ type: 'close' });

    expect(primary.closed).toBe(true);
    expect(attach.closed).toBe(true);
    const late = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [late] });
    expect(late.posted).toEqual([{ type: 'error', message: 'run run-1 does not exist' }]);
  });

  it('a {type:"close"} CONTROL on an ATTACH port only detaches that one port — the run and primary stay alive', async () => {
    const { handler, posted } = await importInterpreter();
    const { primary } = beginRun(handler, posted, 'run-1');
    const attach = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [attach] });

    attach.send({ type: 'close' });

    expect(attach.closed).toBe(true); // detached
    expect(primary.closed).toBe(false); // run untouched

    const late = new FakePort();
    handler({ data: { type: 'attach-run', runId: 'run-1' }, ports: [late] });
    expect(late.posted.some((f) => (f as { type?: string }).type === 'error')).toBe(false); // still alive
  });
});
