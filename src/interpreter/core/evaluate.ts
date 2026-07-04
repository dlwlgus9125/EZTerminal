/**
 * Pipeline execution engine (architecture §4).
 *
 *   evaluate(pipeline, ctx) -> PipelineData
 *
 * Each command's handler receives the previous command's PipelineData as input
 * and returns a new PipelineData. Streaming operators wrap the input lazily;
 * buffering operators materialize it. Nothing is iterated here — the returned
 * PipelineData is consumed (and cancelled) by the caller.
 *
 * Argument validation uses Zod against the declarative CommandDef (arity, flag
 * names, valued-flag types) — once per dispatch, never per row.
 */

import { z } from 'zod';

import type { Command, Expression, Statement } from './ast';
import { EvalError } from './errors';
import type { CommandRegistry } from './registry';
import type { CommandDef, EvalContext, Invocation } from './types';
import {
  boolValue,
  compareValues,
  emptyListStream,
  filesizeValue,
  nullValue,
  numberValue,
  stringValue,
  valueData,
  valueToJson,
} from './value';
import type { PipelineData, RecordValue, RuntimeValue } from './value';

export type { EvalContext } from './types';

// ── expression evaluation ──────────────────────────────────────────────────────

/**
 * Evaluate an expression to a runtime value. `scope` supplies the current row
 * for column references inside `where` predicates; pass null in constant
 * contexts (where a bare identifier is an error).
 */
export function evalExpression(
  expr: Expression,
  scope: RecordValue | null,
  ctx: EvalContext,
): RuntimeValue {
  switch (expr.type) {
    case 'number':
      return numberValue(expr.value);
    case 'filesize':
      return filesizeValue(expr.bytes);
    case 'string':
      return stringValue(expr.value);
    case 'bool':
      return boolValue(expr.value);
    case 'null':
      return nullValue;
    case 'identifier': {
      if (!scope) {
        throw new EvalError(`unexpected column reference '${expr.name}'`, expr.span);
      }
      const field = scope.fields[expr.name];
      if (field === undefined) {
        throw new EvalError(`unknown column: ${expr.name}`, expr.span);
      }
      return field;
    }
    case 'variable': {
      const value = ctx.session.getVar(expr.name);
      if (value === undefined) {
        throw new EvalError(`undefined variable: $${expr.name}`, expr.span);
      }
      return value;
    }
    case 'env': {
      const raw = ctx.env[expr.name];
      if (raw === undefined) {
        throw new EvalError(`undefined environment variable: $env.${expr.name}`, expr.span);
      }
      return stringValue(raw);
    }
    case 'binary': {
      const left = evalExpression(expr.left, scope, ctx);
      const right = evalExpression(expr.right, scope, ctx);
      return boolValue(compareValues(left, right, expr.op));
    }
  }
}

// ── invocation building + argument validation (Zod) ─────────────────────────────

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}

function buildInvocation(def: CommandDef, command: Command, ctx: EvalContext): Invocation {
  const positionals: Expression[] = [];
  const flags = new Map<string, RuntimeValue | true>();

  // Index declared flags by long name and short alias.
  const byLong = new Map(def.flags.map((f) => [f.name, f]));
  const byShort = new Map(def.flags.filter((f) => f.short).map((f) => [f.short as string, f]));
  const seenFlagNames: string[] = [];

  for (const arg of command.args) {
    if (arg.kind === 'positional') {
      positionals.push(arg.expr);
      continue;
    }
    const def_ = arg.short ? byShort.get(arg.name) : byLong.get(arg.name);
    seenFlagNames.push(arg.name);
    if (!def_) continue; // reported by Zod validation below
    if (def_.type === 'boolean') {
      if (arg.value) {
        throw new EvalError(`flag --${def_.name} does not take a value`, arg.span);
      }
      flags.set(def_.name, true);
    } else {
      if (!arg.value) {
        throw new EvalError(`flag --${def_.name} requires a value`, arg.span);
      }
      flags.set(def_.name, evalExpression(arg.value, null, ctx));
    }
  }

  validateArgs(def, positionals.length, seenFlagNames);
  return { command, positionals, flags };
}

function validateArgs(def: CommandDef, positionalCount: number, flagNames: string[]): void {
  const required = def.positionals.filter((p) => p.required).length;
  const lastPositional = def.positionals[def.positionals.length - 1];
  const max = lastPositional?.variadic ? Number.POSITIVE_INFINITY : def.positionals.length;
  const allowed = new Set<string>();
  for (const f of def.flags) {
    allowed.add(f.name);
    if (f.short) allowed.add(f.short);
  }

  const schema = z
    .object({
      positionalCount: z
        .number()
        .min(required, {
          message: `${def.name} expects at least ${required} positional argument(s), got ${positionalCount}`,
        })
        .max(max, {
          message: `${def.name} expects at most ${max} positional argument(s), got ${positionalCount}`,
        }),
      flags: z.array(z.string()),
    })
    .superRefine((val, refineCtx) => {
      for (const name of val.flags) {
        if (!allowed.has(name)) {
          refineCtx.addIssue({ code: 'custom', message: `unknown flag for ${def.name}: ${name}` });
        }
      }
    });

  const result = schema.safeParse({ positionalCount, flags: flagNames });
  if (!result.success) {
    throw new EvalError(formatZodError(result.error));
  }
}

// ── statement dispatch ───────────────────────────────────────────────────────

/** A confirmation line for an assignment statement (rendered as a text block). */
function confirmation(text: string): PipelineData {
  return valueData(stringValue(text));
}

/** Coerce a runtime value to the string stored for an env override. */
function valueToEnvString(value: RuntimeValue, span?: { start: number; end: number }): string {
  switch (value.kind) {
    case 'string':
      return value.value;
    case 'number':
      return String(value.value);
    case 'bool':
      return String(value.value);
    case 'filesize':
      return String(value.bytes);
    default:
      throw new EvalError(`cannot assign a ${value.kind} to an environment variable`, span);
  }
}

/** Evaluate a statement against an explicit registry (used internally). */
export function evaluateWithRegistry(
  statement: Statement,
  ctx: EvalContext,
  registry: CommandRegistry,
): PipelineData {
  switch (statement.type) {
    case 'let': {
      const value = evalExpression(statement.value, null, ctx);
      ctx.session.setVar(statement.name, value);
      return confirmation(`${statement.name} = ${JSON.stringify(valueToJson(value))}`);
    }
    case 'env-assign': {
      const value = evalExpression(statement.value, null, ctx);
      const raw = valueToEnvString(value, statement.value.span);
      ctx.session.setEnv(statement.name, raw);
      return confirmation(`$env.${statement.name} = ${raw}`);
    }
    case 'pipeline':
      return evaluatePipeline(statement.commands, ctx, registry, statement.forceXterm);
  }
}

function evaluatePipeline(
  commands: Command[],
  ctx: EvalContext,
  registry: CommandRegistry,
  forceXterm?: boolean,
): PipelineData {
  // Auto PTY routing (M2): a single, non-piped command runs interactively by
  // default — TTY detection, colors, prompts, alt-screen all match a real
  // terminal. A multi-stage pipeline keeps the existing non-interactive
  // byte-stream text capture for its external stages (paired with M4's stdin
  // policy). `forceXterm` (`!cmd`) never changes this routing — the parser
  // already guarantees it only appears on a single-command pipeline — it is
  // carried through purely as a render hint for the adaptive-render layer (M3).
  const interactive = commands.length === 1;
  let data: PipelineData = emptyListStream();
  for (const command of commands) {
    const def = registry.get(command.name);
    if (!def) {
      // Not a builtin → external program execution, when the context wires it.
      if (ctx.resolveExternal) {
        data = ctx.resolveExternal(command, ctx, { interactive, forceXterm });
        continue;
      }
      throw new EvalError(`unknown command: ${command.name}`, command.nameSpan);
    }
    // B1: `!` is for external programs — a builtin can never render as xterm.
    // (The parser already guarantees a single command when forceXterm is set.)
    if (forceXterm) {
      throw new EvalError(
        `'!' (force xterm) applies to external programs, not the builtin '${command.name}'`,
        command.nameSpan,
      );
    }
    const invocation = buildInvocation(def, command, ctx);
    data = def.handler(data, invocation, ctx);
  }
  return data;
}
