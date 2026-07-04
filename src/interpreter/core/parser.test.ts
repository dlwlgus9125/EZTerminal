import { describe, expect, it } from 'vitest';

import { ParseError, parse } from './index';
import type { Pipeline } from './index';

/** Parse + assert the result is a pipeline (narrowing for the command-shape tests). */
function pipeline(text: string): Pipeline {
  const stmt = parse(text);
  if (stmt.type !== 'pipeline') throw new Error(`expected a pipeline, got ${stmt.type}`);
  return stmt;
}

describe('parser — happy path', () => {
  it('parses a bare command with no args', () => {
    const p = pipeline('ls');
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0].name).toBe('ls');
    expect(p.commands[0].args).toHaveLength(0);
  });

  it('parses gen-rows with a number positional', () => {
    const cmd = pipeline('gen-rows 5').commands[0];
    expect(cmd.name).toBe('gen-rows');
    expect(cmd.args[0]).toMatchObject({ kind: 'positional', expr: { type: 'number', value: 5 } });
  });

  it('parses the canonical 3-stage pipeline (comparison + filesize)', () => {
    const p = pipeline('ls | where size > 100mb | sort-by name');
    expect(p.commands.map((c) => c.name)).toEqual(['ls', 'where', 'sort-by']);

    const whereArg = p.commands[1].args[0];
    expect(whereArg.kind).toBe('positional');
    if (whereArg.kind === 'positional' && whereArg.expr.type === 'binary') {
      expect(whereArg.expr.op).toBe('>');
      expect(whereArg.expr.left).toMatchObject({ type: 'identifier', name: 'size' });
      expect(whereArg.expr.right).toMatchObject({ type: 'filesize', bytes: 100 * 1024 * 1024 });
    } else {
      throw new Error('expected a binary positional expression for where');
    }

    expect(p.commands[2].args[0]).toMatchObject({
      kind: 'positional',
      expr: { type: 'identifier', name: 'name' },
    });
  });

  it('parses string equality and >= comparisons', () => {
    const eq = pipeline('where name == "x"').commands[0].args[0];
    if (eq.kind === 'positional' && eq.expr.type === 'binary') {
      expect(eq.expr.op).toBe('==');
      expect(eq.expr.right).toMatchObject({ type: 'string', value: 'x' });
    } else {
      throw new Error('expected binary == expression');
    }

    const ge = pipeline('where n >= 3').commands[0].args[0];
    if (ge.kind === 'positional' && ge.expr.type === 'binary') {
      expect(ge.expr.op).toBe('>=');
    } else {
      throw new Error('expected binary >= expression');
    }
  });

  it('parses long and short boolean flags', () => {
    const long = pipeline('sort-by name --reverse').commands[0];
    expect(long.args[1]).toMatchObject({ kind: 'flag', name: 'reverse', short: false });

    const short = pipeline('sort-by name -r').commands[0];
    expect(short.args[1]).toMatchObject({ kind: 'flag', name: 'r', short: true });
  });
});

describe('parser — variables, env, and statements (AC#4)', () => {
  it('parses a `let` statement (name + value expression)', () => {
    const stmt = parse('let x = 5');
    expect(stmt).toMatchObject({
      type: 'let',
      name: 'x',
      value: { type: 'number', value: 5 },
    });
  });

  it('parses a `$name` variable reference inside a where predicate', () => {
    const arg = pipeline('where n > $x').commands[0].args[0];
    if (arg.kind === 'positional' && arg.expr.type === 'binary') {
      expect(arg.expr.right).toMatchObject({ type: 'variable', name: 'x' });
    } else {
      throw new Error('expected a binary predicate with a variable');
    }
  });

  it('parses a `$env.NAME` reference inside an expression', () => {
    const arg = pipeline('where name == $env.PATH').commands[0].args[0];
    if (arg.kind === 'positional' && arg.expr.type === 'binary') {
      expect(arg.expr.right).toMatchObject({ type: 'env', name: 'PATH' });
    } else {
      throw new Error('expected a binary predicate with an env reference');
    }
  });

  it('parses a `$env.NAME = value` assignment statement', () => {
    const stmt = parse('$env.FOO = "bar"');
    expect(stmt).toMatchObject({
      type: 'env-assign',
      name: 'FOO',
      value: { type: 'string', value: 'bar' },
    });
  });

  it('lexes bare path arguments for cd (.., relative, and lone -)', () => {
    expect(pipeline('cd ..').commands[0].args[0]).toMatchObject({
      kind: 'positional',
      expr: { type: 'identifier', name: '..' },
    });
    expect(pipeline('cd src/sub').commands[0].args[0]).toMatchObject({
      kind: 'positional',
      expr: { type: 'identifier', name: 'src/sub' },
    });
    expect(pipeline('cd -').commands[0].args[0]).toMatchObject({
      kind: 'positional',
      expr: { type: 'identifier', name: '-' },
    });
  });

  it('rejects a `let` with no `=`', () => {
    expect(() => parse('let x 5')).toThrow(ParseError);
  });

  it('rejects a bare `$` with no name', () => {
    expect(() => parse('where $ > 1')).toThrow(/variable name/);
  });
});

describe('parser — error cases', () => {
  it('rejects a trailing pipe', () => {
    expect(() => parse('ls |')).toThrow(ParseError);
  });

  it('rejects a dangling operator', () => {
    expect(() => parse('where size >')).toThrow(ParseError);
  });

  it('rejects an unterminated string', () => {
    expect(() => parse('where name == "x')).toThrow(/unterminated/);
  });

  it('rejects an unknown size unit', () => {
    expect(() => parse('where size > 100xb')).toThrow(/unknown size unit/);
  });

  it('reports a friendly line/column in the message', () => {
    expect(() => parse('ls |')).toThrow(/line 1, column/);
  });
});
