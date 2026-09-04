import { z } from 'zod';

import type { ProviderProtocol } from './daemon-protocol';

export const MAX_DAEMON_PROVIDER_ID_LENGTH = 64;

export interface ProviderModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly supportsReasoning: boolean;
  readonly isDefault: boolean;
}

export interface ProviderReviewNotice {
  readonly id: string;
  readonly level: 'required' | 'information';
  readonly title: string;
  readonly message: string;
  readonly url?: string;
}

/** Renderer-safe provider identity. Environment values and credentials are never included. */
export interface ProviderProbeResult {
  readonly providerId: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly available: boolean;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly argv: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly capabilities: readonly (
    | 'create'
    | 'resume'
    | 'interrupt'
    | 'model-change'
    | 'permission-change'
    | 'approvals'
    | 'native-subagents'
    | 'history-reconciliation'
  )[];
  readonly reviewNotices?: readonly ProviderReviewNotice[];
  readonly unavailableReason?: string;
}

export interface ProviderInspection {
  readonly probe: ProviderProbeResult;
  /** Binds the executable, argv, capabilities and every review notice. */
  readonly reviewDigest: string;
}

export type ProviderRegistryFailureCode =
  | 'provider-not-registered'
  | 'provider-unavailable'
  | 'provider-incompatible'
  | 'review-mismatch';

export type ProviderRegistryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: ProviderRegistryFailureCode;
      readonly message: string;
    };

export type ClaudeAuthenticationPath =
  /** API key remains solely in the inherited process environment. */
  | 'api-key-environment'
  /** Existing CLI configuration that does not use a claude.ai subscription login. */
  | 'existing-cli-environment'
  /** Already-authenticated claude.ai CLI state; legal only after prior Anthropic approval. */
  | 'existing-claude-ai-login';

/**
 * Non-secret consent state. Authentication material is deliberately absent:
 * the SDK subprocess inherits the user's environment and existing CLI state.
 */
export interface ClaudeProviderEnablement {
  readonly enabled: boolean;
  readonly termsAccepted: boolean;
  readonly commercialUseApproved: boolean;
  readonly authenticationPath: ClaudeAuthenticationPath;
  /** Required only when using an existing claude.ai subscription login. */
  readonly anthropicThirdPartyApproval: boolean;
}

export const DEFAULT_CLAUDE_PROVIDER_ENABLEMENT: ClaudeProviderEnablement = Object.freeze({
  enabled: false,
  termsAccepted: false,
  commercialUseApproved: false,
  authenticationPath: 'existing-cli-environment',
  anthropicThirdPartyApproval: false,
});

const ClaudeProviderEnablementSchema = z.object({
  enabled: z.boolean(),
  termsAccepted: z.boolean(),
  commercialUseApproved: z.boolean(),
  authenticationPath: z.enum([
    'api-key-environment',
    'existing-cli-environment',
    'existing-claude-ai-login',
  ]),
  anthropicThirdPartyApproval: z.boolean(),
}).strict();

export function parseClaudeProviderEnablement(value: unknown): ClaudeProviderEnablement | null {
  const parsed = ClaudeProviderEnablementSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type ClaudeEnablementGateFailureCode =
  | 'CLAUDE_TERMS_REQUIRED'
  | 'CLAUDE_COMMERCIAL_APPROVAL_REQUIRED'
  | 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED';

export interface ClaudeEnablementGateFailure {
  readonly code: ClaudeEnablementGateFailureCode;
  readonly message: string;
}

/** Shared fail-closed policy used before either IPC or persistence can publish enablement. */
export function getClaudeEnablementGateFailure(
  value: ClaudeProviderEnablement,
): ClaudeEnablementGateFailure | null {
  if (!value.enabled) return null;
  if (!value.termsAccepted) {
    return {
      code: 'CLAUDE_TERMS_REQUIRED',
      message: 'Claude Agent requires explicit acceptance of the applicable Anthropic terms.',
    };
  }
  if (!value.commercialUseApproved) {
    return {
      code: 'CLAUDE_COMMERCIAL_APPROVAL_REQUIRED',
      message: 'Claude Agent requires explicit commercial-use approval.',
    };
  }
  if (
    value.authenticationPath === 'existing-claude-ai-login'
    && !value.anthropicThirdPartyApproval
  ) {
    return {
      code: 'CLAUDE_THIRD_PARTY_AUTHORIZATION_REQUIRED',
      message: 'Using claude.ai login or rate limits in a third-party product requires prior Anthropic approval.',
    };
  }
  return null;
}

export function isDaemonProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_DAEMON_PROVIDER_ID_LENGTH
    && value.trim() === value
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

export type DaemonProviderManagementFailureCode =
  | ProviderRegistryFailureCode
  | ClaudeEnablementGateFailureCode
  | 'invalid-input'
  | 'desktop-principal-required'
  | 'provider-operation-failed';

export type DaemonProviderManagementResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: DaemonProviderManagementFailureCode;
      readonly message: string;
    };
