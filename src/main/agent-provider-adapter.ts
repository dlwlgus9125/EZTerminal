import type {
  DaemonCommand,
  DaemonTranscriptItem,
  PermissionPreset,
} from '../shared/daemon-protocol';
import type { ProviderModel, ProviderProbeResult } from '../shared/daemon-provider';

export type {
  ProviderModel,
  ProviderProbeResult,
  ProviderReviewNotice,
} from '../shared/daemon-provider';

export interface ProviderSessionContext {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
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
  readonly permissionPreset: PermissionPreset;
}

export interface ProviderSubmitInput {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly turnId: string;
  readonly commandId: string;
  readonly prompt: string;
}

export interface ProviderApprovalDecision {
  readonly sessionId: string;
  readonly providerSessionId: string;
  readonly providerRequestId: string;
  readonly decision: 'allow' | 'deny';
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
    }
  | {
      readonly kind: 'native-subagent';
      readonly sessionId: string;
      readonly providerChildId: string;
      readonly title: string;
      readonly state: 'starting' | 'working' | 'blocked' | 'done' | 'error';
      readonly summary?: string;
    }
  | {
      readonly kind: 'provider-error';
      readonly sessionId?: string;
      readonly code: string;
      readonly message: string;
      readonly recoverable: boolean;
    };

export type AgentProviderEventListener = (event: AgentProviderEvent) => void;

/**
 * The only provider-specific seam visible to DaemonRuntime. Implementations own
 * wire formats and child processes; callers own durable state and policy.
 */
export interface AgentProviderAdapter {
  readonly providerId: string;

  probe(signal?: AbortSignal): Promise<ProviderProbeResult>;
  listModels(signal?: AbortSignal): Promise<readonly ProviderModel[]>;

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

  subscribe(listener: AgentProviderEventListener): () => void;
  reconcile(input: ProviderReconciliationInput, signal?: AbortSignal): Promise<ProviderReconciliationResult>;
  disposeSession(sessionId: string, providerSessionId: string): Promise<void>;
  dispose(): Promise<void>;
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
