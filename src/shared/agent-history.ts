/**
 * Provider-neutral, transport-safe contracts for the local Agent history UI.
 *
 * EZTerminal persists only project presentation metadata. Transcript content
 * remains in the provider-owned local store and is fetched on demand.
 */

export type AgentHistoryProvider = 'codex' | 'claude';

export interface AgentProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly primaryRoot: string;
  readonly additionalRoots: readonly string[];
  readonly pinned: boolean;
  /** False for a project inferred from provider history but not explicitly saved. */
  readonly saved: boolean;
  readonly sessionCount: number;
  readonly providers: readonly AgentHistoryProvider[];
  readonly lastActiveAt: number | null;
}

export interface AgentProjectPage {
  readonly items: readonly AgentProjectSummary[];
  readonly nextCursor: string | null;
}

export interface AgentHistorySessionSummary {
  /** Opaque EZTerminal id. Provider thread/session ids never cross this boundary. */
  readonly historyId: string;
  readonly projectId: string;
  readonly provider: AgentHistoryProvider;
  readonly title: string;
  readonly preview: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly roots: readonly string[];
  readonly source: string;
}

export interface AgentHistorySessionPage {
  readonly items: readonly AgentHistorySessionSummary[];
  readonly nextCursor: string | null;
}

export type AgentTranscriptEntry =
  | {
      readonly type: 'message';
      readonly id: string;
      readonly role: 'user' | 'assistant';
      readonly markdown: string;
    }
  | {
      readonly type: 'activity';
      readonly id: string;
      readonly kind:
        | 'command'
        | 'tool'
        | 'file-change'
        | 'web-search'
        | 'plan'
        | 'subagent'
        | 'image'
        | 'reasoning';
      readonly summary: string;
      readonly status?: string;
    };

export interface AgentTranscriptTurn {
  readonly id: string;
  readonly status: string;
  readonly entries: readonly AgentTranscriptEntry[];
}

export interface AgentTranscriptPage {
  readonly historyId: string;
  readonly turns: readonly AgentTranscriptTurn[];
  readonly nextCursor: string | null;
}

export type AgentResumeRootChoice = 'recorded' | 'current';

export interface AgentResumePreparation {
  readonly historyId: string;
  readonly provider: AgentHistoryProvider;
  readonly recordedRoots: readonly string[];
  readonly currentRoots: readonly string[];
  readonly rootsMatch: boolean;
  readonly missingRecordedRoots: readonly string[];
  readonly missingCurrentRoots: readonly string[];
  readonly canResume: boolean;
  /** Short-lived optimistic token checked again when the run starts. */
  readonly revision: string;
}

export interface AgentResumeStartRequest {
  readonly historyId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly rootChoice: AgentResumeRootChoice;
  readonly revision: string;
}

/** Renderer-only handoff from a read-only history view into a live terminal. */
export interface AgentResumeBootstrap {
  readonly historyId: string;
  readonly rootChoice: AgentResumeRootChoice;
  readonly revision: string;
  readonly initialPrompt: string;
}

export type AgentResumeStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'not-found' | 'stale' | 'missing-root' | 'unavailable';
    };

export interface AgentProjectInput {
  readonly projectId?: string;
  readonly name: string;
  readonly primaryRoot: string;
  readonly additionalRoots: readonly string[];
  readonly pinned: boolean;
}

export type AgentProjectMutationResult =
  | { readonly ok: true; readonly project: AgentProjectSummary }
  | { readonly ok: false; readonly reason: 'invalid' | 'not-found' | 'duplicate' };

export interface AgentProjectFolderSelection {
  readonly canceled: boolean;
  readonly paths: readonly string[];
}

/** User-visible project history is unbounded; this is only a corrupt-file guard. */
export const MAX_AGENT_PROJECTS = 10_000;
export const MAX_AGENT_PROJECT_ROOTS = 32;
export const MAX_AGENT_PROJECT_NAME_LENGTH = 80;
export const MAX_AGENT_HISTORY_PAGE_SIZE = 100;
export const MAX_AGENT_TRANSCRIPT_PAGE_SIZE = 20;
