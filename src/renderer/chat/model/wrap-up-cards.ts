import type { DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import { parseTranscriptPayload, type TaskSuggestionStatusPayload } from '../../../shared/transcript-payload';
import {
  SUGGEST_TASK_CLAUDE_TOOL, SUGGEST_TASK_REFUSALS, SUGGEST_TASK_SERVER, SUGGEST_TASK_TOOL, suggestedTaskChildSessionId,
  type SuggestedTask, type SuggestedTaskOutcome, type TurnRecap, type TurnTaskSuggestions,
} from '../../../shared/turn-wrap-up';
import { parseObject } from './legacy-decode';
import type { ChatTool, ChatToolRefusal } from './types';

/**
 * Turn wrap-up's cards, read from the host's rows as they stand: a turn's recap is its latest `recap` row, a task's
 * outcome the latest of its status rows and the turn its 여기서 하기 sent. `starting` and `sending` are never here: they
 * are the client's own, while a command is in flight.
 */
export interface WrapUpCards {
  /** By the turn that suggested them. */
  readonly tasks: ReadonlyMap<string, TurnTaskSuggestions>;
  /** By the turn they sum up. */
  readonly recaps: ReadonlyMap<string, TurnRecap>;
  /** Tool calls that ended without finishing, by call id: failed, denied or interrupted. */
  readonly stoppedCalls: ReadonlySet<string>;
}

/** The host's own `suggest_task`: another server's tool of that name, or a bare name with no server, is a tool call like any other. */
function hostSuggestTask(tool: Pick<ChatTool, 'name' | 'server'>): boolean {
  return tool.name === SUGGEST_TASK_CLAUDE_TOOL || (tool.name === SUGGEST_TASK_TOOL && tool.server === SUGGEST_TASK_SERVER);
}

const callInput = (tool: Pick<ChatTool, 'input' | 'inputValue'>): Readonly<Record<string, unknown>> | undefined => tool.inputValue ?? (tool.input ? parseObject(tool.input) : undefined);

/**
 * Whether a tool call is only how a card's task got there, so the card stands for it. It must be the host's own tool
 * and have left that task word for word: a call the host refused (the cap, the setting, a stopped turn, a turn no person
 * sent) leaves no row, and stays a tool row. So does one that did not finish, or whose input cannot be read: nothing the
 * AI did is hidden.
 */
export function foldsIntoCard(tool: Pick<ChatTool, 'callId' | 'name' | 'server' | 'input' | 'inputValue'>, turnId: string | undefined, cards: WrapUpCards): boolean {
  const card = turnId === undefined ? undefined : cards.tasks.get(turnId);
  if (!hostSuggestTask(tool) || !card || cards.stoppedCalls.has(tool.callId)) return false;
  const input = callInput(tool);
  return card.tasks.some((task) => task.title === input?.title && task.prompt === input?.prompt);
}

/**
 * Why the host said no to a `suggest_task` call, and to which suggestion: a proposal not taken, not a tool that broke.
 * Both AIs record it as failed with the host's `{"ok":false,"code":…,"error":…}`, Codex after a status line. The reason
 * is the code; `error` is written to the AI, so a code this client does not know is `unknown`, never that text. Anything
 * else that failed stays a failure.
 */
export function suggestTaskRefusal(tool: Pick<ChatTool, 'name' | 'server' | 'status' | 'output' | 'input' | 'inputValue'>): { readonly reason: ChatToolRefusal; readonly title?: string } | undefined {
  if (tool.status !== 'failed' || !hostSuggestTask(tool) || !tool.output) return undefined;
  const answer = parseObject(tool.output.slice(tool.output.indexOf('{')));
  if (answer?.ok !== false || typeof answer.error !== 'string') return undefined;
  const title = callInput(tool)?.title;
  const reason = SUGGEST_TASK_REFUSALS.find((code) => code === answer.code) ?? 'unknown';
  return { reason, ...(typeof title === 'string' ? { title } : {}) };
}

interface CardRows {
  readonly turnId: string;
  readonly providerId: string;
  readonly tasks: Map<string, SuggestedTask>;
  createdAt: string;
  dropped?: number;
}

interface Dated<T> {
  readonly sequence: number;
  readonly value: T;
}

function statusOutcome(status: TaskSuggestionStatusPayload | undefined, taskId: string): SuggestedTaskOutcome {
  switch (status?.outcome) {
    case 'started':
      return { kind: 'started', sessionId: status.sessionId ?? suggestedTaskChildSessionId(taskId), ...(status.branch ? { branch: status.branch } : {}) };
    case 'dismissed':
      return { kind: 'dismissed' };
    case 'start-failed':
      if (status.reason === undefined || !status.start) return { kind: 'open' };
      return { kind: 'start-failed', reason: status.reason, start: status.start, ...(status.branchTaken ? { branchTaken: true } : {}) };
    default:
      return { kind: 'open' };
  }
}

/** Its place among the conversation's queued turns, by the order the host runs them. */
function queuePosition(turn: DaemonTurn, turns: readonly DaemonTurn[]): number {
  const order = (entry: DaemonTurn): number => entry.enqueueSequence ?? entry.revision;
  return turns.filter((entry) => entry.sessionId === turn.sessionId && entry.state === 'queued' && order(entry) <= order(turn)).length;
}

/** The latest of a task's status and its send; the host's rule: a send that failed or was taken back no longer stands. */
function taskOutcome(
  taskId: string,
  status: Dated<TaskSuggestionStatusPayload> | undefined,
  send: Dated<string> | undefined,
  turnById: ReadonlyMap<string, DaemonTurn>,
  turns: readonly DaemonTurn[],
): SuggestedTaskOutcome {
  const sendTurn = send ? turnById.get(send.value) : undefined;
  const stands = sendTurn !== undefined && sendTurn.state !== 'failed' && sendTurn.state !== 'interrupted';
  if (status?.value.outcome === 'started' || !stands || (status && status.sequence > send!.sequence)) return statusOutcome(status?.value, taskId);
  return sendTurn.state === 'queued' ? { kind: 'queued', position: queuePosition(sendTurn, turns) } : { kind: 'sent' };
}

/** `ordered`: by sequence, as `coalesceTranscript` leaves them. A card with no task row (a dropped count alone) is no card. */
export function wrapUpCards(ordered: readonly DaemonTranscriptItem[], turns: readonly DaemonTurn[]): WrapUpCards {
  const cards = new Map<string, CardRows>();
  const recaps = new Map<string, TurnRecap>();
  const statuses = new Map<string, Dated<TaskSuggestionStatusPayload>>();
  const sends = new Map<string, Dated<string>>();
  const dropped = new Map<string, number>();
  const stoppedCalls = new Set<string>();
  for (const item of ordered) {
    const type = item.payload?.type;
    if (item.kind === 'tool-result' && item.payload?.type === 'tool' && (item.payload.status === 'failed' || item.payload.status === 'denied' || item.payload.status === 'interrupted')) {
      stoppedCalls.add(item.payload.callId);
    }
    if (type !== 'recap' && type !== 'task-suggestion' && type !== 'task-suggestion-status' && type !== 'task-suggestion-send' && type !== 'task-suggestions-dropped') continue;
    const payload = parseTranscriptPayload(item.payload);
    if (payload?.type === 'recap') {
      recaps.set(payload.turnId, { ...payload, createdAt: item.createdAt });
    } else if (payload?.type === 'task-suggestion') {
      const card = cards.get(payload.turnId) ?? { turnId: payload.turnId, providerId: payload.providerId, tasks: new Map<string, SuggestedTask>(), createdAt: item.createdAt };
      card.createdAt = item.createdAt;
      card.tasks.set(payload.taskId, {
        id: payload.taskId, title: payload.title, rationale: payload.rationale, prompt: payload.prompt, ...(payload.worktree !== undefined ? { worktree: payload.worktree } : {}),
      });
      cards.set(payload.turnId, card);
    } else if (payload?.type === 'task-suggestion-status') {
      statuses.set(payload.taskId, { sequence: item.sequence, value: payload });
    } else if (payload?.type === 'task-suggestion-send' && item.kind === 'user-message' && item.turnId) {
      sends.set(payload.taskId, { sequence: item.sequence, value: item.turnId });
    } else if (payload?.type === 'task-suggestions-dropped') {
      dropped.set(payload.turnId, payload.count);
    }
  }
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const tasks = new Map([...cards.values()].map((card): [string, TurnTaskSuggestions] => {
    const count = dropped.get(card.turnId);
    return [card.turnId, {
      turnId: card.turnId, providerId: card.providerId, createdAt: card.createdAt,
      tasks: [...card.tasks.values()].map((task) => ({ ...task, outcome: taskOutcome(task.id, statuses.get(task.id), sends.get(task.id), turnById, turns) })),
      ...(count ? { dropped: count } : {}),
    }];
  }));
  return { tasks, recaps, stoppedCalls };
}
