/**
 * Provider-neutral, transport-safe contracts for the local Agent history UI.
 *
 * EZTerminal persists only project presentation metadata. Transcript content
 * remains in the provider-owned local store and is fetched on demand.
 */

import type { ProjectSessionTarget } from './project-workspace';
import type { ProjectMapAgentLaunchRequest } from './project-map';

export type AgentHistoryProvider = 'codex' | 'claude';
export type AgentProjectLauncherProvider = AgentHistoryProvider | 'generic';

/** Validated options for launching a fresh built-in Agent process. */
export type AgentFreshLaunchOptions =
  | {
      readonly provider: 'codex';
      readonly model?: string;
      readonly sandbox: 'read-only' | 'workspace-write';
    }
  | {
      readonly provider: 'claude';
      readonly model?: string;
      readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      readonly permissionMode: 'plan' | 'manual' | 'acceptEdits';
    };

export interface AgentLauncherCapabilities {
  readonly provider: 'codex' | 'claude';
  readonly available: boolean;
  readonly supportsModel: boolean;
  readonly effortValues: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  readonly permissionValues: readonly ('read-only' | 'workspace-write' | 'plan' | 'manual' | 'acceptEdits')[];
  readonly modelAvailability: 'launch-time' | 'unavailable';
}

export interface AgentProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly primaryRoot: string;
  readonly additionalRoots: readonly string[];
  readonly pinned: boolean;
  /** False for terminal-observed work that the user has not explicitly saved. */
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
      /** Provider-structured file paths used only as transient review hints. */
      readonly changedPaths?: readonly string[];
    };

export interface AgentTranscriptTurn {
  readonly id: string;
  readonly status: string;
  readonly entries: readonly AgentTranscriptEntry[];
}

export interface AgentTranscriptPage {
  readonly historyId: string;
  readonly provider: AgentHistoryProvider;
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
  readonly kind: 'resume';
  readonly historyId: string;
  readonly provider: AgentHistoryProvider;
  /**
   * Primary root of the chosen roots. The resumed shell session starts here:
   * providers without a "run in this directory" flag resolve their session
   * store from the process cwd.
   */
  readonly cwd: string;
  readonly rootChoice: AgentResumeRootChoice;
  readonly revision: string;
  readonly initialPrompt: string;
}

export type AgentResumeStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid'
        | 'not-found'
        | 'stale'
        | 'missing-root'
        | 'session-mismatch'
        | 'unavailable';
    };

export interface AgentProjectLauncherSummary {
  /** Stable opaque catalog id. Generic executable names never cross this boundary. */
  readonly launcherId: string;
  readonly provider: AgentProjectLauncherProvider;
  readonly name: string;
  readonly supportsAdditionalRoots: boolean;
}

export type AgentLaunchTarget =
  | ({ readonly kind: 'project' } & ProjectSessionTarget)
  | {
      readonly kind: 'directory';
      /** Host directory. The main process returns the canonical path after preparation. */
      readonly directory: string;
    };

export type AgentLaunchPreparation =
  | {
      readonly ok: true;
      /** Canonicalized for a direct directory; opaque and unchanged for a project. */
      readonly target: AgentLaunchTarget;
      readonly launcherId: string;
      readonly provider: AgentProjectLauncherProvider;
      readonly name: string;
      readonly cwd: string;
      /** Only roots the selected launcher can actually consume. */
      readonly roots: readonly string[];
      readonly ignoredAdditionalRootCount: number;
      /** Covers the canonical effective roots and current launcher configuration. */
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'not-found' | 'missing-root' | 'unavailable';
    };

export interface AgentLaunchStartRequest {
  readonly target: AgentLaunchTarget;
  readonly launcherId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: string;
}

export type AgentLaunchStartResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid'
        | 'not-found'
        | 'stale'
        | 'missing-root'
        | 'session-mismatch'
        | 'unavailable';
    };

/** Renderer-only one-shot handoff from the launch picker into a fresh terminal. */
export interface AgentLaunchBootstrap {
  readonly kind: 'new-chat';
  readonly target: AgentLaunchTarget;
  readonly launcherId: string;
  readonly provider: AgentProjectLauncherProvider;
  readonly name: string;
  readonly cwd: string;
  readonly revision: string;
  /** Runtime-only Project Map work handed to this fresh Agent session. */
  readonly projectMapRequest?: ProjectMapAgentLaunchRequest;
}

/** Protocol-v5 compatibility shape. New callers use AgentLaunchPreparation. */
export type AgentProjectLaunchPreparation =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly launcherId: string;
      readonly provider: AgentProjectLauncherProvider;
      readonly name: string;
      readonly cwd: string;
      readonly roots: readonly string[];
      /** Covers the canonical project roots and the current launcher configuration. */
      readonly revision: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'not-found' | 'missing-root' | 'unavailable';
    };

export interface AgentProjectLaunchStartRequest {
  readonly projectId: string;
  readonly launcherId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly revision: string;
}

export type AgentProjectLaunchStartResult = AgentLaunchStartResult;

export type AgentTerminalBootstrap = AgentResumeBootstrap | AgentLaunchBootstrap;

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
export const MAX_AGENT_LAUNCH_DIRECTORY_LENGTH = 8_192;
export const MAX_AGENT_HISTORY_PAGE_SIZE = 100;
export const MAX_AGENT_TRANSCRIPT_PAGE_SIZE = 20;
