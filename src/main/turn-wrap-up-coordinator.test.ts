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
  type PermissionPreset,
} from '../shared/daemon-protocol';
import type { ApprovalRequest } from '../shared/approval-request';
import { parseTranscriptPayload, type RecapPayload } from '../shared/transcript-payload';
import { type ConversationViewingStatus } from '../shared/conversation-viewing';
import {
  DEFAULT_TURN_WRAP_UP_SETTINGS, RECAP_INSTRUCTION, recapQuestion, suggestedTaskChildSessionId, TURN_RECAP_LIMITS, type TurnWrapUpSettings,
} from '../shared/turn-wrap-up';
import {
  ProviderSideQuestionError,
  type AgentProviderAdapter,
  type AgentProviderEvent,
  type ProviderPredictInput,
  type ProviderProbeResult,
  type ProviderSideQuestionAnswer,
  type ProviderSideQuestionInput,
} from './agent-provider-adapter';
import { AgentProviderRegistry, createProviderReviewDigest } from './agent-provider-registry';
import { DaemonAgentRuntime } from './daemon-agent-runtime';
import { DaemonCommandRouter } from './daemon-command-router';
import { DaemonStore } from './daemon-store';
import { suggestionMode, TurnWrapUpCoordinator, turnWrapUpPauses, wrapUpAllowed, type RecapJobRecord } from './turn-wrap-up-coordinator';

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
interface Ask { readonly input: ProviderSideQuestionInput; readonly signal: AbortSignal; resolve(answer: ProviderSideQuestionAnswer): void; reject(error: unknown): void }

function fakeAdapter(providerId: 'claude' | 'codex', protocol: ProviderProbeResult['protocol'], minimumVersion: string, sideQuestions: boolean) {
  const listeners = new Set<(event: AgentProviderEvent) => void>();
  const predictions: Prediction[] = [];
  const asks: Ask[] = [];
  let sequence = 0;
  const adapter: AgentProviderAdapter & { emit(event: AgentProviderEvent): void; readonly predictions: Prediction[]; readonly asks: Ask[]; setPromptSuggestions: ReturnType<typeof vi.fn> } = {
    providerId,
    wrapUp: { suggestions: providerId === 'claude' ? 'native' : 'fork', recapWhileBlocked: true, minimumVersion },
    predictions,
    asks,
    ...(sideQuestions ? { askSideQuestion: vi.fn((input: ProviderSideQuestionInput, signal: AbortSignal) => new Promise<ProviderSideQuestionAnswer>((resolve, reject) => {
      asks.push({ input, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new ProviderSideQuestionError('cancelled')), { once: true });
    })) } : {}),
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

async function harness(options: {
  readonly minimumVersion?: string;
  readonly prepared?: (sessionId: string) => boolean;
  readonly sideQuestions?: boolean;
  readonly viewing?: ConversationViewingStatus;
  readonly stored?: unknown;
  readonly recapTimeoutMs?: number;
  readonly startLater?: boolean;
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-wrap-up-'));
  temporaryDirectories.push(directory);
  const root = path.join(directory, 'repo');
  await fs.mkdir(root, { recursive: true });
  let tick = 0;
  const now = () => new Date(NOW_MS + (tick += 1));
  const store = new DaemonStore(path.join(directory, 'daemon'), { now });
  await store.init();
  const codex = fakeAdapter('codex', 'codex-app-server', options.minimumVersion ?? '1.0.0', options.sideQuestions ?? true);
  const claude = fakeAdapter('claude', 'claude-agent-sdk', options.minimumVersion ?? '1.0.0', options.sideQuestions ?? true);
  const providers = new AgentProviderRegistry([codex, claude]);
  const routerRef: { current?: DaemonCommandRouter } = {};
  const settings: { current: TurnWrapUpSettings | undefined } = { current: DEFAULT_TURN_WRAP_UP_SETTINGS };
  const errors: string[] = [];
  const viewing: { status: ConversationViewingStatus } = { status: options.viewing ?? 'viewed' };
  let saved: unknown = options.stored;
  const runtimeRef: { current?: DaemonAgentRuntime } = {};
  const coordinator = new TurnWrapUpCoordinator({
    getSnapshot: () => routerRef.current!.getSnapshot(),
    applySystemCommit: (commit) => routerRef.current!.applySystemCommit(commit),
    readTranscript: (sessionId, afterSequence, limit) => routerRef.current!.readTranscript(sessionId, afterSequence, limit),
    onEvent: (listener) => routerRef.current!.onEvent(listener),
    ask: (input, signal) => runtimeRef.current!.askSideQuestion(input, signal),
    viewers: { status: () => viewing.status },
    store: { load: async () => saved, save: async (jobs) => { saved = jobs; } },
    ...(options.recapTimeoutMs ? { recapTimeoutMs: options.recapTimeoutMs } : {}),
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
  runtimeRef.current = runtime;
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
  if (!options.startLater) await coordinator.start();

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
  const recaps = (sessionId = 'chat'): RecapPayload[] => router.readTranscript(sessionId, 0, 2_000).flatMap((item) => {
    const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
    return payload?.type === 'recap' ? [payload] : [];
  });
  const recapRows = (sessionId = 'chat') => router.readTranscript(sessionId, 0, 2_000).filter((item) => item.payload?.type === 'recap');
  /** The approval a stopped turn raises, as a provider raises it. */
  const raise = async (adapter: typeof codex, sessionId: string, request: Extract<AgentProviderEvent, { kind: 'approval-requested' }>['request'], providerRequestId = 'request-1') => {
    adapter.emit({ kind: 'approval-requested', sessionId, ...(currentTurn(sessionId) ? { turnId: currentTurn(sessionId)! } : {}), providerRequestId, risk: 'write', title: 'Edit a file', ...(request ? { request } : {}) });
    await runtime.whenIdle();
    return router.getSnapshot().approvals.at(-1)!;
  };
  return {
    store, router, runtime, coordinator, providers, codex, claude, errors, settings, viewing, execute, finishTurn, conversation, suggestion, suggest, currentTurn,
    recaps, recapRows, raise, saved: () => saved, setSaved: (jobs: unknown) => { saved = jobs; },
  };
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

describe('a recap at the end of a turn', () => {
  const answer = (text: string | null, synthetic = false): ProviderSideQuestionAnswer => ({ text, synthetic });

  it('asks the conversation\'s AI once nobody watches, and stores what it said as sensitive', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      expect(h.claude.asks[0]!.input).toEqual({ sessionId: 'chat', providerSessionId: 'claude-session-1', question: RECAP_INSTRUCTION, history: [] });
      expect(h.recaps().at(-1)).toMatchObject({ turnId, providerId: 'claude', trigger: 'unattended', state: 'generating' });
      h.claude.asks[0]!.resolve(answer('Changed the price display.\
Check the cart page.'));
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      expect(h.recaps().at(-1)).toMatchObject({ turnId, providerId: 'claude', trigger: 'unattended', state: 'complete', text: 'Changed the price display.\
Check the cart page.' });
      expect(h.recapRows().every((row) => row.isSensitive && row.kind === 'notice' && row.turnId === turnId)).toBe(true);
    } finally { await dispose(h); }
  });

  it('never spends a call while the conversation is on screen', async () => {
    const h = await harness({ viewing: 'viewed' });
    try {
      await h.conversation('claude');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
      expect(h.recaps()).toEqual([]);
    } finally { await dispose(h); }
  });

  it('never spends a call while a window has not said what it shows', async () => {
    const h = await harness({ viewing: 'unknown' });
    try {
      await h.conversation('claude');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('decides after the turn settled: a person who came back in time gets none', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      const finished = h.finishTurn(h.claude, 'chat');
      h.viewing.status = 'viewed';
      await finished;
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('is one per turn, however often the turn is written', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      h.claude.asks[0]!.resolve(answer('Done.'));
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      await h.router.applySystemCommit((snapshot) => {
        const turn = snapshot.turns.find((entry) => entry.id === turnId)!;
        return { mutations: [{ kind: 'turn.upsert', value: { id: turn.id, sessionId: turn.sessionId, commandId: turn.commandId, state: turn.state, finishedAt: turn.finishedAt! } }] };
      });
      await settled();
      expect(h.claude.asks).toHaveLength(1);
      expect(h.recaps()).toHaveLength(2);
    } finally { await dispose(h); }
  });

  it('skips a turn with a message queued behind it', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      await h.finishTurn(h.claude, 'chat');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('skips a turn that did not complete', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      await h.finishTurn(h.claude, 'chat', 'interrupted');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('stays valid when a new turn starts meanwhile', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      expect(h.claude.asks[0]!.signal.aborted).toBe(false);
      h.claude.asks[0]!.resolve(answer('Done.'));
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
    } finally { await dispose(h); }
  });

  it('stops with the recaps switch', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, recaps: false };
      await h.conversation('claude');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
      expect(h.recaps()).toEqual([]);
    } finally { await dispose(h); }
  });

  it('waits for the settings to load', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      h.settings.current = undefined;
      await h.conversation('claude');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('is only for a turn a person sent', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.conversation('claude', 'chat', AUTOMATION);
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('is only for an eligible session', async () => {
    const h = await harness({ viewing: 'unviewed', prepared: (sessionId) => sessionId === 'chat' });
    try {
      await h.conversation('claude');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
      expect(h.recaps()).toEqual([]);
    } finally { await dispose(h); }
  });

  it('never reaches an AI below the measured version', async () => {
    const h = await harness({ viewing: 'unviewed', minimumVersion: '9.0.0' });
    try {
      await h.conversation('claude');
      await settled();
      expect(h.claude.asks).toHaveLength(0);
      expect(h.recaps()).toEqual([]);
    } finally { await dispose(h); }
  });

  it('writes nothing for an AI that cannot answer aside', async () => {
    const h = await harness({ viewing: 'unviewed', sideQuestions: false });
    try {
      await h.conversation('claude');
      await settled();
      expect(h.recaps()).toEqual([]);
    } finally { await dispose(h); }
  });

  it('says so instead of calling while a usage window is at the danger level', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      h.claude.emit({ kind: 'usage', sessionId: 'chat', limits: { weekly: { usedPercent: 93 } } });
      await h.runtime.whenIdle();
      await h.finishTurn(h.claude, 'chat');
      await until(() => h.recaps().length === 1, 'the line');
      expect(h.recaps()[0]).toMatchObject({ state: 'failed', failure: 'usage-limit', trigger: 'unattended' });
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('calls past the danger level when the pause is off', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      h.settings.current = { ...DEFAULT_TURN_WRAP_UP_SETTINGS, pauseNearLimit: false };
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      h.claude.emit({ kind: 'usage', sessionId: 'chat', limits: { weekly: { usedPercent: 93 } } });
      await h.runtime.whenIdle();
      await h.finishTurn(h.claude, 'chat');
      await until(() => h.claude.asks.length === 1, 'the recap call');
    } finally { await dispose(h); }
  });

  it('cuts a long answer to what the row holds', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      h.claude.asks[0]!.resolve(answer('x'.repeat(20_000)));
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      expect(h.recaps().at(-1)!.text!.length).toBeLessThanOrEqual(TURN_RECAP_LIMITS.text);
      expect(h.recapRows().at(-1)!.text.length).toBeLessThanOrEqual(TURN_RECAP_LIMITS.text);
    } finally { await dispose(h); }
  });

  it.each<[string, (ask: Ask) => void, 'disconnected' | 'no-response']>([
    ['a session that is gone', (ask) => { ask.reject(new ProviderSideQuestionError('not-live')); }, 'disconnected'],
    ['a session restarted underneath it', (ask) => { ask.reject(new ProviderSideQuestionError('session-restarted')); }, 'disconnected'],
    ['a provider failure', (ask) => { ask.reject(new ProviderSideQuestionError('failed')); }, 'no-response'],
    ['a provider that stopped offering it', (ask) => { ask.reject(new ProviderSideQuestionError('unsupported')); }, 'no-response'],
    ['an unexpected error', (ask) => { ask.reject(new Error('boom')); }, 'no-response'],
    ['a blank answer', (ask) => { ask.resolve(answer('   ')); }, 'no-response'],
    ['no answer', (ask) => { ask.resolve(answer(null)); }, 'no-response'],
    ['a synthetic answer', (ask) => { ask.resolve(answer('Rate limited.', true)); }, 'no-response'],
  ])('reports %s as a failure the card can word', async (_name, fail, failure) => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      fail(h.claude.asks[0]!);
      await until(() => h.recaps().at(-1)?.state === 'failed', 'the failure');
      expect(h.recaps().at(-1)).toMatchObject({ state: 'failed', failure });
      expect(h.recaps().at(-1)).not.toHaveProperty('text');
      await until(() => Object.keys(h.saved() as object).length === 0, 'the job to leave the file');
    } finally { await dispose(h); }
  });

  it('gives up on an AI that does not answer', async () => {
    const h = await harness({ viewing: 'unviewed', recapTimeoutMs: 20 });
    try {
      await h.conversation('claude');
      await until(() => h.recaps().at(-1)?.state === 'failed', 'the timeout');
      expect(h.recaps().at(-1)).toMatchObject({ state: 'failed', failure: 'no-response' });
      expect(h.claude.asks[0]!.signal.aborted).toBe(true);
    } finally { await dispose(h); }
  });

  it('runs for a child a person started from a card, on the turns the person sends', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the parent\'s recap call');
      h.claude.asks[0]!.resolve(answer('Done.'));
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the parent\'s recap');
      const child = suggestedTaskChildSessionId('task-1');
      await h.execute('agent.create', { sessionId: child, workspaceId: 'workspace-1', title: 'Task', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Do it.', parentSessionId: 'chat' });
      await h.finishTurn(h.claude, child);
      await settled();
      expect(h.claude.asks).toHaveLength(1);
      await h.execute('agent.submit', { sessionId: child, prompt: 'And the docs.' });
      const turnId = await h.finishTurn(h.claude, child);
      await until(() => h.claude.asks.length === 2, 'the child\'s recap call');
      h.claude.asks[1]!.resolve(answer('Docs updated.'));
      await until(() => h.recaps(child).at(-1)?.state === 'complete', 'the child\'s recap');
      expect(h.recaps(child).at(-1)).toMatchObject({ turnId, text: 'Docs updated.' });
    } finally { await dispose(h); }
  });
});

describe('a recap while the AI waits on the person', () => {
  const FILE_CHANGE: ApprovalRequest = { v: 1, kind: 'file-change', files: [{ path: 'src/cart/format.ts' }] };
  const start = async (h: Harness, providerId: 'claude' | 'codex' = 'claude') => {
    await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId, permissionPreset: 'standard', initialPrompt: 'Fix.' });
    return h.currentTurn('chat')!;
  };

  it('says the turn is stopped, names what is open and which decision it waits on', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await start(h);
      const approval = await h.raise(h.claude, 'chat', FILE_CHANGE);
      await until(() => h.claude.asks.length === 1, 'the recap call');
      expect(h.claude.asks[0]!.input.question).toBe(recapQuestion('the person has not answered your request to change format.ts.'));
      h.claude.asks[0]!.resolve({ text: 'Waiting on your approval of format.ts.', synthetic: false });
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      expect(h.recaps().at(-1)).toMatchObject({ turnId, trigger: 'waiting', waiting: 'approval', decisionId: approval.id, text: 'Waiting on your approval of format.ts.' });
    } finally { await dispose(h); }
  });

  it.each<[string, ApprovalRequest, string]>([
    ['question', { v: 1, kind: 'question', questions: [{ question: 'Which file?', multiSelect: false, options: [] }] }, 'the person has not answered your question: "Which file?".'],
    ['plan', { v: 1, kind: 'plan', markdown: '# Plan' }, 'the person has not answered your plan.'],
    ['approval', { v: 1, kind: 'command', command: 'pnpm test' }, 'the person has not answered your request to run a command.'],
    ['approval', { v: 1, kind: 'tool', toolName: 'WebFetch' }, 'the person has not answered your request to use WebFetch.'],
  ])('tells a stopped %s from the rest', async (waiting, request, note) => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await start(h);
      await h.raise(h.claude, 'chat', request);
      await until(() => h.claude.asks.length === 1, 'the recap call');
      expect(h.claude.asks[0]!.input.question).toBe(recapQuestion(note));
      expect(h.recaps().at(-1)).toMatchObject({ trigger: 'waiting', waiting });
    } finally { await dispose(h); }
  });

  it('reads the approval\'s own title when it has no structured request', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await start(h);
      await h.raise(h.claude, 'chat', undefined);
      await until(() => h.claude.asks.length === 1, 'the recap call');
      expect(h.claude.asks[0]!.input.question).toBe(recapQuestion('the person has not answered your request: Edit a file.'));
    } finally { await dispose(h); }
  });

  it('never spends a call while the conversation is on screen', async () => {
    const h = await harness({ viewing: 'viewed' });
    try {
      await start(h);
      await h.raise(h.claude, 'chat', FILE_CHANGE);
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('skips a request answered while it settled', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await start(h);
      const approval = await h.raise(h.claude, 'chat', FILE_CHANGE);
      await h.execute('permission.resolve', { approvalId: approval.id, decision: 'allow' });
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('ignores a provider subagent\'s request', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await start(h);
      await h.raise(h.claude, 'chat', { ...FILE_CHANGE, subagent: { sessionId: 'sub', title: 'Sub' } });
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('ignores a settings proposal, which belongs to no stop', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the end-of-turn recap');
      h.claude.asks[0]!.resolve({ text: 'Done.', synthetic: false });
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
      await h.raise(h.claude, 'chat', undefined, 'settings-proposal:1');
      await settled();
      expect(h.claude.asks).toHaveLength(1);
      expect(h.recaps().every((recap) => recap.turnId === turnId)).toBe(true);
    } finally { await dispose(h); }
  });

  it('is only for a turn a person sent', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' }, AUTOMATION);
      await h.raise(h.claude, 'chat', FILE_CHANGE);
      await settled();
      expect(h.claude.asks).toHaveLength(0);
    } finally { await dispose(h); }
  });

  it('takes the turn\'s one recap: the turn\'s end adds none', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await start(h);
      const approval = await h.raise(h.claude, 'chat', FILE_CHANGE);
      await until(() => h.claude.asks.length === 1, 'the recap call');
      h.claude.asks[0]!.resolve({ text: 'Waiting on you.', synthetic: false });
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      await h.execute('permission.resolve', { approvalId: approval.id, decision: 'allow' });
      await h.finishTurn(h.claude, 'chat');
      await settled();
      expect(h.claude.asks).toHaveLength(1);
      expect(h.recaps()).toHaveLength(2);
    } finally { await dispose(h); }
  });

  it('binds a plan Codex proposes after its turn ended to that turn, as a wait', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await start(h, 'codex');
      await h.finishTurn(h.codex, 'chat');
      const approval = await h.raise(h.codex, 'chat', { v: 1, kind: 'plan', markdown: '# Plan' }, 'proposed-plan:turn-1');
      await until(() => h.codex.asks.length === 1, 'the recap call');
      await settled();
      expect(h.codex.asks).toHaveLength(1);
      expect(h.recaps()).toHaveLength(1);
      expect(h.recaps()[0]).toMatchObject({ turnId, trigger: 'waiting', waiting: 'plan', decisionId: approval.id, state: 'generating' });
    } finally { await dispose(h); }
  });
});

describe('recaps across a restart', () => {
  const job: RecapJobRecord = { sessionId: 'chat', turnId: 'turn-1', providerId: 'claude', trigger: 'unattended', attempt: 'start' };

  it('keeps a running recap on file until it ends', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      expect(Object.values(h.saved() as object)).toEqual([expect.objectContaining({ sessionId: 'chat', turnId, providerId: 'claude', trigger: 'unattended', attempt: 'start' })]);
      h.claude.asks[0]!.resolve({ text: 'Done.', synthetic: false });
      await until(() => Object.keys(h.saved() as object).length === 0, 'the job to leave the file');
    } finally { await dispose(h); }
  });

  it('marks what the last run left running as disconnected, and forgets it', async () => {
    const h = await harness({ startLater: true });
    try {
      const turnId = await h.conversation('claude');
      h.setSaved({ [turnId]: { ...job, turnId } });
      await h.coordinator.start();
      expect(h.recaps()).toEqual([expect.objectContaining({ turnId, state: 'failed', failure: 'disconnected', trigger: 'unattended' })]);
      expect(h.recapRows()[0]).toMatchObject({ isSensitive: true, turnId });
      expect(h.saved()).toEqual({});
    } finally { await dispose(h); }
  });

  it('writes nothing for a conversation that is gone, and drops a malformed record', async () => {
    const h = await harness({ stored: { 'turn-1': job, bad: { sessionId: 'chat' }, 'not-an-object': 3 } });
    try {
      expect(h.saved()).toEqual({});
    } finally { await dispose(h); }
  });

  it('leaves the record for the next start when the app closes mid-recap', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      const ask = h.claude.asks[0]!;
      h.coordinator.dispose();
      expect(ask.signal.aborted).toBe(true);
      await settled();
      expect(h.recaps().at(-1)?.state).toBe('generating');
      expect(Object.keys(h.saved() as object)).toHaveLength(1);
    } finally { await dispose(h); }
  });
});

describe('wrap-up.recap-retry', () => {
  const failed = async (h: Harness) => {
    const turnId = await h.conversation('claude');
    await until(() => h.claude.asks.length === 1, 'the recap call');
    h.claude.asks[0]!.reject(new ProviderSideQuestionError('not-live'));
    await until(() => h.recaps().at(-1)?.state === 'failed', 'the failure');
    return turnId;
  };

  it('asks again and writes a new card state', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await failed(h);
      const receipt = await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId });
      expect(receipt.ok).toBe(true);
      expect(h.recaps().at(-1)).toMatchObject({ turnId, state: 'generating', trigger: 'unattended' });
      await until(() => h.claude.asks.length === 2, 'the second call');
      h.claude.asks[1]!.resolve({ text: 'Done.', synthetic: false });
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      expect(h.recaps().map((recap) => recap.state)).toEqual(['generating', 'failed', 'generating', 'complete']);
    } finally { await dispose(h); }
  });

  it('is the person\'s call: neither looking at the conversation nor the pause stops it', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await failed(h);
      h.viewing.status = 'viewed';
      h.claude.emit({ kind: 'usage', sessionId: 'chat', limits: { weekly: { usedPercent: 93 } } });
      await h.runtime.whenIdle();
      expect((await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId })).ok).toBe(true);
      await until(() => h.claude.asks.length === 2, 'the second call');
      h.claude.asks[1]!.resolve({ text: 'Done.', synthetic: false });
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
    } finally { await dispose(h); }
  });

  it('refuses a recap that did not fail', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      const turnId = await h.conversation('claude');
      await until(() => h.claude.asks.length === 1, 'the recap call');
      const running = await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId });
      expect(running).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      h.claude.asks[0]!.resolve({ text: 'Done.', synthetic: false });
      await until(() => h.recaps().at(-1)?.state === 'complete', 'the recap');
      const done = await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId });
      expect(done).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(h.claude.asks).toHaveLength(1);
    } finally { await dispose(h); }
  });

  it('refuses a turn with no recap, and a host that does not wrap up', async () => {
    const h = await harness();
    try {
      const turnId = await h.conversation('claude');
      expect(await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      expect(await h.execute('wrap-up.recap-retry', { sessionId: 'nowhere', turnId })).toMatchObject({ ok: false });
    } finally { await dispose(h); }
  });

  it('keeps saying the AI waits while that decision is still open', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      const turnId = h.currentTurn('chat')!;
      const approval = await h.raise(h.claude, 'chat', { v: 1, kind: 'command', command: 'pnpm test' });
      await until(() => h.claude.asks.length === 1, 'the recap call');
      h.claude.asks[0]!.reject(new ProviderSideQuestionError('failed'));
      await until(() => h.recaps().at(-1)?.state === 'failed', 'the failure');
      await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId });
      await until(() => h.claude.asks.length === 2, 'the second call');
      expect(h.claude.asks[1]!.input.question).toBe(recapQuestion('the person has not answered your request to run a command.'));
      expect(h.recaps().at(-1)).toMatchObject({ trigger: 'waiting', waiting: 'approval', decisionId: approval.id, state: 'generating' });
    } finally { await dispose(h); }
  });

  it('stops saying so once that decision is made', async () => {
    const h = await harness({ viewing: 'unviewed' });
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      const turnId = h.currentTurn('chat')!;
      const approval = await h.raise(h.claude, 'chat', { v: 1, kind: 'command', command: 'pnpm test' });
      await until(() => h.claude.asks.length === 1, 'the recap call');
      h.claude.asks[0]!.reject(new ProviderSideQuestionError('failed'));
      await until(() => h.recaps().at(-1)?.state === 'failed', 'the failure');
      await h.execute('permission.resolve', { approvalId: approval.id, decision: 'allow' });
      await h.execute('wrap-up.recap-retry', { sessionId: 'chat', turnId });
      await until(() => h.claude.asks.length === 2, 'the second call');
      expect(h.claude.asks[1]!.input.question).toBe(RECAP_INSTRUCTION);
      expect(h.recaps().at(-1)).toMatchObject({ trigger: 'waiting', state: 'generating' });
      expect(h.recaps().at(-1)).not.toHaveProperty('waiting');
      expect(h.recaps().at(-1)).not.toHaveProperty('decisionId');
    } finally { await dispose(h); }
  });
});

describe('the pause, for the Settings screen', () => {
  it('reads the windows pausing the automatic calls now', async () => {
    const h = await harness();
    try {
      await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Fix.' });
      h.claude.emit({ kind: 'usage', sessionId: 'chat', limits: { fiveHour: { usedPercent: 95, resetsAt: NOW_MS + 60_000 } } });
      await h.runtime.whenIdle();
      expect(h.coordinator.paused(h.router.getSnapshot())).toEqual([{ providerId: 'claude', window: 'five-hour', usedPercent: 95, resetsAt: NOW_MS + 60_000 }]);
    } finally { await dispose(h); }
  });
});

describe('a suggested task', () => {
  const TASK = 'task-1';
  const CHILD = suggestedTaskChildSessionId(TASK);
  /** A card in `chat` from its finished turn; step by step the MCP tool writes these. */
  const withCard = async (h: Harness, permissionPreset: PermissionPreset = 'full-access') => {
    await h.execute('agent.create', { sessionId: 'chat', workspaceId: 'workspace-1', title: 'Fix', providerId: 'claude', permissionPreset, initialPrompt: 'Fix.' });
    const turnId = await h.finishTurn(h.claude, 'chat');
    await h.router.applySystemCommit({ mutations: [{ kind: 'transcript.append', items: [{
      id: `card-${TASK}`, sessionId: 'chat', turnId, kind: 'notice', text: 'Suggested task: Add a test', isDelta: false, isSensitive: true, createdAt: '2026-10-30T10:00:00.000Z',
      payload: { v: 1, type: 'task-suggestion', taskId: TASK, turnId, providerId: 'claude', title: 'Add a test', rationale: 'No test.', prompt: 'Write the test.' },
    }] }] });
    return turnId;
  };
  const start = (h: Harness, turnId: string, patch: Record<string, unknown> = {}, principal?: DaemonPrincipal) => h.execute('agent.create', {
    sessionId: CHILD, workspaceId: 'workspace-1', title: 'Add a test', providerId: 'claude', permissionPreset: 'full-access', initialPrompt: 'Write the test.',
    parentSessionId: 'chat', wrapUpTask: { turnId, taskId: TASK, oneClick: true }, ...patch,
  } as never, principal);
  const send = (h: Harness, turnId: string, taskId = TASK) => h.execute('agent.submit', { sessionId: 'chat', prompt: 'Write the test.', wrapUpTask: { turnId, taskId } });
  const statuses = (h: Harness) => h.router.readTranscript('chat', 0, 2_000).filter((item) => item.payload?.type === 'task-suggestion-status');
  const childAgent = (h: Harness) => h.router.getSnapshot().agents.find((agent) => agent.sessionId === CHILD);

  describe('started as a sub-conversation', () => {
    it('commits the conversation and the started row together', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        const receipt = await start(h, turnId, { wrapUpTask: { turnId, taskId: TASK, oneClick: true, branch: 'suggest/add-a-test' } });
        expect(receipt.ok).toBe(true);
        expect(childAgent(h)).toBeDefined();
        expect(h.router.getSnapshot().agentRelations).toEqual([expect.objectContaining({ parentSessionId: 'chat', childSessionId: CHILD, owner: 'managed' })]);
        expect(statuses(h)).toHaveLength(1);
        expect(statuses(h)[0]).toMatchObject({
          sessionId: 'chat', turnId, kind: 'notice', isSensitive: false,
          payload: { type: 'task-suggestion-status', taskId: TASK, turnId, outcome: 'started', sessionId: CHILD, branch: 'suggest/add-a-test' },
        });
      } finally { await dispose(h); }
    });

    it('runs one click at 승인 후 실행, even from a full-access conversation', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h, 'full-access');
        await start(h, turnId);
        expect(childAgent(h)?.permissionPreset).toBe('standard');
      } finally { await dispose(h); }
    });

    it('runs a phone\'s start at 승인 후 실행, whatever it asks for', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await start(h, turnId, { wrapUpTask: { turnId, taskId: TASK } }, { kind: 'android', id: 'phone' });
        expect(childAgent(h)?.permissionPreset).toBe('standard');
      } finally { await dispose(h); }
    });

    it('keeps a person\'s choice in the start form', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await start(h, turnId, { wrapUpTask: { turnId, taskId: TASK } });
        expect(childAgent(h)?.permissionPreset).toBe('full-access');
      } finally { await dispose(h); }
    });

    it('leaves nothing behind when the start is refused', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        const refused = await start(h, turnId, { workspaceId: 'workspace-elsewhere' });
        expect(refused.ok).toBe(false);
        expect(statuses(h)).toEqual([]);
        expect(childAgent(h)).toBeUndefined();
      } finally { await dispose(h); }
    });

    it('answers a second press with the conversation that exists, and no second row', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await start(h, turnId);
        const again = await start(h, turnId);
        expect(again).toMatchObject({ ok: false, error: { code: 'invalid-state', message: 'Session already exists.' } });
        expect(statuses(h)).toHaveLength(1);
      } finally { await dispose(h); }
    });

    it('starts again after a failed start, keeping the same conversation id', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'start-failed', reason: 'Too many.', start: { where: { kind: 'this-folder' }, agent: { providerId: 'claude', permissionPreset: 'standard' }, settings: 'Claude' } });
        expect((await start(h, turnId)).ok).toBe(true);
        expect(statuses(h).at(-1)?.payload).toMatchObject({ outcome: 'started' });
      } finally { await dispose(h); }
    });

    it.each<[string, (h: Harness, turnId: string) => Promise<unknown>]>([
      ['a card that was dismissed', (h, turnId) => h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'dismissed' })],
      ['a card already sent here', (h, turnId) => send(h, turnId)],
    ])('refuses %s', async (_name, before) => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await before(h, turnId);
        const count = statuses(h).length;
        expect((await start(h, turnId)).ok).toBe(false);
        expect(childAgent(h)).toBeUndefined();
        expect(statuses(h)).toHaveLength(count);
      } finally { await dispose(h); }
    });

    it('refuses a card this conversation does not hold', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect((await h.execute('agent.create', {
          sessionId: suggestedTaskChildSessionId('task-other'), workspaceId: 'workspace-1', title: 'Other', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Other.',
          parentSessionId: 'chat', wrapUpTask: { turnId, taskId: 'task-other' },
        })).ok).toBe(false);
      } finally { await dispose(h); }
    });

    it('refuses a card named with another turn', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect((await start(h, turnId, { wrapUpTask: { turnId: 'turn-other', taskId: TASK } })).ok).toBe(false);
      } finally { await dispose(h); }
    });

    it('refuses a child that is not the card\'s, which would start the task twice', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect(await start(h, turnId, { sessionId: 'agent-other' })).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
      } finally { await dispose(h); }
    });

    it('refuses a start with no parent or no prompt', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect(await start(h, turnId, { parentSessionId: undefined })).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
        expect(await start(h, turnId, { initialPrompt: undefined })).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
      } finally { await dispose(h); }
    });
  });

  describe('sent to this conversation', () => {
    it('becomes a person\'s message that names the card', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect((await send(h, turnId)).ok).toBe(true);
        const row = h.router.readTranscript('chat', 0, 2_000).filter((item) => item.kind === 'user-message').at(-1)!;
        expect(row).toMatchObject({ text: 'Write the test.', payload: { v: 1, type: 'task-suggestion-send', taskId: TASK, turnId } });
        expect(row.turnId).not.toBe(turnId);
      } finally { await dispose(h); }
    });

    it('queues behind a running turn like any message', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
        expect((await send(h, turnId)).ok).toBe(true);
        expect(h.router.getSnapshot().turns.filter((turn) => turn.state === 'queued')).toHaveLength(1);
      } finally { await dispose(h); }
    });

    it('refuses a second press while the first stands', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await send(h, turnId);
        expect(await send(h, turnId)).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
        await h.finishTurn(h.claude, 'chat');
        expect(await send(h, turnId)).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      } finally { await dispose(h); }
    });

    it('can be sent again once that message was taken back', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await h.execute('agent.submit', { sessionId: 'chat', prompt: 'Next.' });
        await send(h, turnId);
        const queued = h.router.getSnapshot().turns.find((turn) => turn.state === 'queued')!;
        await h.execute('agent.queue', { sessionId: 'chat', turnId: queued.id, turnRevision: queued.revision, action: 'remove' });
        expect((await send(h, turnId)).ok).toBe(true);
      } finally { await dispose(h); }
    });

    it('refuses a card this conversation does not hold', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect(await send(h, turnId, 'task-other')).toMatchObject({ ok: false, error: { code: 'not-found' } });
      } finally { await dispose(h); }
    });

    it('refuses to interrupt for it: the field exists only on a plain send', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        const receipt = await h.execute('agent.interrupt-and-submit', { sessionId: 'chat', prompt: 'Write the test.', wrapUpTask: { turnId, taskId: TASK } } as never);
        expect(receipt).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
      } finally { await dispose(h); }
    });
  });

  describe('wrap-up.task-outcome', () => {
    it('dismisses and reopens, in rows that carry no one\'s words', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect((await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'dismissed' })).ok).toBe(true);
        expect((await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'open' })).ok).toBe(true);
        expect(statuses(h).map((row) => row.payload)).toEqual([
          { v: 1, type: 'task-suggestion-status', taskId: TASK, turnId, outcome: 'dismissed' },
          { v: 1, type: 'task-suggestion-status', taskId: TASK, turnId, outcome: 'open' },
        ]);
        expect(statuses(h).every((row) => !row.isSensitive)).toBe(true);
      } finally { await dispose(h); }
    });

    it('records a failed start with what was asked, as sensitive', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        const asked = { where: { kind: 'new-worktree', branch: 'suggest/add-a-test' }, agent: { providerId: 'claude', permissionPreset: 'standard' }, settings: 'Claude · 승인 후 실행' } as const;
        expect((await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'start-failed', reason: 'The branch exists.', start: asked, branchTaken: true })).ok).toBe(true);
        expect(statuses(h)).toEqual([expect.objectContaining({
          isSensitive: true,
          payload: { v: 1, type: 'task-suggestion-status', taskId: TASK, turnId, outcome: 'start-failed', reason: 'The branch exists.', start: asked, branchTaken: true },
        })]);
      } finally { await dispose(h); }
    });

    it('refuses a failed start with no reason or no record of what was asked', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect((await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'start-failed' })).ok).toBe(false);
        expect(statuses(h)).toEqual([]);
      } finally { await dispose(h); }
    });

    it('never records `started`: only the start itself does, in its own commit', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect(await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'started' } as never)).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
      } finally { await dispose(h); }
    });

    it('cannot undo a task that started', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        await start(h, turnId);
        expect(await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: TASK, outcome: 'dismissed' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
        expect(statuses(h)).toHaveLength(1);
      } finally { await dispose(h); }
    });

    it('refuses a card this conversation does not hold', async () => {
      const h = await harness();
      try {
        const turnId = await withCard(h);
        expect(await h.execute('wrap-up.task-outcome', { sessionId: 'chat', turnId, taskId: 'task-other', outcome: 'dismissed' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
      } finally { await dispose(h); }
    });
  });
});
