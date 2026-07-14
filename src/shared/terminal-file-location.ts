import type { ExecutionKind } from './ipc';

export interface TerminalFileLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export interface TerminalFileLocationRequest extends TerminalFileLocation {
  readonly cwd: string;
  readonly executionKind: ExecutionKind;
}

export type TerminalFileLocationResult =
  | {
      readonly ok: true;
      readonly path: string;
      /** Opaque, short-lived, one-shot authorization for this terminal preview. */
      readonly capability: string;
      readonly line?: number;
      readonly column?: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'remote' | 'invalid' | 'outside-workspace' | 'missing' | 'not-file' | 'unreadable';
    };

export interface TerminalFileLinkMatch extends TerminalFileLocation {
  /** Zero-based UTF-16 indices into the rendered terminal line. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const LOCATION_TOKEN = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/]|(?:[\p{L}\p{N}_.-]+[\\/])+)[^\s"'<>|]+/gu;
const TRAILING_PUNCTUATION = /[),.;\]}]+$/;
const LINE_COLUMN = /:(\d+)(?::(\d+))?$/;

/** Find path-shaped output tokens; existence/containment is intentionally main-owned. */
export function findTerminalFileLinks(lineText: string): readonly TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  for (const rawMatch of lineText.matchAll(LOCATION_TOKEN)) {
    const start = rawMatch.index;
    if (rawMatch[0].includes('://')) continue;
    if (start > 0 && lineText[start - 1] === ':' && rawMatch[0].startsWith('/')) continue;
    const text = rawMatch[0].replace(TRAILING_PUNCTUATION, '');
    if (!text || text === '.' || text === '..') continue;
    let path = text;
    let line: number | undefined;
    let column: number | undefined;
    const suffix = LINE_COLUMN.exec(text);
    if (suffix) {
      const parsedLine = Number(suffix[1]);
      const parsedColumn = suffix[2] === undefined ? undefined : Number(suffix[2]);
      if (Number.isSafeInteger(parsedLine) && parsedLine > 0 &&
          (parsedColumn === undefined || (Number.isSafeInteger(parsedColumn) && parsedColumn > 0))) {
        line = parsedLine;
        column = parsedColumn;
        path = text.slice(0, suffix.index);
      }
    }
    if (!path) continue;
    matches.push({ start, end: start + text.length, text, path, line, column });
  }
  return matches;
}

/** Resolve a click/caret offset in a potentially multi-line plain terminal
 * buffer. Keeping this text-only makes the plain renderer's DOM caret lookup
 * testable without trusting or rewriting ANSI-produced markup. */
export function findTerminalFileLinkAtOffset(
  text: string,
  offset: number,
): TerminalFileLinkMatch | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const nextNewline = text.indexOf('\n', offset);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  const lineOffset = offset - lineStart;
  return findTerminalFileLinks(text.slice(lineStart, lineEnd)).find(
    (match) => lineOffset >= match.start && lineOffset < match.end,
  ) ?? null;
}
