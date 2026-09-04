import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonEvent,
  type DaemonSnapshot,
} from '../../../src/shared/daemon-protocol';
import { REMOTE_PROTOCOL_VERSION } from '../../../src/shared/remote-protocol';
import {
  WsEzTerminalTransport,
  type CreateSocket,
  type WsLike,
} from './ws-ezterminal';

type Handler = (...args: never[]) => void;

class FakeSocket implements WsLike {
  readonly sent: string[] = [];
  readyState = 1;
  private readonly handlers: Record<'open' | 'message' | 'close' | 'error', Handler[]> = {
    open: [], message: [], close: [], error: [],
  };

  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: never): void {
    this.handlers[type].push(listener as Handler);
  }
  message(value: unknown): void {
    const normalized = (value as { kind?: string })?.kind === 'auth-ok'
      ? { protocolVersion: REMOTE_PROTOCOL_VERSION, hostVersion: '1.0.0-test', ...(value as object) }
      : value;
    const event = { data: JSON.stringify(normalized) };
    for (const handler of this.handlers.message) handler(event as never);
  }
  end(): void {
    this.readyState = 3;
    for (const handler of this.handlers.close) handler();
  }
  lastSent(): unknown { return JSON.parse(this.sent.at(-1)!); }
}

function socketFactory(): { readonly createSocket: CreateSocket; readonly sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

const NOW = '2026-09-04T00:00:00.000Z';

function snapshot(revision: number, eventSequence: number): DaemonSnapshot {
  return {
    protocolVersion: 12,
    revision,
    eventSequence,
    generatedAt: NOW,
    runtime: {
      keepRunning: false,
      startAtLogin: false,
      orchestrationToolsEnabled: true,
      browserEnabled: false,
    },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers: [],
    schedules: [],
    heartbeats: [],
  };
}

function event(sequence: number, revision: number): DaemonEvent {
  return {
    protocolVersion: 12,
    eventId: `event-${sequence}`,
    sequence,
    revision,
    occurredAt: NOW,
    kind: 'entity.upserted',
    payload: { entityType: 'session', entityId: `session-${sequence}` },
  };
}

describe('WsEzTerminalTransport daemon runtime v12', () => {
  afterEach(() => vi.useRealTimers());

  it('subscribes with a v12 cursor, correlates the snapshot, and unsubscribes', async () => {
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, newId: () => 'snapshot-1',
    });
    const states: Array<{ status: string; revision?: number }> = [];
    transport.onDaemonRuntimeState((state) => states.push({
      status: state.status,
      revision: state.snapshot?.revision,
    }));
    transport.setDaemonEventsSubscribed(true);
    sockets[0].message({ kind: 'auth-ok' });

    const sent = sockets[0].sent.map((raw) => JSON.parse(raw));
    expect(sent).toContainEqual({ kind: 'daemon-events-subscribe', afterSequence: 0 });
    expect(sent).toContainEqual({ kind: 'daemon-snapshot-get', requestId: 'snapshot-1' });
    sockets[0].message({
      kind: 'daemon-snapshot', requestId: 'snapshot-1', snapshot: snapshot(3, 5),
    });
    await Promise.resolve();
    expect(states.at(-1)).toEqual({ status: 'ready', revision: 3 });

    transport.setDaemonEventsSubscribed(false);
    expect(sockets[0].lastSent()).toEqual({ kind: 'daemon-events-unsubscribe' });
    transport.disconnect();
  });

  it('takes a fresh authoritative snapshot after reconnect even when its revision is lower', async () => {
    vi.useFakeTimers();
    let id = 0;
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, initialBackoffMs: 10,
      newId: () => `snapshot-${++id}`,
    });
    const revisions: number[] = [];
    transport.onDaemonRuntimeState((state) => {
      if (state.status === 'ready' && state.snapshot) revisions.push(state.snapshot.revision);
    });
    transport.setDaemonEventsSubscribed(true);
    sockets[0].message({ kind: 'auth-ok' });
    sockets[0].message({ kind: 'daemon-snapshot', requestId: 'snapshot-1', snapshot: snapshot(9, 20) });
    await Promise.resolve();

    sockets[0].end();
    await vi.advanceTimersByTimeAsync(10);
    sockets[1].message({ kind: 'auth-ok' });
    expect(sockets[1].sent.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: 'daemon-events-subscribe', afterSequence: 20,
    });
    sockets[1].message({ kind: 'daemon-snapshot', requestId: 'snapshot-2', snapshot: snapshot(1, 2) });
    await Promise.resolve();

    expect(revisions).toEqual([9, 1]);
    expect(sockets[1].sent.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: 'daemon-events-subscribe', afterSequence: 2,
    });
    transport.disconnect();
  });

  it('classifies duplicate and gap events, then resubscribes from recovery', async () => {
    let id = 0;
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, newId: () => `snapshot-${++id}`,
    });
    const continuity: string[] = [];
    const states: string[] = [];
    transport.onDaemonEvent((_event, classification) => continuity.push(classification));
    transport.onDaemonRuntimeState((state) => states.push(`${state.status}:${state.error ?? 'ok'}`));
    transport.setDaemonEventsSubscribed(true);
    sockets[0].message({ kind: 'auth-ok' });
    sockets[0].message({ kind: 'daemon-snapshot', requestId: 'snapshot-1', snapshot: snapshot(4, 10) });
    await Promise.resolve();

    sockets[0].message({ kind: 'daemon-event', event: event(11, 5) });
    sockets[0].message({ kind: 'daemon-event', event: event(11, 5) });
    sockets[0].message({ kind: 'daemon-event', event: event(14, 6) });
    expect(continuity).toEqual(['next', 'duplicate', 'gap']);
    expect(states.at(-1)).toBe('recovering:event-gap');

    sockets[0].message({ kind: 'daemon-snapshot', requestId: 'snapshot-2', snapshot: snapshot(6, 14) });
    await Promise.resolve();
    expect(sockets[0].sent.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: 'daemon-events-subscribe', afterSequence: 14,
    });
    expect(states).toContain('ready:ok');
    transport.disconnect();
  });

  it('correlates command receipts and marks a dropped command delivery-uncertain', async () => {
    let id = 0;
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, newId: () => `request-${++id}`,
    });
    sockets[0].message({ kind: 'auth-ok' });
    const command = createDaemonCommand({
      commandId: 'command-1',
      idempotencyKey: 'mobile-command-1',
      expectedRevision: 0,
      issuedAt: NOW,
      principal: { kind: 'android', id: 'phone-1' },
      type: 'runtime.set-settings',
      payload: { browserEnabled: false },
    });
    const applied = transport.sendDaemonCommand(command);
    expect(sockets[0].lastSent()).toEqual({ kind: 'daemon-command', requestId: 'request-1', command });
    sockets[0].message({
      kind: 'daemon-command-reply',
      requestId: 'some-other-request',
      receipt: { ok: true, status: 'applied', commandId: 'command-1', revision: 1, eventSequence: 1 },
    });
    sockets[0].message({
      kind: 'daemon-command-reply',
      requestId: 'request-1',
      receipt: { ok: true, status: 'applied', commandId: 'command-1', revision: 1, eventSequence: 1 },
    });
    await expect(applied).resolves.toMatchObject({ ok: true, commandId: 'command-1' });

    const uncertainCommand = createDaemonCommand({
      ...command,
      commandId: 'command-2',
      idempotencyKey: 'mobile-command-2',
    });
    const uncertain = transport.sendDaemonCommand(uncertainCommand);
    sockets[0].end();
    await expect(uncertain).resolves.toMatchObject({
      ok: false,
      status: 'delivery-uncertain',
      commandId: 'command-2',
      error: { code: 'delivery-uncertain', retryable: false },
    });
    transport.disconnect();
  });

  it('correlates bounded transcript pages and rejects a mismatched session response', async () => {
    let id = 0;
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, newId: () => `request-${++id}`,
    });
    sockets[0].message({ kind: 'auth-ok' });

    const transcript = transport.getDaemonTranscript('agent-1', 4, 25);
    expect(sockets[0].lastSent()).toEqual({
      kind: 'daemon-transcript-get',
      requestId: 'request-1',
      sessionId: 'agent-1',
      afterSequence: 4,
      limit: 25,
    });
    sockets[0].message({
      kind: 'daemon-transcript',
      requestId: 'request-1',
      sessionId: 'agent-1',
      items: [{
        id: 'transcript-5',
        sessionId: 'agent-1',
        turnId: 'turn-1',
        sequence: 5,
        kind: 'assistant-message',
        text: 'Done.',
        isDelta: false,
        isSensitive: false,
        createdAt: NOW,
      }],
    });
    await expect(transcript).resolves.toMatchObject([{
      id: 'transcript-5', sessionId: 'agent-1', sequence: 5, text: 'Done.',
    }]);

    const mismatched = transport.getDaemonTranscript('agent-1');
    sockets[0].message({
      kind: 'daemon-transcript',
      requestId: 'request-2',
      sessionId: 'agent-2',
      items: [],
    });
    await expect(mismatched).resolves.toEqual([]);
    transport.disconnect();
  });
});
