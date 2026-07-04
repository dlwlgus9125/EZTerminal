/**
 * Pratt parser behind a `Parser` interface (architecture §6).
 *
 * The grammar is small, so a hand-written recursive parser with a Pratt loop
 * for the comparison expressions is plenty. The `Parser` interface is the seam:
 * a future Chevrotain-based grammar (when parse-errors + syntax highlighting +
 * completion share one source) can drop in without touching callers.
 */

import { ParseError } from './errors';
import type { ComparisonOp } from './value';
import { tokenize } from './lexer';
import type { Token, TokenType } from './lexer';
import type {
  Arg,
  BinaryExpression,
  Command,
  EnvAssignStatement,
  Expression,
  LetStatement,
  Pipeline,
  Statement,
} from './ast';

export interface Parser {
  parse(input: string): Statement;
}

const COMPARISON_OPS = new Set<string>(['==', '!=', '>', '>=', '<', '<=']);
// All comparison operators share one (low) binding power; they are left-assoc.
const COMPARISON_BP = 10;

/** Token types that can begin a literal value (for flag value capture). */
const VALUE_LITERAL_TYPES = new Set<TokenType>(['number', 'filesize', 'string', 'bool', 'null']);

class PrattParser implements Parser {
  private tokens: Token[] = [];
  private pos = 0;
  private source = '';

  parse(input: string): Statement {
    this.source = input;
    this.tokens = tokenize(input);
    this.pos = 0;

    const statement = this.parseStatement();
    this.expect('eof');
    return statement;
  }

  // ── cursor helpers ───────────────────────────────────────────────────────────

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new ParseError(
        `expected ${type} but found ${describeToken(token)}`,
        { start: token.start, end: token.end },
        this.source,
      );
    }
    return this.advance();
  }

  // ── grammar ────────────────────────────────────────────────────────────────

  private parseStatement(): Statement {
    const token = this.peek();
    // `!cmd ...` — force a single external program to render as a full xterm
    // block (adaptive-render override, Phase 3). Execution is always PTY for a
    // bare single external command regardless of `!` (evaluate.ts). The sigil is
    // only valid on a standalone command, never a pipeline.
    if (token.type === 'bang') {
      this.advance();
      const pipeline = this.parsePipeline();
      if (pipeline.commands.length !== 1) {
        throw new ParseError(
          "'!' (force xterm) applies to a single command, not a pipeline",
          { start: token.start, end: this.tokens[this.pos - 1].end },
          this.source,
        );
      }
      return { ...pipeline, forceXterm: true };
    }
    // `let <name> = <expr>` — a complete statement, never piped.
    if (token.type === 'word' && token.text === 'let') {
      return this.parseLet();
    }
    // `$env.NAME = <expr>` — env assignment (distinguished from a `$env.NAME`
    // read by the following `=`). A bare `$env.NAME` is only valid in expression
    // position, so at statement start it must be an assignment.
    if (token.type === 'env-var' && this.tokens[this.pos + 1]?.type === 'assign') {
      return this.parseEnvAssign();
    }
    return this.parsePipeline();
  }

  private parseLet(): LetStatement {
    const letTok = this.advance(); // 'let'
    const nameTok = this.peek();
    if (nameTok.type !== 'word') {
      throw new ParseError(
        `expected a variable name after 'let' but found ${describeToken(nameTok)}`,
        { start: nameTok.start, end: nameTok.end },
        this.source,
      );
    }
    this.advance();
    this.expect('assign');
    const value = this.parseExpression(0);
    return {
      type: 'let',
      name: nameTok.text,
      nameSpan: { start: nameTok.start, end: nameTok.end },
      value,
      span: { start: letTok.start, end: value.span.end },
    };
  }

  private parseEnvAssign(): EnvAssignStatement {
    const envTok = this.advance(); // env-var, text = NAME
    this.expect('assign');
    const value = this.parseExpression(0);
    return {
      type: 'env-assign',
      name: envTok.text,
      nameSpan: { start: envTok.start, end: envTok.end },
      value,
      span: { start: envTok.start, end: value.span.end },
    };
  }

  private parsePipeline(): Pipeline {
    const commands: Command[] = [this.parseCommand()];
    while (this.peek().type === 'pipe') {
      this.advance();
      commands.push(this.parseCommand());
    }
    return { type: 'pipeline', commands };
  }

  private parseCommand(): Command {
    const name = this.peek();
    if (name.type !== 'word') {
      throw new ParseError(
        `expected a command name but found ${describeToken(name)}`,
        { start: name.start, end: name.end },
        this.source,
      );
    }
    this.advance();

    const args: Arg[] = [];
    while (!this.atCommandBoundary()) {
      args.push(this.parseArg());
    }

    return {
      type: 'command',
      name: name.text,
      nameSpan: { start: name.start, end: name.end },
      args,
    };
  }

  private atCommandBoundary(): boolean {
    const t = this.peek().type;
    return t === 'pipe' || t === 'eof' || t === 'rparen';
  }

  private parseArg(): Arg {
    const token = this.peek();
    if (token.type === 'flag-long' || token.type === 'flag-short') {
      this.advance();
      const short = token.type === 'flag-short';
      let value: Expression | undefined;
      // A flag may take a space-separated literal value (`--out file.txt`).
      if (VALUE_LITERAL_TYPES.has(this.peek().type)) {
        value = this.parsePrimary();
      }
      return {
        kind: 'flag',
        name: token.text,
        short,
        value,
        span: { start: token.start, end: this.tokens[this.pos - 1].end },
      };
    }
    return { kind: 'positional', expr: this.parseExpression(0) };
  }

  // ── Pratt expression parsing ─────────────────────────────────────────────────

  private parseExpression(minBp: number): Expression {
    let left = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (token.type !== 'op' || !COMPARISON_OPS.has(token.text)) break;
      if (COMPARISON_BP < minBp) break;
      this.advance();
      const right = this.parseExpression(COMPARISON_BP + 1);
      const binary: BinaryExpression = {
        type: 'binary',
        op: token.text as ComparisonOp,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      };
      left = binary;
    }
    return left;
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    const span = { start: token.start, end: token.end };
    switch (token.type) {
      case 'number':
        this.advance();
        return { type: 'number', value: token.numeric, span };
      case 'filesize':
        this.advance();
        return { type: 'filesize', bytes: token.numeric, span };
      case 'string':
        this.advance();
        return { type: 'string', value: token.text, span };
      case 'bool':
        this.advance();
        return { type: 'bool', value: token.text === 'true', span };
      case 'null':
        this.advance();
        return { type: 'null', span };
      case 'word':
        this.advance();
        return { type: 'identifier', name: token.text, span };
      case 'var':
        this.advance();
        return { type: 'variable', name: token.text, span };
      case 'env-var':
        this.advance();
        return { type: 'env', name: token.text, span };
      case 'lparen': {
        this.advance();
        const inner = this.parseExpression(0);
        this.expect('rparen');
        return inner;
      }
      default:
        throw new ParseError(
          `expected an expression but found ${describeToken(token)}`,
          span,
          this.source,
        );
    }
  }
}

function describeToken(token: Token): string {
  if (token.type === 'eof') return 'end of input';
  return `'${token.text}'`;
}

/** Factory for the default parser implementation. */
export function createParser(): Parser {
  return new PrattParser();
}

/** Convenience: parse a single command line into a Statement AST. */
export function parse(input: string): Statement {
  return new PrattParser().parse(input);
}
