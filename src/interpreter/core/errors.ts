/**
 * Core error types (architecture §6 — friendly parse errors).
 *
 * Both errors carry a source position so callers can render friendly,
 * located messages. ParseError computes line/column from the raw source at
 * construction time so the message is self-contained.
 */

/** A source span [start, end) measured in UTF-16 code unit offsets. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** 1-based line/column derived from an offset into the source. */
export interface LineCol {
  readonly line: number;
  readonly column: number;
}

/** Translate an offset into a 1-based line/column for friendly messages. */
export function offsetToLineCol(source: string, offset: number): LineCol {
  let line = 1;
  let column = 1;
  const clamped = Math.max(0, Math.min(offset, source.length));
  for (let i = 0; i < clamped; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** Raised by the lexer/parser for malformed input. */
export class ParseError extends Error {
  readonly span: Span;
  readonly lineCol: LineCol;

  constructor(message: string, span: Span, source: string) {
    const lineCol = offsetToLineCol(source, span.start);
    super(`Parse error at line ${lineCol.line}, column ${lineCol.column}: ${message}`);
    this.name = 'ParseError';
    this.span = span;
    this.lineCol = lineCol;
  }
}

/** Raised during evaluation (unknown command/flag, type mismatch, bad arg). */
export class EvalError extends Error {
  readonly span?: Span;

  constructor(message: string, span?: Span) {
    super(message);
    this.name = 'EvalError';
    this.span = span;
  }
}
