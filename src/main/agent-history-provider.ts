import type {
  AgentHistoryProvider,
  AgentTranscriptPage,
} from '../shared/agent-history';

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
   * Returns null when the provider cannot express this resume — that is the one
   * place a provider declares a support limit, rather than the caller guessing.
   */
  buildResumeCommand(privateId: string, roots: readonly string[]): AgentResumeCommand | null;
  /** Builds a fresh interactive CLI launch. No prompt is included in argv. */
  buildNewCommand?(roots: readonly string[]): AgentPrivateCommand | null;
  dispose(): Promise<void>;
}
