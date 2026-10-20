import { conversationFileChanges, decodeFileChanges, type ConversationFileChange, type FileChangeKind } from '../../shared/conversation-changes';
import type { DaemonTranscriptItem } from '../../shared/daemon-protocol';
import { parseTranscriptPayload, type TodoItem, type ToolCategory } from '../../shared/transcript-payload';
import type { ChatModel } from '../chat/model/types';

/**
 * What the Results tab shows, derived from what the conversation already
 * loaded: no provider is asked again. Pure, so goldens drive its tests.
 */

export interface ResultsFile {
  readonly path: string;
  /** Over the whole conversation: created here, removed here, or changed. */
  readonly kind: FileChangeKind;
  readonly added: number;
  readonly removed: number;
  /** Change record ids, oldest first. */
  readonly changeIds: readonly string[];
  readonly lastTurnId?: string;
  readonly lastSequence: number;
}

export interface ResultsTurn {
  readonly turnId: string;
  readonly createdAt?: string;
  readonly files: number;
  readonly sequence: number;
}

export interface ResultsPlan {
  readonly markdown: string;
  readonly filePath?: string;
  readonly createdAt: string;
  readonly turnId?: string;
}

export interface ResultsRunningTool {
  readonly id: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly target?: string;
  readonly command?: string;
  readonly createdAt: string;
  readonly awaitingApproval: boolean;
}

export interface DerivedResults {
  readonly changes: readonly ConversationFileChange[];
  /** Most recently changed first. */
  readonly files: readonly ResultsFile[];
  /** Turns that changed files, oldest first. */
  readonly turns: readonly ResultsTurn[];
  readonly plan?: ResultsPlan;
  readonly todo?: readonly TodoItem[];
  readonly running: readonly ResultsRunningTool[];
  readonly pendingDecisions: number;
  /** Highest sequence of an item that is an artifact (change, plan, task list); 0 if none. */
  readonly artifactSequence: number;
}

function overallKind(first: FileChangeKind | undefined, last: FileChangeKind | undefined): FileChangeKind {
  if (last === 'delete') return first === 'add' ? 'update' : 'delete';
  if (first === 'add') return 'add';
  if (last === 'rename' || first === 'rename') return 'rename';
  return 'update';
}

/** Change records from both the loaded window and an earlier backfill, one per id. */
export function mergeChanges(
  loaded: readonly ConversationFileChange[],
  earlier: readonly ConversationFileChange[] = [],
): ConversationFileChange[] {
  const byId = new Map<string, ConversationFileChange>();
  for (const change of earlier) byId.set(change.id, change);
  for (const change of loaded) byId.set(change.id, change);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

export function summarizeFiles(changes: readonly ConversationFileChange[]): ResultsFile[] {
  const byPath = new Map<string, { first?: FileChangeKind; last?: FileChangeKind; added: number; removed: number; ids: string[]; turnId?: string; sequence: number }>();
  for (const change of changes) {
    const entry = byPath.get(change.path) ?? { added: 0, removed: 0, ids: [], sequence: 0 };
    if (entry.ids.length === 0) entry.first = change.kind;
    entry.last = change.kind;
    entry.added += change.added;
    entry.removed += change.removed;
    entry.ids.push(change.id);
    entry.turnId = change.turnId;
    entry.sequence = Math.max(entry.sequence, change.sequence);
    byPath.set(change.path, entry);
  }
  return [...byPath.entries()]
    .map(([path, entry]) => ({
      path,
      kind: overallKind(entry.first, entry.last),
      added: entry.added,
      removed: entry.removed,
      changeIds: entry.ids,
      ...(entry.turnId ? { lastTurnId: entry.turnId } : {}),
      lastSequence: entry.sequence,
    }))
    .sort((left, right) => right.lastSequence - left.lastSequence);
}

export function changedTurns(changes: readonly ConversationFileChange[]): ResultsTurn[] {
  const byTurn = new Map<string, { paths: Set<string>; sequence: number; createdAt?: string }>();
  for (const change of changes) {
    if (!change.turnId) continue;
    const entry = byTurn.get(change.turnId) ?? { paths: new Set<string>(), sequence: change.sequence, ...(change.createdAt ? { createdAt: change.createdAt } : {}) };
    entry.paths.add(change.path);
    byTurn.set(change.turnId, entry);
  }
  return [...byTurn.entries()]
    .map(([turnId, entry]) => ({ turnId, files: entry.paths.size, sequence: entry.sequence, ...(entry.createdAt ? { createdAt: entry.createdAt } : {}) }))
    .sort((left, right) => left.sequence - right.sequence);
}

/** An item that counts as a result the person would want to look at. */
export function isArtifactItem(item: DaemonTranscriptItem): boolean {
  if (item.isDelta) return false;
  // Change records follow the review's rule (never sensitive ones); a plan arrives on a
  // reasoning item, which is always marked sensitive, and the chat shows it all the same.
  if (item.kind === 'tool-result') return !item.isSensitive && decodeFileChanges(item.text).length > 0;
  if (!item.payload) return false;
  const payload = parseTranscriptPayload(item.payload);
  return payload?.type === 'plan' || payload?.type === 'todo';
}

export function deriveResults({ sessionId, items, model, earlierChanges }: {
  readonly sessionId: string;
  readonly items: readonly DaemonTranscriptItem[];
  readonly model?: ChatModel;
  readonly earlierChanges?: readonly ConversationFileChange[];
}): DerivedResults {
  const changes = mergeChanges(conversationFileChanges(items, sessionId), earlierChanges);
  let artifactSequence = 0;
  for (const item of items) {
    if (item.sessionId === sessionId && item.sequence > artifactSequence && isArtifactItem(item)) artifactSequence = item.sequence;
  }
  const rows = model?.rows ?? [];
  let plan: ResultsPlan | undefined;
  const running: ResultsRunningTool[] = [];
  for (const row of rows) {
    if (row.kind === 'plan') {
      plan = {
        markdown: row.markdown,
        ...(row.filePath ? { filePath: row.filePath } : {}),
        createdAt: row.createdAt,
        ...(row.turnId ? { turnId: row.turnId } : {}),
      };
    }
    if (row.kind !== 'activity') continue;
    for (const entry of row.entries) {
      if (entry.kind !== 'tool' || entry.tool.status !== 'running') continue;
      const tool = entry.tool;
      running.push({
        id: tool.id,
        name: tool.name,
        category: tool.category,
        ...(tool.target ? { target: tool.target } : {}),
        ...(tool.command ? { command: tool.command } : {}),
        createdAt: tool.createdAt,
        awaitingApproval: tool.awaitingApproval === true,
      });
    }
  }
  return {
    changes,
    files: summarizeFiles(changes),
    turns: changedTurns(changes),
    ...(plan ? { plan } : {}),
    ...(model?.todo?.length ? { todo: model.todo } : {}),
    running,
    pendingDecisions: model?.pendingCount ?? 0,
    artifactSequence,
  };
}
