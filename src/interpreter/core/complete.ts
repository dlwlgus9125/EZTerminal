/**
 * Tab completion for the structured shell's command line: which word the caret
 * is in, what it could become (builtins, executables on PATH, files and
 * folders), and how to write each so the lexer reads it back as one word.
 *
 * Lexer rules this follows (`lexer.ts`): a bare word starts with a letter, `_`,
 * `.`, `/`, `\` or `~` and continues with letters, digits and `- _ . / \ : ~ @`;
 * anything else needs quotes, and inside quotes `\` escapes the next character
 * (`\n` and `\t` included), so a quoted Windows path doubles its backslashes.
 * There is no `~` expansion, so none is offered. Pure apart from the source.
 */

import path from 'node:path';

import {
  TERMINAL_COMPLETION_MAX_CANDIDATES,
  type TerminalCompletionCandidate,
  type TerminalCompletionKind,
  type TerminalCompletionResult,
} from '../../shared/terminal-completion';

export interface CompletionWord {
  /** First word of a command (line start, after `|`, `(` or the `!` sigil) or a later one. */
  readonly position: 'command' | 'argument';
  /** The command's own name when completing one of its arguments. */
  readonly command?: string;
  /** The word up to the caret as the shell will read it (quotes removed, escapes applied). */
  readonly prefix: string;
  /** Where the word starts in the line, its opening quote included. */
  readonly start: number;
  /** The quote the word was opened with. */
  readonly quote?: '"' | "'";
  /** The caret is inside that quote (not closed before it). */
  readonly open?: boolean;
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/** The word the caret ends, or null where nothing can be completed (a flag, a variable). */
export function completionWord(line: string, caret: number): CompletionWord | null {
  const end = Math.max(0, Math.min(caret, line.length));
  let segment: string[] = [];
  let start = -1;
  let decoded = '';
  let quote: '"' | "'" | null = null;
  let opening: '"' | "'" | undefined;
  for (let index = 0; index < end; index += 1) {
    const ch = line[index]!;
    if (quote) {
      if (ch === '\\' && index + 1 < end) {
        const next = line[index + 1]!;
        decoded += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        index += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        decoded += ch;
      }
      continue;
    }
    if (isSpace(ch) || ch === ')') {
      if (start >= 0) segment.push(decoded);
      start = -1;
      decoded = '';
      opening = undefined;
      continue;
    }
    if (ch === '|' || ch === '(') {
      segment = [];
      start = -1;
      decoded = '';
      opening = undefined;
      continue;
    }
    if (ch === '!' && start < 0 && segment.length === 0) continue;
    if (ch === '"' || ch === "'") {
      if (start < 0) {
        start = index;
        opening = ch;
      }
      quote = ch;
      continue;
    }
    if (start < 0) start = index;
    decoded += ch;
  }
  if (start < 0) start = end;
  if (decoded.startsWith('-') || decoded.startsWith('$')) return null;
  return {
    position: segment.length === 0 ? 'command' : 'argument',
    ...(segment.length > 0 ? { command: segment[0]!.toLowerCase() } : {}),
    prefix: decoded,
    start,
    ...(opening ? { quote: opening } : {}),
    ...(quote ? { open: true } : {}),
  };
}

const BARE = /^[A-Za-z_./\\~][A-Za-z0-9_\-./\\:~@]*$/u;

function needsQuote(value: string): boolean {
  return !BARE.test(value) || value === 'true' || value === 'false' || value === 'null';
}

/** Write `value` so the lexer reads it back as one word; `open` leaves a quote open. */
export function encodeWord(value: string, options: { readonly open: boolean; readonly quote?: '"' | "'" }): string {
  const quote = options.quote ?? (needsQuote(value) ? '"' : undefined);
  if (!quote) return value;
  const escaped = value.replace(/\\/gu, '\\\\').replace(quote === '"' ? /"/gu : /'/gu, `\\${quote}`);
  return `${quote}${escaped}${options.open ? '' : quote}`;
}

export interface CompletionEntry {
  readonly name: string;
  readonly directory: boolean;
}

/** What the completer may look at; the interpreter backs it with the session's folder and environment. */
export interface CompletionSource {
  readonly cwd: string;
  readonly builtins: readonly string[];
  /** Executable extensions (PATHEXT), lower case with the dot. */
  readonly executableExtensions: readonly string[];
  /** Entries of an absolute folder, or null when it cannot be read. */
  listDirectory(absolute: string): Promise<readonly CompletionEntry[] | null>;
  /** Executable names on PATH, extension removed. */
  pathExecutables(): Promise<readonly string[]>;
}

interface Match {
  readonly value: string;
  readonly label: string;
  readonly kind: TerminalCompletionKind;
}

const lower = (value: string): string => value.toLowerCase();
const startsWithFolded = (value: string, prefix: string): boolean => lower(value).startsWith(lower(prefix));
const DRIVE_ONLY = /^[A-Za-z]:$/u;

function isPathLike(prefix: string): boolean {
  return prefix.includes('\\') || prefix.includes('/') || prefix.startsWith('.') || /^[A-Za-z]:/u.test(prefix);
}

async function pathMatches(word: CompletionWord, source: CompletionSource): Promise<Match[]> {
  const prefix = word.prefix;
  if (DRIVE_ONLY.test(prefix)) return [{ value: `${prefix.toUpperCase()}\\`, label: `${prefix.toUpperCase()}\\`, kind: 'drive' }];
  const cut = Math.max(prefix.lastIndexOf('\\'), prefix.lastIndexOf('/'));
  const folder = cut >= 0 ? prefix.slice(0, cut + 1) : '';
  const name = prefix.slice(cut + 1);
  // Network shares can stall; they are never listed.
  if (folder.startsWith('\\\\') || folder.startsWith('//')) return [];
  const separator = folder.includes('/') && !folder.includes('\\') ? '/' : '\\';
  const absolute = folder ? path.win32.resolve(source.cwd, folder) : source.cwd;
  const entries = await source.listDirectory(absolute);
  if (!entries) return [];
  const foldersOnly = word.position === 'argument' && word.command === 'cd';
  const executablesOnly = word.position === 'command';
  const showHidden = name.startsWith('.');
  return entries
    .filter((entry) => startsWithFolded(entry.name, name) && (showHidden || !entry.name.startsWith('.')))
    .filter((entry) => entry.directory || (!foldersOnly && (!executablesOnly
      || source.executableExtensions.includes(lower(path.win32.extname(entry.name))))))
    .map((entry) => ({
      value: `${folder}${entry.name}${entry.directory ? separator : ''}`,
      label: `${entry.name}${entry.directory ? separator : ''}`,
      kind: entry.directory ? 'directory' as const : 'file' as const,
    }))
    .sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory')
      || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }));
}

async function commandMatches(word: CompletionWord, source: CompletionSource): Promise<Match[]> {
  const seen = new Set<string>();
  const matches: Match[] = [];
  for (const name of [...source.builtins].sort()) {
    if (!startsWithFolded(name, word.prefix) || seen.has(lower(name))) continue;
    seen.add(lower(name));
    matches.push({ value: name, label: name, kind: 'builtin' });
  }
  const executables = (await source.pathExecutables())
    .filter((name) => startsWithFolded(name, word.prefix) && !seen.has(lower(name)))
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  for (const name of executables) {
    if (seen.has(lower(name))) continue;
    seen.add(lower(name));
    matches.push({ value: name, label: name, kind: 'executable' });
  }
  return matches;
}

function commonPrefix(values: readonly string[]): string {
  let common = values[0] ?? '';
  for (const value of values.slice(1)) {
    let length = 0;
    while (length < common.length && length < value.length && lower(common[length]!) === lower(value[length]!)) length += 1;
    common = common.slice(0, length);
  }
  return common;
}

/**
 * A quoted word is always closed, so the line runs as it stands. A folder (or a
 * shared part still being typed) keeps the caret inside the closing quote, so
 * typing and Tab go on into the folder.
 */
function written(value: string, quote: CompletionWord['quote'], stayInside: boolean): { readonly text: string; readonly caretBack?: number } {
  const text = encodeWord(value, { open: false, ...(quote ? { quote } : {}) });
  return stayInside && text !== value ? { text, caretBack: 1 } : { text };
}

function candidateOf(match: Match, quote: CompletionWord['quote']): TerminalCompletionCandidate {
  const folder = match.kind === 'directory' || match.kind === 'drive';
  const { text, caretBack } = written(match.value, quote, folder);
  return { label: match.label, kind: match.kind, insertText: folder ? text : `${text} `, ...(caretBack ? { caretBack } : {}) };
}

/** Complete the word that ends at `caret`. */
export async function completeLine(line: string, caret: number, source: CompletionSource): Promise<TerminalCompletionResult> {
  const word = completionWord(line, caret);
  if (!word) return { ok: false, reason: 'none' };
  const matches = word.position === 'command' && !isPathLike(word.prefix)
    ? await commandMatches(word, source)
    : await pathMatches(word, source);
  if (matches.length === 0) return { ok: false, reason: 'none' };
  const shown = matches.slice(0, TERMINAL_COMPLETION_MAX_CANDIDATES);
  const candidates = shown.map((match) => candidateOf(match, word.quote));
  // Inside a quote that closes right after the caret, the closing quote is replaced too (the new text closes it).
  const replaceEnd = word.open && word.quote && line[caret] === word.quote ? caret + 1 : caret;
  let commonText = line.slice(word.start, replaceEnd);
  let commonCaretBack: number | undefined = replaceEnd - caret || undefined;
  if (matches.length === 1) {
    commonText = candidates[0]!.insertText;
    commonCaretBack = candidates[0]!.caretBack;
  } else {
    const common = commonPrefix(matches.map((match) => match.value));
    if (common.length > word.prefix.length) {
      const shared = written(common, word.quote, true);
      commonText = shared.text;
      commonCaretBack = shared.caretBack;
    }
  }
  return {
    ok: true,
    replaceStart: word.start,
    replaceEnd,
    commonText,
    ...(commonCaretBack ? { commonCaretBack } : {}),
    candidates,
    truncated: matches.length > shown.length,
  };
}
