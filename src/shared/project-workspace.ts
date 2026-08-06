/** Desktop-only, read-only project workbench wire contract. */

export const PROJECT_TEXT_MAX_BYTES = 1024 * 1024;
export const PROJECT_SEARCH_MAX_QUERY = 256;
export const PROJECT_SEARCH_MAX_FILES = 50_000;
export const PROJECT_SEARCH_MAX_BYTES = 128 * 1024 * 1024;
export const PROJECT_SEARCH_MAX_RESULTS = 200;
export const PROJECT_SEARCH_TIMEOUT_MS = 10_000;
export const PROJECT_REFERENCE_MAX_COUNT = 20;
export const PROJECT_REFERENCE_MAX_LINES = 40;
export const PROJECT_REFERENCE_MAX_SNIPPET_BYTES = 4 * 1024;

export type ProjectWorkspaceError =
  | 'invalid-request'
  | 'project-not-found'
  | 'root-not-found'
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

export interface ProjectWorkspaceDescriptor {
  readonly projectId: string;
  readonly name: string;
  readonly roots: readonly ProjectRootDescriptor[];
}

export type ProjectWorkspaceDescriptorResult =
  | { readonly ok: true; readonly project: ProjectWorkspaceDescriptor }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectPathRequest {
  readonly projectId: string;
  readonly rootId: string;
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

export interface ProjectTextValidationRequest extends ProjectPathRequest {
  readonly version: string;
  readonly startLine: number;
  readonly endLine: number;
}

export type ProjectTextValidationResult =
  | {
    readonly ok: true;
    readonly currentVersion: string;
    readonly lineCount: number;
    readonly sensitive: boolean;
  }
  | { readonly ok: false; readonly error: ProjectWorkspaceError };

export interface ProjectSearchRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly rootId?: string;
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

export type ProjectReviewScope = 'last-turn' | 'working-tree' | 'staged' | 'branch';
export type ProjectReviewSource = 'codex' | 'claude' | 'git';
export type ProjectChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ProjectReviewRequest {
  readonly projectId: string;
  readonly rootId: string;
  /** POSIX path from the registered root to a nested Git top-level. Empty/omitted names the root. */
  readonly repositoryRelativePath?: string;
  readonly scope: ProjectReviewScope;
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

export interface ProjectQuestionReference {
  readonly projectId: string;
  readonly rootId: string;
  readonly relativePath: string;
  readonly version: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly snippet?: string;
  readonly sensitive: boolean;
}

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
