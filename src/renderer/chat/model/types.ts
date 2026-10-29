import type { ApprovalRequest } from '../../../shared/approval-request';
import type { ChatMessageContext } from '../../../shared/chat-message';
import type { DaemonApproval, DaemonTurn } from '../../../shared/daemon-protocol';
import type { RecordedFileChange } from '../../../shared/conversation-changes';
import type { ReviewFinding, ReviewState, ReviewTarget, ReviewerRef } from '../../../shared/review-findings';
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

/** The provider-native subagent a call started (Claude Agent tool, Codex spawn). */
export interface ChatSubagentLink {
  readonly sessionId: string;
  readonly title?: string;
  /** Provider's agent kind, e.g. Claude `Explore`. */
  readonly subagentType?: string;
  readonly background?: boolean;
  /** Set once the parent heard the child finish. */
  readonly state?: 'done' | 'error';
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
  readonly subagent?: ChatSubagentLink;
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

/**
 * Where a finding stands on its card: untouched, sent to this conversation to fix (and that
 * turn's state), or dismissed by the person. A finished fix turn's reply decides the rest:
 * `fixed` or `not-changed` (with the AI's reason) when it says so for that finding, `unconfirmed`
 * when it does not. A fix turn that failed or was interrupted is `fix-stopped`.
 */
export type ChatReviewFindingStatus =
  | 'open' | 'requested' | 'fixing' | 'fixed' | 'not-changed' | 'unconfirmed' | 'fix-stopped' | 'dismissed';

export interface ChatReviewFinding extends ReviewFinding {
  readonly status: ChatReviewFindingStatus;
  /** A change record for this file arrived after the review finished, so the reported line may have moved. */
  readonly stale?: boolean;
  /** The turn the finding was last sent to be fixed in. */
  readonly fixTurnId?: string;
  /** `not-changed`: why the fix turn left it, in the AI's words. */
  readonly fixReason?: string;
}

/** One AI review (`review-loop-v1`): the latest of its rows, with each finding's state from the rows after it. */
export interface ChatReview {
  readonly reviewId: string;
  readonly reviewer: ReviewerRef;
  readonly target: ReviewTarget;
  readonly state: ReviewState;
  /** Queued: behind this conversation's running turn, or for a free run slot. */
  readonly waitingFor?: 'turn' | 'slot';
  readonly reason?: string;
  readonly focus?: string;
  readonly findings: readonly ChatReviewFinding[];
  readonly overall?: string;
  /** The reviewer sent more findings than a card keeps. */
  readonly truncated?: boolean;
  /** Findings left out because their path was outside the working folder or missing. */
  readonly dropped?: number;
  /** Some finding text was cut to the limits; the raw answer is kept (원문 보기). */
  readonly clipped?: boolean;
  /** The reviewer's own answer when it could not be read as findings. */
  readonly rawText?: string;
  /** Files changed while the read-only reviewer ran. */
  readonly wroteFiles?: boolean;
  readonly durationMs?: number;
  /** The latest row's readable text (what clients without the card show). */
  readonly text: string;
  /** When the first `running` row arrived: the elapsed clock of a running review. */
  readonly startedAt?: string;
  /** When the latest row arrived. */
  readonly updatedAt: string;
}

/** A user row the review loop wrote: a fix turn, or the request an other-AI reviewer received. */
export interface ChatReviewTurn {
  readonly reviewId: string;
  readonly findingIds?: readonly string[];
  readonly target?: ReviewTarget;
  readonly focus?: string;
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
      /**
       * Not the person: a subagent's first row is what its parent agent asked
       * (`parent-agent`); a delegated child's reported result arrives in its parent
       * as a message (`subagent-report`, from `from`). The review loop writes the
       * person's fix turns (`review-fix`) and an other-AI reviewer's request
       * (`review-request`); both show as a compact chip with the full text on demand.
       */
      readonly origin?: 'parent-agent' | 'subagent-report' | 'review-fix' | 'review-request';
      readonly from?: ChatSubagentLink;
      readonly review?: ChatReviewTurn;
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
  | (RowBase & {
      readonly kind: 'child';
      readonly text: string;
      readonly relatedSessionId?: string;
      /** A subagent's result: its task, kind and outcome. */
      readonly subagent?: ChatSubagentLink;
    })
  | (RowBase & {
      readonly kind: 'turn-status';
      readonly turnId: string;
      readonly state: DaemonTurn['state'];
      readonly startedAt?: string;
      readonly finishedAt?: string;
    })
  | (RowBase & { readonly kind: 'changes'; readonly files: readonly ChatToolFile[]; readonly changes: readonly RecordedFileChange[] })
  /** One card per review id, at the place its first row arrived, updated in place by later rows. */
  | (RowBase & { readonly kind: 'review'; readonly review: ChatReview });

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
