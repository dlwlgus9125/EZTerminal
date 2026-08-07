/** Desktop-only, read-only project workbench wire contract. */

export const PROJECT_TEXT_MAX_BYTES = 1024 * 1024;
export const PROJECT_SEARCH_MAX_QUERY = 256;
export const PROJECT_SEARCH_MAX_FILES = 50_000;
export const PROJECT_SEARCH_MAX_BYTES = 128 * 1024 * 1024;
export const PROJECT_SEARCH_MAX_RESULTS = 200;
export const PROJECT_SEARCH_TIMEOUT_MS = 10_000;
export type ProjectWorkspaceError =
  | 'invalid-request'
  | 'project-not-found'
  | 'root-not-found'
  | 'workspace-not-found'
  | 'authorization-required'
  | 'path-outside-root'
  | 'symlink-not-supported'
  | 'not-found'
  | 'not-a-directory'
  | 'not-a-file'
  | 'binary'
  | 'too-large'
  | 'stale'
  | 'not-a-repository'
  | 'git-failed'
  | 'unsupported'
  | 'io-error';

export interface ProjectRootDescriptor {
  readonly rootId: string;
  readonly name: string;
  /** Presentation only. Subsequent requests must use rootId + relativePath. */
  readonly displayPath: string;
  readonly primary: boolean;
}

export type ProjectWorkspaceKind = 'root' | 'main' | 'managed' | 'external';
export type ProjectWorkspaceAccess = 'granted' | 'authorization-required' | 'unavailable';

/**
 * One concrete checkout that can be inspected beneath a registered Agent
 * Project root. `displayPath` is presentation-only; every read is re-resolved
 * from the opaque ids and revalidated in main.
 */
export interface ProjectWorkspaceLocationDescriptor {
  readonly workspaceId: string;
  readonly rootId: string;
  readonly name: string;
  readonly displayPath: string;
  readonly kind: ProjectWorkspaceKind;
  readonly access: ProjectWorkspaceAccess;
  readonly branch?: string;
  readonly head?: string;
  readonly repositoryId?: string;
  readonly locked?: boolean;
}

export interface ProjectWorkspaceDescriptor {
  readonly projectId: string;
  readonly name: string;
  readonly roots: readonly ProjectRootDescriptor[];
  /** Present on the desktop descriptor; optional for protocol/test fixtures created before v2. */
  readonly workspaces?: readonly ProjectWorkspaceLocationDescriptor[];
}

export type ProjectWorkspaceDescriptorResult =
  | { readonly ok: true; readonly project: ProjectWorkspaceDescriptor }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectPathRequest {
  readonly projectId: string;
  readonly rootId: string;
  /** Concrete checkout. Omitted only by legacy callers and old layouts. */
  readonly workspaceId?: string;
  /** POSIX-style project-relative path. The empty string names the root. */
  readonly relativePath: string;
}

export interface ProjectDirectoryEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly mtimeMs: number;
  readonly sensitive: boolean;
}

export type ProjectDirectoryResult =
  | {
    readonly ok: true;
    readonly relativePath: string;
    readonly parent: string | null;
    readonly entries: readonly ProjectDirectoryEntry[];
  }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

/**
 * The sole identity of an opened Agent Project document. A concrete workspace
 * is always present after main resolves a request, even when a legacy caller
 * omitted it.
 */
export interface ProjectDocumentId {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
  readonly relativePath: string;
}

/** Main-owned equality token. Renderers compare this instead of normalizing
 * Windows casing, worktree paths, or legacy ids themselves. */
export interface ProjectDocumentIdentity {
  readonly id: ProjectDocumentId;
  readonly key: string;
}

export type ProjectDocumentLens =
  | { readonly kind: 'current' }
  | {
      readonly kind: 'agent-turn';
      readonly historyId: string;
      readonly turnId: string;
    };

export type ProjectDocumentTargetRequest =
  | {
      readonly kind: 'project-path';
      readonly projectId: string;
      readonly rootId: string;
      readonly workspaceId?: string;
      readonly relativePath: string;
      readonly lens?: ProjectDocumentLens;
      readonly line?: number;
      readonly column?: number;
    }
  | {
      readonly kind: 'absolute-path';
      /** Optional because PTY links are resolved across all registered projects in main. */
      readonly projectId?: string;
      readonly absolutePath: string;
      readonly lens?: ProjectDocumentLens;
      readonly line?: number;
      readonly column?: number;
    };

export interface ProjectDocumentTarget {
  readonly document: ProjectDocumentIdentity;
  readonly lens: ProjectDocumentLens;
  readonly line?: number;
  readonly column?: number;
}

export type ProjectDocumentTargetResult =
  | { readonly ok: true; readonly target: ProjectDocumentTarget }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export type ProjectDocumentDirectoryRequest = ProjectPathRequest;

export interface ProjectDocumentDirectoryEntry extends ProjectDirectoryEntry {
  readonly document: ProjectDocumentIdentity;
  readonly status?: ProjectChangeKind;
  readonly additions?: number;
  readonly deletions?: number;
  /** Project-root-relative path used before a rename. */
  readonly previousRelativePath?: string;
  /** Project-root-relative destination shown by a virtual rename tombstone. */
  readonly renamedToRelativePath?: string;
  /** True when Git reports a path which no longer exists on disk. */
  readonly virtual?: boolean;
}

export type ProjectDocumentDirectoryResult =
  | {
      readonly ok: true;
      readonly directory: ProjectDocumentIdentity;
      readonly parent: string | null;
      readonly entries: readonly ProjectDocumentDirectoryEntry[];
      /** Git revision that produced status decorations, absent outside a repository. */
      readonly statusRevision?: string;
      /** Repository/status discovery failed; filesystem entries remain usable. */
      readonly statusError?: ProjectWorkspaceError;
    }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectTextSnapshot {
  readonly relativePath: string;
  readonly content: string;
  /** Content-derived token used for stale-reference validation. */
  readonly version: string;
  readonly byteLength: number;
  readonly language: string;
  readonly sensitive: boolean;
}

export type ProjectTextResult =
  | { readonly ok: true; readonly file: ProjectTextSnapshot }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectSearchRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly rootId?: string;
  readonly workspaceId?: string;
  readonly query: string;
  readonly mode: 'files' | 'content';
  readonly caseSensitive?: boolean;
}

export interface ProjectSearchMatch {
  readonly rootId: string;
  readonly relativePath: string;
  readonly line?: number;
  readonly column?: number;
  /** Bounded and masked when the source appears sensitive. */
  readonly preview?: string;
  readonly sensitive: boolean;
}

export type ProjectSearchResult =
  | {
    readonly ok: true;
    readonly matches: readonly ProjectSearchMatch[];
    readonly truncated: boolean;
    readonly scannedFiles: number;
    readonly scannedBytes: number;
  }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

/** Legacy `last-turn` remains readable while persisted panels migrate. */
export type ProjectReviewScope = 'last-turn' | 'working-tree' | 'staged' | 'branch';
export type ProjectReviewSource = 'codex' | 'claude' | 'git';
export type ProjectChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export type ProjectReviewSelection =
  | { readonly kind: 'working-tree' }
  | { readonly kind: 'staged' }
  | { readonly kind: 'branch'; readonly baseRef: string }
  | { readonly kind: 'agent-turn'; readonly historyId: string; readonly turnId: string };

export interface ProjectReviewRequest {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId?: string;
  /** POSIX path from the registered root to a nested Git top-level. Empty/omitted names the root. */
  readonly repositoryRelativePath?: string;
  /** New callers use this discriminated source. */
  readonly sourceSelection?: ProjectReviewSelection;
  /** @deprecated Compatibility input for e113c67 layouts and callers. */
  readonly scope?: ProjectReviewScope;
  /** Opaque local history id. Required for a completed-history Last turn review. */
  readonly historyId?: string;
  /** Opaque transcript turn selected from a file-change activity. */
  readonly reviewTurnId?: string;
  /** Local branch/ref only. Used by branch review; no network fetch occurs. */
  readonly baseRef?: string;
}

export interface ProjectReviewTarget {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId?: string;
  readonly repositoryRelativePath: string;
  readonly repositoryName: string;
  /** Path relative to the discovered Git top-level. */
  readonly relativePath: string;
}

export type ProjectReviewTargetResult =
  | { readonly ok: true; readonly target: ProjectReviewTarget }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectReviewChange {
  readonly relativePath: string;
  readonly previousRelativePath?: string;
  readonly kind: ProjectChangeKind;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export type ProjectReviewIndexResult =
  | {
    readonly ok: true;
    readonly scope: ProjectReviewScope;
      readonly source: ProjectReviewSource;
      readonly title: string;
      readonly repositoryName?: string;
      readonly revision: string;
    readonly changes: readonly ProjectReviewChange[];
    readonly coverageNotice?: string;
    readonly baseRef?: string;
    readonly sourceSelection?: ProjectReviewSelection;
  }
  | {
    readonly ok: false;
    readonly error: ProjectWorkspaceError;
    readonly fallbackScope?: 'working-tree';
    readonly coverageNotice?: string;
  };

export interface ProjectReviewFileRequest extends ProjectReviewRequest {
  readonly relativePath: string;
  readonly revision: string;
}

export interface ProjectRecordedChangeLine {
  readonly kind: 'meta' | 'context' | 'added' | 'removed';
  readonly text: string;
}

export interface ProjectRecordedChangeSection {
  readonly lines: readonly ProjectRecordedChangeLine[];
  /** One-based current-file line, present only after an exact unique match. */
  readonly anchorLine?: number;
}

export type ProjectReviewTextView =
  | {
    readonly kind: 'full-diff';
    readonly coverage: 'full-file' | 'current-context';
    readonly original: string;
    readonly modified: string;
  }
  | {
    readonly kind: 'current-with-record';
    readonly current: string;
    readonly sections: readonly ProjectRecordedChangeSection[];
  }
  | {
    readonly kind: 'record-only';
    readonly sections: readonly ProjectRecordedChangeSection[];
  };

export type ProjectReviewFileResult =
  | {
    readonly ok: true;
    readonly relativePath: string;
    readonly originalPath: string;
    readonly modifiedPath: string;
    readonly language: string;
    readonly binary: false;
    readonly view: ProjectReviewTextView;
    readonly sensitive: boolean;
  }
  | {
    readonly ok: true;
    readonly relativePath: string;
    readonly originalPath: string;
    readonly modifiedPath: string;
    readonly binary: true;
    readonly sensitive: boolean;
  }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectDocumentComparison {
  readonly lens: ProjectDocumentLens;
  readonly source: ProjectReviewSource;
  readonly title: string;
  readonly repositoryName?: string;
  readonly language: string;
  readonly revision: string;
  readonly change: ProjectReviewChange;
  readonly originalPath: string;
  readonly modifiedPath: string;
  readonly view: ProjectReviewTextView;
  readonly coverageNotice?: string;
}

export interface ProjectDocumentSnapshot {
  readonly document: ProjectDocumentIdentity;
  readonly lens: ProjectDocumentLens;
  /** Full current file. Null only for a deleted path or truthful record-only fallback. */
  readonly current: ProjectTextSnapshot | null;
  readonly state: 'text' | 'deleted' | 'record-only';
  /** File content version or comparison revision, suitable for refresh/stale checks. */
  readonly revision: string;
  readonly comparison?: ProjectDocumentComparison;
  /** A failed comparison never hides an otherwise readable current file. */
  readonly comparisonError?: ProjectWorkspaceError;
  readonly coverageNotice?: string;
}

export interface ProjectDocumentSnapshotRequest {
  readonly document: ProjectDocumentId;
  readonly lens?: ProjectDocumentLens;
}

export type ProjectDocumentSnapshotResult =
  | { readonly ok: true; readonly snapshot: ProjectDocumentSnapshot }
  | {
      readonly ok: false;
      readonly error: ProjectWorkspaceError;
      readonly document?: ProjectDocumentIdentity;
    };

export interface ProjectWorkspaceAccessRequest {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
}

export type ProjectWorkspaceAccessResult =
  | { readonly ok: true; readonly workspace: ProjectWorkspaceLocationDescriptor }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  bat: 'bat', c: 'c', cc: 'cpp', cjs: 'javascript', cpp: 'cpp', cs: 'csharp',
  css: 'css', csv: 'plaintext', go: 'go', h: 'c', hpp: 'cpp', html: 'html',
  java: 'java', js: 'javascript', json: 'json', jsx: 'javascript', kt: 'kotlin',
  kts: 'kotlin', less: 'less', lua: 'lua', md: 'markdown', mjs: 'javascript',
  ps1: 'powershell', py: 'python', rb: 'ruby', rs: 'rust', scss: 'scss',
  sh: 'shell', sql: 'sql', svg: 'xml', toml: 'ini', ts: 'typescript',
  tsx: 'typescript', txt: 'plaintext', xml: 'xml', yaml: 'yaml', yml: 'yaml',
});

export function languageForProjectPath(relativePath: string): string {
  const name = relativePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'plaintext';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
}

const SENSITIVE_NAME = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials?|secrets?|[^/]+\.(?:pem|key|p12|pfx|kdbx))$/i;
const SENSITIVE_CONTENT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=])/i;

export function isSensitiveProjectPath(relativePath: string): boolean {
  return SENSITIVE_NAME.test(relativePath.replace(/\\/g, '/'));
}

export function hasSensitiveProjectContent(content: string): boolean {
  return SENSITIVE_CONTENT.test(content);
}

export function hasProjectPathControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
