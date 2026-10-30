import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeParseDaemonCommand, type DaemonCommand, type DaemonCommandPayloads, type DaemonCommandReceipt, type DaemonSnapshot, type DaemonTranscriptItem } from '../shared/daemon-protocol';
import { suggestedTaskChildSessionId, TURN_WRAP_UP_CAPABILITY, type SuggestedTaskStart, type SuggestedTaskState } from '../shared/turn-wrap-up';
import type { ChatTaskDefaults, ChatWrapUpAction } from './chat/ChatContext';
import { cartStory, formatStory, WRAP_SESSION, type WrapUpFixture } from './chat/wrap-up/wrap-up-fixtures';
import { createChildConversation, startTaskFromForm, taskStartForm, turnWrapUpHost, type TaskFormRequest } from './turn-wrap-up-commands';

const NOW = '2026-10-30T09:00:00.000Z';
const WORKSPACE = 'workspace-cart';
const TASK = 'task-claude-1';
const AGENT = { providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard' } as const;
const DEFAULTS: ChatTaskDefaults = { agent: AGENT, settings: 'Claude · Opus 5.5 · High · Ask before running' };
const AS_ASKED = { agent: AGENT, settings: DEFAULTS.settings };

function snapshotOf(fixture: WrapUpFixture, patch: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 4, eventSequence: 9, generatedAt: NOW, capabilities: [TURN_WRAP_UP_CAPABILITY],
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ id: 'project-1', name: 'cart-kit', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
    workspaces: [{ id: WORKSPACE, projectId: 'project-1', name: 'cart-kit', kind: 'local', rootPath: 'C:\\Working\\cart-kit', revision: 1, createdAt: NOW, updatedAt: NOW }],
    sessions: [{ id: WRAP_SESSION, projectId: 'project-1', workspaceId: WORKSPACE, kind: 'agent', title: 'Cart', state: 'running', source: 'structured', revision: 2, createdAt: NOW, updatedAt: NOW }],
    agents: [{ sessionId: WRAP_SESSION, providerId: 'claude', permissionPreset: 'standard', state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true, revision: 2, createdAt: NOW, updatedAt: NOW }],
    agentRelations: [], turns: [...fixture.turns], approvals: [], schedules: [], heartbeats: [], transcriptHeads: [], providers: [],
    ...patch,
  };
}

const OK = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 5, eventSequence: 10 });
const REFUSED = (command: DaemonCommand, code: string, message: string): DaemonCommandReceipt => ({
  ok: false, status: 'rejected', commandId: command.commandId, error: { code, message, retryable: false },
} as DaemonCommandReceipt);

type Answer = (command: DaemonCommand, index: number) => DaemonCommandReceipt | null;

/** The host side of the tests: what it answers, and the row it commits with a command that went through. */
function harness({ fixture = cartStory('en', 'claude'), snapshot = snapshotOf(fixture), answer = OK as Answer, created, forms = [] as TaskFormRequest[] }: {
  readonly fixture?: WrapUpFixture;
  readonly snapshot?: DaemonSnapshot;
  readonly answer?: Answer;
  readonly created?: (branch: string) => Promise<{ readonly ok: true; readonly value: { readonly workspaceId: string } } | { readonly ok: false; readonly reason: 'branch-taken' | 'git-failed'; readonly message: string }>;
  readonly forms?: TaskFormRequest[];
} = {}) {
  let items: readonly DaemonTranscriptItem[] = fixture.items;
  const commands: DaemonCommand[] = [];
  const marks: (readonly [string, string | undefined])[] = [];
  const sendCommand = vi.fn(async (command: DaemonCommand) => {
    // As the host would read it: its schemas are strict.
    expect(safeParseDaemonCommand(command).error).toBeUndefined();
    const receipt = answer(command, commands.length);
    commands.push(command);
    const row = (kind: DaemonTranscriptItem['kind'], payload: DaemonTranscriptItem['payload']): void => {
      items = [...items, { id: `row-${String(items.length)}`, sessionId: WRAP_SESSION, sequence: 1000 + items.length, kind, text: 'row', isDelta: false, isSensitive: false, createdAt: NOW, turnId: `turn-${String(items.length)}`, ...(payload ? { payload } : {}) }];
    };
    if (receipt?.ok && command.type === 'agent.submit' && command.payload.wrapUpTask) row('user-message', { v: 1, type: 'task-suggestion-send', ...command.payload.wrapUpTask });
    if (receipt?.ok && command.type === 'agent.create' && command.payload.wrapUpTask) {
      const { taskId, turnId } = command.payload.wrapUpTask;
      row('notice', { v: 1, type: 'task-suggestion-status', taskId, turnId, outcome: 'started', sessionId: command.payload.sessionId });
    }
    if (receipt?.ok && command.type === 'wrap-up.task-outcome') {
      const { taskId, turnId, outcome, reason, start, branchTaken } = command.payload;
      row('notice', { v: 1, type: 'task-suggestion-status', taskId, turnId, outcome, ...(reason ? { reason } : {}), ...(start ? { start } : {}), ...(branchTaken ? { branchTaken } : {}) });
    }
    return receipt;
  });
  const worktrees = created ? { create: vi.fn(async (_project: string, branch: string) => created(branch)) } : undefined;
  const input = {
    snapshot, sessionId: WRAP_SESSION, items: () => items,
    access: { latestSnapshot: vi.fn(async () => snapshot), sendCommand },
    pending: new Map(),
    onPending: (taskId: string, kind?: 'starting' | 'sending') => { marks.push([taskId, kind]); },
    ...(worktrees ? { worktrees } : {}),
    onStartForm: (form: TaskFormRequest) => { forms.push(form); },
  };
  const host = turnWrapUpHost(input);
  if (!host) throw new Error('No host.');
  const act = (action: ChatWrapUpAction) => host.onAction(action, DEFAULTS);
  return { input, host, act, commands, marks, sendCommand, worktrees };
}

const single = { kind: 'task-start', turnId: 'turn-cart', taskId: TASK } as const;
const payloadOf = <T extends DaemonCommand['type']>(command: DaemonCommand | undefined, type: T): DaemonCommandPayloads[T] => {
  expect(command?.type).toBe(type);
  return command!.payload as DaemonCommandPayloads[T];
};

afterEach(() => { vi.useRealTimers(); });

describe('turnWrapUpHost', () => {
  it('offers nothing on a host without turn-wrap-up-v1: the screen stays as it was', () => {
    const fixture = cartStory('en', 'claude');
    const input = harness({ fixture }).input;
    expect(turnWrapUpHost({ ...input, snapshot: snapshotOf(fixture, { capabilities: ['review-loop-v1'] }) })).toBeUndefined();
    expect(turnWrapUpHost({ ...input, snapshot: null })).toBeUndefined();
  });

  it('takes the suggestion from the snapshot and offers 다시 만들기 only while the session is attached', () => {
    const fixture = formatStory('en', 'claude', { suggestion: false });
    const attached = snapshotOf(fixture, { nextPromptSuggestions: { [WRAP_SESSION]: { turnId: 'turn-fix', text: 'Yes' } }, sideQuestionSessionIds: [WRAP_SESSION] });
    expect(harness({ fixture, snapshot: attached }).host).toMatchObject({ suggestion: { turnId: 'turn-fix', text: 'Yes' }, recapRetry: true });
    const restarted = harness({ fixture, snapshot: snapshotOf(fixture, { nextPromptSuggestions: { other: { turnId: 't', text: 'No' } } }) }).host;
    expect(restarted.suggestion).toBeUndefined();
    expect(restarted.recapRetry).toBe(false);
  });

  describe('one click', () => {
    it('starts the task in this folder at 승인 후 실행, under the id the host expects, and says it is starting until its row comes', async () => {
      const { act, commands, marks } = harness();
      await expect(act(single)).resolves.toEqual({ ok: true });
      const command = commands[0]!;
      expect(command.idempotencyKey).toBe(command.commandId);
      expect(command.principal).toEqual({ kind: 'desktop', id: 'renderer-agent-ui' });
      expect(payloadOf(command, 'agent.create')).toEqual({
        sessionId: suggestedTaskChildSessionId(TASK), workspaceId: WORKSPACE, title: 'Fix the always-true role check in src/auth.ts',
        providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard',
        initialPrompt: expect.stringContaining('In src/auth.ts, canAccess returns') as string,
        parentSessionId: WRAP_SESSION, wrapUpTask: { turnId: 'turn-cart', taskId: TASK, oneClick: true },
      });
      expect(marks).toEqual([[TASK, 'starting'], [TASK, undefined]]);
    });

    it('treats a task another press or device started as started: nothing to record', async () => {
      for (const message of ['Session already exists.', 'This suggested task already started.']) {
        const { act, commands } = harness({ answer: (command) => REFUSED(command, 'invalid-state', message) });
        await expect(act(single)).resolves.toEqual({ ok: true });
        expect(commands).toHaveLength(1);
      }
    });

    it('reads the revision again after a race, under a fresh command id', async () => {
      const { act, commands } = harness({ answer: (command, index) => (index === 0 ? REFUSED(command, 'revision-conflict', 'Revision conflict') : OK(command)) });
      await expect(act(single)).resolves.toEqual({ ok: true });
      expect(commands).toHaveLength(2);
      expect(commands[1]!.commandId).not.toBe(commands[0]!.commandId);
      expect(commands[1]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    });

    it('records a start the host refused, with its words and exactly what was asked for', async () => {
      const { act, commands, marks } = harness({ answer: (command) => (command.type === 'agent.create' ? REFUSED(command, 'child-rate-limit', 'At most 12 children in 10 minutes.') : OK(command)) });
      await expect(act(single)).resolves.toEqual({ ok: true });
      expect(payloadOf(commands[1], 'wrap-up.task-outcome')).toEqual({
        sessionId: WRAP_SESSION, turnId: 'turn-cart', taskId: TASK, outcome: 'start-failed', reason: 'At most 12 children in 10 minutes.', start: { where: { kind: 'this-folder' }, ...AS_ASKED },
      });
      expect(marks.at(-1)).toEqual([TASK, undefined]);
    });

    it('cuts a host message to what a row holds', async () => {
      const { act, commands } = harness({ answer: (command) => (command.type === 'agent.create' ? REFUSED(command, 'provider-unavailable', 'x'.repeat(3_000)) : OK(command)) });
      await act(single);
      expect(payloadOf(commands[1], 'wrap-up.task-outcome').reason).toHaveLength(2_000);
    });

    it('leaves the card open when the host never answered: it may still have started', async () => {
      const { act, commands, marks } = harness({ answer: () => null });
      const result = await act(single);
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining('did not answer') as string });
      expect(commands).toHaveLength(1);
      expect(marks).toEqual([[TASK, 'starting'], [TASK, undefined]]);
    });

    it('says so when even the failure could not be recorded', async () => {
      const { act } = harness({ answer: (command) => (command.type === 'agent.create' ? REFUSED(command, 'tree-node-limit', 'Too many.') : null) });
      await expect(act(single)).resolves.toEqual({ ok: false, message: 'Too many.' });
    });
  });

  describe('where it starts', () => {
    const inWorktree: SuggestedTaskStart = { where: { kind: 'new-worktree', branch: 'suggest/auth' }, ...AS_ASKED };
    const retry = (start: SuggestedTaskStart) => ({ kind: 'task-retry', turnId: 'turn-cart', taskId: TASK, start }) as const;

    it('repeats a start exactly, in a new worktree, with the branch on the card', async () => {
      const { act, commands, worktrees } = harness({ created: async () => ({ ok: true, value: { workspaceId: 'workspace-suggest' } }) });
      await act(retry(inWorktree));
      expect(worktrees?.create).toHaveBeenCalledWith('project-1', 'suggest/auth');
      const payload = payloadOf(commands[0], 'agent.create');
      expect(payload.workspaceId).toBe('workspace-suggest');
      expect(payload.wrapUpTask).toEqual({ turnId: 'turn-cart', taskId: TASK, branch: 'suggest/auth' });
      expect(payload.permissionPreset).toBe('standard');
    });

    it('keeps the access a person chose in the form when it repeats a start', async () => {
      const { act, commands } = harness();
      await act(retry({ where: { kind: 'this-folder' }, agent: { ...AGENT, permissionPreset: 'full-access' }, settings: 'Claude · Full access' }));
      const payload = payloadOf(commands[0], 'agent.create');
      expect(payload.permissionPreset).toBe('full-access');
      expect(payload.wrapUpTask?.oneClick).toBeUndefined();
    });

    it('records a taken branch, so a retry asks for another name', async () => {
      const { act, commands } = harness({ created: async () => ({ ok: false, reason: 'branch-taken', message: 'A branch with this name already exists.' }) });
      await expect(act(retry(inWorktree))).resolves.toEqual({ ok: true });
      expect(payloadOf(commands[0], 'wrap-up.task-outcome')).toMatchObject({
        outcome: 'start-failed', reason: 'A branch with this name already exists.', branchTaken: true, start: inWorktree,
      });
    });

    it('does not call another git failure a taken branch', async () => {
      const { act, commands } = harness({ created: async () => ({ ok: false, reason: 'git-failed', message: 'No disk.' }) });
      await act(retry(inWorktree));
      expect(payloadOf(commands[0], 'wrap-up.task-outcome').branchTaken).toBeUndefined();
    });

    it('remembers a worktree it made when the start was refused, and a retry does not collide with its own branch', async () => {
      const { act, commands, worktrees } = harness({
        created: async () => ({ ok: true, value: { workspaceId: 'workspace-made' } }),
        answer: (command) => (command.type === 'agent.create' ? REFUSED(command, 'child-rate-limit', 'Later.') : OK(command)),
      });
      await act(retry(inWorktree));
      const recorded = payloadOf(commands[1], 'wrap-up.task-outcome');
      expect(recorded.start?.where).toEqual({ kind: 'new-worktree', branch: 'suggest/auth', workspaceId: 'workspace-made' });
      await act(retry(recorded.start!));
      expect(worktrees?.create).toHaveBeenCalledTimes(1);
      expect(payloadOf(commands[2], 'agent.create').workspaceId).toBe('workspace-made');
    });

    it('cannot make a worktree where only the desktop can', async () => {
      const { act, commands } = harness();
      await act(retry(inWorktree));
      expect(payloadOf(commands[0], 'wrap-up.task-outcome')).toMatchObject({ outcome: 'start-failed', reason: 'New worktrees can be created on the desktop only.' });
    });
  });

  describe('모두 시작', () => {
    const starts = (...ids: readonly string[]) => ({ kind: 'task-start-all', turnId: 'turn-cart', starts: ids.map((taskId) => ({ taskId, where: { kind: 'this-folder' } as const })) }) as const;

    it('starts one at a time and goes on past a failure', async () => {
      const { act, commands, marks } = harness({
        answer: (command) => (command.type === 'agent.create' && command.payload.sessionId === suggestedTaskChildSessionId('task-claude-2') ? REFUSED(command, 'child-rate-limit', 'Later.') : OK(command)),
      });
      await expect(act(starts('task-claude-1', 'task-claude-2', 'task-claude-3'))).resolves.toEqual({ ok: true });
      expect(commands.map((command) => command.type)).toEqual(['agent.create', 'agent.create', 'wrap-up.task-outcome', 'agent.create']);
      for (const command of commands.filter((entry) => entry.type === 'agent.create')) expect(payloadOf(command, 'agent.create').wrapUpTask?.oneClick).toBe(true);
      expect(marks.slice(0, 3)).toEqual([['task-claude-1', 'starting'], ['task-claude-2', 'starting'], ['task-claude-3', 'starting']]);
      expect(marks.slice(3)).toEqual([['task-claude-1', undefined], ['task-claude-2', undefined], ['task-claude-3', undefined]]);
    });

    it('leaves no task showing as starting when the host stops answering', async () => {
      const { act, marks } = harness({ answer: () => null });
      const result = await act(starts('task-claude-1', 'task-claude-2'));
      expect(result.ok).toBe(false);
      expect(marks.filter(([, kind]) => kind === undefined)).toHaveLength(2);
    });
  });

  describe('the other actions', () => {
    it('sends 여기서 하기 as the person’s message, marked with its card', async () => {
      const { act, commands, marks } = harness();
      await expect(act({ kind: 'task-here', turnId: 'turn-cart', taskId: 'task-claude-2' })).resolves.toEqual({ ok: true });
      expect(payloadOf(commands[0], 'agent.submit')).toEqual({
        sessionId: WRAP_SESSION, prompt: expect.stringContaining('formatPrice divides cents by 10') as string, wrapUpTask: { turnId: 'turn-cart', taskId: 'task-claude-2' },
      });
      expect(marks).toEqual([['task-claude-2', 'sending'], ['task-claude-2', undefined]]);
    });

    it('reports a refused send above the chat and leaves the task as it was', async () => {
      const { act, marks } = harness({ answer: (command) => REFUSED(command, 'invalid-state', 'This conversation is archived.') });
      await expect(act({ kind: 'task-here', turnId: 'turn-cart', taskId: 'task-claude-2' })).resolves.toEqual({ ok: false, message: 'This conversation is archived.' });
      expect(marks.at(-1)).toEqual(['task-claude-2', undefined]);
    });

    it('dismisses, reopens and asks for a recap again', async () => {
      const { act, commands } = harness();
      await act({ kind: 'task-dismiss', turnId: 'turn-cart', taskId: TASK });
      await act({ kind: 'task-reopen', turnId: 'turn-cart', taskId: TASK });
      await act({ kind: 'recap-retry', turnId: 'turn-cart' });
      expect(payloadOf(commands[0], 'wrap-up.task-outcome')).toEqual({ sessionId: WRAP_SESSION, turnId: 'turn-cart', taskId: TASK, outcome: 'dismissed' });
      expect(payloadOf(commands[1], 'wrap-up.task-outcome')).toEqual({ sessionId: WRAP_SESSION, turnId: 'turn-cart', taskId: TASK, outcome: 'open' });
      expect(payloadOf(commands[2], 'wrap-up.recap-retry')).toEqual({ sessionId: WRAP_SESSION, turnId: 'turn-cart' });
    });

    it('opens the start form on the task, with what the card offers', async () => {
      const forms: TaskFormRequest[] = [];
      const { act, commands } = harness({ forms });
      await act({ kind: 'task-start-custom', turnId: 'turn-cart', taskId: TASK });
      expect(commands).toHaveLength(0);
      expect(forms[0]).toMatchObject({ turnId: 'turn-cart', task: { id: TASK }, defaults: DEFAULTS });
    });

    it('says when a card is no longer in the transcript', async () => {
      const { act, commands } = harness({ fixture: formatStory('en', 'claude') });
      expect((await act(single)).ok).toBe(false);
      expect(commands).toHaveLength(0);
    });
  });

  it('stops waiting for the row after 1.5 s: a receipt without one still settles', async () => {
    vi.useFakeTimers();
    const fixture = cartStory('en', 'claude');
    const items = fixture.items;
    const snapshot = snapshotOf(fixture);
    const marks: (readonly [string, string | undefined])[] = [];
    const host = turnWrapUpHost({
      snapshot, sessionId: WRAP_SESSION, items: () => items, pending: new Map(), onPending: (taskId, kind) => { marks.push([taskId, kind]); },
      access: { latestSnapshot: async () => snapshot, sendCommand: async (command) => OK(command) },
    })!;
    const started = host.onAction(single, DEFAULTS);
    await vi.advanceTimersByTimeAsync(1_400);
    expect(marks).toEqual([[TASK, 'starting']]);
    await vi.advanceTimersByTimeAsync(200);
    await expect(started).resolves.toEqual({ ok: true });
    expect(marks).toEqual([[TASK, 'starting'], [TASK, undefined]]);
  });
});

describe('the start form', () => {
  const failed = (start: SuggestedTaskStart, branchTaken = false): SuggestedTaskState => ({
    id: TASK, title: 'Reject negative quantities', rationale: 'Why', prompt: 'Do it', outcome: { kind: 'start-failed', reason: 'No', start, ...(branchTaken ? { branchTaken } : {}) },
  });

  it('opens on what the card’s line says, so a person with no saved profile can still start', () => {
    const task: SuggestedTaskState = { id: TASK, title: 'Fix it', rationale: 'Why', prompt: 'Do it', outcome: { kind: 'open' } };
    expect(taskStartForm({ turnId: 'turn-cart', task, tasks: [task], defaults: DEFAULTS })).toEqual({
      initialInstruction: 'Do it', initialAgent: { ...AGENT, label: DEFAULTS.settings },
    });
  });

  it('fills the new worktree a task is recommended for, on a branch of its own in the batch', () => {
    const one: SuggestedTaskState = { id: 'a', title: 'Fix auth', rationale: 'Why', prompt: 'Do it', worktree: true, outcome: { kind: 'open' } };
    const two: SuggestedTaskState = { ...one, id: 'b' };
    expect(taskStartForm({ turnId: 'turn-cart', task: two, tasks: [one, two], defaults: DEFAULTS }).initialWorkspace).toEqual({ kind: 'new-worktree', branch: 'suggest/fix-auth-2' });
  });

  it('comes back as a failed start asked for: its place, branch and settings', () => {
    const start: SuggestedTaskStart = { where: { kind: 'new-worktree', branch: 'suggest/taken' }, agent: { providerId: 'codex', permissionPreset: 'standard' }, settings: 'Codex · Ask before running' };
    const task = failed(start, true);
    expect(taskStartForm({ turnId: 'turn-cart', task, tasks: [task], defaults: DEFAULTS })).toEqual({
      initialInstruction: 'Do it', initialWorkspace: { kind: 'new-worktree', branch: 'suggest/taken' }, initialAgent: { ...start.agent, label: start.settings },
    });
  });

  const form = (workspace: Parameters<typeof startTaskFromForm>[1]['workspace'], overrides: Partial<Parameters<typeof startTaskFromForm>[1]> = {}): Parameters<typeof startTaskFromForm>[1] => ({
    turnId: 'turn-cart', task: { id: TASK, title: 'Fix it', rationale: 'Why', prompt: 'Do it' },
    agent: { ...AGENT, permissionPreset: 'full-access' }, settings: 'Claude · Full access', workspace, instruction: 'Do it my way', reportBack: true, ...overrides,
  });

  it('starts what the person chose: their access stands, and their edited instruction goes', async () => {
    const { input, commands } = harness();
    await expect(startTaskFromForm(input, form({ kind: 'existing', workspaceId: WORKSPACE }))).resolves.toEqual({ ok: true });
    expect(payloadOf(commands[0], 'agent.create')).toMatchObject({
      permissionPreset: 'full-access', initialPrompt: 'Do it my way', reportBack: true, workspaceId: WORKSPACE, wrapUpTask: { turnId: 'turn-cart', taskId: TASK },
    });
    expect(payloadOf(commands[0], 'agent.create').wrapUpTask?.oneClick).toBeUndefined();
  });

  it('stays open until the transcript holds the row, so focus finds the title and not a button about to go', async () => {
    vi.useFakeTimers();
    const fixture = cartStory('en', 'claude');
    const snapshot = snapshotOf(fixture);
    let items: readonly DaemonTranscriptItem[] = fixture.items;
    let closed = false;
    const done = startTaskFromForm({
      snapshot, sessionId: WRAP_SESSION, items: () => items, pending: new Map(), onPending: () => undefined,
      access: { latestSnapshot: async () => snapshot, sendCommand: async (command) => OK(command) },
    }, form({ kind: 'existing', workspaceId: WORKSPACE })).then((result) => { closed = true; return result; });
    await vi.advanceTimersByTimeAsync(500);
    expect(closed).toBe(false);
    items = [...items, {
      id: 'started', sessionId: WRAP_SESSION, sequence: 900, kind: 'notice', text: 'Started.', isDelta: false, isSensitive: false, createdAt: NOW, turnId: 'turn-cart',
      payload: { v: 1, type: 'task-suggestion-status', taskId: TASK, turnId: 'turn-cart', outcome: 'started', sessionId: suggestedTaskChildSessionId(TASK) },
    }];
    await vi.advanceTimersByTimeAsync(60);
    expect(closed).toBe(true);
    await expect(done).resolves.toEqual({ ok: true });
  });

  it('keeps the form open on a refusal, and the card says it failed too', async () => {
    const { input, commands } = harness({
      created: async () => ({ ok: false, reason: 'branch-taken', message: 'That branch exists.' }),
    });
    await expect(startTaskFromForm(input, form({ kind: 'new-worktree', branch: 'suggest/taken' }))).resolves.toEqual({ ok: false, error: 'That branch exists.' });
    expect(payloadOf(commands[0], 'wrap-up.task-outcome')).toMatchObject({ branchTaken: true, start: { where: { kind: 'new-worktree', branch: 'suggest/taken' } } });
  });

  it('uses the worktree a failed start already made for that branch', async () => {
    const fixture = cartStory('en', 'claude');
    const failure: DaemonTranscriptItem = {
      id: 'failed', sessionId: WRAP_SESSION, sequence: 900, kind: 'notice', text: 'Could not start.', isDelta: false, isSensitive: true, createdAt: NOW, turnId: 'turn-cart',
      payload: { v: 1, type: 'task-suggestion-status', taskId: TASK, turnId: 'turn-cart', outcome: 'start-failed', reason: 'Later.', start: { where: { kind: 'new-worktree', branch: 'suggest/made', workspaceId: 'workspace-made' }, ...AS_ASKED } },
    };
    const { input, commands, worktrees } = harness({ fixture: { ...fixture, items: [...fixture.items, failure] }, created: async () => ({ ok: true, value: { workspaceId: 'not-this-one' } }) });
    await startTaskFromForm(input, form({ kind: 'new-worktree', branch: 'suggest/made' }));
    expect(worktrees?.create).not.toHaveBeenCalled();
    expect(payloadOf(commands[0], 'agent.create').workspaceId).toBe('workspace-made');
  });

  it('records no failure for another existing folder: a row could not say where, and 다시 시도 must not drift', async () => {
    const { input, commands } = harness({ answer: (command) => REFUSED(command, 'child-rate-limit', 'Later.') });
    await expect(startTaskFromForm(input, form({ kind: 'existing', workspaceId: 'workspace-other' }))).resolves.toEqual({ ok: false, error: 'Later.' });
    expect(payloadOf(commands[0], 'agent.create').workspaceId).toBe('workspace-other');
    expect(commands).toHaveLength(1);
  });
});

describe('createChildConversation', () => {
  const child = { sessionId: 'agent-1', title: 'Hand off', providerId: 'claude', permissionPreset: 'standard', initialPrompt: 'Go', parentSessionId: WRAP_SESSION } as const;

  it('reads the revision again after a race', async () => {
    const { input, commands } = harness({ answer: (command, index) => (index === 0 ? REFUSED(command, 'revision-conflict', 'Moved') : OK(command)) });
    await expect(createChildConversation(input.access, undefined, { projectId: 'project-1', place: { workspaceId: WORKSPACE }, child })).resolves.toEqual({ ok: true });
    expect(commands).toHaveLength(2);
  });

  it('gets through a host busy with the children it just started: each race recorded nothing, so each send is safe', async () => {
    const { input, commands } = harness({ answer: (command, index) => (index < 5 ? REFUSED(command, 'revision-conflict', 'Moved') : OK(command)) });
    await expect(createChildConversation(input.access, undefined, { projectId: 'project-1', place: { workspaceId: WORKSPACE }, child })).resolves.toEqual({ ok: true });
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(6);
  });

  it('gives up in the end, in words', async () => {
    const { input, commands } = harness({ answer: (command) => REFUSED(command, 'revision-conflict', 'Moved') });
    await expect(createChildConversation(input.access, undefined, { projectId: 'project-1', place: { workspaceId: WORKSPACE }, child })).resolves.toMatchObject({ ok: false, error: 'refused', message: 'The project changed while handing off. Try again.' });
    expect(commands.length).toBeLessThanOrEqual(8);
  });
});
