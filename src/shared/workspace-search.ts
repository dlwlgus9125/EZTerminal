export const WORKSPACE_FILE_SEARCH_DEBOUNCE_MS = 120;
export const WORKSPACE_FILE_INDEX_CACHE_TTL_MS = 10_000;
export const WORKSPACE_FILE_INDEX_MAX_FILES = 50_000;
export const WORKSPACE_FILE_SEARCH_MAX_RESULTS = 200;
export const WORKSPACE_FILE_SEARCH_MAX_QUERY_CHARS = 256;

export type WorkspaceFileIndexSource = 'git' | 'walk';

export interface WorkspaceFileSearchRequest {
  readonly requestId: string;
  readonly root: string;
  readonly query: string;
  readonly signal?: AbortSignal;
}

export interface WorkspaceFileMatch {
  readonly relativePath: string;
  readonly basename: string;
}

export interface WorkspaceFileSearchSuccess {
  readonly ok: true;
  readonly requestId: string;
  readonly root: string;
  readonly query: string;
  readonly matches: readonly WorkspaceFileMatch[];
  readonly source: WorkspaceFileIndexSource | null;
  readonly indexedFiles: number;
  readonly indexTruncated: boolean;
  readonly cacheHit: boolean;
  readonly indexRevision: string;
}

export type WorkspaceFileSearchErrorCode =
  | 'invalid-request'
  | 'invalid-query'
  | 'invalid-root'
  | 'cancelled'
  | 'index-failed'
  | 'disposed';

export interface WorkspaceFileSearchFailure {
  readonly ok: false;
  readonly requestId: string;
  readonly error: WorkspaceFileSearchErrorCode;
  readonly message: string;
}

export type WorkspaceFileSearchResult = WorkspaceFileSearchSuccess | WorkspaceFileSearchFailure;
