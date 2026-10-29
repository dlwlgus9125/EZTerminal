import { reviewLines, type RecordedFileChange, type ReviewLine } from '../../shared/conversation-changes';
import { relocateExcerpt, type ReviewFinding } from '../../shared/review-findings';
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

/** A changed file's path (repository-relative from git, often absolute from the AI) names the finding's file. */
export function isFindingFile(path: string, findingFile: string, workspaceRoot?: string): boolean {
  return samePath(path, findingFile) || samePath(path, resolveWorkspacePath(findingFile, workspaceRoot) ?? findingFile);
}

/** Where a review problem is in one recorded patch. */
export type FindingPlace =
  /** `index`: the first new-side patch line it covers; `moved`: its line now, when the review's lines moved. */
  | { readonly state: 'found'; readonly index: number; readonly moved?: number }
  /** The patch shows the problem's line, but not the code the review read there: it is never anchored on it. */
  | { readonly state: 'missing' }
  /** The patch does not show the problem's line (or the review gave none). */
  | { readonly state: 'outside' };

/**
 * Where a finding's line is in a patch. With the lines the review read (its excerpt), the finding
 * follows them when they moved, and is `missing` when the patch shows that place holding other code:
 * a line number alone never anchors it there. Without an excerpt, the line number is all there is.
 */
export function locateFinding(change: RecordedFileChange, finding: Pick<ReviewFinding, 'line' | 'endLine' | 'excerpt'>): FindingPlace {
  if (finding.line === undefined) return { state: 'outside' };
  const lines = reviewLines(change);
  let first = finding.line;
  let moved: number | undefined;
  if (finding.excerpt && change.coverage === 'patch') {
    // The new side as far as the patch shows it; lines between hunks stay unknown.
    const current: (string | undefined)[] = [];
    for (const line of lines) {
      if (line.after !== undefined && (line.kind === 'add' || line.kind === 'context')) current[line.after - 1] = line.text.slice(1);
    }
    const { excerpt } = finding;
    const where = relocateExcerpt(excerpt, current as string[]);
    if (where.state === 'moved') {
      moved = finding.line + (where.line - excerpt.startLine);
      first = moved;
    } else if (where.state === 'missing') {
      if (current[finding.line - 1] === undefined) return { state: 'outside' };
      // Some of the review's lines are outside the patch: what it does show must still be the review's code.
      const differs = excerpt.lines.some((text, offset) => {
        const now = current[excerpt.startLine - 1 + offset];
        return now !== undefined && now !== text;
      });
      if (differs) return { state: 'missing' };
    }
  }
  const last = finding.endLine !== undefined && finding.endLine > finding.line ? first + (finding.endLine - finding.line) : first;
  const index = lines.findIndex((line) => (line.kind === 'add' || line.kind === 'context') && line.after !== undefined && line.after >= first && line.after <= last);
  return index < 0 ? { state: 'outside' } : { state: 'found', index, ...(moved !== undefined && moved !== finding.line ? { moved } : {}) };
}
