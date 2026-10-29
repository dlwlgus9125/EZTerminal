/**
 * The provider CLI program itself (Claude Code, Codex): its installed and latest
 * versions and an in-place update. Desktop only; never part of the remote protocol.
 */
export type AgentCliProviderId = 'codex' | 'claude';

/** Where the program is running, which stops Windows from replacing it. */
export interface AgentCliLocation {
  readonly kind: 'conversation' | 'terminal' | 'outside';
  /** Conversation or terminal-tab title when known. */
  readonly label?: string;
}

export type AgentCliBlocker =
  | { readonly kind: 'running'; readonly locations: readonly AgentCliLocation[] }
  /** Installed some other way than a global npm package; update it by hand. */
  | { readonly kind: 'not-npm' }
  /** The npm on PATH would install into a different folder than the one in use. */
  | { readonly kind: 'prefix-mismatch' }
  /** Claude Code's DISABLE_UPDATES policy blocks every update path. */
  | { readonly kind: 'policy' }
  /** The latest version is one this app cannot run. */
  | { readonly kind: 'incompatible'; readonly version: string };

export interface AgentCliStatus {
  readonly providerId: AgentCliProviderId;
  /** `null` when the program is not installed. */
  readonly installedVersion: string | null;
  /** `null` when the latest version could not be read (offline, registry error). */
  readonly latestVersion: string | null;
  readonly updateAvailable: boolean;
  readonly updating: boolean;
  readonly blockers: readonly AgentCliBlocker[];
  /** The exact command to run by hand when the app cannot update or install it. */
  readonly manualCommand: string;
  readonly checkedAt: string;
}

export type AgentCliUpdateResult =
  | {
    readonly ok: true;
    readonly previousVersion: string;
    readonly version: string;
    /** `needs-review`: the app turned the provider off and it must be reviewed again. */
    readonly provider: 'ready' | 'not-enabled' | 'needs-review';
  }
  | {
    readonly ok: false;
    readonly code: 'blocked' | 'failed' | 'unavailable';
    readonly blockers?: readonly AgentCliBlocker[];
    /** Sanitised npm output; never environment values. */
    readonly detail?: string;
    readonly manualCommand?: string;
  };

export interface AgentCliClient {
  status(providerId: AgentCliProviderId, options?: { readonly refreshLatest?: boolean }): Promise<AgentCliStatus | null>;
  update(providerId: AgentCliProviderId): Promise<AgentCliUpdateResult | null>;
}

export const AGENT_CLI_PACKAGES: Readonly<Record<AgentCliProviderId, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};
