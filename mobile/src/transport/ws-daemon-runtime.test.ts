import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonEvent,
  type DaemonSnapshot,
} from '../../../src/shared/daemon-protocol';
import { REMOTE_PROTOCOL_VERSION } from '../../../src/shared/remote-protocol';
import type { PlanningCommand, PlanningSnapshot } from '../../../src/shared/planning';
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

function planningSnapshot(): PlanningSnapshot {
  return {
    schemaVersion: 1, projectId: 'project', revision: 0,
    draft: { id: 'draft-1', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] },
    baselines: [], history: [], profileProposals: [],
  };
}

describe('planning over the authenticated mobile transport', () => {
  it('rejects malformed or cross-kind asset replies and leaves interrupted archive/AI requests unconfirmed', async () => {
    const { createSocket, sockets } = socketFactory(); let sequence = 0;
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => `extension-${++sequence}` });
    sockets[0].message({ kind: 'auth-ok' });
    const asset = transport.executePlanningAsset({ type: 'read', projectId: 'project', assetId: 'logo' });
    const assetRequest = sockets[0].lastSent() as { requestId: string };
    sockets[0].message({ kind: 'planning-asset-reply', requestId: assetRequest.requestId, result: { ok: true, asset: { id: 'logo' }, dataBase64: '<script/>' } });
    expect(await asset).toMatchObject({ ok: false });
    const crossed = transport.executePlanningAsset({ type: 'read', projectId: 'project', assetId: 'logo' });
    const crossedRequest = sockets[0].lastSent() as { requestId: string };
    sockets[0].message({ kind: 'planning-ai-reply', requestId: crossedRequest.requestId, result: { ok: true, jobs: [] } });
    expect(await crossed).toMatchObject({ ok: false });
    const archive = transport.executeProjectArchive({ type: 'export', projectId: 'project', commandId: 'stable-export' });
    const ai = transport.planningAiRequest({ type: 'read', projectId: 'project', requestId: 'saved-proposal' });
    transport.disconnect();
    expect(await archive).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await ai).toMatchObject({ ok: false });
    expect(sockets[0].sent.map(raw => JSON.parse(raw)).filter(message => message.kind === 'project-archive-request')).toHaveLength(1);
  });

  it('correlates and validates project snapshots without accepting another project', async () => {
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'read-1' });
    sockets[0].message({ kind: 'auth-ok' });
    const read = transport.getPlanningSnapshot('project');
    expect(sockets[0].lastSent()).toEqual({ kind: 'planning-read', requestId: 'read-1', projectId: 'project' });
    sockets[0].message({ kind: 'planning-read-reply', requestId: 'read-1', result: { ok: true, snapshot: planningSnapshot() } });
    expect(await read).toEqual({ ok: true, snapshot: planningSnapshot() });
    const wrong = transport.getPlanningSnapshot('project');
    sockets[0].message({ kind: 'planning-read-reply', requestId: 'read-1', result: { ok: true, snapshot: { ...planningSnapshot(), projectId: 'other' } } });
    expect(await wrong).toMatchObject({ ok: false, error: 'invalid' });
    transport.disconnect();
  });

  it('preserves an unconfirmed command for explicit reconciliation instead of auto-replaying it', async () => {
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket, newId: () => 'command-1' });
    sockets[0].message({ kind: 'auth-ok' });
    const command: PlanningCommand = {
      commandId: 'stable-change', projectId: 'project', expectedRevision: 0,
      actor: { kind: 'user', id: 'client' }, type: 'planning.freeze',
      payload: { baselineId: 'approved', title: 'Approved' },
    };
    const write = transport.executePlanningCommand(command);
    expect(sockets[0].lastSent()).toEqual({ kind: 'planning-execute', requestId: 'command-1', command });
    transport.disconnect();
    expect(await write).toMatchObject({ ok: false, error: 'unavailable' });
    expect(sockets[0].sent.map((raw) => JSON.parse(raw)).filter((msg) => msg.kind === 'planning-execute')).toHaveLength(1);
  });

  it('declines planning commands when the host cannot negotiate the new protocol', async () => {
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].message({ kind: 'auth-ok', protocolVersion: 12 });
    expect(await transport.getPlanningSnapshot('project')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(sockets[0].sent.map((raw) => JSON.parse(raw)).some((msg) => msg.kind === 'planning-read')).toBe(false);
    transport.disconnect();
  });
});

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

describe('unified picker fallback on an explicitly negotiated older host', () => {
  it.each([12, 13, 14])('lists and lazily reads native history through the picker client on v%s without adoption writes', async protocolVersion => {
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({ url: 'ws://x', token: 'tok', createSocket });
    sockets[0].message({ kind: 'auth-ok', protocolVersion });
    expect(transport.isAuthed).toBe(true);
    const listing = transport.listConversations({ source: 'native' });
    const readRequest = sockets[0].lastSent() as { kind: string; requestId: string }; expect(readRequest.kind).toBe('daemon-snapshot-get');
    sockets[0].message({ kind: 'daemon-snapshot', requestId: readRequest.requestId, snapshot: snapshot(1, 1) });
    await vi.waitFor(() => expect(sockets[0].lastSent()).toMatchObject({ kind: 'agent-projects-list' }));
    const projects = sockets[0].lastSent() as { requestId: string };
    sockets[0].message({ kind: 'agent-projects-list-reply', requestId: projects.requestId, result: { items: [{ projectId: 'project', name: 'Native project', primaryRoot: '/work', additionalRoots: [], pinned: false, saved: true, sessionCount: 1, providers: ['codex'], lastActiveAt: 2 }], nextCursor: null } });
    await vi.waitFor(() => expect(sockets[0].lastSent()).toMatchObject({ kind: 'agent-history-sessions' }));
    const sessions = sockets[0].lastSent() as { requestId: string };
    sockets[0].message({ kind: 'agent-history-sessions-reply', requestId: sessions.requestId, result: { items: [{ historyId: 'codex_opaque', projectId: 'project', provider: 'codex', title: 'Old task', preview: 'Old prompt', createdAt: 1, updatedAt: 2, roots: ['/work'], source: 'cli' }], nextCursor: null } });
    const rows = await listing; expect(rows).toMatchObject({ ok: true, items: [{ source: 'native', historyId: 'codex_opaque', action: 'unavailable' }] });
    if (!rows.ok) throw new Error(rows.message);
    const preview = transport.readConversation(rows.items[0].conversationId);
    const requested = sockets[0].lastSent() as { kind: string; requestId: string }; expect(requested.kind).toBe('agent-history-read');
    sockets[0].message({ kind: 'agent-history-read-reply', requestId: requested.requestId, result: { historyId: 'codex_opaque', provider: 'codex', turns: [{ id: 'turn', status: 'completed', entries: [{ type: 'message', id: 'item', role: 'user', markdown: 'Full old prompt' }] }], nextCursor: null } });
    expect(await preview).toMatchObject({ ok: true, transcript: { turns: [{ entries: [{ markdown: 'Full old prompt' }] }] } });
    expect(await transport.prepareHistoryResume({ conversationId: rows.items[0].conversationId })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(sockets[0].sent.map(value => JSON.parse(value)).some(message => message.kind.startsWith('conversation-history-'))).toBe(false);
    transport.disconnect();
  });
});

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

  it('enters terminal-only safe mode without retrying daemon requests or disconnecting', async () => {
    const { createSocket, sockets } = socketFactory();
    const transport = new WsEzTerminalTransport({
      url: 'ws://x', token: 'tok', createSocket, newId: () => 'safe-request',
    });
    const states: string[] = [];
    transport.onDaemonRuntimeState((state) => states.push(state.status));
    sockets[0].message({ kind: 'auth-ok' });
    sockets[0].message({
      kind: 'daemon-availability',
      availability: {
        state: 'legacy-only-safe-mode',
        initializationCode: 'future-schema',
        databaseDisposition: 'preserved',
        supportedSchemaVersion: 3,
        currentSchemaVersion: 4,
      },
    });

    const sentBeforeRequests = sockets[0].sent.length;
    await expect(transport.getDaemonSnapshot()).resolves.toBeNull();
    await transport.setDaemonEventsSubscribed(true);
    const receipt = await transport.sendDaemonCommand(createDaemonCommand({
      commandId: 'safe-command',
      idempotencyKey: 'safe-command',
      expectedRevision: 0,
      issuedAt: NOW,
      principal: { kind: 'android', id: 'phone-1' },
      type: 'runtime.set-settings',
      payload: { browserEnabled: false },
    }));

    expect(states.at(-1)).toBe('safe-mode');
    expect(receipt).toMatchObject({
      ok: false,
      status: 'rejected',
      error: { code: 'internal-error', retryable: false },
    });
    expect(sockets[0].sent).toHaveLength(sentBeforeRequests);
    expect(sockets[0].readyState).toBe(1);
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
