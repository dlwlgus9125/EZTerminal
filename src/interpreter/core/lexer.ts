/**
 * Hand-written lexer (architecture §6).
 *
 * Produces a flat token stream with source spans. No regex scanning — a simple
 * char cursor keeps positions exact for friendly parse errors.
 *
 * Notable rules:
 *   - Bare words may contain hyphens in the middle (`sort-by`, `gen-rows`) but
 *     never start with one — a leading `-`/`--` begins a flag. A lone `-` at a
 *     boundary is a bare word (e.g. `cd -`). Words may also contain path
 *     characters (`. / \ : ~`) so `cd ..`, `cd src/sub` and `node foo.bat` lex
 *     as a single word/path token.
 *   - A number immediately followed by a known unit (`100mb`) lexes as one
 *     `filesize` token; trailing letters that are not a unit are an error.
 *   - `$name` is a variable reference; `$env.NAME` is an env access.
 *   - Comparison operators: == != > >= < <= ; `=` alone is assignment (`let`).
 */

import { ParseError } from './errors';
import { filesizeBytes, isFilesizeUnit } from './value';

export type TokenType =
  | 'word'
  | 'number'
  | 'filesize'
  | 'string'
  | 'bool'
  | 'null'
  | 'pipe'
  | 'op'
  | 'assign'
  | 'bang'
  | 'var'
  | 'env-var'
  | 'flag-long'
  | 'flag-short'
  | 'lparen'
  | 'rparen'
  | 'eof';

interface TokenBase {
  /** The lexeme text (decoded for strings; numeric text for numbers). */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Tokens whose value IS a number — `numeric` is required (the lexer always
 * computes it at tokenization time), so consumers never need a fallback. */
export interface NumericToken extends TokenBase {
  readonly type: 'number' | 'filesize';
  /** For `number` tokens: the parsed value. For `filesize`: byte count. */
  readonly numeric: number;
}

export interface PlainToken extends TokenBase {
  readonly type: Exclude<TokenType, NumericToken['type']>;
}

export type Token = NumericToken | PlainToken;

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isWordStart = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
const isWordPart = (ch: string): boolean => isWordStart(ch) || isDigit(ch) || ch === '-';
/** Filesystem-path characters that may appear inside a bare word/path token.
 * `@` additionally lets `user@host` (ssh-connect, E5) lex as one word. */
const isPathChar = (ch: string): boolean =>
  ch === '.' || ch === '/' || ch === '\\' || ch === ':' || ch === '~' || ch === '@';
const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  const span = (start: number, end: number) => ({ start, end });

  while (i < n) {
    const ch = source[i];

    if (isSpace(ch)) {
      i += 1;
      continue;
    }

    const start = i;

    // Pipe
    if (ch === '|') {
      tokens.push({ type: 'pipe', text: '|', start, end: i + 1 });
      i += 1;
      continue;
    }

    // Parentheses
    if (ch === '(') {
      tokens.push({ type: 'lparen', text: '(', start, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', text: ')', start, end: i + 1 });
      i += 1;
      continue;
    }

    // Assignment (=) vs equality (==)
    if (ch === '=') {
      if (source[i + 1] === '=') {
        tokens.push({ type: 'op', text: '==', start, end: i + 2 });
        i += 2;
      } else {
        tokens.push({ type: 'assign', text: '=', start, end: i + 1 });
        i += 1;
      }
      continue;
    }
    // Inequality (`!=`) or the interactive-run sigil (`!cmd`).
    if (ch === '!') {
      if (source[i + 1] === '=') {
        tokens.push({ type: 'op', text: '!=', start, end: i + 2 });
        i += 2;
        continue;
      }
      // A lone `!` is the interactive-run sigil (run a single external program as
      // a PTY/TUI). Its valid position (statement start, single command) is
      // enforced by the parser — the lexer stays context-free.
      tokens.push({ type: 'bang', text: '!', start, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      if (source[i + 1] === '=') {
        tokens.push({ type: 'op', text: ch + '=', start, end: i + 2 });
        i += 2;
      } else {
        tokens.push({ type: 'op', text: ch, start, end: i + 1 });
        i += 1;
      }
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let value = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          const next = source[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= n) {
        throw new ParseError('unterminated string literal', span(start, n), source);
      }
      i += 1; // closing quote
      tokens.push({ type: 'string', text: value, start, end: i });
      continue;
    }

    // Flags
    if (ch === '-') {
      const long = source[i + 1] === '-';
      const dashCount = long ? 2 : 1;
      let j = i + dashCount;
      if (!(j < n && isWordStart(source[j]))) {
        // A lone `-` at a boundary is a bare word (e.g. `cd -`), not a flag.
        if (!long && (j >= n || isSpace(source[j]) || source[j] === '|')) {
          tokens.push({ type: 'word', text: '-', start, end: i + 1 });
          i += 1;
          continue;
        }
        throw new ParseError('expected a flag name after dash', span(start, j), source);
      }
      while (j < n && isWordPart(source[j])) j += 1;
      const name = source.slice(i + dashCount, j);
      tokens.push({ type: long ? 'flag-long' : 'flag-short', text: name, start, end: j });
      i = j;
      continue;
    }

    // Variables ($name) and env access ($env.NAME)
    if (ch === '$') {
      let j = i + 1;
      if (!(j < n && isWordStart(source[j]))) {
        throw new ParseError('expected a variable name after $', span(start, j), source);
      }
      while (j < n && isWordPart(source[j])) j += 1;
      const head = source.slice(i + 1, j);
      if (head === 'env' && source[j] === '.') {
        let k = j + 1;
        if (!(k < n && isWordStart(source[k]))) {
          throw new ParseError('expected an environment variable name after $env.', span(start, k), source);
        }
        while (k < n && isWordPart(source[k])) k += 1;
        tokens.push({ type: 'env-var', text: source.slice(j + 1, k), start, end: k });
        i = k;
        continue;
      }
      tokens.push({ type: 'var', text: head, start, end: j });
      i = j;
      continue;
    }

    // Numbers / filesizes
    if (isDigit(ch)) {
      let j = i + 1;
      while (j < n && isDigit(source[j])) j += 1;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        j += 1;
        while (j < n && isDigit(source[j])) j += 1;
      }
      const numText = source.slice(i, j);
      // Optional unit suffix glued to the number.
      let unitEnd = j;
      while (unitEnd < n && ((source[unitEnd] >= 'a' && source[unitEnd] <= 'z') || (source[unitEnd] >= 'A' && source[unitEnd] <= 'Z'))) {
        unitEnd += 1;
      }
      if (unitEnd > j) {
        const unit = source.slice(j, unitEnd);
        if (!isFilesizeUnit(unit)) {
          throw new ParseError(`unknown size unit: ${unit}`, span(j, unitEnd), source);
        }
        const bytes = filesizeBytes(Number.parseFloat(numText), unit);
        tokens.push({ type: 'filesize', text: source.slice(i, unitEnd), numeric: bytes, start, end: unitEnd });
        i = unitEnd;
        continue;
      }
      tokens.push({ type: 'number', text: numText, numeric: Number.parseFloat(numText), start, end: j });
      i = j;
      continue;
    }

    // Words (command names, column references, keywords) and bare paths.
    if (isWordStart(ch) || ch === '.' || ch === '/' || ch === '\\' || ch === '~') {
      let j = i + 1;
      while (j < n && (isWordPart(source[j]) || isPathChar(source[j]))) j += 1;
      const text = source.slice(i, j);
      if (text === 'true' || text === 'false') {
        tokens.push({ type: 'bool', text, start, end: j });
      } else if (text === 'null') {
        tokens.push({ type: 'null', text, start, end: j });
      } else {
        tokens.push({ type: 'word', text, start, end: j });
      }
      i = j;
      continue;
    }

    throw new ParseError(`unexpected character '${ch}'`, span(start, i + 1), source);
  }

  tokens.push({ type: 'eof', text: '', start: n, end: n });
  return tokens;
}
