/**
 * AC#4-A — durable ShellSession: variables (`let` / `$x`), env access (`$env.X`),
 * and `cd` (session cwd that persists across runs). Proves that state set by one
 * run is visible to the next against the SAME session, and resets on a new one.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evalExpression, evaluate, parse, recordToJson } from './core';
import type { EvalContext, Expression, JsonRecord, PipelineData } from './core';
import { ShellSession } from './shell-session';

function ctxOf(session: ShellSession): EvalContext {
  return session.createContext(new AbortController().signal);
}

/** Extract a single expression from a `where <text>` predicate, for direct eval. */
function exprOf(text: string): Expression {
  const stmt = parse(`where ${text}`);
  if (stmt.type !== 'pipeline') throw new Error('expected a pipeline');
  const arg = stmt.commands[0].args[0];
  if (arg.kind !== 'positional') throw new Error('expected a positional');
  return arg.expr;
}

async function collect(data: PipelineData): Promise<JsonRecord[]> {
  if (data.kind !== 'list-stream') throw new Error(`expected list-stream, got ${data.kind}`);
  const rows: JsonRecord[] = [];
  for await (const row of data.rows) rows.push(recordToJson(row));
  return rows;
}

let dir: string;
let child: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezterm-session-'));
  child = join(dir, 'child');
  await mkdir(child);
  await writeFile(join(child, 'marker.txt'), 'x');
  await writeFile(join(dir, 'top.txt'), 'y');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('variables — let / $name', () => {
  it('`let x = 5` then `$x` resolves to 5', () => {
    const session = new ShellSession(dir);
    evaluate(parse('let x = 5'), ctxOf(session));

    expect(session.getVar('x')).toEqual({ kind: 'number', value: 5 });
    expect(evalExpression(exprOf('$x'), null, ctxOf(session))).toEqual({ kind: 'number', value: 5 });
  });

  it('`$x` is usable in a where predicate (gen-rows 10 | where n > $x)', async () => {
    const session = new ShellSession(dir);
    evaluate(parse('let x = 5'), ctxOf(session));

    const rows = await collect(evaluate(parse('gen-rows 10 | where n > $x'), ctxOf(session)));
    expect(rows.map((r) => r.n)).toEqual([6, 7, 8, 9, 10]);
  });

  it('persists variables across runs in one session, but resets on a new session', async () => {
    const a = new ShellSession(dir);
    evaluate(parse('let x = 5'), ctxOf(a));
    // Two later runs against the SAME session both see x.
    expect(await collect(evaluate(parse('gen-rows 10 | where n > $x'), ctxOf(a)))).toHaveLength(5);
    expect(await collect(evaluate(parse('gen-rows 7 | where n > $x'), ctxOf(a)))).toHaveLength(2);

    // A brand-new session has no x — referencing it errors when iterated.
    const b = new ShellSession(dir);
    expect(b.getVar('x')).toBeUndefined();
    await expect(
      collect(evaluate(parse('gen-rows 3 | where n > $x'), ctxOf(b))),
    ).rejects.toThrow(/undefined variable: \$x/);
  });
});

describe('history — session records commands; `history` builtin renders them', () => {
  it('records appended commands, oldest first', () => {
    const session = new ShellSession(dir);
    session.addHistory('ls');
    session.addHistory('gen-rows 5');
    expect(session.getHistory()).toEqual(['ls', 'gen-rows 5']);
  });

  it('`history` builtin returns the recorded commands as an indexed table', async () => {
    const session = new ShellSession(dir);
    session.addHistory('ls');
    session.addHistory('gen-rows 5 | where n > 2');

    const data = evaluate(parse('history'), ctxOf(session));
    expect(data.kind).toBe('list-stream');
    expect(data.meta?.columns?.map((c) => c.name)).toEqual(['index', 'command']);

    const rows = await collect(data);
    expect(rows).toEqual([
      { index: 1, command: 'ls' },
      { index: 2, command: 'gen-rows 5 | where n > 2' },
    ]);
  });

  it('`history` is pipeable: history | where command == "ls"', async () => {
    const session = new ShellSession(dir);
    session.addHistory('ls');
    session.addHistory('gen-rows 5');
    session.addHistory('ls');

    const rows = await collect(evaluate(parse('history | where command == "ls"'), ctxOf(session)));
    expect(rows.map((r) => r.index)).toEqual([1, 3]);
  });

  it('returns an empty table when no commands have run', async () => {
    const rows = await collect(evaluate(parse('history'), ctxOf(new ShellSession(dir))));
    expect(rows).toEqual([]);
  });
});

describe('env — $env.NAME read + $env.NAME = value', () => {
  it('`$env.PATH` reads a value from the process env', () => {
    const session = new ShellSession(dir);
    const value = evalExpression(exprOf('$env.PATH'), null, ctxOf(session));
    expect(value.kind).toBe('string');
    expect((value as { value: string }).value.length).toBeGreaterThan(0);
  });

  it('`$env.X = value` sets an override that `$env.X` then reads back', () => {
    const session = new ShellSession(dir);
    evaluate(parse('$env.GREETING = "hi"'), ctxOf(session));
    expect(evalExpression(exprOf('$env.GREETING'), null, ctxOf(session))).toEqual({
      kind: 'string',
      value: 'hi',
    });
  });

  it('throws on an unset env variable', () => {
    const session = new ShellSession(dir);
    expect(() => evalExpression(exprOf('$env.DEFINITELY_UNSET_XYZ'), null, ctxOf(session))).toThrow(
      /undefined environment variable/,
    );
  });
});

describe('cd — session cwd persistence', () => {
  it('`cd <subdir>` then `ls` lists THAT directory across two runs on one session', async () => {
    const session = new ShellSession(dir);

    // Run 1 (parent): ls does NOT contain the child's marker.
    const before = await collect(evaluate(parse('ls'), ctxOf(session)));
    expect(before.map((r) => r.name)).not.toContain('marker.txt');

    // Run 2: cd into the subdir — mutates the durable session cwd.
    evaluate(parse('cd child'), ctxOf(session));
    expect(session.cwd).toBe(resolve(dir, 'child'));

    // Run 3 (after cd): ls now reflects the NEW cwd.
    const after = await collect(evaluate(parse('ls'), ctxOf(session)));
    expect(after.map((r) => r.name)).toEqual(['marker.txt']);
  });

  it('`cd` to a missing directory errors cleanly', () => {
    const session = new ShellSession(dir);
    expect(() => evaluate(parse('cd does-not-exist-xyz'), ctxOf(session))).toThrow(
      /no such file or directory/,
    );
    expect(session.cwd).toBe(dir); // unchanged after the failed cd
  });

  it('`cd ..` returns to the parent directory', async () => {
    const session = new ShellSession(child);
    evaluate(parse('cd ..'), ctxOf(session));
    const rows = await collect(evaluate(parse('ls'), ctxOf(session)));
    expect(rows.map((r) => r.name)).toContain('child');
  });

  it('`cd -` returns to the previous directory (via OLDPWD)', () => {
    const session = new ShellSession(dir);
    evaluate(parse('cd child'), ctxOf(session));
    expect(session.cwd).toBe(resolve(dir, 'child'));
    evaluate(parse('cd -'), ctxOf(session));
    expect(session.cwd).toBe(dir);
  });

  it('`cd` with no argument goes to the home directory', () => {
    const session = new ShellSession(dir);
    evaluate(parse('cd'), ctxOf(session));
    expect(session.cwd).toBe(homedir());
  });
});
