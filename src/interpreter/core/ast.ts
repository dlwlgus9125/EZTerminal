/**
 * AST node definitions (architecture §6).
 *
 * Grammar (Phase 1):
 *   statement := let | env-assign | '!'? pipeline
 *   let       := 'let' WORD '=' expression           (writes a session variable)
 *   env-assign:= ENV-VAR '=' expression               ($env.NAME = expression)
 *   pipeline  := command ('|' command)*               ('!' prefix = force xterm render,
 *                                                       single command only)
 *   command  := WORD arg*
 *   arg      := flag | expression          (positional expressions)
 *   flag     := ('--' WORD | '-' WORD) value?
 *   expression handles comparisons for `where` (Pratt-parsed) plus variable
 *   ($name) and env ($env.NAME) references:
 *     size > 100mb | name == "x" | n >= 3 | n > $threshold | $env.PATH
 *
 * Every node keeps a source span for friendly errors + future highlighting.
 */

import type { Span } from './errors';
import type { ComparisonOp } from './value';

export interface NumberLiteral {
  readonly type: 'number';
  readonly value: number;
  readonly span: Span;
}
export interface FilesizeLiteral {
  readonly type: 'filesize';
  readonly bytes: number;
  readonly span: Span;
}
export interface StringLiteral {
  readonly type: 'string';
  readonly value: string;
  readonly span: Span;
}
export interface BoolLiteral {
  readonly type: 'bool';
  readonly value: boolean;
  readonly span: Span;
}
export interface NullLiteral {
  readonly type: 'null';
  readonly span: Span;
}
/** A bare word in expression position — a column reference. */
export interface Identifier {
  readonly type: 'identifier';
  readonly name: string;
  readonly span: Span;
}
/** A `$name` reference — resolved from the session variables. */
export interface VariableExpr {
  readonly type: 'variable';
  readonly name: string;
  readonly span: Span;
}
/** A `$env.NAME` reference — resolved from the session env (merged over process env). */
export interface EnvExpr {
  readonly type: 'env';
  readonly name: string;
  readonly span: Span;
}
export interface BinaryExpression {
  readonly type: 'binary';
  readonly op: ComparisonOp;
  readonly left: Expression;
  readonly right: Expression;
  readonly span: Span;
}

export type Expression =
  | NumberLiteral
  | FilesizeLiteral
  | StringLiteral
  | BoolLiteral
  | NullLiteral
  | Identifier
  | VariableExpr
  | EnvExpr
  | BinaryExpression;

export interface FlagArg {
  readonly kind: 'flag';
  readonly name: string;
  /** True for short flags (`-r`), false for long flags (`--reverse`). */
  readonly short: boolean;
  /** Optional space-separated literal value (`--out file.txt`). */
  readonly value?: Expression;
  readonly span: Span;
}

export interface PositionalArg {
  readonly kind: 'positional';
  readonly expr: Expression;
}

export type Arg = FlagArg | PositionalArg;

export interface Command {
  readonly type: 'command';
  readonly name: string;
  readonly nameSpan: Span;
  readonly args: Arg[];
}

export interface Pipeline {
  readonly type: 'pipeline';
  readonly commands: Command[];
  /**
   * True when prefixed with `!` — force a full xterm render for a single external
   * command, bypassing adaptive-render downgrade (Phase 3). Execution is ALWAYS a
   * PTY for a single, non-builtin command regardless of this flag (auto PTY
   * routing, evaluate.ts); `!` only overrides the render decision. Only valid on a
   * standalone command (the parser rejects `!a | b`); the evaluator rejects `!` on
   * a builtin.
   */
  readonly forceXterm?: boolean;
}

/** `let <name> = <expr>` — writes a session variable, produces a confirmation. */
export interface LetStatement {
  readonly type: 'let';
  readonly name: string;
  readonly nameSpan: Span;
  readonly value: Expression;
  readonly span: Span;
}

/** `$env.<NAME> = <expr>` — writes a session env override, produces a confirmation. */
export interface EnvAssignStatement {
  readonly type: 'env-assign';
  readonly name: string;
  readonly nameSpan: Span;
  readonly value: Expression;
  readonly span: Span;
}

/** A complete parsed command line: a pipeline or a top-level assignment statement. */
export type Statement = Pipeline | LetStatement | EnvAssignStatement;
