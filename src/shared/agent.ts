/**
 * Transport-safe Agent Activity contracts.
 *
 * Deliberately absent from every public shape: provider transcript paths,
 * prompts/responses, tool input, the provider's session id, and EZTerminal's
 * internal run id. Those values are either discarded by the hook relay or
 * kept private inside AgentActivityService.
 */

export const AGENT_SETTINGS_SCHEMA_VERSION = 1 as const;

export type AgentStatus = 'starting' | 'working' | 'waiting' | 'blocked' | 'done' | 'error';

export type AgentProvider = 'codex' | 'claude' | 'generic';

export interface AgentActivity {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: AgentProvider;
  readonly cwd: string;
  readonly status: AgentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentActivitySnapshot {
  readonly revision: number;
  readonly items: readonly AgentActivity[];
}

export type AgentFollowupError =
  | 'not-found'
  | 'not-waiting'
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
}

export const EMPTY_AGENT_ACTIVITY_SNAPSHOT: AgentActivitySnapshot = Object.freeze({
  revision: 0,
  items: Object.freeze([]),
});
