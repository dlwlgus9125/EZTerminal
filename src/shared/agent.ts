/**
 * Transport-safe Agent Activity contracts.
 *
 * Deliberately absent from every public shape: provider transcript paths,
 * prompts/responses, the provider's session id, and EZTerminal's internal run
 * id. Those values are either discarded by the hook relay or kept private
 * inside AgentActivityService.
 *
 * One narrow exception exists: `AgentApproval.command`. You cannot ask a human
 * to approve a command without showing them the command. It is admitted under
 * strict terms — it lives only while the agent is blocked on that one call, it
 * is dropped the instant a decision is delivered or the request expires, and
 * it is never written to disk or to a log. `scripts/guard-approval-privacy.mjs`
 * is what keeps that true.
 */

export const AGENT_SETTINGS_SCHEMA_VERSION = 2 as const;
/** v1 files predate `approvalGate` and are migrated forward on read. */
export const AGENT_SETTINGS_SCHEMA_VERSION_LEGACY = 1 as const;

export type AgentState =
  | 'starting'
  | 'working'
  | 'blocked'
  | 'done'
  | 'idle'
  | 'error'
  | 'unknown';
/** @deprecated Use AgentState. Kept as a source-compatible type alias. */
export type AgentStatus = AgentState;
export type AgentStateSource = 'process' | 'provider-hook' | 'terminal' | 'unknown';

export type AgentProvider = 'codex' | 'claude' | 'generic';
export const MAX_AGENT_PROVIDER_LABEL_LENGTH = 80;

export type AgentApprovalRisk = 'danger' | 'write' | 'read';

/** The tool call a `blocked` agent is waiting on. Present only while the
 * provider hook is still holding its request open. */
export interface AgentApproval {
  /** Opaque identity of this exact parked hook. A later request for the same
   * activity gets a different id, so a delayed decision cannot approve it. */
  readonly approvalId: string;
  readonly toolName: string;
  /** Shell text for shell-shaped tools. Absent when the provider sent none. */
  readonly command?: string;
  readonly risk: AgentApprovalRisk;
  /** Authoritative host-side truth. Client wall clocks are not trusted to
   * decide whether the provider hook is still parked. */
  readonly pending: boolean;
  readonly requestedAt: number;
  /** Wall-clock deadline. Past it the gate fails open and the provider asks in
   * the terminal itself, so the card must stop offering buttons. */
  readonly expiresAt: number;
}

export interface AgentActivity {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: AgentProvider;
  /** Human-readable launcher identity; generic profiles keep their configured name. */
  readonly providerLabel?: string;
  readonly cwd: string;
  readonly state: AgentState;
  /** @deprecated Transitional renderer alias; always identical to `state`. */
  readonly status: AgentState;
  /** Monotonic per-activity lifecycle sequence used by wait/focus semantics. */
  readonly stateSeq: number;
  /** Whether the provider process is still running. */
  readonly live: boolean;
  /** Whether the PTY has advertised safe structured prompt input. */
  readonly interactiveReady: boolean;
  readonly stateSource: AgentStateSource;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly participant?: {
    readonly participantId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly worktreeId?: string;
    readonly alias: string;
    readonly role: string;
    readonly task: string;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set iff `status === 'blocked'` and the approval gate captured the call. */
  readonly approval?: AgentApproval;
}

export type AgentDecision = 'allow' | 'deny';

export type AgentDecisionError =
  | 'not-found'
  | 'not-pending'
  | 'expired'
  | 'stale'
  | 'conflict'
  | 'delivery-failed'
  | 'outcome-unknown';

export type AgentDecisionResult = { readonly ok: true } | { readonly ok: false; readonly error: AgentDecisionError };

export interface AgentActivitySnapshot {
  readonly revision: number;
  readonly items: readonly AgentActivity[];
}

export type AgentFollowupError =
  | 'not-found'
  | 'not-waiting'
  | 'not-ready'
  | 'invalid-text'
  | 'session-ended'
  | 'delivery-failed';

export type AgentFollowupResult = { readonly ok: true } | { readonly ok: false; readonly error: AgentFollowupError };

export interface AgentNotificationSettings {
  readonly waiting: boolean;
  readonly blocked: boolean;
  readonly error: boolean;
}

/** A direct executable basename only. Wrappers, shell pipelines and SSH are
 * intentionally outside generic lifecycle detection. */
export interface GenericAgentProfile {
  readonly id: string;
  readonly name: string;
  readonly executable: string;
  readonly enabled: boolean;
}

export interface AgentSettings {
  readonly schemaVersion: typeof AGENT_SETTINGS_SCHEMA_VERSION;
  readonly notifications: AgentNotificationSettings;
  readonly genericProfiles: readonly GenericAgentProfile[];
  /** Whether EZTerminal answers the provider's permission hook instead of
   * letting it fall through to the provider's own terminal prompt. */
  readonly approvalGate: boolean;
}

export type AgentIntegrationProvider = Exclude<AgentProvider, 'generic'>;

export interface AgentIntegrationStatus {
  readonly provider: AgentIntegrationProvider;
  readonly configPath: string;
  readonly enabled: boolean;
  readonly drift: boolean;
  readonly needsTrust: boolean;
  readonly blockers: readonly string[];
}

export type AgentIntegrationMutationResult =
  | {
      readonly ok: true;
      readonly status: AgentIntegrationStatus;
      readonly backupPath?: string;
    }
  | {
      readonly ok: false;
      readonly error: 'invalid-json' | 'invalid-shape' | 'drift' | 'blocked' | 'io-error';
      readonly message: string;
      readonly status: AgentIntegrationStatus;
    };

/** Sanitized relay input. The PowerShell relay constructs only this allowlist
 * before making a loopback request; main validates it a second time. */
export interface AgentHookEvent {
  readonly provider: AgentIntegrationProvider;
  readonly ezSessionId: string;
  readonly providerSessionId: string;
  readonly cwd: string;
  readonly event: string;
  readonly turnId?: string;
  readonly toolName?: string;
  readonly notificationType?: string;
  /** The single human-readable line the pending tool call is about — the shell
   * command, or the file path for file tools. The relay picks one string
   * rather than forwarding the provider's whole `tool_input` object, so the
   * allowlist stays an allowlist. Only sent for permission events. */
  readonly command?: string;
}

export const EMPTY_AGENT_ACTIVITY_SNAPSHOT: AgentActivitySnapshot = Object.freeze({
  revision: 0,
  items: Object.freeze([]),
});
