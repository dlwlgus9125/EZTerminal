import { useCallback, useState } from 'react';

import type { ChatAgentSettings } from '../shared/chat-agent-profiles';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandPayloads,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
} from '../shared/daemon-protocol';
import {
  suggestedTaskBranches,
  suggestedTaskChildSessionId,
  TURN_WRAP_UP_CAPABILITY,
  type NextPromptSuggestion,
  type SuggestedTask,
  type SuggestedTaskStart,
  type SuggestedTaskState,
} from '../shared/turn-wrap-up';
import type { WorkspaceWorktreeAccess } from '../shared/workspace-worktree';
import type { ChatTaskDefaults, ChatWrapUpAction, ChatWrapUpPending } from './chat/ChatContext';
import { coalesceTranscript } from './chat/model/build-chat-model';
import { wrapUpCards } from './chat/model/wrap-up-cards';
import { opaqueId, type ConversationCommandAccess } from './conversation-commands';
import type { DelegateWorkspaceChoice } from './DelegateAgentDialog';
import { structuredAgentSessionTitle } from './structured-agent-create';
import type { StructuredAgentUiResult } from './StructuredAgentSession';

/**
 * Turn wrap-up's host side as the conversation screens use it (`turn-wrap-up-v1`), shared by the desktop tab and the
 * phone: the composer's suggestion from the snapshot, and the commands behind the cards. The AI only proposes; each of
 * these is a person pressing a button. Only the desktop has `worktrees` and the start form.
 */

type WrapUpCommandType = 'agent.create' | 'agent.submit' | 'wrap-up.task-outcome' | 'wrap-up.recap-retry';

type CommandAnswer =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'no-answer'; readonly message: string };

const PRINCIPAL = { kind: 'desktop', id: 'renderer-agent-ui' } as const;

/**
 * One command against the latest snapshot, under a fresh command id each attempt: a repeated key would replay the stored
 * receipt, rejection included. A revision race is read again once. No answer is reported as such, never retried.
 */
async function sendWrapUpCommand<T extends WrapUpCommandType>(access: ConversationCommandAccess, type: T, payload: DaemonCommandPayloads[T]): Promise<CommandAnswer> {
  const creating = type === 'agent.create';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const authority = await access.latestSnapshot();
    if (!authority) return { kind: 'no-answer', message: 'The Agent daemon is unavailable.' };
    const commandId = opaqueId('command');
    const command = createDaemonCommand<T>({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: access.principal ?? PRINCIPAL,
      type,
      payload,
    });
    const receipt = await access.sendCommand(command as DaemonCommand);
    if (!receipt) return { kind: 'no-answer', message: `The Agent daemon did not answer. Check the ${creating ? 'child list' : 'card'} before trying again.` };
    if (receipt.ok) return { kind: 'ok' };
    if (receipt.error.code !== 'revision-conflict') return { kind: 'refused', message: receipt.error.message };
  }
  return { kind: 'refused', message: creating ? 'The project changed while handing off. Try again.' : 'The conversation changed meanwhile. Try again.' };
}

const uiResult = (answer: CommandAnswer): StructuredAgentUiResult => (answer.kind === 'ok' ? { ok: true } : { ok: false, message: answer.message });

/** Where a new child conversation works: a workspace that exists, or a new worktree on this branch (desktop). */
export type ChildPlace = { readonly workspaceId: string } | { readonly branch: string };

export type ChildCreateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: 'worktree'; readonly message: string; readonly branchTaken: boolean }
  /** `workspaceId`: where it was to work, a worktree made for it included. */
  | { readonly ok: false; readonly error: 'refused' | 'no-answer'; readonly message: string; readonly workspaceId: string };

/** A managed child of a conversation: its worktree first when it needs one, then `agent.create`. */
export async function createChildConversation(
  access: ConversationCommandAccess,
  worktrees: Pick<WorkspaceWorktreeAccess, 'create'> | undefined,
  input: {
    readonly projectId: string;
    readonly place: ChildPlace;
    readonly child: Omit<DaemonCommandPayloads['agent.create'], 'workspaceId'>;
  },
): Promise<ChildCreateResult> {
  let workspaceId: string;
  if ('branch' in input.place) {
    if (!worktrees) return { ok: false, error: 'worktree', message: 'New worktrees can be created on the desktop only.', branchTaken: false };
    const created = await worktrees.create(input.projectId, input.place.branch);
    if (!created.ok) return { ok: false, error: 'worktree', message: created.message, branchTaken: created.reason === 'branch-taken' };
    workspaceId = created.value.workspaceId;
  } else {
    workspaceId = input.place.workspaceId;
  }
  const answer = await sendWrapUpCommand(access, 'agent.create', { ...input.child, workspaceId });
  return answer.kind === 'ok' ? { ok: true } : { ok: false, error: answer.kind, message: answer.message, workspaceId };
}

const TASK_ROW_WAIT_MS = 1_500;
const TASK_ROW_POLL_MS = 50;
/** What a `wrap-up.task-outcome` reason holds. */
const REASON_LIMIT = 2_000;
/** The host's answers to a start that another press, or another device, got to first: its rows say what happened. */
const ALREADY_STARTED: ReadonlySet<string> = new Set(['Session already exists.', 'This suggested task already started.']);

/** What a screen gives the commands about one conversation. */
export interface TurnWrapUpHostInput {
  readonly snapshot: DaemonSnapshot | null;
  readonly sessionId: string;
  /** The transcript as it stands now: a command waits on it for the host's row. */
  readonly items: () => readonly DaemonTranscriptItem[];
  readonly access: ConversationCommandAccess;
  readonly pending: ChatWrapUpPending;
  readonly onPending: (taskId: string, kind?: 'starting' | 'sending') => void;
  /** Desktop: makes new worktrees. */
  readonly worktrees?: Pick<WorkspaceWorktreeAccess, 'create'>;
  /** Desktop: opens the start form on a task. */
  readonly onStartForm?: (request: TaskFormRequest) => void;
}

export interface TurnWrapUpHostProps {
  readonly suggestion?: NextPromptSuggestion;
  readonly onAction: (action: ChatWrapUpAction, defaults: ChatTaskDefaults) => Promise<StructuredAgentUiResult>;
  readonly pending: ChatWrapUpPending;
  /** The session is attached: a recap can be asked for again. After a restart it is not until the person sends a message. */
  readonly recapRetry: boolean;
}

/** What a task's start form opens on. */
export interface TaskFormRequest {
  readonly turnId: string;
  readonly task: SuggestedTaskState;
  /** The card's tasks, in order: each gets its own branch. */
  readonly tasks: readonly SuggestedTaskState[];
  readonly defaults: ChatTaskDefaults;
}

/** The form's first state: what the card's line says, or what a failed start asked for. */
export interface TaskStartFormValues {
  readonly initialInstruction: string;
  readonly initialAgent: ChatAgentSettings & { readonly label: string };
  readonly initialWorkspace?: DelegateWorkspaceChoice;
}

export function taskStartForm({ task, tasks, defaults }: TaskFormRequest): TaskStartFormValues {
  const failed = task.outcome.kind === 'start-failed' ? task.outcome.start : undefined;
  const asked = failed ?? defaults;
  const branch = failed
    ? (failed.where.kind === 'new-worktree' ? failed.where.branch : undefined)
    : (task.worktree ? suggestedTaskBranches(tasks.map((entry) => entry.title))[tasks.findIndex((entry) => entry.id === task.id)] : undefined);
  return {
    initialInstruction: task.prompt,
    initialAgent: { ...asked.agent, label: asked.settings },
    ...(branch ? { initialWorkspace: { kind: 'new-worktree', branch } } : {}),
  };
}

/** A card's tasks as the transcript holds them now. */
function cardTasks(input: TurnWrapUpHostInput, turnId: string): readonly SuggestedTaskState[] {
  return wrapUpCards(coalesceTranscript(input.items()), input.snapshot?.turns ?? []).tasks.get(turnId)?.tasks ?? [];
}

const taskRows = (items: readonly DaemonTranscriptItem[], taskId: string): number => items.filter(({ payload }) => (
  (payload?.type === 'task-suggestion-status' || payload?.type === 'task-suggestion-send') && payload.taskId === taskId
)).length;

/** The receipt comes before the row: hold until the transcript shows it, so a card never steps back between the two. */
async function taskRowArrived(input: TurnWrapUpHostInput, taskId: string, before: number): Promise<void> {
  for (let waited = 0; waited < TASK_ROW_WAIT_MS && taskRows(input.items(), taskId) === before; waited += TASK_ROW_POLL_MS) {
    await new Promise((resolve) => { setTimeout(resolve, TASK_ROW_POLL_MS); });
  }
}

interface TaskStartRequest {
  readonly turnId: string;
  readonly task: SuggestedTask;
  readonly start: SuggestedTaskStart;
  /** One press: the host holds it to 승인 후 실행 whatever this conversation runs at. */
  readonly oneClick?: boolean;
  /** The start form's words, when the person edited them. */
  readonly instruction?: string;
  readonly reportBack?: boolean;
  /** Another existing folder, chosen in the form. A task's row can name this folder or a new worktree, nothing else. */
  readonly elsewhere?: string;
}

type TaskStartAnswer =
  | { readonly kind: 'started' | 'already-started' }
  /** Refused, and the card says so. */
  | { readonly kind: 'on-card'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

async function startTask(input: TurnWrapUpHostInput, request: TaskStartRequest): Promise<TaskStartAnswer> {
  const { turnId, task, start } = request;
  const { where, agent } = start;
  const parent = input.snapshot?.sessions.find((entry) => entry.id === input.sessionId);
  if (!parent) return { kind: 'failed', message: 'This conversation is no longer available.' };
  const place: ChildPlace = request.elsewhere !== undefined ? { workspaceId: request.elsewhere }
    : where.kind === 'this-folder' ? { workspaceId: parent.workspaceId }
      : where.workspaceId ? { workspaceId: where.workspaceId } : { branch: where.branch };
  const created = await createChildConversation(input.access, input.worktrees, {
    projectId: parent.projectId,
    place,
    child: {
      sessionId: suggestedTaskChildSessionId(task.id),
      title: structuredAgentSessionTitle(task.title),
      providerId: agent.providerId,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
      permissionPreset: agent.permissionPreset,
      initialPrompt: request.instruction ?? task.prompt,
      parentSessionId: input.sessionId,
      ...(request.reportBack ? { reportBack: true } : {}),
      wrapUpTask: { turnId, taskId: task.id, ...(request.oneClick ? { oneClick: true } : {}), ...(where.kind === 'new-worktree' ? { branch: where.branch } : {}) },
    },
  });
  if (created.ok) return { kind: 'started' };
  if (created.error === 'refused' && ALREADY_STARTED.has(created.message)) return { kind: 'already-started' };
  // It may have started: nothing on the card says otherwise.
  if (created.error === 'no-answer' || request.elsewhere !== undefined) return { kind: 'failed', message: created.message };
  const recorded = await sendWrapUpCommand(input.access, 'wrap-up.task-outcome', {
    sessionId: input.sessionId, turnId, taskId: task.id, outcome: 'start-failed',
    reason: created.message.slice(0, REASON_LIMIT),
    // The worktree it made stays with the failure, so a retry does not collide with its own branch.
    start: { ...start, where: where.kind === 'new-worktree' && created.error === 'refused' ? { ...where, workspaceId: created.workspaceId } : where },
    ...(created.error === 'worktree' && created.branchTaken ? { branchTaken: true } : {}),
  });
  return { kind: recorded.kind === 'ok' ? 'on-card' : 'failed', message: created.message };
}

/** A start that holds until its row shows, unless nothing is coming. */
async function startAndWait(input: TurnWrapUpHostInput, request: TaskStartRequest): Promise<TaskStartAnswer> {
  const before = taskRows(input.items(), request.task.id);
  const answer = await startTask(input, request);
  if (answer.kind === 'started' || answer.kind === 'on-card') await taskRowArrived(input, request.task.id, before);
  return answer;
}

const startResult = (answer: TaskStartAnswer): StructuredAgentUiResult => (answer.kind === 'failed' ? { ok: false, message: answer.message } : { ok: true });

/**
 * The start form's 시작. The person's choices stand (no `oneClick`), and a refusal keeps the form open with the card
 * saying the same. The form closes once the transcript holds the row, so focus finds the task's title.
 */
export async function startTaskFromForm(input: TurnWrapUpHostInput, form: {
  readonly turnId: string;
  readonly task: SuggestedTask;
  readonly agent: ChatAgentSettings;
  readonly settings: string;
  readonly workspace: DelegateWorkspaceChoice;
  readonly instruction: string;
  readonly reportBack: boolean;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const { providerId, model, reasoningEffort, permissionPreset } = form.agent;
  const agent: ChatAgentSettings = { providerId, permissionPreset, ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
  const parent = input.snapshot?.sessions.find((entry) => entry.id === input.sessionId);
  const { workspace } = form;
  let where: SuggestedTaskStart['where'] = { kind: 'this-folder' };
  if (workspace.kind === 'new-worktree') {
    // The same name as a start that failed after making its worktree: that worktree, not a collision with it.
    const outcome = cardTasks(input, form.turnId).find((entry) => entry.id === form.task.id)?.outcome;
    const made = outcome?.kind === 'start-failed' && outcome.start.where.kind === 'new-worktree' && outcome.start.where.branch === workspace.branch
      ? outcome.start.where.workspaceId : undefined;
    where = { kind: 'new-worktree', branch: workspace.branch, ...(made ? { workspaceId: made } : {}) };
  }
  const answer = await startAndWait(input, {
    turnId: form.turnId, task: form.task, start: { where, agent, settings: form.settings }, instruction: form.instruction, reportBack: form.reportBack,
    ...(workspace.kind === 'existing' && workspace.workspaceId !== parent?.workspaceId ? { elsewhere: workspace.workspaceId } : {}),
  });
  return answer.kind === 'failed' || answer.kind === 'on-card' ? { ok: false, error: answer.message } : { ok: true };
}

/** One at a time, past failures: each start reads the revision the last one moved, and one refusal stops none of the others. */
async function startAll(input: TurnWrapUpHostInput, action: Extract<ChatWrapUpAction, { kind: 'task-start-all' }>, defaults: ChatTaskDefaults): Promise<StructuredAgentUiResult> {
  const tasks = cardTasks(input, action.turnId);
  const starts = action.starts.flatMap((start) => {
    const task = tasks.find((entry) => entry.id === start.taskId);
    return task ? [{ task, where: start.where }] : [];
  });
  for (const { task } of starts) input.onPending(task.id, 'starting');
  let failed: StructuredAgentUiResult | undefined;
  for (const { task, where } of starts) {
    const result = startResult(await startAndWait(input, { turnId: action.turnId, task, start: { where, ...defaults }, oneClick: true }));
    input.onPending(task.id);
    if (!result.ok) failed ??= result;
  }
  return failed ?? { ok: true };
}

const CARD_GONE: StructuredAgentUiResult = { ok: false, message: 'This suggested task is no longer in the conversation.' };

async function runAction(input: TurnWrapUpHostInput, action: ChatWrapUpAction, defaults: ChatTaskDefaults): Promise<StructuredAgentUiResult> {
  const { access, sessionId } = input;
  if (action.kind === 'recap-retry') return uiResult(await sendWrapUpCommand(access, 'wrap-up.recap-retry', { sessionId, turnId: action.turnId }));
  if (action.kind === 'task-start-all') return startAll(input, action, defaults);
  const { turnId, taskId } = action;
  const tasks = cardTasks(input, turnId);
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task) return CARD_GONE;
  switch (action.kind) {
    case 'task-start':
    case 'task-retry': {
      const retry = action.kind === 'task-retry';
      input.onPending(taskId, 'starting');
      const answer = await startAndWait(input, { turnId, task, start: retry ? action.start : { where: { kind: 'this-folder' }, ...defaults }, ...(retry ? {} : { oneClick: true }) });
      input.onPending(taskId);
      return startResult(answer);
    }
    case 'task-start-custom':
      input.onStartForm?.({ turnId, task, tasks, defaults });
      return { ok: true };
    case 'task-here': {
      input.onPending(taskId, 'sending');
      const before = taskRows(input.items(), taskId);
      const answer = await sendWrapUpCommand(access, 'agent.submit', { sessionId, prompt: task.prompt, wrapUpTask: { turnId, taskId } });
      if (answer.kind === 'ok') await taskRowArrived(input, taskId, before);
      input.onPending(taskId);
      return uiResult(answer);
    }
    case 'task-dismiss':
    case 'task-reopen':
      return uiResult(await sendWrapUpCommand(access, 'wrap-up.task-outcome', { sessionId, turnId, taskId, outcome: action.kind === 'task-dismiss' ? 'dismissed' : 'open' }));
  }
}

/** The suggestion and the card commands for one conversation, or nothing on a host without `turn-wrap-up-v1`. */
export function turnWrapUpHost(input: TurnWrapUpHostInput): TurnWrapUpHostProps | undefined {
  const { snapshot, sessionId, pending } = input;
  if (!snapshot?.capabilities?.includes(TURN_WRAP_UP_CAPABILITY)) return undefined;
  const suggestion = snapshot.nextPromptSuggestions?.[sessionId];
  return {
    ...(suggestion ? { suggestion } : {}),
    pending,
    recapRetry: snapshot.sideQuestionSessionIds?.includes(sessionId) === true,
    onAction: (action, defaults) => runAction(input, action, defaults),
  };
}

/** The in-flight overlay a screen holds for its cards. */
export function useWrapUpPending(): Pick<TurnWrapUpHostInput, 'pending' | 'onPending'> {
  const [pending, setPending] = useState<ChatWrapUpPending>(() => new Map());
  const onPending = useCallback((taskId: string, kind?: 'starting' | 'sending'): void => {
    setPending((current) => {
      const next = new Map(current);
      if (kind) next.set(taskId, kind);
      else next.delete(taskId);
      return next;
    });
  }, []);
  return { pending, onPending };
}
