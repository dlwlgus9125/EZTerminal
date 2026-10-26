import type { ApprovalRequest, ApprovalResponse } from '../shared/approval-request';
import type { ChatMessageContext } from '../shared/chat-message';
import type { AgentExtensionCommand, ProviderCapabilityCatalog } from '../shared/agent-capabilities';
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

export interface ProviderSessionContext {
  readonly reasoningEffort?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly managedExecution?: true;
  /** Require a provider-enforced empty tool catalog; unsupported adapters must reject. */
  readonly toolsDisabled?: true;
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
  /** Metadata-only discovery: never create a user message, turn, or durable conversation. */
  listCapabilities?(workspaceRoot: string, signal?: AbortSignal): Promise<ProviderCapabilityCatalog>;
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
  /** /btw: one tool-less answer from this live session's context; never a turn, never recorded or persisted. */
  askSideQuestion?(input: ProviderSideQuestionInput, signal: AbortSignal): Promise<ProviderSideQuestionAnswer>;

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
  readonly history: readonly SideQuestionExchange[];
}

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
