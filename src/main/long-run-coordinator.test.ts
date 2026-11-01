import { describe, expect, it, vi } from 'vitest';

import { type DaemonAgent, type DaemonAgentRelation, type DaemonEvent, type DaemonSession, type DaemonSnapshot, type DaemonTurn } from '../shared/daemon-protocol';
import { RESUME_TIMING, type LongRunSettings, type ProviderUsageLimit, type UsageLimitReading } from '../shared/long-run';
import { parseTranscriptPayload } from '../shared/transcript-payload';
import type { AgentProviderAdapter } from './agent-provider-adapter';
import type { DaemonStoreCommit, DaemonTranscriptItemInput } from './daemon-store';
import { limitRowItem, LongRunCoordinator, type LimitJobRecord } from './long-run-coordinator';

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
  readonly settings?: LongRunSettings | undefined;
  readonly unattended?: boolean;
  readonly conversation?: boolean;
  readonly prepared?: boolean;
  readonly recoverLimit?: AgentProviderAdapter['recoverLimit'];
  readonly capability?: boolean;
  readonly commands?: readonly string[];
  readonly now?: () => Date;
  readonly snapshot?: Partial<DaemonSnapshot>;
}

function harness(options: HarnessOptions = {}) {
  const held = { snapshot: {
    sessions: [session('chat')], agents: [agent('chat')], turns: [turn('turn-1')], agentRelations: [], providers: [{ id: 'claude' }, { id: 'codex' }], approvals: [], revision: 7,
    ...options.snapshot,
  } as unknown as DaemonSnapshot };
  const rows: DaemonTranscriptItemInput[] = [];
  const order: string[] = [];
  const saved: { jobs: Readonly<Record<string, LimitJobRecord>> } = { jobs: {} };
  const listeners = new Set<(event: DaemonEvent) => void>();
  const events: unknown[] = [];
  const wakeQueuedTurns = vi.fn();
  const settings = { current: 'settings' in options ? options.settings : { autoResume: true } };
  const coordinator = new LongRunCoordinator({
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
      load: async () => options.jobs,
      save: async (jobs) => { order.push('file'); saved.jobs = jobs; },
    },
    providers: {
      longRunCapability: () => (options.capability === false ? undefined : { minimumVersion: '1.0.0' }),
      enabledAdapter: () => ({ ok: true, value: { recoverLimit: options.recoverLimit } as AgentProviderAdapter }),
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
  return { coordinator, held, rows, order, saved, listeners, events, wakeQueuedTurns, settings, stop, cards, lastCard: () => cards().at(-1) };
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
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'other' })).toBe(true);
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
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'other' })).toBe(true);
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
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'queued' })).toBe(false);
    expect(h.coordinator.canDispatchTurn({ sessionId: 'elsewhere', commandId: 'queued' })).toBe(true);
  });

  it('lets the send that resumes it through', async () => {
    const h = harness({ jobs: { 'stop-1': job({ phase: 'resuming', sending: { commandId: 'send-1', reason: 'scheduled-time', from: 'waiting' } }) } });
    await h.coordinator.load();
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'send-1' })).toBe(true);
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'other' })).toBe(false);
  });

  it('holds across a restart from the first pass: loading is enough', async () => {
    const h = harness({ jobs: { 'stop-1': job() } });
    await h.coordinator.load();
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'queued' })).toBe(false);
  });

  it('a card that was left holds nothing', async () => {
    const h = harness({ jobs: { 'stop-1': job({ phase: 'left', resumeAt: undefined }) } });
    await h.coordinator.load();
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'queued' })).toBe(true);
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
    expect(h.coordinator.canDispatchTurn({ sessionId: 'chat', commandId: 'queued' })).toBe(true);
  });

  it('a load that fails starts empty, and tells', async () => {
    const reportError = vi.fn();
    const coordinator = new LongRunCoordinator({
      getSnapshot: () => ({ sessions: [], agents: [], turns: [], agentRelations: [], providers: [] }) as unknown as DaemonSnapshot,
      applySystemCommit: async () => undefined, onEvent: () => () => undefined, wakeQueuedTurns: () => undefined, commandExists: () => false,
      store: { load: async () => { throw new Error('unreadable'); }, save: async () => undefined },
      providers: { longRunCapability: () => undefined, enabledAdapter: () => ({ ok: false, message: 'off' }) },
      settings: () => undefined, allowed: () => true, prepared: () => false, reportError,
    });
    await coordinator.start();
    expect(reportError).toHaveBeenCalledWith('limit jobs load failed', expect.any(Error));
  });
});
