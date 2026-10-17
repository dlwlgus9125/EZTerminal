import type { ApprovalRequest } from '../../../shared/approval-request';
import type { RecordedFileChange } from '../../../shared/conversation-changes';
import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../../shared/daemon-protocol';
import { parseTranscriptPayload, type TodoItem, type ToolPayload, type ToolStatus } from '../../../shared/transcript-payload';
import { decodeLegacyToolCall, decodeLegacyToolResult, unwrapShellCommand } from './legacy-decode';
import type { ChatActivity, ChatModel, ChatRow, ChatSubagentLink, ChatTool, ChatToolFile, PendingInteraction, TodoChange } from './types';

export interface BuildChatModelInput {
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  readonly turns?: readonly DaemonTurn[];
}

/** A transcript item after streaming fragments have been merged. */
export interface CoalescedItem extends DaemonTranscriptItem {
  readonly sourceIds: readonly string[];
}

const ACTIVE_TURN_STATES = new Set<DaemonTurn['state']>(['queued', 'submitting', 'working', 'blocked', 'delivery-uncertain']);
/** Notices that only restate a lifecycle the turn status row already shows. */
const LIFECYCLE_NOTICE = /^(?:Claude|Codex|The agent) (?:completed the turn|was interrupted|turn (?:completed|interrupted))\.?$/u;

/** Merge streaming deltas by message identity without reordering. Mirrors the legacy coalescer. */
export function coalesceTranscript(items: readonly DaemonTranscriptItem[]): CoalescedItem[] {
  const ordered = items.slice().sort((left, right) => left.sequence - right.sequence);
  const result: CoalescedItem[] = [];
  const byMessage = new Map<string, number>();
  for (const item of ordered) {
    const messageKey = item.messageId ? `${item.sessionId}:${item.turnId ?? ''}:${item.kind}:${item.messageId}` : undefined;
    const index = messageKey === undefined ? undefined : byMessage.get(messageKey);
    if (index !== undefined) {
      const current = result[index];
      result[index] = {
        ...item,
        // A delta extends; a final (non-delta) item replaces the streamed text.
        text: item.isDelta ? `${current.text}${item.text}` : item.text,
        payload: item.payload ?? current.payload,
        sourceIds: [...current.sourceIds, item.id],
      };
      continue;
    }
    if (messageKey) byMessage.set(messageKey, result.length);
    const previous = result.at(-1);
    if (previous && previous.id === item.id) {
      result[result.length - 1] = item.isDelta
        ? { ...item, text: `${previous.text}${item.text}`, sourceIds: [...previous.sourceIds, item.id] }
        : { ...item, sourceIds: previous.sourceIds };
    } else if (
      previous && !item.messageId && !previous.messageId && item.isDelta && previous.isDelta
      && previous.kind === item.kind && previous.turnId === item.turnId && previous.sessionId === item.sessionId
    ) {
      result[result.length - 1] = { ...previous, sequence: item.sequence, text: `${previous.text}${item.text}`, sourceIds: [...previous.sourceIds, item.id] };
    } else {
      result.push({ ...item, sourceIds: [item.id] });
    }
  }
  return result;
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function toolPayload(item: DaemonTranscriptItem): ToolPayload | undefined {
  const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
  return payload?.type === 'tool' ? payload : undefined;
}

function filesFromChanges(changes: readonly RecordedFileChange[]): ChatToolFile[] {
  return changes.map((change) => {
    const lines = change.patch.split('\n');
    return {
      path: change.path,
      added: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
      removed: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
    };
  });
}

type MutableTool = { -readonly [Key in keyof ChatTool]: ChatTool[Key] };

function toolFromCall(item: CoalescedItem, callId: string): MutableTool {
  const payload = toolPayload(item);
  const legacy = decodeLegacyToolCall(item);
  const command = payload?.command ? unwrapShellCommand(payload.command) : legacy.command;
  return {
    id: item.id,
    callId,
    name: payload?.name ?? legacy.name,
    category: payload?.category ?? legacy.category,
    status: payload?.status ?? 'running',
    ...((payload?.target ?? legacy.target) ? { target: payload?.target ?? legacy.target } : {}),
    ...(command ? { command } : {}),
    ...(legacy.input !== undefined ? { input: legacy.input } : {}),
    ...(legacy.inputValue ? { inputValue: legacy.inputValue } : {}),
    ...((payload?.files ?? legacy.files) ? { files: payload?.files ?? legacy.files } : {}),
    ...((payload?.query ?? legacy.query) ? { query: payload?.query ?? legacy.query } : {}),
    ...((payload?.server ?? legacy.server) ? { server: payload?.server ?? legacy.server } : {}),
    createdAt: item.createdAt,
  };
}

function applyResult(tool: MutableTool, item: CoalescedItem): void {
  const payload = toolPayload(item);
  const legacy = decodeLegacyToolResult(item);
  tool.status = payload?.status ?? legacy.status;
  if (legacy.output !== undefined) tool.output = legacy.output;
  if (legacy.changes) tool.changes = legacy.changes;
  const files = payload?.files ?? legacy.files;
  if (files) tool.files = files;
  const exitCode = payload?.exitCode ?? legacy.exitCode;
  if (exitCode !== undefined) tool.exitCode = exitCode;
  if (payload?.durationMs !== undefined) tool.durationMs = payload.durationMs;
  const query = payload?.query ?? legacy.query;
  if (query && !tool.query) {
    tool.query = query;
    if (!tool.target || tool.target === tool.name) tool.target = query;
  }
  if (payload?.target && !tool.target) tool.target = payload.target;
  if (payload?.command && !tool.command) tool.command = unwrapShellCommand(payload.command);
}

function todoChange(previous: readonly TodoItem[] | undefined, next: readonly TodoItem[]): TodoChange {
  const before = new Map((previous ?? []).map((item) => [item.text, item.status]));
  return {
    added: next.filter((item) => !before.has(item.text)).map((item) => item.text),
    started: next.filter((item) => item.status === 'in_progress' && before.get(item.text) !== 'in_progress').map((item) => item.text),
    completed: next.filter((item) => item.status === 'completed' && before.get(item.text) !== 'completed').map((item) => item.text),
  };
}

/** Two consecutive list updates as one: what got added, started and finished across both. */
function mergeTodoChange(first: TodoChange, second: TodoChange): TodoChange {
  const unique = (values: readonly string[]): string[] => [...new Set(values)];
  const completed = unique([...first.completed, ...second.completed]);
  return {
    added: unique([...first.added, ...second.added]),
    started: unique([...first.started, ...second.started]).filter((text) => !completed.includes(text)),
    completed,
  };
}

function legacyTodos(tool: ChatTool): TodoItem[] | undefined {
  const todos = tool.name === 'TodoWrite' ? tool.inputValue?.todos : undefined;
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((todo): TodoItem[] => {
    if (!todo || typeof todo !== 'object') return [];
    const record = todo as Record<string, unknown>;
    const text = typeof record.content === 'string' ? record.content : undefined;
    const status = record.status === 'in_progress' || record.status === 'completed' ? record.status : 'pending';
    return text ? [{ text, status, ...(typeof record.activeForm === 'string' ? { active: record.activeForm } : {}) }] : [];
  });
}

function questionsFrom(tool: ChatTool): { question: string; header?: string; options: string[] }[] {
  const questions = tool.inputValue?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.question !== 'string') return [];
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => (option && typeof option === 'object' && typeof (option as Record<string, unknown>).label === 'string'
        ? [String((option as Record<string, unknown>).label)] : []))
      : [];
    return [{ question: record.question, ...(typeof record.header === 'string' ? { header: record.header } : {}), options }];
  });
}

/** One entry per path, with line counts summed across edits in the same turn. */
function mergeFiles(files: readonly ChatToolFile[]): ChatToolFile[] {
  const byPath = new Map<string, ChatToolFile>();
  for (const file of files) {
    const current = byPath.get(file.path);
    byPath.set(file.path, current ? {
      ...current,
      added: (current.added ?? 0) + (file.added ?? 0),
      removed: (current.removed ?? 0) + (file.removed ?? 0),
    } : file);
  }
  return [...byPath.values()];
}

/** Provider plumbing that never deserves a line of its own. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);

/**
 * Claude's Task tools (TaskCreate/TaskUpdate) in conversations stored before the
 * adapter emitted todo payloads: rebuild the list from the calls themselves.
 */
class LegacyTaskList {
  private readonly items = new Map<string, TodoItem>();
  private readonly pendingCreates = new Map<string, TodoItem>();

  create(tool: ChatTool): void {
    const subject = typeof tool.inputValue?.subject === 'string' ? tool.inputValue.subject : undefined;
    if (!subject) return;
    const active = typeof tool.inputValue?.activeForm === 'string' ? tool.inputValue.activeForm : undefined;
    this.pendingCreates.set(tool.callId, { text: subject, status: 'pending', ...(active ? { active } : {}) });
  }

  /** Returns true when the visible list changed. */
  result(tool: ChatTool): boolean {
    if (tool.name === 'TaskCreate') {
      const created = this.pendingCreates.get(tool.callId);
      const id = tool.output?.match(/Task #(\d+)/u)?.[1];
      if (!created || !id) return false;
      this.pendingCreates.delete(tool.callId);
      this.items.set(id, created);
      return true;
    }
    if (tool.name === 'TaskUpdate') {
      const id = tool.inputValue?.taskId === undefined ? undefined : String(tool.inputValue.taskId);
      const status = tool.inputValue?.status;
      const current = id ? this.items.get(id) : undefined;
      if (!id || !current || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return false;
      this.items.set(id, { ...current, status });
      return true;
    }
    return false;
  }

  list(): TodoItem[] {
    return [...this.items.values()];
  }
}

/**
 * Subagents by the provider call that started them: the parent's `link`
 * notice names the child, a later `result` records how it ended.
 */
function subagentLinks(items: readonly DaemonTranscriptItem[]): Map<string, ChatSubagentLink> {
  const links = new Map<string, ChatSubagentLink>();
  for (const item of items) {
    const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
    if (payload?.type !== 'subagent' || !payload.callId) continue;
    const current = links.get(payload.callId);
    const sessionId = payload.childSessionId ?? item.relatedSessionId ?? current?.sessionId;
    if (!sessionId) continue;
    links.set(payload.callId, {
      ...current,
      sessionId,
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.subagentType ? { subagentType: payload.subagentType } : {}),
      ...(payload.background !== undefined ? { background: payload.background } : {}),
      ...(payload.state ? { state: payload.state } : {}),
    });
  }
  return links;
}

/** Build the presentation model for one conversation. */
export function buildChatModel({ items, approvals = [], turns = [] }: BuildChatModelInput): ChatModel {
  const coalesced = coalesceTranscript(items);
  const turnById = new Map(turns.map((turn) => [turn.id, turn]));
  const rows: ChatRow[] = [];
  const toolsByCallId = new Map<string, MutableTool>();
  const toolTurn = new Map<MutableTool, string | undefined>();
  const openCallsByTurn = new Map<string, MutableTool[]>();
  const userTextByTurn = new Map<string, string>();
  const lastAssistantByTurn = new Map<string, string>();
  const turnFiles = new Map<string, { files: ChatToolFile[]; changes: RecordedFileChange[] }>();
  const statusInserted = new Set<string>();
  let activity: { row: Extract<ChatRow, { kind: 'activity' }>; entries: ChatActivity[] } | undefined;
  let todo: TodoItem[] | undefined;
  let callSerial = 0;
  const hasTodoPayloads = items.some((item) => item.payload && parseTranscriptPayload(item.payload)?.type === 'todo');
  const subagents = subagentLinks(items);
  // Codex records a sub-agent's link before the call that spawned it; look ahead for the call.
  const calledIds = new Set(items.flatMap((item) => {
    if (item.kind !== 'tool-call' || !item.payload) return [];
    const payload = parseTranscriptPayload(item.payload);
    return payload?.type === 'tool' ? [payload.callId] : [];
  }));
  const legacyTasks = hasTodoPayloads ? undefined : new LegacyTaskList();

  const turnActive = (turnId: string | undefined): boolean => {
    if (!turnId) return false;
    const turn = turnById.get(turnId);
    return turn ? ACTIVE_TURN_STATES.has(turn.state) : false;
  };
  const closeActivity = (): void => { activity = undefined; };
  const push = (row: ChatRow): void => {
    closeActivity();
    rows.push(row);
  };
  const activityFor = (item: CoalescedItem): ChatActivity[] => {
    if (activity && activity.row.turnId === item.turnId) return activity.entries;
    const entries: ChatActivity[] = [];
    const row = { kind: 'activity', id: `activity:${item.id}`, ...(item.turnId ? { turnId: item.turnId } : {}), createdAt: item.createdAt, entries, live: false } as Extract<ChatRow, { kind: 'activity' }>;
    rows.push(row);
    activity = { row, entries };
    return entries;
  };
  const recordTodo = (item: CoalescedItem, next: TodoItem[]): void => {
    const change = todoChange(todo, next);
    todo = next;
    // Back-to-back updates (finish one task, start the next) read as one row.
    const last = rows[rows.length - 1];
    if (last?.kind === 'todo' && last.turnId === item.turnId) {
      rows[rows.length - 1] = { ...last, items: next, change: mergeTodoChange(last.change, change) };
      return;
    }
    push({ kind: 'todo', id: `todo:${item.id}`, ...(item.turnId ? { turnId: item.turnId } : {}), createdAt: item.createdAt, items: next, change });
  };

  for (const item of coalesced) {
    const turnId = item.turnId;
    switch (item.kind) {
      case 'user-message': {
        // The runtime stores the prompt; providers echo it back (sensitive).
        const key = turnId ?? `seq:${item.sequence}`;
        const text = normalized(item.text);
        if (turnId && userTextByTurn.get(key) === text) break;
        if (turnId) userTextByTurn.set(key, text);
        const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
        push({
          kind: 'user', id: `user:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt,
          text: item.text, ...(item.context ? { context: item.context } : {}),
          ...(payload?.type === 'subagent' && payload.role === 'instruction' ? { origin: 'parent-agent' as const } : {}),
          ...(payload?.type === 'subagent' && payload.role === 'result' && payload.childSessionId ? {
            origin: 'subagent-report' as const,
            from: { sessionId: payload.childSessionId, ...(payload.title ? { title: payload.title } : {}), ...(payload.state ? { state: payload.state } : {}) },
          } : {}),
          messageId: item.sourceIds[0] ?? item.id, anchorId: item.messageId ?? item.sourceIds[0] ?? item.id, sensitive: item.isSensitive,
        });
        if (turnId && !statusInserted.has(turnId)) {
          const turn = turnById.get(turnId);
          if (turn) {
            statusInserted.add(turnId);
            rows.push({
              kind: 'turn-status', id: `turn:${turnId}`, turnId, createdAt: item.createdAt, state: turn.state,
              ...(turn.startedAt ? { startedAt: turn.startedAt } : {}), ...(turn.finishedAt ? { finishedAt: turn.finishedAt } : {}),
            });
          }
        }
        break;
      }
      case 'assistant-message': {
        if (!item.text.trim()) break;
        if (turnId) lastAssistantByTurn.set(turnId, normalized(item.text));
        push({
          kind: 'assistant', id: `assistant:${item.sourceIds[0] ?? item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt,
          text: item.text, messageId: item.sourceIds[0] ?? item.id, anchorId: item.messageId ?? item.sourceIds[0] ?? item.id,
          streaming: item.isDelta && (turnActive(turnId) || !turnById.size), sensitive: item.isSensitive,
        });
        break;
      }
      case 'reasoning': {
        const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
        if (payload?.type === 'plan') {
          push({ kind: 'plan', id: `plan:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, markdown: payload.markdown ?? item.text, ...(payload.filePath ? { filePath: payload.filePath } : {}) });
          break;
        }
        const durationMs = payload?.type === 'reasoning' ? payload.durationMs : undefined;
        // A blank reasoning block under a second is noise, not "Thought for 0s".
        if (!item.text.trim() && (durationMs === undefined || durationMs < 1_000)) break;
        activityFor(item).push({
          kind: 'thought', id: item.sourceIds[0] ?? item.id, text: item.text,
          ...(durationMs !== undefined ? { durationMs } : {}), streaming: item.isDelta && turnActive(turnId),
        });
        break;
      }
      case 'tool-call': {
        const payload = toolPayload(item);
        const callId = payload?.callId ?? item.messageId ?? `call:${++callSerial}:${item.id}`;
        const existing = toolsByCallId.get(callId);
        if (existing) break;
        const tool = toolFromCall(item, callId);
        const subagent = subagents.get(callId);
        if (subagent) tool.subagent = subagent;
        toolsByCallId.set(callId, tool);
        toolTurn.set(tool, turnId);
        if (tool.category === 'plan' || tool.name === 'ExitPlanMode') {
          const plan = typeof tool.inputValue?.plan === 'string' ? tool.inputValue.plan : undefined;
          if (plan) {
            push({ kind: 'plan', id: `plan:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, markdown: plan,
              ...(typeof tool.inputValue?.planFilePath === 'string' ? { filePath: tool.inputValue.planFilePath } : {}) });
            const open = openCallsByTurn.get(turnId ?? '') ?? [];
            open.push(tool);
            openCallsByTurn.set(turnId ?? '', open);
            break;
          }
        }
        if (tool.category === 'question') {
          const questions = questionsFrom(tool);
          if (questions.length) {
            push({ kind: 'question', id: `question:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, questions });
            const open = openCallsByTurn.get(turnId ?? '') ?? [];
            open.push(tool);
            openCallsByTurn.set(turnId ?? '', open);
            break;
          }
        }
        // Task-list tools show as the todo rows they produce, not as tool lines.
        if (!HIDDEN_TOOLS.has(tool.name) && tool.category !== 'todo') activityFor(item).push({ kind: 'tool', tool });
        const open = openCallsByTurn.get(turnId ?? '') ?? [];
        open.push(tool);
        openCallsByTurn.set(turnId ?? '', open);
        if (tool.name === 'TaskCreate') legacyTasks?.create(tool);
        const todos = hasTodoPayloads ? undefined : legacyTodos(tool);
        if (todos) recordTodo(item, todos);
        break;
      }
      case 'tool-result': {
        const payload = toolPayload(item);
        const open = openCallsByTurn.get(turnId ?? '') ?? [];
        let tool = payload?.callId ? toolsByCallId.get(payload.callId)
          : item.messageId ? toolsByCallId.get(item.messageId) : undefined;
        // Legacy Claude results carry no identity: pair with the oldest open call.
        if (!tool) tool = open.find((candidate) => candidate.status === 'running' && candidate.output === undefined);
        if (!tool) {
          const callId = payload?.callId ?? `result:${item.id}`;
          tool = toolFromCall({ ...item, kind: 'tool-call', text: payload?.name ?? 'tool' }, callId);
          toolsByCallId.set(callId, tool);
          toolTurn.set(tool, turnId);
          activityFor(item).push({ kind: 'tool', tool });
        }
        applyResult(tool, item);
        const index = open.indexOf(tool);
        if (index >= 0) open.splice(index, 1);
        if (legacyTasks?.result(tool)) recordTodo(item, legacyTasks.list());
        // Update question/plan rows that wait on this tool.
        for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
          const row = rows[rowIndex];
          if (row.kind === 'question' && row.id === `question:${tool.id}`) {
            rows[rowIndex] = { ...row, status: tool.status, ...(tool.output ? { answer: tool.output } : {}) };
            break;
          }
          if (row.kind === 'plan' && row.id === `plan:${tool.id}`) {
            rows[rowIndex] = { ...row, status: tool.status };
            break;
          }
        }
        if (tool.changes?.length && turnId) {
          const entry = turnFiles.get(turnId) ?? { files: [], changes: [] };
          entry.changes.push(...tool.changes);
          entry.files.push(...(tool.files ?? filesFromChanges(tool.changes)));
          turnFiles.set(turnId, entry);
        }
        break;
      }
      case 'notice': {
        const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
        if (payload?.type === 'todo') {
          recordTodo(item, [...payload.items]);
          break;
        }
        // A subagent's start is shown on the call that started it.
        if (payload?.type === 'subagent' && payload.callId && calledIds.has(payload.callId)) break;
        // A delegated child's own origin row: its header already leads back to the parent.
        if (payload?.type === 'subagent' && payload.role === 'link' && payload.parentSessionId && !payload.childSessionId) break;
        if (payload?.type === 'subagent' && item.relatedSessionId) {
          const subagent = payload.callId ? subagents.get(payload.callId) : undefined;
          push({ kind: 'child', id: `notice:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, text: item.text,
            relatedSessionId: item.relatedSessionId, ...(subagent ? { subagent } : {}) });
          break;
        }
        const text = normalized(item.text);
        if (LIFECYCLE_NOTICE.test(text)) break;
        if (turnId && lastAssistantByTurn.get(turnId) === text) break;
        push(item.relatedSessionId
          ? { kind: 'child', id: `notice:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, text: item.text, relatedSessionId: item.relatedSessionId }
          : { kind: 'notice', id: `notice:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, text: item.text });
        break;
      }
      case 'error':
        push({ kind: 'error', id: `error:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, text: item.text });
        break;
      case 'child-summary': {
        const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
        const subagent = payload?.type === 'subagent' && payload.callId ? subagents.get(payload.callId) : undefined;
        push({ kind: 'child', id: `child:${item.id}`, ...(turnId ? { turnId } : {}), createdAt: item.createdAt, text: item.text,
          ...(item.relatedSessionId ? { relatedSessionId: item.relatedSessionId } : {}), ...(subagent ? { subagent } : {}) });
        break;
      }
      case 'approval':
        // Decisions show on the tool line; pending ones own the composer area.
        break;
    }
  }

  // Mark tools of finished turns that never got a result.
  for (const tool of toolsByCallId.values()) {
    if (tool.status !== 'running') continue;
    const owner = toolTurn.get(tool);
    const turn = owner ? turnById.get(owner) : undefined;
    if (turn && !ACTIVE_TURN_STATES.has(turn.state)) {
      tool.status = turn.state === 'interrupted' ? 'interrupted' : turn.state === 'failed' ? 'failed' : 'completed';
    }
  }

  // Liveness and per-turn change rollups. A live turn's status trails its rows
  // (where the work is happening); a finished turn's status heads them.
  const finalRows: ChatRow[] = [];
  const liveStatus = new Map<string, ChatRow>();
  const awaitingCallIds = new Set(approvals.flatMap((approval) => (approval.state === 'pending' && approval.request?.callId ? [approval.request.callId] : [])));
  for (let index = 0; index < rows.length; index += 1) {
    let row = rows[index];
    if (row.kind === 'activity') {
      const live = turnActive(row.turnId) && row.entries.some((entry) => (entry.kind === 'tool' ? entry.tool.status === 'running' : entry.streaming));
      row = {
        ...row,
        entries: row.entries.map((entry) => (entry.kind === 'tool'
          ? { kind: 'tool', tool: { ...entry.tool, ...(entry.tool.status === 'running' && awaitingCallIds.has(entry.tool.callId) ? { awaitingApproval: true } : {}) } }
          : entry)),
        live,
      };
    }
    if (row.kind === 'turn-status' && ACTIVE_TURN_STATES.has(row.state)) liveStatus.set(row.turnId, row);
    else finalRows.push(row);
    const next = rows[index + 1];
    if (row.turnId && next?.turnId !== row.turnId) {
      const entry = turnFiles.get(row.turnId);
      if (entry) {
        turnFiles.delete(row.turnId);
        finalRows.push({ kind: 'changes', id: `changes:${row.turnId}`, turnId: row.turnId, createdAt: row.createdAt, files: mergeFiles(entry.files), changes: entry.changes });
      }
      const status = liveStatus.get(row.turnId);
      if (status) {
        liveStatus.delete(row.turnId);
        finalRows.push(status);
      }
    }
  }
  finalRows.push(...liveStatus.values());

  const pendingApprovals = approvals
    .filter((approval) => approval.state === 'pending')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  let pending: PendingInteraction | undefined;
  if (pendingApprovals[0]) {
    const approval = pendingApprovals[0];
    const request: ApprovalRequest | undefined = approval.request;
    const tool = request?.callId ? toolsByCallId.get(request.callId) : undefined;
    pending = { approval, ...(request ? { request } : {}), ...(tool ? { tool: { ...tool } } : {}) };
  }

  // The dock asks the pending question / shows the pending plan; don't repeat it in the transcript.
  let shownRows = finalRows;
  const pendingKind = pending?.request?.kind;
  if (pendingKind === 'question' || pendingKind === 'plan') {
    const kind = pendingKind;
    const index = [...finalRows].reverse().findIndex((row) => row.kind === kind && row.status === undefined);
    if (index >= 0) {
      const target = finalRows.length - 1 - index;
      shownRows = finalRows.filter((_row, rowIndex) => rowIndex !== target);
    }
  }

  return { rows: shownRows, ...(todo ? { todo } : {}), ...(pending ? { pending } : {}), pendingCount: pendingApprovals.length };
}

export type { ToolStatus };
