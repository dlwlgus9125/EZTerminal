/**
 * File-explorer shared types and constants (file-explorer plan, M0) — the
 * single isomorphic source of truth for the desktop drawer (`FileService` via
 * IPC, M1/M2) and the mobile `MobileFileView` (via the WS bridge's `file-*`
 * messages in `remote-protocol.ts`, M3+). No Node imports here — this module
 * is bundled into the mobile app the same way `remote-protocol.ts` is.
 */

/** Cap on how much of a file `readTextFile`/text-mode `openReadStream` will
 * decode and send — larger files are truncated with a banner in the UI. */
export const TEXT_VIEW_MAX_BYTES = 1_048_576;

/** How many leading bytes to scan for a NUL byte when an extension isn't in
 * `TEXT_EXTENSIONS` (the binary/text heuristic for unrecognized extensions). */
export const TEXT_SNIFF_BYTES = 8_192;

/** Mobile-only upload/download size ceilings — always server-enforced, never
 * just a UX hint (see file-explorer plan's security notes). */
export const UPLOAD_MAX_FILE_BYTES = 50 * 1_048_576;
export const DOWNLOAD_MAX_FILE_BYTES = 50 * 1_048_576;

/** Wire chunk size for both directions of file streaming (download + upload). */
export const FILE_CHUNK_BYTES = 256 * 1_024;

/**
 * Extensions that are always treated as text, regardless of content, skipping
 * the NUL-byte sniff. Entries with no dot (`dockerfile`, `makefile`,
 * `gitignore`, ...) match extension-less names and dotfiles by their whole
 * lowercased basename instead of a suffix — see `textExtKey` in
 * `file-service.ts` for the lookup key construction.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // prose / docs
  'txt', 'md', 'markdown', 'log',
  // structured data / config
  'json', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'csv', 'tsv',
  'env', 'lock', 'properties', 'gradle',
  // web
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm',
  // shell / scripts
  'sh', 'bash', 'zsh', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  // languages
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'sql',
  // dotfiles / extension-less names
  'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'makefile',
]);

export interface FileEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly isSymlink: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export type FileListResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly parent: string | null;
      readonly entries: readonly FileEntry[];
    }
  | { readonly ok: false; readonly error: string };

export type FileOpResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type FileReadTextResult =
  | {
      readonly ok: true;
      readonly isText: true;
      readonly content: string;
      readonly truncated: boolean;
      readonly fileSize: number;
    }
  | { readonly ok: true; readonly isText: false; readonly fileSize: number }
  | { readonly ok: false; readonly error: string };

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable byte size for entry rows and transfer progress — shared by
 * the desktop drawer (`FileExplorerPanel`) and mobile (`MobileFileView`). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** Join a listing path and an entry name client-side. Listing paths come from
 * `path.resolve` on main (see `FileService`), so the path's own separator
 * tells us which one to join with — mirrors `format-cwd.ts`'s same
 * `includes('\\')` check. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}
