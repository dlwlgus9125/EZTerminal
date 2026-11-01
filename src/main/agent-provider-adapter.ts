import type { ApprovalRequest, ApprovalResponse } from '../shared/approval-request';
import type { ChatMessageContext } from '../shared/chat-message';
import type { ProviderUsageLimit, UsageLimitReading } from '../shared/long-run';
import type { AgentExtensionCommand, AgentPluginEntry, ProviderCapabilityCatalog } from '../shared/agent-capabilities';
import type { AgentUsageLimitsReading } from '../shared/agent-usage';
import type { SideQuestionExchange } from '../shared/agent-side-question';
import type {
  DaemonCommand,
  DaemonTranscriptItem,
  PermissionPreset,
} from '../shared/daemon-protocol';
import type {
  ProviderLaunchDescriptor,
  ProviderModel,
  ProviderProbeResult,
} from '../shared/daemon-provider';

export type {
  ProviderModel,
  ProviderProbeResult,
  ProviderReviewNotice,
} from '../shared/daemon-provider';

/**
 * A session's next-prompt suggestions, on a provider that makes its own. `on` keeps them on past the provider's
 * own near-limit stop, so the host's pause at 90% is the only gate; `off` stops them.
 */
export type PromptSuggestionMode = 'off' | 'on';

/** Turn wrap-up for a conversation a person sees directly; every other session goes without. */
export interface ProviderWrapUpContext {
  /**
   * The session is eligible, and how it starts. An eligible session always launches and resumes with the
   * provider's suggestions available, because one launched without cannot get them later; this mode then
   * applies before its first turn, and `setPromptSuggestions` changes it.
   */
  readonly promptSuggestions?: PromptSuggestionMode;
  /** The session's MCP endpoint has `suggest_task`: Claude may run it without asking. */
  readonly suggestTask?: true;
  /** Said to a new Codex thread at `thread/start`; it stays through resumes. */
  readonly developerInstructions?: string;
}

export interface ProviderSessionContext {
  readonly reasoningEffort?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly managedExecution?: true;
  /** Require a provider-enforced empty tool catalog; unsupported adapters must reject. */
  readonly toolsDisabled?: true;
  /**
   * A review loop reviewer (`review-` conversations): read-only tools, no permission prompts, and
   * every turn answers in REVIEW_FINDINGS_JSON_SCHEMA through the provider's schema channel; the
   * answer ends the turn as its last assistant message (the JSON text).
   */
  readonly readOnlyReviewer?: true;
  readonly wrapUp?: ProviderWrapUpContext;
  /**
   * Long-run continuity (`long-run-v1`): a usage limit ends the turn with `turn-finished.limit` and leaves the session
   * idle and usable. Absent, as on a provider older than `longRun.minimumVersion`, a limit classifies as any error does.
   */
  readonly longRun?: true;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  /**
   * The project's other registered folders the conversation also reads and edits, under the
   * same permission level as `workspaceRoot`. Absolute paths; omitted when there are none.
   */
  readonly additionalRoots?: readonly string[];
  readonly model?: string;
  readonly permissionPreset: PermissionPreset;
  /** Ephemeral endpoint/token material; adapters must not persist either value. */
  readonly orchestration?: {
    readonly endpoint: string;
    readonly bearerToken: string;
  };
}

export interface ProviderSessionHandle {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly model?: string;
  /** The effort the provider runs at: the chosen one, or what it applies by default. */
  readonly reasoningEffort?: string;
  readonly permissionPreset: PermissionPreset;
}

export interface ProviderSubmitInput {
  readonly reasoningEffort?: string;
  readonly context?: ChatMessageContext;
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly turnId: string;
  readonly commandId: string;
  readonly prompt: string;
  /**
   * A person sent this turn from a desktop or phone conversation and can answer
   * the provider's plan questions. Agents, schedules, planning runs and
   * delegated first turns run unattended: plan mode then only plans, read-only.
   */
  readonly attended?: boolean;
  /**
   * The conversation's additional folders as of this turn. When they differ from what the
   * session runs with (the project's folders changed), the adapter applies them before this
   * turn. Undefined leaves the session's folders as they are.
   */
  readonly additionalRoots?: readonly string[];
  /**
   * Turn wrap-up: what this thread should have heard. A provider that needs telling (Codex) says it with
   * this turn if the thread has not heard it yet, and remembers; the setting off means leaving this out.
   */
  readonly wrapUpInstructions?: string;
  /**
   * How a provider's own suggestions run for this turn, on a session launched for them. `off` for a turn no
   * person sent: the provider would otherwise spend a call on it, and no one is there to read the guess.
   */
  readonly promptSuggestions?: PromptSuggestionMode;
}

export type AgentProviderTurnScope =
  | {
      readonly turnId: string;
      readonly providerTurnId?: string;
    }
  | {
      readonly turnId?: string;
      readonly providerTurnId: string;
    };

export interface ProviderApprovalDecision {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly providerRequestId: string;
  readonly decision: 'allow' | 'deny';
  /** Answers, plan mode or deny feedback; adapters ignore kinds they cannot express. */
  readonly response?: ApprovalResponse;
}

export interface ProviderReconciliationInput {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly unsettledCommands: readonly (Pick<DaemonCommand, 'commandId' | 'idempotencyKey' | 'type'> & {
    readonly turnId?: string;
    readonly providerTurnId?: string;
    readonly state?: 'submitting' | 'working' | 'blocked' | 'delivery-uncertain';
  })[];
}

export interface ProviderReconciliationResult {
  readonly commands: readonly {
    readonly commandId: string;
    readonly state: 'applied' | 'not-applied' | 'delivery-uncertain';
    readonly providerTurnId?: string;
    readonly turnState?: 'working' | 'blocked' | 'completed' | 'interrupted' | 'failed';
    readonly errorCode?: string;
  }[];
  readonly transcriptItems: readonly DaemonTranscriptItem[];
}

export type AgentProviderEvent =
  | {
      readonly kind: 'session-state';
      readonly sessionId: string;
      readonly state: 'starting' | 'idle' | 'working' | 'blocked' | 'completed' | 'interrupted' | 'failed';
      readonly detail?: string;
    }
  | {
      readonly kind: 'turn-started';
      readonly sessionId: string;
      readonly turnId: string;
      readonly providerTurnId?: string;
      readonly commandId: string;
    }
  | {
      readonly kind: 'transcript';
      readonly item: DaemonTranscriptItem;
      /**
       * The item belongs to this provider-native subagent of `item.sessionId`.
       * Only the daemon knows the child's session id; it re-homes the item.
       */
      readonly providerChildId?: string;
    }
  | {
      readonly kind: 'turn-finished';
      readonly sessionId: string;
      readonly turnId: string;
      readonly outcome: 'completed' | 'interrupted' | 'failed';
      readonly summary?: string;
      readonly errorCode?: string;
      /** A usage limit stopped this turn (`outcome: 'failed'`, `errorCode: USAGE_LIMIT_ERROR`): no error row, and the session stays usable. */
      readonly limit?: ProviderUsageLimit;
    }
  | {
      readonly kind: 'approval-requested';
      readonly sessionId: string;
      readonly turnId?: string;
      readonly providerRequestId: string;
      readonly risk: 'read' | 'write' | 'danger';
      readonly title: string;
      readonly detail?: string;
      /** Structured subject of the approval (command, files, question, plan). */
      readonly request?: ApprovalRequest;
      /** Raised inside this provider-native subagent; the approval still lives on `sessionId`. */
      readonly providerChildId?: string;
    }
  | {
      readonly kind: 'native-subagent';
      readonly sessionId: string;
      readonly providerChildId: string;
      readonly title: string;
      readonly state: 'starting' | 'working' | 'blocked' | 'done' | 'error';
      readonly summary?: string;
      /** Provider call that started the child (Claude Agent tool use, Codex spawn item). */
      readonly toolUseId?: string;
      /** What the parent asked the child to do. */
      readonly instruction?: string;
      /** Provider's agent kind, e.g. Claude `Explore`. */
      readonly subagentType?: string;
      readonly background?: boolean;
      /** Set when another subagent started this one. */
      readonly parentProviderChildId?: string;
    }
  | {
      readonly kind: 'provider-error';
      readonly sessionId?: string;
      /** Omitted only for errors that apply to the whole Provider Session. */
      readonly turnScope?: AgentProviderTurnScope;
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    }
  | {
      /** Sent before that reply's `turn-finished`; kept in memory only. */
      readonly kind: 'usage';
      /** Set when this conversation finished a reply; absent for an account-wide limits change. */
      readonly sessionId?: string;
      readonly limits?: AgentUsageLimitsReading;
      /** The conversation's last request against its model's context window, 0-100. */
      readonly contextPercent?: number;
    }
  | {
      /** The provider's own guess of the person's next message after `turnId`; kept in memory only. */
      readonly kind: 'prompt-suggestion';
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    };

export type AgentProviderEventListener = (event: AgentProviderEvent) => void;

/**
 * The only provider-specific seam visible to DaemonRuntime. Implementations own
 * wire formats and child processes; callers own durable state and policy.
 */
export interface AgentProviderAdapter {
  readonly providerId: string;

  /** Bind the durable user-reviewed process identity before any launch-capable operation. */
  setLaunchDescriptor?(descriptor: ProviderLaunchDescriptor): void;

  probe(signal?: AbortSignal): Promise<ProviderProbeResult>;
  listModels(signal?: AbortSignal): Promise<readonly ProviderModel[]>;
  /**
   * Metadata-only discovery: never create a user message, turn, or durable conversation.
   * `hostUser` reads the PC user settings from a neutral folder: no project settings, every
   * plugin install with its project folder, and the configured marketplaces.
   */
  listCapabilities?(workspaceRoot: string, signal?: AbortSignal, options?: { readonly hostUser?: boolean }): Promise<ProviderCapabilityCatalog>;
  /** Every plugin the configured marketplaces offer, read from a neutral folder. */
  listAvailablePlugins?(workspaceRoot: string, signal?: AbortSignal): Promise<readonly AgentPluginEntry[]>;
  /** Explicit native settings mutation; does not restart or change live sessions. */
  manageExtension?(workspaceRoot: string, command: AgentExtensionCommand, signal?: AbortSignal): Promise<void>;

  createSession(context: ProviderSessionContext, signal?: AbortSignal): Promise<ProviderSessionHandle>;
  resumeSession(
    context: ProviderSessionContext & { readonly providerSessionId: string },
    signal?: AbortSignal,
  ): Promise<ProviderSessionHandle>;

  submit(input: ProviderSubmitInput, signal?: AbortSignal): Promise<void>;
  interrupt(sessionId: string, providerSessionId: string): Promise<void>;
  setSettings(input: {
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
  }): Promise<ProviderSessionHandle>;
  resolveApproval(input: ProviderApprovalDecision): Promise<void>;
  /**
   * Approve a plan request and end its turn there instead of continuing it, so the host can send the
   * implementation as a new turn that starts with changed settings. The turn finishes as completed,
   * and `response` carries the chosen mode. Without it, an approved plan continues the same turn.
   */
  approvePlanEndingTurn?(input: Omit<ProviderApprovalDecision, 'decision'>): Promise<void>;
  /** /btw: one tool-less answer from this live session's context; never a turn, never recorded or persisted. */
  askSideQuestion?(input: ProviderSideQuestionInput, signal: AbortSignal): Promise<ProviderSideQuestionAnswer>;
  /**
   * `review-loop-v1`: the oldest CLI version known to run read-only reviews (reviewer sessions and,
   * with `reviewFork`, forks). Absent: this provider does not review.
   */
  readonly reviewMinimumVersion?: string;
  /**
   * `review-loop-v1`, same AI: one review answered by a read-only fork of the conversation. Nothing
   * reaches the conversation (no row, turn, usage or approval) and nothing of the fork is kept.
   * No timeout here: the host bounds it through `signal`.
   */
  reviewFork?(input: ProviderReviewForkInput, signal: AbortSignal): Promise<ProviderReviewForkResult>;

  /**
   * `turn-wrap-up-v1`. `suggestions`: `native` emits `prompt-suggestion`, `fork` answers `predictNextPrompt`.
   * `recapWhileBlocked`: a side question works while a turn is stopped on the person (probe P5).
   * `minimumVersion`: the version this was measured on; wrap-up stays off below it, because a request an older
   * provider refuses could fail the person's message. Read it through `AgentProviderRegistry.wrapUpCapability`.
   * Absent: this provider does not wrap up turns.
   */
  readonly wrapUp?: { readonly suggestions: 'native' | 'fork'; readonly recapWhileBlocked: boolean; readonly minimumVersion: string };
  /**
   * `long-run-v1`. `minimumVersion`: the version this was measured on; below it `ProviderSessionContext.longRun` stays
   * absent. Read it through `AgentProviderRegistry.longRunCapability`. Absent: this provider does not run it.
   */
  readonly longRun?: { readonly minimumVersion: string };
  /** Where the limit stands when a stop's own frames named no reset. Undefined when it cannot be told. Never rejects. */
  recoverLimit?(sessionId: string, providerSessionId: string): Promise<UsageLimitReading | undefined>;
  /** Live switch for `native` suggestions; a session not launched eligible ignores it. Never rejects. */
  setPromptSuggestions?(sessionId: string, mode: PromptSuggestionMode): Promise<void>;
  /**
   * `fork` suggestions: the person's likely next message from a read-only fork of this live session, cheap
   * (lowest effort, the session's prompt cache). Undefined: no suggestion. Rejects like a side question;
   * nothing reaches the conversation. The host aborts it through `signal` when a new turn starts.
   */
  predictNextPrompt?(input: ProviderPredictInput, signal: AbortSignal): Promise<string | undefined>;

  subscribe(listener: AgentProviderEventListener): () => void;
  reconcile(input: ProviderReconciliationInput, signal?: AbortSignal): Promise<ProviderReconciliationResult>;
  disposeSession(sessionId: string, providerSessionId: string): Promise<void>;
  /** Release all live Sessions/shared processes while keeping the reviewed adapter reusable. */
  deactivate(): Promise<void>;
  /** Permanently release the adapter and its event listeners during application shutdown. */
  dispose(): Promise<void>;
}

export interface ProviderSideQuestionInput {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly question: string;
  /** The host's own words, read before the question. A person's side question has none. */
  readonly note?: string;
  readonly history: readonly SideQuestionExchange[];
}

export type ProviderPredictInput = Pick<ProviderSideQuestionInput, 'sessionId' | 'providerSessionId'>;

export interface ProviderSideQuestionAnswer {
  readonly text: string | null;
  readonly synthetic: boolean;
  readonly fallbackNotice?: string;
}

export type ProviderSideQuestionFailure = 'not-live' | 'session-restarted' | 'cancelled' | 'unsupported' | 'failed';

/** Carries only a code: provider errors could echo the question. */
export class ProviderSideQuestionError extends Error {
  constructor(readonly code: ProviderSideQuestionFailure) {
    super(`Side question ${code}.`);
    this.name = 'ProviderSideQuestionError';
  }
}

export interface ProviderReviewForkInput {
  /** The reviewed conversation and its provider session (Claude session id, Codex thread id). */
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly workspaceRoot: string;
  /**
   * The conversation's other folders, model and effort, as its record has them (the same AI reviews as
   * it is). An adapter whose session of the conversation is live uses that session's own instead, so the
   * fork's request matches the conversation's last one.
   */
  readonly additionalRoots?: readonly string[];
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** The host's review instruction with the change quoted (composeReviewPrompt, in this answer format). */
  readonly prompt: string;
  /**
   * `json-text`: the fork keeps the conversation's request shape, so it reuses its prompt cache, and the
   * prompt asks for the JSON. `enforced`: the provider's schema channel shapes the answer, which costs the
   * cache (structured output changes the request); the host retries this way once when JSON text fails.
   */
  readonly answerFormat: 'json-text' | 'enforced';
}

export interface ProviderReviewForkResult {
  /** The answer the provider's schema channel returned, already parsed. */
  readonly output?: unknown;
  /** The fork's final text: the answer when it came as text, else what it said instead. */
  readonly text?: string;
}

/**
 * A review thread whose read-only setup could not be confirmed for this run (Codex: the MCP servers to
 * switch off could not be read), so it did not run. Also the `errorCode` of a reviewer conversation's
 * turn that did not start for this reason.
 */
export const REVIEW_READ_ONLY_UNVERIFIED = 'read-only-unverified';

/**
 * `unavailable`: the AI cannot start; `unsupported`: this version cannot fork read-only;
 * `read-only-unverified`: see REVIEW_READ_ONLY_UNVERIFIED; `failed`: it ran and erred.
 */
export type ProviderReviewFailure = 'cancelled' | 'unavailable' | 'unsupported' | typeof REVIEW_READ_ONLY_UNVERIFIED | 'failed';

/** Carries only a code: provider errors could echo the reviewed code. */
export class ProviderReviewError extends Error {
  constructor(readonly code: ProviderReviewFailure) {
    super(`Review ${code}.`);
    this.name = 'ProviderReviewError';
  }
}

export function validateProviderProbe(result: ProviderProbeResult): void {
  if (!result.providerId.trim() || !result.displayName.trim()) {
    throw new Error('Provider identity is incomplete.');
  }
  if (!result.executablePath.trim() || !result.executableVersion.trim()) {
    throw new Error('Provider executable identity is incomplete.');
  }
  if (!Array.isArray(result.argv) || result.argv.some((argument) => typeof argument !== 'string')) {
    throw new Error('Provider argv must be an explicit string array.');
  }
  if (result.environmentVariableNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
    throw new Error('Provider environment variable names are invalid.');
  }
  if (result.reviewNotices?.some((notice) =>
    !notice.id.trim()
    || (notice.level !== 'required' && notice.level !== 'information')
    || !notice.title.trim()
    || !notice.message.trim()
    || (notice.url !== undefined && !notice.url.startsWith('https://')))) {
    throw new Error('Provider review notices are invalid.');
  }
}
