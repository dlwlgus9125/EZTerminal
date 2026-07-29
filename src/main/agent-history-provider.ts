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

export interface AgentHistoryProviderAdapter {
  readonly provider: AgentHistoryProvider;
  /**
   * Reads one recent page from the provider's lightweight state index. It must
   * not inspect transcript/rollout files.
   */
  listSessions(query: ProviderSessionQuery): Promise<ProviderHistorySessionPage>;
  readTranscript(privateId: string, cursor?: string, limit?: number): Promise<AgentTranscriptPage>;
  dispose(): Promise<void>;
}
