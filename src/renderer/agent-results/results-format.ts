import type { ReviewLine } from '../../shared/conversation-changes';
import type { ChatLocale } from '../chat/model/summary';

/** Pure helpers shared by the Results tab sections and their tests. */

export interface ReviewComment {
  readonly id: string;
  /** As displayed (workspace-relative where possible). */
  readonly path: string;
  /** e.g. `12-14`, `+12`, or empty for a fragment without line numbers. */
  readonly lines: string;
  /** The selected patch lines, as shown. */
  readonly quote: readonly string[];
  /** The person's note; empty for a plain quote. */
  readonly text: string;
  /** Where in the review it was made, to mark the lines; not part of the message. */
  readonly recordId?: string;
  readonly start?: number;
  readonly end?: number;
}

/** Longest single message the composer takes from review comments. */
export const REVIEW_DRAFT_LIMIT = 8_000;
const QUOTE_LINES = 12;

/** `12-14` from the new-side numbers (old side for a pure removal); empty when unnumbered. */
export function lineRangeLabel(lines: readonly ReviewLine[]): string {
  const after = lines.map((line) => line.after).filter((value): value is number => value !== undefined);
  const before = lines.map((line) => line.before).filter((value): value is number => value !== undefined);
  const numbers = after.length ? after : before;
  if (!numbers.length) return '';
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const prefix = after.length ? '' : '−';
  return first === last ? `${prefix}${String(first)}` : `${prefix}${String(first)}-${String(last)}`;
}

/** The text that goes into the composer draft: a heading, then one entry per comment. */
export function formatReviewComments(comments: readonly ReviewComment[], locale: ChatLocale): string {
  if (!comments.length) return '';
  const heading = locale === 'ko' ? `검토 의견 (${String(comments.length)})` : `Review comments (${String(comments.length)})`;
  const entries = comments.map((comment) => {
    const location = comment.lines ? `${comment.path}:${comment.lines}` : comment.path;
    const head = comment.text.trim() ? `- ${location} — ${comment.text.trim().replace(/\s*\n\s*/gu, ' ')}` : `- ${location}`;
    const shown = comment.quote.slice(0, QUOTE_LINES).map((line) => `  > ${line}`);
    if (comment.quote.length > QUOTE_LINES) shown.push(`  > …(+${String(comment.quote.length - QUOTE_LINES)})`);
    return [head, ...shown].join('\n');
  });
  return `${heading}\n${entries.join('\n')}\n\n`;
}

function separatorOf(root: string): string {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

/**
 * `\\server\share`, `//server`, `\\?\…` and `\\.\…`: reading one makes Windows
 * contact another machine (and offer the user's credentials) or a device. A
 * path from an AI's record or message is never opened that way.
 */
export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/u.test(path);
}

/** True for a local absolute path: `C:\…` or `/…` (never a network or device path). */
export function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/u.test(path);
}

/** A relative path from a chat link or `git diff` made absolute under the working folder. */
export function resolveWorkspacePath(path: string, workspaceRoot?: string): string | undefined {
  const clean = path.replace(/<WORKSPACE>[\\/]+/gu, '');
  if (isNetworkOrDevicePath(clean) || /^[A-Za-z]:(?![\\/])/u.test(clean)) return undefined;
  if (isAbsolutePath(clean)) return clean;
  if (!workspaceRoot) return undefined;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(clean) || clean.startsWith('~')) return undefined;
  const separator = separatorOf(workspaceRoot);
  const relative = clean.replace(/^\.[\\/]/u, '').replace(/[\\/]+/gu, separator);
  return `${workspaceRoot.replace(/[\\/]+$/u, '')}${separator}${relative}`;
}

/** True when `path` is the working folder or inside it (case-insensitive, either separator). */
export function isInsideWorkspace(path: string, workspaceRoot?: string): boolean {
  if (!workspaceRoot) return false;
  const normalize = (value: string): string => value.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '').toLowerCase();
  const root = normalize(workspaceRoot);
  const target = normalize(path);
  return target === root || target.startsWith(`${root}/`);
}

/** Same file whatever the separators or letter case (Windows paths). */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/<WORKSPACE>[\\/]+/gu, '').replace(/[\\/]+/gu, '/').toLowerCase();
  return normalize(left) === normalize(right);
}

export function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export function fileExtension(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export type FileViewKind = 'markdown' | 'html' | 'pdf' | 'image' | 'code';

/** How the Files section shows a path before reading it; the read result can still refine it. */
export function fileViewKind(path: string): FileViewKind {
  const extension = fileExtension(path);
  if (extension === 'md' || extension === 'markdown' || extension === 'mdx') return 'markdown';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  return 'code';
}

/** The fence language for a file's extension, as the chat's code blocks use it. */
export function fileLanguage(path: string): string | undefined {
  const extension = fileExtension(path);
  if (!extension) return undefined;
  const name = fileName(path).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  return extension;
}
