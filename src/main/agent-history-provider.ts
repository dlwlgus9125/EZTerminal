import type {
  AgentHistoryProvider,
  AgentTranscriptPage,
} from '../shared/agent-history';
import type { AgentPersonaLaunch } from '../shared/agent-team';

export interface ProviderHistorySession {
  readonly privateId: string;
  readonly parentPrivateId: string | null;
  readonly title: string;
  readonly preview: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cwd: string;
  readonly roots: readonly string[];
  readonly source: string;
  readonly rolloutPath: string | null;
}

export interface ProviderHistorySessionPage {
  readonly items: readonly ProviderHistorySession[];
  readonly nextCursor: string | null;
}

export interface ProviderSessionQuery {
  readonly roots: readonly string[];
  readonly cursor?: string;
  readonly limit: number;
}

/** Main-private structured record used by the read-only Last turn review. */
export interface ProviderFileChangeRecord {
  readonly path: string;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly previousPath?: string;
  /** Provider operation semantics when the record came from a structured tool. */
  readonly operation?: 'edit' | 'write' | 'notebook-edit';
  /** Claude Edit's replace_all cannot be reversed safely without a full before snapshot. */
  readonly replaceAll?: boolean;
  /** Provider-authored unified diff when one is available. */
  readonly diff?: string;
  /** Bounded before/after snapshots when the provider records them directly. */
  readonly original?: string;
  readonly modified?: string;
}

export interface ProviderFileChangeSet {
  readonly provider: 'codex' | 'claude';
  readonly turnId: string;
  readonly changes: readonly ProviderFileChangeRecord[];
}

/**
 * A launch line for one provider's resume, built inside the adapter so the
 * provider's CLI grammar never leaks into main's dispatch or the mobile bridge.
 * `displayCommandText` is all the renderer, block list, and shell history see.
 */
export interface AgentPrivateCommand {
  readonly commandText: string;
  readonly displayCommandText: string;
}

export type AgentResumeCommand = AgentPrivateCommand;

export interface AgentHistoryProviderAdapter {
  readonly provider: AgentHistoryProvider;
  /**
   * Reads one recent page from the provider's lightweight state index. It must
   * not inspect transcript/rollout files.
   */
  listSessions(query: ProviderSessionQuery): Promise<ProviderHistorySessionPage>;
  readTranscript(privateId: string, cursor?: string, limit?: number): Promise<AgentTranscriptPage>;
  /**
   * Reads one completed turn's structured changes. When `turnId` is omitted,
   * the provider's latest completed turn is used. The opaque turn id is the
   * same renderer-safe id returned by `readTranscript`.
   */
  readFileChanges?(privateId: string, turnId?: string): Promise<ProviderFileChangeSet | null>;
  /**
   * Returns null when the provider cannot express this resume — that is the one
   * place a provider declares a support limit, rather than the caller guessing.
   */
  buildResumeCommand(privateId: string, roots: readonly string[]): AgentResumeCommand | null;
  /** Builds a fresh interactive CLI launch. No prompt is included in argv. */
  buildNewCommand?(roots: readonly string[], launch?: AgentPersonaLaunch): AgentPrivateCommand | null;
  dispose(): Promise<void>;
}
