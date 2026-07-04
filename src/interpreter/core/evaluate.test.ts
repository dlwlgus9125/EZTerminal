import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluate, parse, recordToJson } from './index';
import type { EvalContext, JsonRecord, PipelineData, ProcessInfo } from './index';
import { ShellSession } from '../shell-session';

function ctxFor(cwd: string, signal?: AbortSignal): EvalContext {
  return new ShellSession(cwd).createContext(signal ?? new AbortController().signal);
}

/** A deterministic process snapshot so the `ps` builtin is testable without the OS. */
const FAKE_PROCESSES: readonly ProcessInfo[] = [
  { pid: 4, name: 'System', sessionName: 'Services', memoryKb: 2 },
  { pid: 1234, name: 'node.exe', sessionName: 'Console', memoryKb: 45678 },
  { pid: 42, name: 'explorer.exe', sessionName: 'Console', memoryKb: 1024 },
];

function ctxForPs(processes: readonly ProcessInfo[] = FAKE_PROCESSES): EvalContext {
  return new ShellSession(dir).createContext(
    new AbortController().signal,
    undefined,
    async () => processes,
  );
}

async function collect(data: PipelineData): Promise<JsonRecord[]> {
  if (data.kind !== 'list-stream') throw new Error(`expected list-stream, got ${data.kind}`);
  const rows: JsonRecord[] = [];
  for await (const row of data.rows) rows.push(recordToJson(row));
  return rows;
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezterm-'));
  await writeFile(join(dir, 'a-small.txt'), 'x'.repeat(10));
  await writeFile(join(dir, 'b-big.txt'), 'x'.repeat(2000));
  await writeFile(join(dir, 'c-huge.txt'), 'x'.repeat(3000));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ls', () => {
  it('lists the directory as a table with declared columns', async () => {
    const data = evaluate(parse('ls'), ctxFor(dir));
    expect(data.kind).toBe('list-stream');
    expect(data.meta?.columns?.map((c) => c.name)).toEqual(['name', 'size', 'type', 'modified']);

    const rows = await collect(data);
    expect(rows.map((r) => r.name).sort()).toEqual(['a-small.txt', 'b-big.txt', 'c-huge.txt']);

    const big = rows.find((r) => r.name === 'b-big.txt');
    expect(big?.size).toBe(2000);
    expect(big?.type).toBe('file');
  });
});

describe('pipeline: ls | where size > 1kb | sort-by name', () => {
  it('filters by filesize (streaming) then sorts (buffering)', async () => {
    const rows = await collect(evaluate(parse('ls | where size > 1kb | sort-by name'), ctxFor(dir)));
    expect(rows.map((r) => r.name)).toEqual(['b-big.txt', 'c-huge.txt']);
    expect(rows.every((r) => (r.size as number) > 1024)).toBe(true);
  });

  it('honors the sort-by --reverse flag', async () => {
    const rows = await collect(evaluate(parse('ls | sort-by name --reverse'), ctxFor(dir)));
    expect(rows.map((r) => r.name)).toEqual(['c-huge.txt', 'b-big.txt', 'a-small.txt']);
  });
});

describe('gen-rows | where | sort-by', () => {
  it('produces the deterministic result rows', async () => {
    const rows = await collect(evaluate(parse('gen-rows 5 | where n > 2 | sort-by n'), ctxFor(dir)));
    expect(rows).toEqual([
      { n: 3, name: 'row-3' },
      { n: 4, name: 'row-4' },
      { n: 5, name: 'row-5' },
    ]);
  });

  it('is lazy — a huge count constructs instantly and yields the first rows', async () => {
    const data = evaluate(parse('gen-rows 1000000000'), ctxFor(dir));
    if (data.kind !== 'list-stream') throw new Error('expected list-stream');
    const it = data.rows[Symbol.asyncIterator]();
    const a = await it.next();
    const b = await it.next();
    const c = await it.next();
    if (a.done || b.done || c.done) throw new Error('unexpected early end');
    expect(recordToJson(a.value)).toEqual({ n: 1, name: 'row-1' });
    expect(recordToJson(c.value)).toEqual({ n: 3, name: 'row-3' });
    await it.return?.();
  });
});

describe('ps (injected process source)', () => {
  it('lists processes as a table with the declared columns', async () => {
    const data = evaluate(parse('ps'), ctxForPs());
    expect(data.kind).toBe('list-stream');
    expect(data.meta?.columns?.map((c) => c.name)).toEqual(['pid', 'name', 'sessionName', 'memory']);

    const rows = await collect(data);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const node = rows.find((r) => r.name === 'node.exe');
    expect(node?.pid).toBe(1234);
    // memoryKb (45678) is surfaced as a filesize in bytes (45678 * 1024).
    expect(node?.memory).toBe(45678 * 1024);
  });

  it('is pipeable: ps | where name == "node.exe"', async () => {
    const rows = await collect(evaluate(parse('ps | where name == "node.exe"'), ctxForPs()));
    expect(rows.map((r) => r.name)).toEqual(['node.exe']);
  });

  it('is pipeable: ps | sort-by pid', async () => {
    const rows = await collect(evaluate(parse('ps | sort-by pid'), ctxForPs()));
    expect(rows.map((r) => r.pid)).toEqual([4, 42, 1234]);
  });

  it('errors cleanly when no process source is wired', () => {
    const ctx = new ShellSession(dir).createContext(new AbortController().signal);
    expect(() => evaluate(parse('ps'), ctx)).toThrow(/ps is not available/);
  });
});

describe('cancellation', () => {
  it('aborts mid-stream and stops early', async () => {
    const ac = new AbortController();
    const data = evaluate(parse('gen-rows 1000'), ctxFor(dir, ac.signal));
    if (data.kind !== 'list-stream') throw new Error('expected list-stream');

    const it = data.rows[Symbol.asyncIterator]();
    const seen: number[] = [];
    const a = await it.next();
    const b = await it.next();
    if (!a.done) seen.push(recordToJson(a.value).n as number);
    if (!b.done) seen.push(recordToJson(b.value).n as number);

    ac.abort();
    await expect(it.next()).rejects.toThrow();
    expect(seen).toEqual([1, 2]); // never reached row 1000
  });
});

describe('errors', () => {
  it('rejects an unknown command', () => {
    expect(() => evaluate(parse('bogus'), ctxFor(dir))).toThrow(/unknown command/);
  });

  it('rejects an unknown flag', () => {
    expect(() => evaluate(parse('sort-by name --nope'), ctxFor(dir))).toThrow(/unknown flag/);
  });

  it('rejects wrong arity (gen-rows needs a count)', () => {
    expect(() => evaluate(parse('gen-rows'), ctxFor(dir))).toThrow(/positional/);
  });

  it('rejects a non-integer gen-rows count (Zod arg validation)', () => {
    expect(() => evaluate(parse('gen-rows 2.5'), ctxFor(dir))).toThrow(/gen-rows/);
  });

  it('rejects a non-boolean where predicate during iteration', async () => {
    const data = evaluate(parse('ls | where name'), ctxFor(dir));
    await expect(collect(data)).rejects.toThrow(/boolean/);
  });
});
