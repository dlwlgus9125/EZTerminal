/**
 * Interpreter core — public API surface.
 *
 * The clean seams T5 (credit backpressure + ResultStore) and T6 (table UI)
 * plug into:
 *   - `parse`    : text -> Pipeline AST (behind the `Parser` interface)
 *   - `evaluate` : Pipeline + context -> PipelineData (lazy, cancellable)
 *   - the command registry (declarative defs + handlers)
 *   - the discriminated `PipelineData` / `RuntimeValue` value model
 */

import { createDefaultRegistry } from './builtins';
import { evaluateWithRegistry } from './evaluate';
import type { EvalContext } from './types';
import type { Statement } from './ast';
import type { PipelineData } from './value';

export { createParser, parse } from './parser';
export type { Parser } from './parser';
export { createDefaultRegistry, BUILTIN_DEFS } from './builtins';
export { CommandRegistry } from './registry';
export { evalExpression, evaluateWithRegistry } from './evaluate';
export { ParseError, EvalError } from './errors';

export type {
  EvalContext,
  SessionState,
  ProcessInfo,
  CommandDef,
  CommandHandler,
  FlagDef,
  Invocation,
  InputKind,
  OutputKind,
  PositionalDef,
} from './types';
export type {
  Statement,
  Pipeline,
  LetStatement,
  EnvAssignStatement,
  Command,
  Expression,
  Arg,
} from './ast';
export {
  parseFilesize,
  filesizeBytes,
  compareValues,
  compareForSort,
  recordToJson,
  valueToJson,
  inferColumns,
  toRowIterable,
  ptyStreamData,
  scriptStreamData,
  sshStreamData,
  listStreamData,
  valueData,
  recordValue,
  nullValue,
  boolValue,
  numberValue,
  stringValue,
} from './value';
export type {
  RuntimeValue,
  ScalarValue,
  RecordValue,
  TableValue,
  ValueKind,
  PipelineData,
  ListStreamData,
  ValueData,
  ByteStreamData,
  PtyStreamData,
  PtyHandle,
  ScriptStreamData,
  SshStreamData,
  ColumnSchema,
  JsonValue,
  JsonRecord,
} from './value';

const defaultRegistry = createDefaultRegistry();

/**
 * Evaluate a parsed statement (pipeline / `let` / `$env` assignment) against the
 * default builtin registry. Returns a lazy PipelineData — pipeline rows execute
 * only when iterated; assignments mutate the session eagerly here.
 */
export function evaluate(statement: Statement, ctx: EvalContext): PipelineData {
  return evaluateWithRegistry(statement, ctx, defaultRegistry);
}
