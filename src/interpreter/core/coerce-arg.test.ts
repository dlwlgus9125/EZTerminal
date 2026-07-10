import { describe, expect, it } from 'vitest';

import { parse } from '.';
import type { Expression } from './ast';
import { coerceArg } from './coerce-arg';
import type { EvalContext } from './types';
import type { RuntimeValue } from './value';
import {
  boolValue,
  datetimeValue,
  filesizeValue,
  nullValue,
  numberValue,
  recordValue,
  stringValue,
} from './value';
import { ShellSession } from '../shell-session';

/** Parse a single positional argument expression (`x <arg>` → the arg's expr). */
function exprOf(argText: string): Expression {
  const stmt = parse(`x ${argText}`);
  if (stmt.type !== 'pipeline') throw new Error(`expected pipeline, got ${stmt.type}`);
  const arg = stmt.commands[0].args[0];
  if (arg.kind !== 'positional') throw new Error(`expected positional, got ${arg.kind}`);
  return arg.expr;
}

/** A context with the given session variables + env overrides pre-set. */
function ctxWith(
  vars: Record<string, RuntimeValue> = {},
  env: Record<string, string> = {},
): EvalContext {
  const session = new ShellSession(process.cwd());
  for (const [k, v] of Object.entries(vars)) session.setVar(k, v);
  for (const [k, v] of Object.entries(env)) session.setEnv(k, v);
  return session.createContext(new AbortController().signal);
}

const label = 'test-cmd';
const coerce = (argText: string, ctx: EvalContext = ctxWith()) => coerceArg(exprOf(argText), ctx, label);

describe('coerceArg', () => {
  describe('literals', () => {
    it('a bare word (identifier) is its literal name', () => {
      expect(coerce('checkout')).toBe('checkout');
    });
    it('a quoted string is its value', () => {
      expect(coerce('"hello world"')).toBe('hello world');
    });
    it('a number stringifies', () => {
      expect(coerce('42')).toBe('42');
    });
    it('a bool stringifies', () => {
      expect(coerce('true')).toBe('true');
      expect(coerce('false')).toBe('false');
    });
    it('null is the literal string "null"', () => {
      expect(coerce('null')).toBe('null');
    });
    it('a filesize is its byte count', () => {
      expect(coerce('100mb')).toBe(String(100 * 1024 * 1024));
    });
  });

  describe('$var resolution (every scalar kind)', () => {
    it('resolves a string variable', () => {
      expect(coerce('$branch', ctxWith({ branch: stringValue('main') }))).toBe('main');
    });
    it('resolves a number variable', () => {
      expect(coerce('$n', ctxWith({ n: numberValue(7) }))).toBe('7');
    });
    it('resolves a bool variable', () => {
      expect(coerce('$b', ctxWith({ b: boolValue(true) }))).toBe('true');
    });
    it('resolves a null variable', () => {
      expect(coerce('$z', ctxWith({ z: nullValue }))).toBe('null');
    });
    it('resolves a filesize variable to its bytes', () => {
      expect(coerce('$s', ctxWith({ s: filesizeValue(2048) }))).toBe('2048');
    });
    it('resolves a datetime variable to ISO-8601', () => {
      expect(coerce('$t', ctxWith({ t: datetimeValue(0) }))).toBe('1970-01-01T00:00:00.000Z');
    });
    it('throws on an undefined variable', () => {
      expect(() => coerce('$missing')).toThrow(/undefined variable: \$missing/);
    });
    it('throws (with label) when a variable is a non-scalar (record)', () => {
      expect(() => coerce('$r', ctxWith({ r: recordValue({}) }))).toThrow(
        /test-cmd: \$r is a record, not a valid argument/,
      );
    });
  });

  describe('$env resolution', () => {
    it('resolves a set env override', () => {
      expect(coerce('$env.DEPLOY_TARGET', ctxWith({}, { DEPLOY_TARGET: 'prod' }))).toBe('prod');
    });
    it('throws (with label) on an unset env var', () => {
      expect(() => coerce('$env.EZ_COERCE_DEFINITELY_UNSET')).toThrow(
        /test-cmd: \$env\.EZ_COERCE_DEFINITELY_UNSET is not set/,
      );
    });
  });

  describe('comparison expressions', () => {
    it('throws (with label) — a binary is not a valid argument', () => {
      expect(() => coerce('size > 100mb')).toThrow(
        /test-cmd: comparison expressions are not valid arguments/,
      );
    });
  });
});
