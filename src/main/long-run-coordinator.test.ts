import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DaemonAgent, type DaemonAgentRelation, type DaemonApproval, type DaemonCommand, type DaemonCommandReceipt, type DaemonEvent, type DaemonSession, type DaemonSnapshot,
  type DaemonTranscriptItem, type DaemonTurn,
} from '../shared/daemon-protocol';
import { LONG_RUN_PRINCIPAL, RESUME_TEXT, RESUME_TIMING, type LimitAction, type LongRunSettings, type ProviderUsageLimit, type UsageLimitReading } from '../shared/long-run';
import { parseTranscriptPayload } from '../shared/transcript-payload';
import type { AgentProviderAdapter } from './agent-provider-adapter';
import type { DaemonCommandExecutionResult } from './daemon-command-router';
import type { DaemonStoreCommit, DaemonTranscriptItemInput } from './daemon-store';
import { limitRowItem, LongRunCoordinator, steerRowItem, type LimitJobRecord, type SteerRecord } from './long-run-coordinator';

const STOPPED = '2026-11-01T10:00:00.000Z';
const stoppedMs = Date.parse(STOPPED);
const inHours = (hours: number): string => new Date(stoppedMs + hours * 3_600_000).toISOString();
const RESET = inHours(2);
const RESUME = new Date(Date.parse(RESET) + RESUME_TIMING.afterResetMs).toISOString();
const fiveHour: ProviderUsageLimit = { kind: 'resettable', window: 'five-hour', resetsAt: RESET };

const session = (id: string, patch: Partial<DaemonSession> = {}): DaemonSession => ({
  id, projectId: 'project', workspaceId: 'workspace', kind: 'agent', title: id, state: 'idle', source: 'structured', revision: 1, createdAt: '', updatedAt: '', ...patch,
});
const agent = (sessionId: string, patch: Partial<DaemonAgent> = {}): DaemonAgent => ({
  id: sessionId, sessionId, providerId: 'claude', providerSessionId: `provider-${sessionId}`, state: 'idle', permissionPreset: 'standard', queuedTurnCount: 0, revision: 1, createdAt: '', updatedAt: '', ...patch,
} as DaemonAgent);
const turn = (id: string, patch: Partial<DaemonTurn> = {}): DaemonTurn => ({
  id, sessionId: 'chat', commandId: `command-${id}`, enqueueSequence: 1, state: 'failed', errorCode: 'usage-limit', revision: 1, createdAt: '', updatedAt: '', ...patch,
} as DaemonTurn);
const relation = (childSessionId: string, patch: Partial<DaemonAgentRelation> = {}): DaemonAgentRelation => ({
  id: `relation-${childSessionId}`, treeId: 'tree', parentSessionId: 'chat', childSessionId, owner: 'managed', depth: 1, revision: 1, createdAt: '', updatedAt: '', ...patch,
});

interface HarnessOptions {
  readonly jobs?: unknown;
  readonly steers?: unknown;
  readonly reconcile?: AgentProviderAdapter['reconcile'];
  readonly settings?: LongRunSettings | undefined;
  readonly unattended?: boolean;
  readonly conversation?: boolean;
  readonly prepared?: boolean;
  readonly recoverLimit?: AgentProviderAdapter['recoverLimit'];
  readonly capability?: boolean;
  readonly commands?: readonly string[];
  readonly now?: () => Date;
  readonly snapshot?: Partial<DaemonSnapshot>;
  readonly execute?: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly providerOff?: boolean;
  readonly transcript?: () => readonly DaemonTranscriptItem[];
}

function harness(options: HarnessOptions = {}) {
  const held = { snapshot: {
    sessions: [session('chat')], agents: [agent('chat')], turns: [turn('turn-1')], agentRelations: [], providers: [{ id: 'claude' }, { id: 'codex' }], approvals: [], revision: 7,
    ...options.snapshot,
  } as unknown as DaemonSnapshot };
  const rows: DaemonTranscriptItemInput[] = [];
  const order: string[] = [];
  const saved: { jobs: Readonly<Record<string, LimitJobRecord>>; steers: Readonly<Record<string, SteerRecord>> } = { jobs: {}, steers: {} };
  const listeners = new Set<(event: DaemonEvent) => void>();
  const events: unknown[] = [];
  const wakeQueuedTurns = vi.fn();
  const settings = { current: 'settings' in options ? options.settings : { autoResume: true } };
  const sent: DaemonCommand[] = [];
  const applied = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 8 } as DaemonCommandReceipt);
  const coordinator = new LongRunCoordinator({
    execute: async (command) => {
      sent.push(command);
      return options.execute ? options.execute(command) : applied(command);
    },
    readTranscript: (_sessionId, afterSequence) => (options.transcript?.() ?? []).filter((item) => item.sequence > afterSequence),
    getSnapshot: () => held.snapshot,
    applySystemCommit: async (commit) => {
      const planned: DaemonStoreCommit | undefined = typeof commit === 'function' ? commit(held.snapshot) ?? undefined : commit;
      for (const mutation of planned?.mutations ?? []) if (mutation.kind === 'transcript.append') rows.push(...mutation.items);
      events.push(...(planned?.events ?? []));
      if (planned?.mutations?.length) order.push('row');
    },
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    wakeQueuedTurns,
    commandExists: (commandId) => (options.commands ?? []).includes(commandId),
    store: {
      load: async () => ({ jobs: options.jobs, steers: options.steers }),
      save: async (state) => { order.push('file'); saved.jobs = state.jobs; saved.steers = state.steers; },
    },
    providers: {
      longRunCapability: () => (options.capability === false ? undefined : { minimumVersion: '1.0.0' }),
      enabledAdapter: () => (options.providerOff ? { ok: false, message: 'off' } : { ok: true, value: { recoverLimit: options.recoverLimit, reconcile: options.reconcile } as AgentProviderAdapter }),
    },
    settings: () => settings.current,
    allowed: (_sessionId, askedTurn) => (options.conversation !== false && !(askedTurn && options.unattended)),
    prepared: () => options.prepared === true,
    now: options.now ?? (() => new Date(stoppedMs)),
  });
  const stop = (limit: ProviderUsageLimit = fiveHour, id = 'turn-1', sessionId = 'chat'): void => {
    coordinator.limitStopped({ sessionId, providerId: 'claude', turn: turn(id, { sessionId }), limit, stoppedAt: STOPPED });
  };
  const cards = () => rows.map((row) => parseTranscriptPayload(row.payload)).filter((payload) => payload?.type === 'usage-limit');
  const emit = (event: DaemonEvent): void => { for (const listener of listeners) listener(event); };
  return { coordinator, held, rows, order, saved, listeners, events, wakeQueuedTurns, settings, stop, cards, lastCard: () => cards().at(-1), sent, emit };
}

const job = (patch: Partial<LimitJobRecord> = {}): LimitJobRecord => ({
  stopId: 'stop-1', sessionId: 'chat', turnId: 'turn-1', providerId: 'claude', phase: 'waiting', window: 'five-hour', stoppedAt: STOPPED, resetsAt: RESET, resumeAt: RESUME, attempt: 0, revision: 1, ...patch,
});

describe('a stop becomes a card', () => {
  it('a known reset within hours waits for its time plus two minutes', async () => {
    const h = harness();
    h.stop();
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting', window: 'five-hour', turnId: 'turn-1', providerId: 'claude', stoppedAt: STOPPED, resetsAt: RESET, resumeAt: RESUME });
  });

  it('writes the file before the row, and the row is a notice that reads on its own', async () => {
    const h = harness();
    h.stop();
    await h.coordinator.settled();
    expect(h.order.slice(0, 2)).toEqual(['file', 'row']);
    expect(Object.values(h.saved.jobs)).toEqual([expect.objectContaining({ phase: 'waiting', sessionId: 'chat', attempt: 0 })]);
    expect(h.rows[0]).toMatchObject({ kind: 'notice', sessionId: 'chat', turnId: 'turn-1', isSensitive: false, isDelta: false });
    expect(h.rows[0]?.text).toMatch(/usage limit/u);
    expect(parseTranscriptPayload(h.rows[0]?.payload)).toBeDefined();
  });

  it('tells clients to read the snapshot again', async () => {
    const h = harness();
    h.stop();
    await h.coordinator.settled();
    expect(h.events).toContainEqual({ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: 'chat' } });
  });

  it('asks first for a weekly limit, a reset past six hours, and a turn no person sent', async () => {
    const weekly = harness();
    weekly.stop({ kind: 'resettable', window: 'weekly', resetsAt: RESET });
    await weekly.coordinator.settled();
    expect(weekly.lastCard()).toMatchObject({ phase: 'ask-reset', resumeAt: RESUME });

    const far = harness();
    far.stop({ kind: 'resettable', window: 'five-hour', resetsAt: inHours(6.5) });
    await far.coordinator.settled();
    expect(far.lastCard()).toMatchObject({ phase: 'ask-reset' });

    const unattended = harness({ unattended: true });
    unattended.stop();
    await unattended.coordinator.settled();
    expect(unattended.lastCard()).toMatchObject({ phase: 'ask-reset' });
  });

  it('asks when no time is known', async () => {
    const h = harness();
    h.stop({ kind: 'resettable', window: 'unknown' });
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'ask-unknown', window: 'unknown' });
    expect(h.lastCard()).not.toHaveProperty('resumeAt');
  });

  it('with the setting off a stop that would wait is off instead; one that asks still asks', async () => {
    const off = harness({ settings: { autoResume: false } });
    off.stop();
    await off.coordinator.settled();
    expect(off.lastCard()).toMatchObject({ phase: 'off', offBy: 'setting' });

    const weekly = harness({ settings: { autoResume: false } });
    weekly.stop({ kind: 'resettable', window: 'weekly', resetsAt: RESET });
    await weekly.coordinator.settled();
    expect(weekly.lastCard()).toMatchObject({ phase: 'ask-reset' });
  });

  it('asks rather than waits until the setting has loaded', async () => {
    const h = harness({ settings: undefined });
    h.stop();
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'ask-reset' });
  });

  it('a reset already past still waits its own two minutes', async () => {
    const h = harness();
    h.stop({ kind: 'resettable', window: 'five-hour', resetsAt: inHours(-1) });
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting', resumeAt: new Date(stoppedMs + RESUME_TIMING.afterResetMs).toISOString() });
  });

  it('a plan without this AI gets a card and nothing more: it holds nothing and stays in no file', async () => {
    const h = harness();
    h.stop({ kind: 'not-included', window: 'unknown' });
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'other' })).toBe(true);
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'not-included' });
    expect(h.saved.jobs).toEqual({});
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
  });

  it('a managed child never resumes by itself, and nothing can be offered yet (D7)', async () => {
    const h = harness({ conversation: false, snapshot: { agentRelations: [relation('chat')] } });
    h.stop();
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'child', childKind: 'managed' });
    expect(h.saved.jobs).toEqual({});
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'other' })).toBe(true);
  });

  it('a session that is neither gets no card', async () => {
    const h = harness({ conversation: false });
    h.stop();
    await h.coordinator.settled();
    expect(h.rows).toEqual([]);
  });

  it('keeps one card when another turn is refused while it is open: the card moves down', async () => {
    const h = harness();
    h.stop();
    await h.coordinator.settled();
    const stopId = h.lastCard()?.stopId;
    h.stop({ kind: 'resettable', window: 'unknown', resetsAt: inHours(3) }, 'turn-2');
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ stopId, turnId: 'turn-2', window: 'five-hour', resetsAt: inHours(3) });
    expect(new Set(h.rows.map((row) => row.id)).size).toBe(h.rows.length);
    expect(Object.keys(h.saved.jobs)).toHaveLength(1);
  });

  it('gives each stop its own id, derived from the turn', async () => {
    const one = harness();
    one.stop();
    const again = harness();
    again.stop();
    const other = harness();
    other.stop(fiveHour, 'turn-2');
    await Promise.all([one.coordinator.settled(), again.coordinator.settled(), other.coordinator.settled()]);
    expect(one.lastCard()?.stopId).toBe(again.lastCard()?.stopId);
    expect(one.lastCard()?.stopId).not.toBe(other.lastCard()?.stopId);
  });
});

describe('the reset comes later', () => {
  const unknown: ProviderUsageLimit = { kind: 'resettable', window: 'unknown' };

  it('asks the provider when a stop names no reset, and schedules from its answer', async () => {
    const recoverLimit = vi.fn(async (): Promise<UsageLimitReading> => ({ window: 'five-hour', resetsAt: RESET }));
    const h = harness({ recoverLimit });
    h.stop(unknown);
    await vi.waitFor(() => expect(h.lastCard()).toMatchObject({ phase: 'waiting', window: 'five-hour', resetsAt: RESET, resumeAt: RESUME }));
    expect(recoverLimit).toHaveBeenCalledWith('chat', 'provider-chat');
    expect(h.cards().map((card) => card?.phase)).toEqual(['ask-unknown', 'waiting']);
  });

  it('a weekly answer still asks first', async () => {
    const h = harness({ recoverLimit: async () => ({ window: 'weekly', resetsAt: RESET }) });
    h.stop(unknown);
    await vi.waitFor(() => expect(h.lastCard()).toMatchObject({ phase: 'ask-reset', window: 'weekly' }));
  });

  it('with no answer, or no time in it, the card stays as it is', async () => {
    for (const recoverLimit of [async () => undefined, async () => ({ window: 'five-hour' as const })]) {
      const h = harness({ recoverLimit });
      h.stop(unknown);
      await h.coordinator.settled();
      await new Promise((resolve) => setImmediate(resolve));
      await h.coordinator.settled();
      expect(h.cards().map((card) => card?.phase)).toEqual(['ask-unknown']);
    }
  });

  it('does not ask when the stop named a reset', async () => {
    const recoverLimit = vi.fn(async () => undefined);
    const h = harness({ recoverLimit });
    h.stop();
    await h.coordinator.settled();
    expect(recoverLimit).not.toHaveBeenCalled();
  });
});

describe('the queue behind a stop', () => {
  it('holds from the moment the runtime hands the stop over, before anything is written', () => {
    const h = harness();
    h.stop();
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(false);
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'elsewhere', commandId: 'queued' })).toBe(true);
  });

  it('lets the send that resumes it through', async () => {
    const h = harness({ jobs: { 'stop-1': job({ phase: 'resuming', sending: { commandId: 'send-1', reason: 'scheduled-time', from: 'waiting' } }) } });
    await h.coordinator.load();
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'send-1' })).toBe(true);
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'other' })).toBe(false);
  });

  it('holds across a restart from the first pass: loading is enough', async () => {
    const h = harness({ jobs: { 'stop-1': job() } });
    await h.coordinator.load();
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(false);
  });

  it('a card that was left holds nothing', async () => {
    const h = harness({ jobs: { 'stop-1': job({ phase: 'left', resumeAt: undefined }) } });
    await h.coordinator.load();
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(true);
  });
});

describe('whether a stop is open', () => {
  it('holds for a stop that holds, and not for one let go or finished', async () => {
    const h = harness({ jobs: { 'stop-1': job() } });
    await h.coordinator.start();
    expect(h.coordinator.limitOpen('chat')).toBe(true);
    expect(h.coordinator.limitOpen('other')).toBe(false);
    const left = harness({ jobs: { 'stop-1': job({ phase: 'left' }) } });
    await left.coordinator.start();
    expect(left.coordinator.limitOpen('chat')).toBe(false);
  });
});

describe('what the snapshot carries', () => {
  it('open stops by conversation, without what only the host needs', async () => {
    const h = harness();
    h.stop();
    await h.coordinator.settled();
    const limits = h.coordinator.usageLimits(h.held.snapshot);
    expect(Object.keys(limits ?? {})).toEqual(['chat']);
    expect(limits?.chat).toMatchObject({ phase: 'waiting', stopId: expect.any(String), resumeAt: RESUME });
    for (const key of ['sessionId', 'attempt', 'revision', 'sending']) expect(limits?.chat).not.toHaveProperty(key);
  });

  it('nothing when nothing is open, or for an archived conversation', async () => {
    const h = harness();
    expect(h.coordinator.usageLimits(h.held.snapshot)).toBeUndefined();
    h.stop();
    await h.coordinator.settled();
    expect(h.coordinator.usageLimits({ sessions: [session('chat', { archivedAt: STOPPED })] })).toBeUndefined();
    expect(h.coordinator.usageLimits({ sessions: [] })).toBeUndefined();
  });

  it('never a card that holds nothing', async () => {
    const h = harness({ jobs: { 'stop-1': job({ phase: 'left' }) } });
    await h.coordinator.load();
    expect(h.coordinator.usageLimits(h.held.snapshot)).toBeUndefined();
  });
});

describe('who launches with it', () => {
  it('a conversation or a managed child, on an AI at or past the measured version', () => {
    expect(harness().coordinator.sessionContext('chat')).toBe(true);
    expect(harness({ capability: false }).coordinator.sessionContext('chat')).toBeUndefined();
    expect(harness().coordinator.sessionContext('nobody')).toBeUndefined();
    expect(harness({ conversation: false, snapshot: { agentRelations: [relation('chat')] } }).coordinator.sessionContext('chat')).toBe(true);
  });

  it('never a prepared session or one neither a conversation nor a managed child', () => {
    expect(harness({ conversation: false }).coordinator.sessionContext('chat')).toBeUndefined();
    expect(harness({ conversation: false, prepared: true, snapshot: { agentRelations: [relation('chat')] } }).coordinator.sessionContext('chat')).toBeUndefined();
    expect(harness({ conversation: false, snapshot: { agentRelations: [relation('chat', { owner: 'provider-native' })] } }).coordinator.sessionContext('chat')).toBeUndefined();
  });

  it('says per AI whether it runs this', () => {
    expect(harness().coordinator.support({ providers: [{ id: 'claude' }, { id: 'codex' }] } as never)).toEqual({ claude: true, codex: true });
    expect(harness({ capability: false }).coordinator.support({ providers: [{ id: 'claude' }] } as never)).toEqual({ claude: false });
  });
});

describe('the setting goes off', () => {
  it('cancels what has not gone out, and turning it on restores nothing', async () => {
    const h = harness();
    await h.coordinator.start();
    h.stop();
    await h.coordinator.settled();
    h.settings.current = { autoResume: false };
    h.coordinator.settingsChanged();
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'setting' });
    h.settings.current = { autoResume: true };
    h.coordinator.settingsChanged();
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'off' });
  });

  it('leaves alone what asks, and what already went out', async () => {
    const h = harness({ jobs: { a: job({ stopId: 'a', phase: 'ask-reset' }), b: job({ stopId: 'b', sessionId: 'other', phase: 'resuming' }) } });
    await h.coordinator.start();
    await h.coordinator.settled();
    const before = h.rows.length;
    h.settings.current = { autoResume: false };
    h.coordinator.settingsChanged();
    await h.coordinator.settled();
    expect(h.rows).toHaveLength(before);
  });
});

describe('after a restart', () => {
  const at = (iso: string) => () => new Date(iso);

  it.each(['waiting', 'scheduled'] as const)('%s past its time asks: the app was closed (D5)', async (phase) => {
    const h = harness({ jobs: { 'stop-1': job({ phase }) }, now: at(inHours(3)) });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ stopId: 'stop-1', phase: 'ask-reopened' });
  });

  it('retrying past its time asks too', async () => {
    const h = harness({ jobs: { 'stop-1': job({ phase: 'retrying', retryAt: inHours(2.5), attempt: 1 }) }, now: at(inHours(3)) });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'ask-reopened' });
  });

  it('a time still ahead stands, and its row is written again without adding one', async () => {
    const h = harness({ jobs: { 'stop-1': job() }, now: at(inHours(1)) });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting', resumeAt: RESUME });
    expect(h.rows.map((row) => row.id)).toEqual([limitRowItem(job()).id]);
  });

  it('with the setting off a schedule is off', async () => {
    const h = harness({ jobs: { 'stop-1': job() }, settings: { autoResume: false }, now: at(inHours(1)) });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'setting' });
  });

  const sending = { commandId: 'send-1', reason: 'scheduled-time', from: 'waiting' } as const;
  const resuming = job({ phase: 'resuming', sending });
  const sent = (patch: Partial<DaemonTurn>) => ({ jobs: { 'stop-1': resuming }, commands: ['send-1'], now: at(inHours(3)), snapshot: { turns: [turn('turn-1'), turn('turn-2', { commandId: 'send-1', ...patch })] } });

  it('a send that never reached the host asks', async () => {
    const h = harness({ jobs: { 'stop-1': resuming }, now: at(inHours(3)) });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'ask-reopened' });
    expect(Object.values(h.saved.jobs)[0]).not.toHaveProperty('sending');
  });

  it('a send the limit refused counts as a try', async () => {
    const h = harness(sent({ state: 'failed', errorCode: 'usage-limit', finishedAt: inHours(2.1) }));
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'retrying', turnId: 'turn-2', refusedAt: inHours(2.1), retryAt: new Date(Date.parse(inHours(2.1)) + RESUME_TIMING.retryAfterRefusalMs).toISOString() });
  });

  it('a second refusal gives up', async () => {
    const h = harness({ ...sent({ state: 'failed', errorCode: 'usage-limit', finishedAt: inHours(2.1) }), jobs: { 'stop-1': { ...resuming, attempt: 1 } } });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'gave-up', refusedAt: inHours(2.1) });
  });

  it('a send that went on to finish resumed', async () => {
    const h = harness(sent({ state: 'completed', errorCode: undefined }));
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'resumed' });
    expect(h.saved.jobs).toEqual({});
  });

  it('a send in doubt says so, and is not sent again', async () => {
    const h = harness(sent({ state: 'delivery-uncertain', errorCode: undefined }));
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'unconfirmed' });
  });

  it('a send already in doubt adds nothing at each later restart', async () => {
    const unconfirmed = { ...resuming, phase: 'unconfirmed' as const };
    const h = harness({ ...sent({ state: 'delivery-uncertain', errorCode: undefined }), jobs: { 'stop-1': unconfirmed } });
    await h.coordinator.start();
    expect(h.rows.map((row) => row.id)).toEqual([limitRowItem(unconfirmed).id]);
    expect(Object.values(h.saved.jobs)[0]).toMatchObject({ phase: 'unconfirmed', revision: unconfirmed.revision, sending });
  });

  it('a send still running stands', async () => {
    const h = harness(sent({ state: 'working', errorCode: undefined }));
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'resuming' });
  });

  it('forgets the stop of a conversation that is gone', async () => {
    const h = harness({ jobs: { 'stop-1': job() }, snapshot: { sessions: [] }, now: at(inHours(1)) });
    await h.coordinator.start();
    expect(h.rows).toEqual([]);
    expect(h.saved.jobs).toEqual({});
  });

  it('drops what this build did not write', async () => {
    const h = harness({ jobs: { a: { stopId: 'a' }, b: job({ stopId: 'b', phase: 'lifted' as never }), c: 'nonsense', d: job({ stopId: 'd', sessionId: 'chat', attempt: 'x' as never }) }, now: at(inHours(1)) });
    await h.coordinator.start();
    expect(h.rows).toEqual([]);
    expect(h.saved.jobs).toEqual({});
    await expect(harness({ jobs: 'nonsense' }).coordinator.start()).resolves.toBeUndefined();
  });

  it('a conversation archived later takes its stop with it', async () => {
    const h = harness();
    await h.coordinator.start();
    h.stop();
    await h.coordinator.settled();
    h.held.snapshot = { ...h.held.snapshot, sessions: [session('chat', { archivedAt: STOPPED })] };
    for (const listener of h.listeners) listener({ kind: 'entity.archived', payload: { entityType: 'session', entityId: 'chat' } } as DaemonEvent);
    await vi.waitFor(() => expect(h.saved.jobs).toEqual({}));
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(true);
  });

  it('a load that fails starts empty, and tells', async () => {
    const reportError = vi.fn();
    const coordinator = new LongRunCoordinator({
      getSnapshot: () => ({ sessions: [], agents: [], turns: [], agentRelations: [], providers: [] }) as unknown as DaemonSnapshot,
      applySystemCommit: async () => undefined, onEvent: () => () => undefined, wakeQueuedTurns: () => undefined, commandExists: () => false,
      execute: async () => { throw new Error('nothing is sent'); }, readTranscript: () => [],
      store: { load: async () => { throw new Error('unreadable'); }, save: async () => undefined },
      providers: { longRunCapability: () => undefined, enabledAdapter: () => ({ ok: false, message: 'off' }) },
      settings: () => undefined, allowed: () => true, prepared: () => false, reportError,
    });
    await coordinator.start();
    expect(reportError).toHaveBeenCalledWith('limit jobs load failed', expect.any(Error));
  });
});

describe('a person presses a card', () => {
  const press = (h: ReturnType<typeof harness>, action: LimitAction, stopId = 'stop-1', sessionId = 'chat') => h.coordinator.limitAction({ sessionId, stopId, action });
  const done = async (h: ReturnType<typeof harness>, result: DaemonCommandExecutionResult): Promise<void> => {
    expect(result.ok).toBe(true);
    if (result.ok) result.afterCommit?.();
    await h.coordinator.settled();
  };
  const started = async (patch: Partial<LimitJobRecord>, options: HarnessOptions = {}) => {
    const h = harness({ jobs: { 'stop-1': job(patch) }, ...options });
    await h.coordinator.start();
    return h;
  };

  it.each([
    ['try-now', { phase: 'waiting' }, 'try-now'],
    ['resume', { phase: 'ask-unknown' }, 'resume-pressed'],
    ['resume', { phase: 'gave-up', attempt: 2 }, 'resume-pressed'],
    ['resume', { phase: 'ask-reopened' }, 'resume-pressed'],
    ['resume', { phase: 'off', offBy: 'setting' }, 'resume-pressed'],
    ['resume', { phase: 'off', offBy: 'card' }, 'resume-pressed'],
    ['resume', { phase: 'left' }, 'resume-pressed'],
    ['resume', { phase: 'person-refused' }, 'resume-pressed'],
    ['resume', { phase: 'failed', failure: 'disconnected' }, 'resume-pressed'],
    ['resume', { phase: 'unconfirmed' }, 'resume-pressed'],
    ['resume', { phase: 'skipped' }, 'resume-pressed'],
    ['resume', { phase: 'child', childKind: 'managed-supported' }, 'resume-pressed'],
  ] as const)('%s from %o sends "Continue." with the reason it went out', async (action, patch, reason) => {
    const h = await started(patch);
    await done(h, press(h, action));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toMatchObject({ type: 'agent.submit', principal: { kind: 'cli', id: LONG_RUN_PRINCIPAL }, payload: { sessionId: 'chat', prompt: RESUME_TEXT, longRunResume: { stopId: 'stop-1', reason } } });
    expect(h.lastCard()).toMatchObject({ phase: 'resuming' });
  });

  it('nothing goes out before the command that pressed it has committed', async () => {
    const h = await started({ phase: 'waiting' });
    const result = press(h, 'try-now');
    await h.coordinator.settled();
    expect(h.sent).toEqual([]);
    expect(h.lastCard()).toMatchObject({ phase: 'waiting' });
    await done(h, result);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
  });

  it('a refused 지금 시도 keeps its clock, spends no attempt and says when', async () => {
    const h = await started({ phase: 'waiting' });
    await done(h, press(h, 'try-now'));
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    h.coordinator.limitStopped({ sessionId: 'chat', providerId: 'claude', turn: turn('turn-2', { commandId: h.sent[0]!.commandId }), limit: fiveHour, stoppedAt: inHours(1) });
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting', turnId: 'turn-2', resumeAt: RESUME, triedAt: inHours(1) });
    expect(Object.values(h.saved.jobs)[0]).toMatchObject({ attempt: 0 });
  });

  it('자동 끄기 turns this card off, and only this card', async () => {
    const h = await started({ phase: 'waiting' });
    await done(h, press(h, 'auto-off'));
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'card' });
  });

  it('자동 끄기 stops a retry too', async () => {
    const h = await started({ phase: 'retrying', retryAt: inHours(1), refusedAt: STOPPED });
    await done(h, press(h, 'auto-off'));
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'card' });
  });

  it('turning this card back on waits again, and forgets it was off', async () => {
    const h = await started({ phase: 'off', offBy: 'card' });
    await done(h, press(h, 'auto-on'));
    expect(h.lastCard()).toMatchObject({ phase: 'waiting', resumeAt: RESUME });
    expect(h.lastCard()).not.toHaveProperty('offBy');
  });

  it('turning a card back on while Settings has it off stays off, by Settings', async () => {
    const h = await started({ phase: 'off', offBy: 'card' }, { settings: { autoResume: false } });
    await done(h, press(h, 'auto-on'));
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'setting' });
  });

  it('그때 이어서 하기 waits for the time, however far off; taking it back asks again', async () => {
    const h = await started({ phase: 'ask-reset', window: 'weekly' });
    await done(h, press(h, 'schedule'));
    expect(h.lastCard()).toMatchObject({ phase: 'scheduled', resumeAt: RESUME });
    await done(h, press(h, 'unschedule'));
    expect(h.lastCard()).toMatchObject({ phase: 'ask-reset', resumeAt: RESUME });
  });

  it('asking for a time with the Settings switch off leaves it off', async () => {
    const h = await started({ phase: 'ask-reset', window: 'weekly' }, { settings: { autoResume: false } });
    await done(h, press(h, 'schedule'));
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'setting' });
  });

  it('그대로 두기 lets go of the queue and keeps the card', async () => {
    const h = await started({ phase: 'ask-unknown' });
    await done(h, press(h, 'leave'));
    expect(h.lastCard()).toMatchObject({ phase: 'left' });
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
    expect(h.coordinator.canDispatchTurn(turn('turn-2', { state: 'queued' }))).toBe(true);
    expect(Object.keys(h.saved.jobs)).toEqual(['stop-1']);
  });

  it.each([
    ['try-now', { phase: 'ask-reset' }], ['try-now', { phase: 'resuming' }], ['resume', { phase: 'waiting' }], ['resume', { phase: 'ask-reset' }], ['resume', { phase: 'resuming' }], ['resume', { phase: 'scheduled' }],
    ['auto-off', { phase: 'ask-reset' }], ['auto-on', { phase: 'off', offBy: 'setting' }], ['auto-on', { phase: 'waiting' }], ['schedule', { phase: 'waiting' }], ['unschedule', { phase: 'waiting' }], ['leave', { phase: 'waiting' }], ['leave', { phase: 'resuming' }],
  ] as const)('%s from %o is not on that card', async (action, patch) => {
    const h = await started(patch);
    expect(press(h, action)).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
    expect(h.sent).toEqual([]);
  });

  it('a card that is gone or belongs to another conversation is not found', async () => {
    const h = await started({ phase: 'waiting' });
    expect(press(h, 'try-now', 'stop-elsewhere')).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(press(h, 'try-now', 'stop-1', 'other')).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('no button works once a person wrote first', async () => {
    const h = await started({ phase: 'waiting' });
    h.coordinator.personSent('chat', 'turn-person');
    expect(press(h, 'try-now')).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
  });
});

describe('a person writes first', () => {
  const started = async (patch: Partial<LimitJobRecord> = {}, options: HarnessOptions = {}) => {
    const h = harness({ jobs: { 'stop-1': job(patch) }, ...options });
    await h.coordinator.start();
    return h;
  };
  const personTurn = (patch: Partial<DaemonTurn> = {}): DaemonTurn => turn('turn-person', { commandId: 'command-person', state: 'working', errorCode: undefined, ...patch });
  const running = (h: ReturnType<typeof harness>, patch: Partial<DaemonTurn> = {}): void => {
    h.held.snapshot = { ...h.held.snapshot, turns: [turn('turn-1'), personTurn(patch)] };
    h.emit({ kind: 'entity.upserted', payload: { entityType: 'turn', entityId: 'turn-person' } } as DaemonEvent);
  };

  it('closes the schedule: the time comes and nothing goes out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] });
    try {
      const clock = { now: inHours(1) };
      const h = await started({}, { now: () => new Date(clock.now) });
      h.coordinator.personSent('chat', 'turn-person');
      clock.now = inHours(3);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('is written ahead: a restart still knows', async () => {
    const h = await started();
    h.coordinator.personSent('chat', 'turn-person');
    await h.coordinator.settled();
    expect(Object.values(h.saved.jobs)[0]).toMatchObject({ personTurnId: 'turn-person' });
  });

  it('lets only that turn past the hold', async () => {
    const h = await started();
    h.coordinator.personSent('chat', 'turn-person');
    expect(h.coordinator.canDispatchTurn(personTurn({ state: 'queued' }))).toBe(true);
    expect(h.coordinator.canDispatchTurn(turn('turn-older', { state: 'queued' }))).toBe(false);
  });

  it('a limit on it says so and keeps the message; the card can still continue', async () => {
    const h = await started();
    h.coordinator.personSent('chat', 'turn-person');
    h.coordinator.limitStopped({ sessionId: 'chat', providerId: 'claude', turn: personTurn({ state: 'failed' }), limit: { ...fiveHour, resetsAt: inHours(3) }, stoppedAt: inHours(1) });
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'person-refused', turnId: 'turn-person', resetsAt: inHours(3) });
    expect(Object.values(h.saved.jobs)[0]).not.toHaveProperty('personTurnId');
    expect(h.coordinator.canDispatchTurn(turn('turn-older', { state: 'queued' }))).toBe(true);
  });

  it('a first answer closes the card: the limit let it through', async () => {
    const rows: DaemonTranscriptItem[] = [];
    const h = await started({}, { transcript: () => rows });
    h.coordinator.personSent('chat', 'turn-person');
    rows.push({ id: 'row', sessionId: 'chat', turnId: 'turn-person', sequence: 9, kind: 'assistant-message', text: 'Yes.', isDelta: false, isSensitive: true, createdAt: STOPPED });
    h.held.snapshot = { ...h.held.snapshot, turns: [turn('turn-1'), personTurn()] };
    h.emit({ kind: 'transcript.appended', payload: { sessionId: 'chat', fromSequence: 9, toSequence: 9 } } as DaemonEvent);
    await vi.waitFor(() => expect(h.lastCard()).toMatchObject({ phase: 'cancelled' }));
    await h.coordinator.settled();
    expect(h.saved.jobs).toEqual({});
  });

  it.each(['completed', 'interrupted'] as const)('its turn %s: the card closes', async (state) => {
    const h = await started();
    h.coordinator.personSent('chat', 'turn-person');
    running(h, { state });
    await vi.waitFor(() => expect(h.lastCard()).toMatchObject({ phase: 'cancelled' }));
    await h.coordinator.settled();
    expect(h.saved.jobs).toEqual({});
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
  });

  it('a turn still running changes nothing yet', async () => {
    const h = await started();
    h.coordinator.personSent('chat', 'turn-person');
    running(h);
    await new Promise((resolve) => { setImmediate(resolve); });
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting' });
  });

  it('a "Continue." on its way is not overtaken: its outcome decides', async () => {
    const h = await started({ phase: 'resuming', sending: { commandId: 'send-1', reason: 'scheduled-time', from: 'waiting' } }, { commands: ['send-1'], snapshot: { turns: [turn('turn-1'), turn('turn-2', { commandId: 'send-1', state: 'working', errorCode: undefined })] } });
    h.coordinator.personSent('chat', 'turn-person');
    await h.coordinator.settled();
    expect(Object.values(h.saved.jobs)[0]).not.toHaveProperty('personTurnId');
  });

  it('a "Continue." in doubt gives way to the person: the card closes on their turn', async () => {
    const h = await started({ phase: 'unconfirmed', sending: { commandId: 'send-1', reason: 'scheduled-time', from: 'waiting' } }, { commands: ['send-1'], snapshot: { turns: [turn('turn-1'), turn('turn-2', { commandId: 'send-1', state: 'delivery-uncertain', errorCode: undefined })] } });
    h.coordinator.personSent('chat', 'turn-person');
    running(h, { state: 'completed' });
    await vi.waitFor(() => expect(h.lastCard()).toMatchObject({ phase: 'cancelled' }));
  });

  it('a second message waits behind the first and changes nothing', async () => {
    const h = await started();
    h.coordinator.personSent('chat', 'turn-person');
    h.coordinator.personSent('chat', 'turn-next');
    await h.coordinator.settled();
    expect(Object.values(h.saved.jobs)[0]).toMatchObject({ personTurnId: 'turn-person' });
  });

  it('after a restart a turn the limit refused says so, and one that finished closes the card', async () => {
    const refused = harness({ jobs: { 'stop-1': job({ personTurnId: 'turn-person' }) }, snapshot: { turns: [personTurn({ state: 'failed', errorCode: 'usage-limit' })] } });
    await refused.coordinator.start();
    expect(refused.lastCard()).toMatchObject({ phase: 'person-refused', turnId: 'turn-person' });

    const finished = harness({ jobs: { 'stop-1': job({ personTurnId: 'turn-person' }) }, snapshot: { turns: [personTurn({ state: 'completed' })] } });
    await finished.coordinator.start();
    expect(finished.lastCard()).toMatchObject({ phase: 'cancelled' });
    expect(finished.saved.jobs).toEqual({});
  });

  it('after a restart a turn that never reached the host leaves the schedule as it was', async () => {
    const h = harness({ jobs: { 'stop-1': job({ personTurnId: 'turn-person' }) } });
    await h.coordinator.start();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting' });
    expect(Object.values(h.saved.jobs)[0]).not.toHaveProperty('personTurnId');
  });
});

describe('a message on its way into a running turn', () => {
  const steer = (patch: Partial<SteerRecord> = {}): SteerRecord => ({
    id: 'steer-1', sessionId: 'chat', turnId: 'turn-running', providerId: 'claude', text: 'Use the other file.', state: 'on-its-way', sentAt: STOPPED, ...patch,
  });
  const runningTurn = turn('turn-running', { state: 'working', errorCode: undefined });
  const started = async (options: HarnessOptions = {}) => {
    const h = harness({ snapshot: { turns: [runningTurn] }, ...options });
    await h.coordinator.start();
    return h;
  };
  const finishTurn = (h: ReturnType<typeof harness>, patch: Partial<DaemonTurn>): void => {
    h.held.snapshot = { ...h.held.snapshot, turns: [{ ...runningTurn, ...patch }] };
    h.emit({ kind: 'entity.upserted', payload: { entityType: 'turn', entityId: 'turn-running' } } as DaemonEvent);
  };

  it('is written to the file before the call that sends it may go', async () => {
    const h = await started();
    h.order.length = 0;
    await h.coordinator.steerSent(steer());
    expect(h.order[0]).toBe('file');
    expect(h.saved.steers['steer-1']).toMatchObject({ text: 'Use the other file.', state: 'on-its-way', sessionId: 'chat' });
    expect(h.events).toContainEqual({ kind: 'entity.upserted', payload: { entityType: 'agent', entityId: 'chat' } });
  });

  it('the snapshot shows the person\'s words by session, and no more than a client needs', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    expect(h.coordinator.steers(h.held.snapshot)).toEqual({ chat: [{ id: 'steer-1', text: 'Use the other file.', state: 'on-its-way', sentAt: STOPPED }] });
  });

  it('with nothing on its way the snapshot carries nothing', async () => {
    const h = await started();
    expect(h.coordinator.steers(h.held.snapshot)).toBeUndefined();
  });

  it('an open approval is what holds it, and the snapshot says so', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    const approvals = [{ id: 'a', sessionId: 'chat', turnId: 'turn-running', state: 'pending' }] as unknown as DaemonApproval[];
    expect(h.coordinator.steers({ ...h.held.snapshot, approvals })?.chat?.[0]).toMatchObject({ state: 'behind-approval' });
    expect(Object.values(h.saved.steers)[0]).toMatchObject({ state: 'on-its-way' });
  });

  it('remembers what holds it once the provider says', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    h.coordinator.steerMoved('steer-1', { state: 'on-its-way', behind: 'text' });
    expect(h.coordinator.steers(h.held.snapshot)?.chat?.[0]).toMatchObject({ state: 'on-its-way', behind: 'text' });
  });

  it('holds the queue behind it until it has gone somewhere', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    const queued = turn('turn-queued', { state: 'queued' });
    expect(h.coordinator.canDispatchTurn(queued)).toBe(false);
    expect(h.coordinator.canDispatchTurn(turn('turn-elsewhere', { sessionId: 'other', state: 'queued' }))).toBe(true);
    h.wakeQueuedTurns.mockClear();
    h.coordinator.steerGone('steer-1');
    expect(h.coordinator.canDispatchTurn(queued)).toBe(true);
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
    expect(h.coordinator.steerOf('steer-1')).toBeUndefined();
    await h.coordinator.settled();
    expect(h.saved.steers).toEqual({});
  });

  it('a message in doubt or failed waits for the person, not the queue', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    h.wakeQueuedTurns.mockClear();
    h.coordinator.steerMoved('steer-1', { state: 'failed', failure: 'disconnected' });
    expect(h.coordinator.canDispatchTurn(turn('turn-queued', { state: 'queued' }))).toBe(true);
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
    expect(h.coordinator.steers(h.held.snapshot)?.chat?.[0]).toMatchObject({ state: 'failed', failure: 'disconnected' });
  });

  it('what the provider said late does not take back what was already decided', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    h.coordinator.steerMoved('steer-1', { state: 'unconfirmed' });
    h.coordinator.steerMoved('steer-1', { state: 'on-its-way', behind: 'tool' });
    expect(h.coordinator.steerOf('steer-1')).toMatchObject({ state: 'unconfirmed' });
    expect(() => h.coordinator.steerMoved('steer-gone', { state: 'unconfirmed' })).not.toThrow();
  });

  it.each([
    ['a limit', { state: 'failed', errorCode: 'usage-limit' }, 'limit'],
    ['Stop', { state: 'interrupted', errorCode: undefined }, 'stop'],
  ] as const)('%s first leaves it in doubt, and says what caught it', async (_name, patch, caught) => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    finishTurn(h, patch);
    await vi.waitFor(() => expect(h.coordinator.steerOf('steer-1')).toMatchObject({ state: 'unconfirmed', caught }));
    await h.coordinator.settled();
    expect(h.saved.steers['steer-1']).toMatchObject({ state: 'unconfirmed', caught });
    expect(h.coordinator.canDispatchTurn(turn('turn-queued', { state: 'queued' }))).toBe(true);
  });

  it('any other failure leaves it in doubt with no cause named', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    finishTurn(h, { state: 'failed', errorCode: 'provider-session-failed' });
    await vi.waitFor(() => expect(h.coordinator.steerOf('steer-1')).toMatchObject({ state: 'unconfirmed' }));
    expect(h.coordinator.steerOf('steer-1')).not.toHaveProperty('caught');
  });

  it('a turn that finished well leaves it on its way: Claude starts it next, as its own turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] });
    try {
      const h = await started();
      await h.coordinator.steerSent(steer());
      finishTurn(h, { state: 'completed' });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.coordinator.steerOf('steer-1')).toMatchObject({ state: 'on-its-way' });
      h.coordinator.steerGone('steer-1');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.coordinator.steerOf('steer-1')).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('if nothing lands after the turn finished it stops holding the queue and says it cannot tell', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] });
    try {
      const h = await started();
      await h.coordinator.steerSent(steer());
      finishTurn(h, { state: 'completed' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.coordinator.steerOf('steer-1')).toMatchObject({ state: 'unconfirmed' });
      expect(h.coordinator.canDispatchTurn(turn('turn-queued', { state: 'queued' }))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a conversation archived takes it along', async () => {
    const h = await started();
    await h.coordinator.steerSent(steer());
    h.held.snapshot = { ...h.held.snapshot, sessions: [session('chat', { archivedAt: STOPPED })] };
    h.emit({ kind: 'entity.archived', payload: { entityType: 'session', entityId: 'chat' } } as DaemonEvent);
    await vi.waitFor(() => expect(h.coordinator.steerOf('steer-1')).toBeUndefined());
    await h.coordinator.settled();
    expect(h.saved.steers).toEqual({});
  });

  describe('after a restart', () => {
    const inThread = (state: 'applied' | 'not-applied' | 'delivery-uncertain') => vi.fn<NonNullable<HarnessOptions['reconcile']>>(async () => ({ commands: [{ commandId: 'steer-1', state }], transcriptItems: [] }));

    it('asks for it by command, with no turn: a turn would be recovered', async () => {
      const reconcile = inThread('applied');
      const h = await started({ steers: { 'steer-1': steer() }, reconcile });
      await h.coordinator.settled();
      expect(reconcile).toHaveBeenCalledExactlyOnceWith({ sessionId: 'chat', providerSessionId: 'provider-chat', unsettledCommands: [{ commandId: 'steer-1', idempotencyKey: 'steer-1', type: 'agent.steer' }] });
    });

    it('found, it landed: the row is written and the record goes', async () => {
      const h = await started({ steers: { 'steer-1': steer() }, reconcile: inThread('applied') });
      await h.coordinator.settled();
      expect(h.rows).toEqual([expect.objectContaining({ id: steerRowItem(steer(), 'turn-running', {}).id, kind: 'user-message', text: 'Use the other file.', turnId: 'turn-running', payload: { v: 1, type: 'steer' } })]);
      expect(h.coordinator.steerOf('steer-1')).toBeUndefined();
      expect(h.saved.steers).toEqual({});
    });

    it.each(['not-applied', 'delivery-uncertain'] as const)('%s, it cannot be told', async (state) => {
      const h = await started({ steers: { 'steer-1': steer() }, reconcile: inThread(state) });
      await h.coordinator.settled();
      expect(h.rows).toEqual([]);
      expect(h.saved.steers['steer-1']).toMatchObject({ state: 'unconfirmed' });
    });

    it('a read that fails, or an AI that is off, cannot tell either', async () => {
      const failing = await started({ steers: { 'steer-1': steer() }, reconcile: async () => { throw new Error('no answer'); } });
      await failing.coordinator.settled();
      expect(failing.saved.steers['steer-1']).toMatchObject({ state: 'unconfirmed' });

      const off = await started({ steers: { 'steer-1': steer() }, providerOff: true });
      await off.coordinator.settled();
      expect(off.saved.steers['steer-1']).toMatchObject({ state: 'unconfirmed' });
    });

    it('one left in doubt is looked for again; one that failed stands', async () => {
      const doubt = await started({ steers: { 'steer-1': steer({ state: 'unconfirmed' }) }, reconcile: inThread('applied') });
      await doubt.coordinator.settled();
      expect(doubt.coordinator.steerOf('steer-1')).toBeUndefined();

      const reconcile = inThread('applied');
      const failed = await started({ steers: { 'steer-1': steer({ state: 'failed', failure: 'disconnected' }) }, reconcile });
      await failed.coordinator.settled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(failed.coordinator.steerOf('steer-1')).toMatchObject({ state: 'failed', failure: 'disconnected' });
    });

    it('holds the queue from the first pass, before it has been looked for', async () => {
      const h = harness({ steers: { 'steer-1': steer() }, snapshot: { turns: [runningTurn] } });
      await h.coordinator.load();
      expect(h.coordinator.canDispatchTurn(turn('turn-queued', { state: 'queued' }))).toBe(false);
    });

    it('forgets one whose conversation is gone, and drops what this build did not write', async () => {
      const gone = await started({ steers: { 'steer-1': steer({ sessionId: 'gone' }), nonsense: { id: 'x' }, 'bad-state': steer({ state: 'landed' as never }) } });
      await gone.coordinator.settled();
      expect(gone.saved.steers).toEqual({});
    });
  });
});

describe('the scheduler', () => {
  const clock = { ms: stoppedMs };
  const now = (): Date => new Date(clock.ms);
  const DUE = Date.parse(RESUME);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clock.ms = stoppedMs;
  });
  afterEach(() => { vi.useRealTimers(); });
  /** Moves the clock, then lets one capped timer run. */
  async function at(ms: number): Promise<void> {
    clock.ms = ms;
    await vi.advanceTimersByTimeAsync(60_000);
  }
  async function waiting(options: HarnessOptions = {}) {
    const h = harness({ now, ...options });
    await h.coordinator.start();
    h.stop();
    await h.coordinator.settled();
    return h;
  }
  const row = (sequence: number, turnId: string, kind: DaemonTranscriptItem['kind']): DaemonTranscriptItem => ({
    id: `row-${String(sequence)}`, sessionId: 'chat', turnId, sequence, kind, text: 'x', isDelta: false, isSensitive: false, createdAt: STOPPED,
  });
  const receipt = (code: string): DaemonCommandReceipt => ({ ok: false, status: 'rejected', commandId: 'c', revision: 7, error: { code, message: code, retryable: false } } as DaemonCommandReceipt);
  /** The running job's send, as a turn the runtime holds. */
  const sentTurn = (h: ReturnType<typeof harness>, patch: Partial<DaemonTurn>, index = -1): DaemonTurn => {
    const command = h.sent.at(index)!;
    const value = turn(`turn-sent-${command.commandId}`, { commandId: command.commandId, errorCode: undefined, ...patch });
    h.held.snapshot = { ...h.held.snapshot, turns: [...h.held.snapshot.turns.filter((entry) => entry.commandId !== command.commandId), value] };
    h.emit({ kind: 'entity.upserted', payload: { entityType: 'turn', entityId: value.id } } as DaemonEvent);
    return value;
  };
  const pass = async (h: ReturnType<typeof harness>): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await h.coordinator.settled();
  };

  it('sends "Continue." once at its time, and not a moment before', async () => {
    const h = await waiting();
    await at(DUE - 1_000);
    expect(h.sent).toEqual([]);
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      type: 'agent.submit', expectedRevision: 7, principal: { kind: 'cli', id: LONG_RUN_PRINCIPAL },
      payload: { sessionId: 'chat', prompt: RESUME_TEXT, longRunResume: { stopId: h.lastCard()?.stopId, reason: 'scheduled-time' } },
    });
    await at(DUE + 3_600_000);
    expect(h.sent).toHaveLength(1);
  });

  it('writes the send ahead of it: the file and the card say so before the command goes out', async () => {
    const seen: unknown[] = [];
    const held: { h?: ReturnType<typeof harness> } = {};
    const h = await waiting({ execute: async (command) => {
      seen.push({ phase: held.h?.lastCard()?.phase, sending: Object.values(held.h?.saved.jobs ?? {})[0]?.sending });
      return { ok: true, status: 'applied', commandId: command.commandId, revision: 8 } as DaemonCommandReceipt;
    } });
    held.h = h;
    await at(DUE);
    await h.coordinator.settled();
    expect(seen).toEqual([{ phase: 'resuming', sending: { commandId: h.sent[0]?.commandId, reason: 'scheduled-time', from: 'waiting' } }]);
  });

  it('lets its own send past the hold, and nothing else', async () => {
    const h = await waiting();
    await at(DUE);
    await h.coordinator.settled();
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: h.sent[0]!.commandId })).toBe(true);
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(false);
  });

  it('sends nothing until the setting has loaded', async () => {
    const h = await waiting();
    h.settings.current = undefined;
    await at(DUE);
    expect(h.sent).toEqual([]);
    h.settings.current = { autoResume: true };
    await at(DUE + 60_000);
    expect(h.sent).toHaveLength(1);
  });

  it('a setting found off at the time cancels the send', async () => {
    const h = await waiting();
    h.settings.current = { autoResume: false };
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toEqual([]);
    expect(h.lastCard()).toMatchObject({ phase: 'off', offBy: 'setting' });
  });

  const approval = (patch: Partial<DaemonApproval>): DaemonApproval => ({ id: 'a', sessionId: 'chat', providerRequestId: 'request', state: 'pending', risk: 'read', title: 't', revision: 1, createdAt: '', updatedAt: '', ...patch } as DaemonApproval);

  it('an open request skips the send', async () => {
    const h = await waiting();
    h.held.snapshot = { ...h.held.snapshot, approvals: [approval({})] };
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toEqual([]);
    expect(h.lastCard()).toMatchObject({ phase: 'skipped' });
  });

  it('a request that stops nothing does not: another conversation\'s, a settled one, a settings proposal', async () => {
    const h = await waiting();
    h.held.snapshot = { ...h.held.snapshot, approvals: [approval({ sessionId: 'other' }), approval({ state: 'allowed' }), approval({ providerRequestId: 'settings-proposal:x' })] };
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);
  });

  it('a held queue goes instead of "Continue.": the refused prompt stays in the session', async () => {
    const h = await waiting({ snapshot: { turns: [turn('turn-1'), turn('queued', { state: 'queued', errorCode: undefined })] } });
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'command-queued' })).toBe(false);
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toEqual([]);
    expect(h.lastCard()).toMatchObject({ phase: 'cancelled' });
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'command-queued' })).toBe(true);
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
  });

  it('an AI no longer enabled fails the send', async () => {
    const h = await waiting({ providerOff: true });
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toEqual([]);
    expect(h.lastCard()).toMatchObject({ phase: 'failed', failure: 'disconnected' });
  });

  it('a lost revision race is a new command, written ahead like the first', async () => {
    let conflicts = 0;
    const h = await waiting({ execute: async (command) => {
      if (conflicts < 1) { conflicts += 1; h2.held.snapshot = { ...h2.held.snapshot, revision: 8 }; return receipt('revision-conflict'); }
      return { ok: true, status: 'applied', commandId: command.commandId, revision: 9 } as DaemonCommandReceipt;
    } });
    const h2 = h;
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]?.commandId).not.toBe(h.sent[1]?.commandId);
    expect(h.sent[1]).toMatchObject({ expectedRevision: 8 });
    expect(Object.values(h.saved.jobs)[0]?.sending?.commandId).toBe(h.sent[1]?.commandId);
  });

  it('a refused command fails the send, and never tries again by itself', async () => {
    const h = await waiting({ execute: async () => receipt('invalid-state') });
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);
    expect(h.lastCard()).toMatchObject({ phase: 'failed' });
    expect(Object.values(h.saved.jobs)[0]).not.toHaveProperty('sending');
    await at(DUE + 3_600_000);
    expect(h.sent).toHaveLength(1);
  });

  it('a conversation that is gone says so', async () => {
    const h = await waiting({ execute: async () => receipt('not-found') });
    await at(DUE);
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'failed', failure: 'session-gone' });
  });

  it('never loops on a command that keeps losing the race', async () => {
    const h = await waiting({ execute: async () => receipt('revision-conflict') });
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(3);
    expect(h.lastCard()).toMatchObject({ phase: 'failed' });
  });

  it('refused: one later try ten minutes on with a new command, then it stops and asks (D4)', async () => {
    const h = await waiting();
    await at(DUE);
    await h.coordinator.settled();
    const refusal = (index: number): void => {
      const value = sentTurn(h, { state: 'failed', errorCode: 'usage-limit' }, index);
      h.coordinator.limitStopped({ sessionId: 'chat', providerId: 'claude', turn: value, limit: fiveHour, stoppedAt: new Date(clock.ms).toISOString() });
    };
    refusal(0);
    await h.coordinator.settled();
    const retryAt = new Date(DUE + RESUME_TIMING.retryAfterRefusalMs).toISOString();
    expect(h.lastCard()).toMatchObject({ phase: 'retrying', refusedAt: RESUME, retryAt, turnId: expect.stringContaining('turn-sent-') });
    expect(new Set(h.cards().map((card) => card?.stopId)).size).toBe(1);

    await at(Date.parse(retryAt) - 1_000);
    expect(h.sent).toHaveLength(1);
    await at(Date.parse(retryAt));
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.commandId).not.toBe(h.sent[0]?.commandId);

    refusal(1);
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'gave-up', refusedAt: retryAt });
    await at(Date.parse(retryAt) + 3_600_000);
    expect(h.sent).toHaveLength(2);
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(false);
  });

  it('a refused 지금 시도 keeps the clock and spends no attempt', async () => {
    const h = harness({ now, jobs: { 'stop-1': job({ phase: 'resuming', sending: { commandId: 'try-1', reason: 'try-now', from: 'waiting' } }) }, commands: ['try-1'], snapshot: { turns: [turn('turn-1'), turn('try', { commandId: 'try-1', state: 'working', errorCode: undefined })] } });
    await h.coordinator.start();
    h.coordinator.limitStopped({ sessionId: 'chat', providerId: 'claude', turn: turn('try', { commandId: 'try-1' }), limit: fiveHour, stoppedAt: STOPPED });
    await h.coordinator.settled();
    expect(h.lastCard()).toMatchObject({ phase: 'waiting', resumeAt: RESUME, triedAt: STOPPED, turnId: 'try' });
    expect(Object.values(h.saved.jobs)[0]).toMatchObject({ attempt: 0 });
    expect(Object.values(h.saved.jobs)[0]).not.toHaveProperty('sending');
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);
  });

  it('the first answer closes the card and lets the queue go', async () => {
    const rows: DaemonTranscriptItem[] = [];
    const h = await waiting({ transcript: () => rows });
    await at(DUE);
    await h.coordinator.settled();
    const value = sentTurn(h, { state: 'working' });
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'resuming' });
    // Rows of another turn, and the user's own, prove nothing.
    rows.push(row(5, 'turn-1', 'assistant-message'), row(6, value.id, 'user-message'));
    h.emit({ kind: 'transcript.appended', payload: { sessionId: 'chat', fromSequence: 5, toSequence: 6 } } as DaemonEvent);
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'resuming' });
    rows.push(row(7, value.id, 'tool-call'));
    h.emit({ kind: 'transcript.appended', payload: { sessionId: 'chat', fromSequence: 7, toSequence: 7 } } as DaemonEvent);
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'resumed' });
    expect(h.saved.jobs).toEqual({});
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(true);
    expect(h.wakeQueuedTurns).toHaveBeenCalled();
  });

  it('a clean finish closes it too', async () => {
    const h = await waiting();
    await at(DUE);
    await h.coordinator.settled();
    sentTurn(h, { state: 'completed' });
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'resumed' });
  });

  it('a send in doubt says so, keeps holding, and a later answer still closes it', async () => {
    const h = await waiting();
    await at(DUE);
    await h.coordinator.settled();
    sentTurn(h, { state: 'delivery-uncertain' });
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'unconfirmed' });
    expect(h.coordinator.canDispatchTurn({ id: 'turn-queued', sessionId: 'chat', commandId: 'queued' })).toBe(false);
    sentTurn(h, { state: 'completed' });
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'resumed' });
  });

  it('a send that never started failed; one that broke after going out may have arrived', async () => {
    const started = await waiting();
    await at(DUE);
    await started.coordinator.settled();
    sentTurn(started, { state: 'failed', errorCode: 'provider-start-failed' });
    await pass(started);
    expect(started.lastCard()).toMatchObject({ phase: 'failed', failure: 'disconnected' });

    clock.ms = stoppedMs;
    const broke = await waiting();
    await at(DUE);
    await broke.coordinator.settled();
    sentTurn(broke, { state: 'failed', errorCode: 'CLAUDE_PROVIDER_ERROR' });
    await pass(broke);
    expect(broke.lastCard()).toMatchObject({ phase: 'unconfirmed' });
    expect(Object.values(broke.saved.jobs)[0]).not.toHaveProperty('sending');
  });

  it('a stop the runtime reports is not read twice from the turn', async () => {
    const h = await waiting();
    await at(DUE);
    await h.coordinator.settled();
    sentTurn(h, { state: 'failed', errorCode: 'usage-limit' });
    await pass(h);
    expect(h.lastCard()).toMatchObject({ phase: 'resuming' });
  });

  describe('the line (D6)', () => {
    const two = (): HarnessOptions => ({
      now,
      snapshot: { sessions: [session('old'), session('new'), session('other')], agents: [agent('old'), agent('new'), agent('other', { providerId: 'codex' })], turns: [] },
      jobs: {
        new: job({ stopId: 'new', sessionId: 'new', stoppedAt: inHours(0.5) }),
        old: job({ stopId: 'old', sessionId: 'old', stoppedAt: inHours(0) }),
      },
    });
    const sessions = (h: ReturnType<typeof harness>) => h.sent.map((command) => (command.payload as { sessionId: string }).sessionId);

    it('oldest stop first, one at a time, 60 seconds apart, whatever the first is doing', async () => {
      const h = harness(two());
      await h.coordinator.start();
      await at(DUE);
      await h.coordinator.settled();
      expect(sessions(h)).toEqual(['old']);
      await at(DUE + 59_000);
      await h.coordinator.settled();
      expect(sessions(h)).toEqual(['old']);
      await at(DUE + 60_000);
      await h.coordinator.settled();
      expect(sessions(h)).toEqual(['old', 'new']);
    });

    it('each AI keeps its own line', async () => {
      const options = two();
      const h = harness({ ...options, jobs: { ...(options.jobs as object), other: job({ stopId: 'other', sessionId: 'other', providerId: 'codex', stoppedAt: inHours(1) }) } });
      await h.coordinator.start();
      await at(DUE);
      await h.coordinator.settled();
      expect(sessions(h).sort()).toEqual(['old', 'other']);
    });

    it('tells each card its place, and never stores it', async () => {
      const h = harness(two());
      await h.coordinator.start();
      await h.coordinator.settled();
      const limits = h.coordinator.usageLimits(h.held.snapshot);
      expect(limits?.old?.line).toEqual({ position: 1, total: 2 });
      expect(limits?.new?.line).toEqual({ position: 2, total: 2 });
      for (const card of h.cards()) expect(card).not.toHaveProperty('line');
    });

    it('no line for one alone, or for stops whose times are apart', async () => {
      const alone = await waiting();
      expect(alone.coordinator.usageLimits(alone.held.snapshot)?.chat?.line).toBeUndefined();
      const options = two();
      const apart = harness({ ...options, jobs: { old: job({ stopId: 'old', sessionId: 'old' }), new: job({ stopId: 'new', sessionId: 'new', resumeAt: inHours(4) }) } });
      await apart.coordinator.load();
      expect(apart.coordinator.usageLimits(apart.held.snapshot)?.old?.line).toBeUndefined();
    });
  });

  it('after a sleep the first send waits a minute for the network', async () => {
    const h = await waiting();
    clock.ms = DUE + 3_600_000;
    h.coordinator.wake();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.sent).toEqual([]);
    clock.ms += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);
  });

  it('reads the clock at each pass: forward is seen within a minute, backward waits for its time', async () => {
    const h = await waiting();
    await at(DUE - 3_600_000);
    expect(h.sent).toEqual([]);
    await at(DUE + 5_000);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);

    clock.ms = stoppedMs;
    const back = await waiting();
    await at(stoppedMs + 60_000);
    await at(stoppedMs - 3_600_000);
    expect(back.sent).toEqual([]);
  });

  it('picks a schedule back up after a restart', async () => {
    const h = harness({ now, jobs: { 'stop-1': job() } });
    await h.coordinator.start();
    await at(DUE);
    await h.coordinator.settled();
    expect(h.sent).toHaveLength(1);
  });

  it('stops with the host', async () => {
    const h = await waiting();
    h.coordinator.dispose();
    await at(DUE);
    expect(h.sent).toEqual([]);
  });
});
