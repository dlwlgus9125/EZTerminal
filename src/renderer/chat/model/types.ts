import type { ApprovalRequest } from '../../../shared/approval-request';
import type { ChatMessageContext } from '../../../shared/chat-message';
import type { DaemonApproval, DaemonTurn } from '../../../shared/daemon-protocol';
import type { RecordedFileChange } from '../../../shared/conversation-changes';
import type { TodoItem, ToolCategory, ToolStatus } from '../../../shared/transcript-payload';

/**
 * Presentation model for one conversation. Both skins (bubble and CLI) render
 * the same `ChatRow[]`; nothing in here knows about DOM, CSS or i18n.
 */

export interface ChatToolFile {
  readonly path: string;
  readonly kind?: 'add' | 'update' | 'delete' | 'rename';
  readonly added?: number;
  readonly removed?: number;
}

/** One tool use: the call and (once it arrives) its result, paired. */
export interface ChatTool {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  readonly category: ToolCategory;
  readonly status: ToolStatus;
  readonly target?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  /** Call body as the provider sent it (JSON input or a command). */
  readonly input?: string;
  /** Parsed call input when it was JSON. */
  readonly inputValue?: Readonly<Record<string, unknown>>;
  /** Result body (output, error, answer text). */
  readonly output?: string;
  readonly files?: readonly ChatToolFile[];
  /** Diffs recorded for edit/write results. */
  readonly changes?: readonly RecordedFileChange[];
  readonly query?: string;
  readonly server?: string;
  readonly createdAt: string;
  /** The pending approval in the dock is about this call; it has not started. */
  readonly awaitingApproval?: boolean;
}

/** A line inside an activity run: a tool use or a stretch of reasoning. */
export type ChatActivity =
  | { readonly kind: 'tool'; readonly tool: ChatTool }
  | {
      readonly kind: 'thought';
      readonly id: string;
      readonly text: string;
      readonly durationMs?: number;
      readonly streaming: boolean;
    };

export interface TodoChange {
  readonly started: readonly string[];
  readonly completed: readonly string[];
  readonly added: readonly string[];
}

interface RowBase {
  /** Stable React key. */
  readonly id: string;
  readonly turnId?: string;
  readonly createdAt: string;
}

export type ChatRow =
  | (RowBase & {
      readonly kind: 'user';
      readonly text: string;
      readonly context?: ChatMessageContext;
      /** Identity a reply quotes (first source item). */
      readonly messageId: string;
      /** Provider message identity; stable across streamed and final chunks. */
      readonly anchorId: string;
      readonly sensitive: boolean;
    })
  | (RowBase & {
      readonly kind: 'assistant';
      readonly text: string;
      readonly messageId: string;
      readonly anchorId: string;
      readonly streaming: boolean;
      readonly sensitive: boolean;
    })
  | (RowBase & {
      readonly kind: 'activity';
      readonly entries: readonly ChatActivity[];
      /** A tool is running or reasoning is streaming in a live turn. */
      readonly live: boolean;
    })
  | (RowBase & { readonly kind: 'plan'; readonly markdown: string; readonly filePath?: string; readonly status?: ToolStatus })
  | (RowBase & {
      readonly kind: 'question';
      readonly questions: readonly { readonly question: string; readonly header?: string; readonly options: readonly string[] }[];
      readonly answer?: string;
      readonly status?: ToolStatus;
    })
  | (RowBase & { readonly kind: 'todo'; readonly items: readonly TodoItem[]; readonly change: TodoChange })
  | (RowBase & { readonly kind: 'notice'; readonly text: string })
  | (RowBase & { readonly kind: 'error'; readonly text: string })
  | (RowBase & { readonly kind: 'child'; readonly text: string; readonly relatedSessionId?: string })
  | (RowBase & {
      readonly kind: 'turn-status';
      readonly turnId: string;
      readonly state: DaemonTurn['state'];
      readonly startedAt?: string;
      readonly finishedAt?: string;
    })
  | (RowBase & { readonly kind: 'changes'; readonly files: readonly ChatToolFile[]; readonly changes: readonly RecordedFileChange[] });

export type ChatRowKind = ChatRow['kind'];

/** The approval that currently owns the composer area, if any. */
export interface PendingInteraction {
  readonly approval: DaemonApproval;
  readonly request?: ApprovalRequest;
  /** The tool call the approval is about, when it could be matched. */
  readonly tool?: ChatTool;
}

export interface ChatModel {
  readonly rows: readonly ChatRow[];
  /** Latest task list for the docked todo panel. */
  readonly todo?: readonly TodoItem[];
  /** Oldest pending approval; it owns the composer area. */
  readonly pending?: PendingInteraction;
  readonly pendingCount: number;
}
