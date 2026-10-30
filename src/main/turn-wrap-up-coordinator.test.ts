import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonCommand,
  type DaemonAgentRelation,
  type DaemonCommand,
  type DaemonCommandType,
  type DaemonPrincipal,
  type DaemonSession,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import { DEFAULT_TURN_WRAP_UP_SETTINGS, suggestedTaskChildSessionId, type TurnWrapUpSettings } from '../shared/turn-wrap-up';
import {
  ProviderSideQuestionError,
  type AgentProviderAdapter,
  type AgentProviderEvent,
  type ProviderPredictInput,
  type ProviderProbeResult,
} from './agent-provider-adapter';
import { AgentProviderRegistry, createProviderReviewDigest } from './agent-provider-registry';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore } from './daemon-store';
import { suggestionMode, TurnWrapUpCoordinator, turnWrapUpPauses, wrapUpAllowed } from './turn-wrap-up-coordinator';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const session = (id: string, patch: Partial<DaemonSession> = {}): DaemonSession => ({
  id, projectId: 'project', workspaceId: 'workspace', kind: 'agent', title: id, state: 'idle', source: 'structured', revision: 1, createdAt: '', updatedAt: '', ...patch,
});
const relation = (childSessionId: string, patch: Partial<DaemonAgentRelation> = {}): DaemonAgentRelation => ({
  id: `relation-${childSessionId}`, treeId: 'tree', parentSessionId: 'parent', childSessionId, owner: 'managed', depth: 1, revision: 1, createdAt: '', updatedAt: '', ...patch,
});
const sent = (type: DaemonCommandType, payload: Record<string, unknown>, principal: DaemonPrincipal = { kind: 'desktop', id: 'person' }): DaemonCommand => ({
  protocolVersion: 12, commandId: 'command', idempotencyKey: 'key', expectedRevision: 0, issuedAt: '2026-10-30T10:00:00.000Z', principal, type, payload,
} as DaemonCommand);
const AUTOMATION: DaemonPrincipal = { kind: 'cli', id: 'automation-runtime' };
const REPORT_BACK: DaemonPrincipal = { kind: 'cli', id: 'report-back-runtime' };

function allowed(
  sessionId: string,
  options: { readonly sessions?: readonly DaemonSession[]; readonly relations?: readonly DaemonAgentRelation[]; readonly prepared?: boolean; readonly turnCommand?: DaemonCommand | null } = {},
): boolean {
  const snapshot = { sessions: options.sessions ?? [session(sessionId)], agents: [], agentRelations: options.relations ?? [] };
  return wrapUpAllowed(snapshot, sessionId, { prepared: options.prepared ?? false, ...(options.turnCommand === undefined ? {} : { turnCommand: options.turnCommand }) });
}

describe('wrapUpAllowed: the one rule, by session class', () => {
  const cardChild = suggestedTaskChildSessionId('task-1');
  const message = sent('agent.submit', { sessionId: 'chat', prompt: 'Next.' });

  it('takes a top-level conversation, for a turn a person sent from either device', () => {
    expect(allowed('chat')).toBe(true);
    expect(allowed('chat', { turnCommand: sent('agent.create', { sessionId: 'chat', initialPrompt: 'Fix it.' }) })).toBe(true);
    expect(allowed('chat', { turnCommand: message })).toBe(true);
    expect(allowed('chat', { turnCommand: sent('agent.submit', { sessionId: 'chat', prompt: 'Next.' }, { kind: 'android', id: 'phone' }) })).toBe(true);
  });

  it('takes a turn a person asked for through a review fix', () => {
    expect(allowed('chat', { turnCommand: sent('review.fix', { sessionId: 'chat', reviewId: 'review-1', findingIds: ['finding-1'] }) })).toBe(true);
  });

  it('refuses a heartbeat or another automation', () => {
    expect(allowed('chat', { turnCommand: sent('agent.submit', { sessionId: 'chat', prompt: 'Beat.' }, AUTOMATION) })).toBe(false);
  });

  it('refuses a child\'s report into its parent, which no person sent', () => {
    expect(allowed('chat', { turnCommand: sent('agent.submit', { sessionId: 'chat', prompt: 'Done.', reportOf: 'child' }, REPORT_BACK) })).toBe(false);
  });

  it('refuses a turn whose command cannot be told', () => {
    expect(allowed('chat', { turnCommand: null })).toBe(false);
  });

  it('takes a child a person started from a card, for what the person sends there', () => {
    const relations = [relation(cardChild)];
    expect(allowed(cardChild, { relations })).toBe(true);
    expect(allowed(cardChild, { relations, turnCommand: sent('agent.submit', { sessionId: cardChild, prompt: 'And the docs.' }) })).toBe(true);
  });

  it('refuses a card child\'s delegated first turn and any report it receives', () => {
    const relations = [relation(cardChild)];
    expect(allowed(cardChild, { relations, turnCommand: sent('agent.create', { sessionId: cardChild, initialPrompt: 'Fix it.', parentSessionId: 'parent' }) })).toBe(false);
    expect(allowed(cardChild, { relations, turnCommand: sent('agent.submit', { sessionId: cardChild, prompt: 'Done.', reportOf: 'grandchild' }, REPORT_BACK) })).toBe(false);
  });

  it('refuses a managed child an AI started, even for a person\'s message', () => {
    const relations = [relation('agent-1')];
    expect(allowed('agent-1', { relations })).toBe(false);
    expect(allowed('agent-1', { relations, turnCommand: sent('agent.submit', { sessionId: 'agent-1', prompt: 'Next.' }) })).toBe(false);
  });

  it('refuses a provider\'s own subagent, whatever its id says', () => {
    expect(allowed(cardChild, { relations: [relation(cardChild, { owner: 'provider-native' })] })).toBe(false);
  });

  it('takes a child once it is detached: it is a conversation of its own', () => {
    expect(allowed('agent-1', { relations: [relation('agent-1', { detachedAt: '2026-10-30T10:00:00.000Z' })] })).toBe(true);
  });

  it('refuses reviewers, advisors, planning and scheduled conversations', () => {
    for (const id of ['review-1', 'advisor-1', 'planning-1', 'planning-review-1', 'scheduled-agent-1']) expect(allowed(id), id).toBe(false);
  });

  it('refuses a prepared (workflow stage) session', () => {
    expect(allowed('chat', { prepared: true })).toBe(false);
  });

  it('refuses an archived conversation, a terminal and a session the snapshot does not hold', () => {
    expect(allowed('chat', { sessions: [session('chat', { archivedAt: '2026-10-30T10:00:00.000Z' })] })).toBe(false);
    expect(allowed('chat', { sessions: [session('chat', { source: 'legacy-pty' })] })).toBe(false);
    expect(allowed('chat', { sessions: [session('chat', { kind: 'terminal' })] })).toBe(false);
    expect(allowed('chat', { sessions: [] })).toBe(false);
  });
});

describe('suggestionMode', () => {
  const settings = (patch: Partial<TurnWrapUpSettings>): TurnWrapUpSettings => ({ ...DEFAULT_TURN_WRAP_UP_SETTINGS, ...patch });

  it('leaves suggestions to the AI when the pause is on and nothing is near a limit', () => {
    expect(suggestionMode(settings({}), 'claude', false)).toBe('on');
  });

  it('stops them while paused', () => {
    expect(suggestionMode(settings({}), 'claude', true)).toBe('off');
  });

  it('keeps them on past the AI\'s own near-limit stop when the pause is off', () => {
    expect(suggestionMode(settings({ pauseNearLimit: false }), 'claude', false)).toBe('on-past-limit');
    expect(suggestionMode(settings({ pauseNearLimit: false }), 'claude', true)).toBe('on-past-limit');
  });

  it('stops them when the switch is off, whatever else holds', () => {
    const off = { suggestions: { claude: false, codex: true } };
    expect(suggestionMode(settings(off), 'claude', false)).toBe('off');
    expect(suggestionMode(settings({ ...off, pauseNearLimit: false }), 'claude', false)).toBe('off');
  });

  it('knows no switch for another provider', () => {
    expect(suggestionMode(settings({}), 'other', false)).toBe('off');
  });
});

describe('turnWrapUpPauses', () => {
  const NOW = 1_000_000;

  it('names each window at the danger level', () => {
    const snapshot = { providerUsage: {
      claude: { fiveHour: { usedPercent: 90, resetsAt: NOW + 1 }, weekly: { usedPercent: 89 } },
      codex: { weekly: { usedPercent: 97 } },
    } };
    expect(turnWrapUpPauses(snapshot, NOW)).toEqual([
      { providerId: 'claude', window: 'five-hour', usedPercent: 90, resetsAt: NOW + 1 },
      { providerId: 'codex', window: 'weekly', usedPercent: 97 },
    ]);
  });

  it('ignores a window that has reset since the reading', () => {
    expect(turnWrapUpPauses({ providerUsage: { claude: { fiveHour: { usedPercent: 99, resetsAt: NOW } } } }, NOW)).toEqual([]);
  });

  it('is empty without usage', () => {
    expect(turnWrapUpPauses({}, NOW)).toEqual([]);
  });
});

function probe(providerId: string, protocol: ProviderProbeResult['protocol'], executableVersion: string): ProviderProbeResult {
  return {
    providerId,
    displayName: providerId === 'claude' ? 'Claude Agent' : 'Codex',
    protocol,
    available: true,
    executablePath: `C:\\Tools\\${providerId}.exe`,
    executableVersion,
    argv: protocol === 'codex-app-server' ? ['app-server'] : [],
    environmentVariableNames: ['PATH'],
    capabilities: ['create', 'resume', 'interrupt', 'model-change', 'permission-change', 'approvals'],
  };
}

interface Prediction { readonly input: ProviderPredictInput; readonly signal: AbortSignal; resolve(text: string | undefined): void }

function fakeAdapter(providerId: 'claude' | 'codex', protocol: ProviderProbeResult['protocol'], minimumVersion: string) {
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const predictions: Prediction[] = [];
  let sequence = 0;
  const adapter: AgentProviderAdapter & { emit(event: AgentProviderEvent): void; readonly predictions: Prediction[]; setPromptSuggestions: ReturnType<typeof vi.fn> } = {
    providerId,
    wrapUp: { suggestions: providerId === 'claude' ? 'native' : 'fork', recapWhileBlocked: true, minimumVersion },
    predictions,
    probe: vi.fn(async () => probe(providerId, protocol, '1.2.0')),
    listModels: vi.fn(async () => []),
    createSession: vi.fn(async (context) => ({
      sessionId: context.sessionId, providerSessionId: `${providerId}-session-${String(++sequence)}`, model: context.model, permissionPreset: context.permissionPreset,
    })),
    resumeSession: vi.fn(async (context) => ({ sessionId: context.sessionId, providerSessionId: context.providerSessionId, permissionPreset: context.permissionPreset })),
    submit: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    setSettings: vi.fn(async (input) => ({ sessionId: input.sessionId, providerSessionId: input.providerSessionId, permissionPreset: input.permissionPreset ?? 'standard' })),
    resolveApproval: vi.fn(async () => undefined),
    setPromptSuggestions: vi.fn(async () => undefined),
    ...(providerId === 'codex' ? { predictNextPrompt: vi.fn((input: ProviderPredictInput, signal: AbortSignal) => new Promise<string | undefined>((resolve, reject) => {
      predictions.push({ input, signal, resolve });
      signal.addEventListener('abort', () => reject(new ProviderSideQuestionError('cancelled')), { once: true });
    })) } : {}),
    subscribe: vi.fn((listener) => { listeners.add(listener); return () => listeners.delete(listener); }),
    reconcile: vi.fn(async () => ({ commands: [], transcriptItems: [] })),
    disposeSession: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    emit: (event) => { for (const listener of listeners) listener(event); },
  };
  return adapter;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settled = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const NOW_MS = Date.parse('2026-10-30T10:00:00.000Z');

async function harness(options: { readonly minimumVersion?: string; readonly prepared?: (sessionId: string) => boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-wrap-up-'));
  temporaryDirectories.push(directory);
  const root = path.join(directory, 'repo');
  await fs.mkdir(root, { recursive: true });
  let tick = 0;
  const now = () => new Date(NOW_MS + (tick += 1));
  const store = new DaemonStore(path.join(directory, 'daemon'), { now });
  await store.init();
  const codex = fakeAdapter('codex', 'codex-app-server', options.minimumVersion ?? '1.0.0');
  const claude = fakeAdapter('claude', 'claude-agent-sdk', options.minimumVersion ?? '1.0.0');
  const providers = new AgentProviderRegistry([codex, claude]);
  const routerRef: { current?: DaemonCommandRouter } = {};
  const settings: { current: TurnWrapUpSettings | undefined } = { current: DEFAULT_TURN_WRAP_UP_SETTINGS };
  const errors: string[] = [];
  const coordinator = new TurnWrapUpCoordinator({
    getSnapshot: () => routerRef.current!.getSnapshot(),
    applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
    onEvent: (listener) => routerRef.current!.onEvent(listener),
    providers,
    settings: () => settings.current,
    allowed: (sessionId, turn) => wrapUpAllowed(routerRef.current!.getSnapshot(), sessionId, {
      prepared: options.prepared?.(sessionId) ?? false,
      ...(turn ? { turnCommand: store.findCommand(turn.commandId)?.command ?? null } : {}),
    }),
    now,
    settleMs: 5,
    reportError: (context, error) => { errors.push(`${context}: ${String(error)}`); },
  });
  const runtime = new DaemonAgentRuntime({
    providers,
    getSnapshot: () => routerRef.current!.getSnapshot(),
    applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
    applySystemTransition: (transition) => routerRef.current!.applySystemTransition(transition),
    readTranscript: (sessionId, afterSequence, limit) => routerRef.current!.readTranscript(sessionId, afterSequence, limit),
    findCommand: (commandId) => store.findCommand(commandId)?.command,
    executeCommand: (command) => routerRef.current!.execute(command),
    wrapUp: coordinator,
    now,
    idFactory: (() => { let id = 0; return () => `runtime-id-${String(++id)}`; })(),
  });
  const router = new DaemonCommandRouter(store, {
    handlers: runtime.handlers(),
    agentUsage: (snapshot) => runtime.agentUsage(snapshot),
    nextPromptSuggestions: (snapshot) => coordinator.nextPromptSuggestions(snapshot),
  });
  routerRef.current = router;
  await runtime.start();
  const currentTurn = (sessionId: string): string | undefined => router.getSnapshot().agents.find((agent) => agent.sessionId === sessionId)?.currentTurnId;

  let commandSequence = 0;
  const execute = async <T extends DaemonCommandType>(
    type: T,
    payload: Parameters<typeof createDaemonCommand<T>>[0]['payload'],
    principal: DaemonPrincipal = { kind: 'desktop', id: 'person' },
  ) => {
    const suffix = ++commandSequence;
    const receipt = await router.execute(createDaemonCommand({
      commandId: `command-${String(suffix)}`, idempotencyKey: `test:${String(suffix)}`, expectedRevision: store.getRevision(),
      issuedAt: '2026-10-30T10:00:00.000Z', principal, type, payload,
    }));
    await runtime.whenIdle();
    return receipt;
  };
  const enable = async (adapter: typeof codex) => {
    const inspected = await providers.inspect(adapter.providerId);
    if (!inspected.ok) throw new Error(inspected.message);
    const current = inspected.value.probe;
    return execute('provider.enable', {
      providerId: current.providerId, displayName: current.displayName, protocol: current.protocol, executablePath: current.executablePath,
      executableVersion: current.executableVersion, argv: current.argv, environmentVariableNames: current.environmentVariableNames,
      capabilities: current.capabilities, reviewDigest: createProviderReviewDigest(await adapter.probe()),
    });
  };
  await enable(codex);
  await enable(claude);
  await execute('project.create', { projectId: 'project-1', name: 'Cart', rootPath: root });
  await execute('workspace.create', { workspaceId: 'workspace-1', projectId: 'project-1', name: 'Local', kind: 'local', rootPath: root });
  await coordinator.start();

  const finishTurn = async (adapter: typeof codex, sessionId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed') => {
    const turnId = currentTurn(sessionId);
    if (!turnId) throw new Error(`${sessionId} runs no turn.`);
    adapter.emit({ kind: 'turn-finished', sessionId, turnId, outcome });
    await runtime.whenIdle();
    adapter.emit({ kind: 'session-state', sessionId, state: 'idle' });
    await runtime.whenIdle();
    return turnId;
  };
  /** A conversation with one finished turn: its provider session is known. */
  const conversation = async (providerId: 'codex' | 'claude', sessionId = 'chat', principal?: DaemonPrincipal) => {
    await execute('agent.create', { sessionId, workspaceId: 'workspace-1', title: 'Fix prices', providerId, permissionPreset: 'standard', initialPrompt: 'Fix the price display.' }, principal);
    return finishTurn(providerId === 'codex' ? codex : claude, sessionId);
  };
  const suggestion = (sessionId = 'chat') => router.getSnapshot().nextPromptSuggestions?.[sessionId];
  const suggest = async (turnId: string, text = 'Run the tests.', sessionId = 'chat') => {
    claude.emit({ kind: 'prompt-suggestion', sessionId, turnId, text });
    await runtime.whenIdle();
  };
  return { store, router, runtime, coordinator, providers, codex, claude, errors, settings, execute, finishTurn, conversation, suggestion, suggest, currentTurn };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function dispose(h: Harness): Promise<void> {
  h.coordinator.dispose();
  await h.runtime.dispose('process-loss');
  await h.store.close();
  expect(h.errors).toEqual([]);
}

vi.setConfig({ testTimeout: 20_000 });

describe('a provider\'s own next-prompt suggestion', () => {
  it('is kept in memory for the newest finished turn and never stored', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      await h.suggest(turnId);
      await until(() => h.suggestion() !== undefined, 'the suggestion');
      expect(h.suggestion()).toEqual({ turnId, text: 'Run the tests.' });
      expect(h.store.getSnapshot()).not.toHaveProperty('nextPromptSuggestions');
      expect(h.router.readTranscript('chat', 0, 100).some((item) => item.text.includes('Run the tests.'))).toBe(false);
    } finally { await dispose(h); }
  });

  it('tells clients: they refetch the snapshot that carries it', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      const events: string[] = [];
      const stop = h.router.onEvent((event) => { if (event.kind === 'entity.upserted' && event.payload.entityType === 'agent') events.push(event.payload.entityId); });
      await h.suggest(turnId);
      await until(() => events.includes('chat'), 'the announcement');
      stop();
    } finally { await dispose(h); }
  });

  it('is dropped while a message waits behind the turn', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'And then.' });
      const first = h.currentTurn('chat')!;
      h.claude.emit({ kind: 'turn-finished', sessionId: 'chat', turnId: first, outcome: 'completed' });
      await h.runtime.whenIdle();
      await h.suggest(first);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is dropped once it is not for the newest turn', async () => {
    const h = await harness();
    try {
      const old = await h.conversation('claude');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      await h.finishTurn(h.claude, 'chat');
      await h.suggest(old);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is dropped for a turn that did not complete', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      const turnId = await h.finishTurn(h.claude, 'chat', 'interrupted');
      await h.suggest(turnId);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('goes away with the next message, at once', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      await h.suggest(turnId);
      await until(() => h.suggestion() !== undefined, 'the suggestion');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('goes away when the conversation is archived', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      await h.suggest(turnId);
      await until(() => h.suggestion() !== undefined, 'the suggestion');
      await h.execute('agent.archive', { sessionId: 'chat' });
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('goes away when the switch is turned off', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      await h.suggest(turnId);
      await until(() => h.suggestion() !== undefined, 'the suggestion');
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, suggestions: { claude: false, codex: true } };
      h.coordinator.settingsChanged();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is ignored with the switch off', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, suggestions: { claude: false, codex: true } };
      await h.suggest(turnId);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is ignored until the settings have loaded', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      h.settings.current = undefined;
      await h.suggest(turnId);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is ignored for a turn no person sent', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Heartbeat.' }, AUTOMATION);
      const turnId = await h.finishTurn(h.claude, 'chat');
      await h.suggest(turnId);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is ignored for a session that is not eligible', async () => {
    const h = await harness({ prepared: (sessionId) => sessionId === 'chat' });
    try {
      const turnId = await h.conversation('claude');
      await h.suggest(turnId);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is ignored from an AI below the measured version', async () => {
    const h = await harness({ minimumVersion: '9.0.0' });
    try {
      const turnId = await h.conversation('claude');
      await h.suggest(turnId);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });
});

describe('a forked next-prompt prediction', () => {
  it('runs on the conversation\'s live session once the turn has settled', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      const prediction = h.codex.predictions[0]!;
      expect(prediction.input).toEqual({ sessionId: 'chat', providerSessionId: 'codex-session-1' });
      prediction.resolve('Run the tests.');
      await until(() => h.suggestion() !== undefined, 'the suggestion');
      expect(h.suggestion()).toEqual({ turnId, text: 'Run the tests.' });
    } finally { await dispose(h); }
  });

  it('runs once for a turn, however often the turn is written', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      await h.router.applySystemCommit((snapshot) => {
        const turn = snapshot.turns.find((entry) => entry.id === turnId)!;
        return { mutations: [{ kind: 'turn.upsert', value: { id: turn.id, sessionId: turn.sessionId, commandId: turn.commandId, state: turn.state, finishedAt: turn.finishedAt! } }] };
      });
      await settled();
      expect(h.codex.predictions).toHaveLength(1);
    } finally { await dispose(h); }
  });

  it('leaves no suggestion when the AI has none', async () => {
    const h = await harness();
    try {
      await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      h.codex.predictions[0]!.resolve(undefined);
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('skips a conversation that is busy again once the turn settled', async () => {
    const h = await harness();
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      await h.finishTurn(h.codex, 'chat');
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('is aborted by the next message, which does not wait for it', async () => {
    const h = await harness();
    try {
      await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      const prediction = h.codex.predictions[0]!;
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      await until(() => prediction.signal.aborted, 'the abort');
      expect(h.suggestion()).toBeUndefined();
      expect(h.currentTurn('chat')).toBeDefined();
    } finally { await dispose(h); }
  });

  it('drops an answer that lands after the next message', async () => {
    const h = await harness();
    try {
      await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      h.codex.predictions[0]!.resolve('Run the tests.');
      await settled();
      expect(h.suggestion()).toBeUndefined();
    } finally { await dispose(h); }
  });

  it('is aborted when the switch is turned off', async () => {
    const h = await harness();
    try {
      await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, suggestions: { claude: true, codex: false } };
      h.coordinator.settingsChanged();
      expect(h.codex.predictions[0]!.signal.aborted).toBe(true);
    } finally { await dispose(h); }
  });

  it('never starts with the switch off', async () => {
    const h = await harness();
    try {
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, suggestions: { claude: true, codex: false } };
      await h.conversation('codex');
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('never starts while a usage window is at the danger level', async () => {
    const h = await harness();
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      h.codex.emit({ kind: 'usage', sessionId: 'chat', limits: { fiveHour: { usedPercent: 92, resetsAt: NOW_MS + 60_000 } } });
      await h.runtime.whenIdle();
      await h.finishTurn(h.codex, 'chat');
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('runs past the danger level when the pause is off', async () => {
    const h = await harness();
    try {
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, pauseNearLimit: false };
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'codex', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      h.codex.emit({ kind: 'usage', sessionId: 'chat', limits: { fiveHour: { usedPercent: 92, resetsAt: NOW_MS + 60_000 } } });
      await h.runtime.whenIdle();
      await h.finishTurn(h.codex, 'chat');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
    } finally { await dispose(h); }
  });

  it('never starts for a turn no person sent', async () => {
    const h = await harness();
    try {
      await h.conversation('codex', 'chat', AUTOMATION);
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('never starts for a session that is not eligible', async () => {
    const h = await harness({ prepared: (sessionId) => sessionId === 'chat' });
    try {
      await h.conversation('codex');
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('never starts for an AI below the measured version', async () => {
    const h = await harness({ minimumVersion: '9.0.0' });
    try {
      await h.conversation('codex');
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('never starts until the settings have loaded', async () => {
    const h = await harness();
    try {
      h.settings.current = undefined;
      await h.conversation('codex');
      await settled();
      expect(h.codex.predictions).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('stops on shutdown', async () => {
    const h = await harness();
    try {
      await h.conversation('codex');
      await until(() => h.codex.predictions.length === 1, 'the prediction');
      const prediction = h.codex.predictions[0]!;
      h.coordinator.dispose();
      expect(prediction.signal.aborted).toBe(true);
    } finally { await dispose(h); }
  });
});

describe('the live switch for a provider\'s own suggestions', () => {
  const pause = async (h: Harness, usedPercent: number) => {
    h.claude.emit({ kind: 'usage', sessionId: 'chat', limits: { fiveHour: { usedPercent, resetsAt: NOW_MS + 60_000 } } });
    await h.runtime.whenIdle();
    await settled(10);
  };

  it('follows the setting at once', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      h.claude.setPromptSuggestions.mockClear();
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, suggestions: { claude: false, codex: true } };
      h.coordinator.settingsChanged();
      expect(h.claude.setPromptSuggestions).toHaveBeenCalledWith('chat', 'off');
    } finally { await dispose(h); }
  });

  it('follows the pause and lets go of it', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      await pause(h, 90);
      expect(h.claude.setPromptSuggestions).toHaveBeenLastCalledWith('chat', 'off');
      await pause(h, 20);
      expect(h.claude.setPromptSuggestions).toHaveBeenLastCalledWith('chat', 'on');
    } finally { await dispose(h); }
  });

  it('switches once for a change, not per event', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      await pause(h, 90);
      h.claude.setPromptSuggestions.mockClear();
      await pause(h, 91);
      await pause(h, 92);
      expect(h.claude.setPromptSuggestions).not.toHaveBeenCalled();
    } finally { await dispose(h); }
  });

  it('keeps them on past the limit when the pause is off', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, pauseNearLimit: false };
      h.coordinator.settingsChanged();
      expect(h.claude.setPromptSuggestions).toHaveBeenLastCalledWith('chat', 'on-past-limit');
    } finally { await dispose(h); }
  });

  it('leaves off a turn no person sent, which is running now', async () => {
    const h = await harness();
    try {
      await h.conversation('claude');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Heartbeat.' }, AUTOMATION);
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, pauseNearLimit: false };
      h.coordinator.settingsChanged();
      expect(h.claude.setPromptSuggestions).toHaveBeenLastCalledWith('chat', 'off');
    } finally { await dispose(h); }
  });

  it('never touches a session that is not eligible', async () => {
    const h = await harness({ prepared: (sessionId) => sessionId === 'chat' });
    try {
      await h.conversation('claude');
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, pauseNearLimit: false };
      h.coordinator.settingsChanged();
      expect(h.claude.setPromptSuggestions).not.toHaveBeenCalled();
    } finally { await dispose(h); }
  });

  it('never touches an AI below the measured version', async () => {
    const h = await harness({ minimumVersion: '9.0.0' });
    try {
      await h.conversation('claude');
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, pauseNearLimit: false };
      h.coordinator.settingsChanged();
      expect(h.claude.setPromptSuggestions).not.toHaveBeenCalled();
    } finally { await dispose(h); }
  });
});

describe('snapshots', () => {
  it('keeps a snapshot without suggestions free of the field', async () => {
    const h = await harness();
    try {
      const snapshot: DaemonSnapshot = h.router.getSnapshot();
      expect(snapshot).not.toHaveProperty('nextPromptSuggestions');
    } finally { await dispose(h); }
  });
});
