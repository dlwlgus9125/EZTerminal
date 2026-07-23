import { rm } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { ChunkFrame, InterpreterFrame, ProgressFrame } from '../shared/ipc';
import { evaluate, parse } from './core';
import type { EvalContext, PipelineData } from './core';
import { runBlock } from './block-runner';
import { ShellSession } from './shell-session';

function ctx(signal?: AbortSignal): EvalContext {
  return new ShellSession(process.cwd()).createContext(signal ?? new AbortController().signal);
}

function chunks(frames: InterpreterFrame[]): ChunkFrame[] {
  return frames.filter((f): f is ChunkFrame => f.type === 'chunk');
}
function progress(frames: InterpreterFrame[]): ProgressFrame[] {
  return frames.filter((f): f is ProgressFrame => f.type === 'progress');
}

/** Poll until `predicate` holds (drive() uses setImmediate, so let macrotasks run). */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const LARGE = 'gen-rows 100000';

describe('runBlock — credit/window protocol', () => {
  it('answers a window request with only that slice, never the whole 100k', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    const data = evaluate(parse(LARGE), ctx(signal));

    const handle = runBlock(data, (f) => frames.push(f), signal);
    handle.handleControl({ type: 'requestRows', start: 0, count: 50 });
    await handle.done;

    // schema once, table-shaped, with the gen-rows columns.
    const schema = frames.find((f) => f.type === 'schema');
    expect(schema).toMatchObject({
      type: 'schema',
      shape: 'table',
      columns: [
        { name: 'n', type: 'number' },
        { name: 'name', type: 'string' },
      ],
    });

    // The running total reaches 100000 and completes.
    const prog = progress(frames);
    expect(prog.length).toBeGreaterThan(0);
    expect(prog.at(-1)).toEqual({ type: 'progress', count: 100_000, done: true });
    expect(frames.some((f) => f.type === 'end')).toBe(true);

    // CREDIT: only the requested 50 rows ever crossed the boundary.
    const sent = chunks(frames);
    const totalRowsSent = sent.reduce((sum, c) => sum + c.rows.length, 0);
    expect(totalRowsSent).toBe(50);
    expect(sent.every((c) => c.rows.length <= 50)).toBe(true);
    expect(sent[0].start).toBe(0);
    expect(sent[0].rows[0]).toEqual({ n: 1, name: 'row-1' });
    expect(sent[0].rows[49]).toEqual({ n: 50, name: 'row-50' });
    // 50 rows sent for a 100000-row source proves no flood.
    expect(totalRowsSent).toBeLessThan(100_000);
  });

  it('emits NO rows when the renderer never requests a window', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    const data = evaluate(parse(LARGE), ctx(signal));

    const handle = runBlock(data, (f) => frames.push(f), signal);
    await handle.done;

    expect(chunks(frames)).toHaveLength(0); // interpreter never auto-pushes rows
    expect(progress(frames).at(-1)).toEqual({ type: 'progress', count: 100_000, done: true });
  });

  it('keeps serving windows after the source is exhausted (post-end paging)', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    const data = evaluate(parse(LARGE), ctx(signal));

    const handle = runBlock(data, (f) => frames.push(f), signal);
    await handle.done; // fully drained + `end` already sent

    handle.handleControl({ type: 'requestRows', start: 99_000, count: 10 });
    await waitFor(() => chunks(frames).some((c) => c.start === 99_000), 'tail chunk');

    const tail = chunks(frames).find((c) => c.start === 99_000)!;
    expect(tail.rows).toHaveLength(10);
    expect(tail.rows[0]).toEqual({ n: 99_001, name: 'row-99001' });
    expect(tail.rows[9]).toEqual({ n: 99_010, name: 'row-99010' });
  });

  it('emits `cancelled` when aborted and never `end`', async () => {
    const frames: InterpreterFrame[] = [];
    const ac = new AbortController();
    ac.abort();
    const data = evaluate(parse(LARGE), ctx(ac.signal));

    const handle = runBlock(data, (f) => frames.push(f), ac.signal);
    await handle.done;

    expect(frames.some((f) => f.type === 'cancelled')).toBe(true);
    expect(frames.some((f) => f.type === 'end')).toBe(false);
  });

  it('bounds cancellation to the in-flight pull for a slow async structured stream', async () => {
    const frames: InterpreterFrame[] = [];
    const ac = new AbortController();
    let pulls = 0;
    let signalThirdPull!: () => void;
    const thirdPull = new Promise<void>((resolve) => {
      signalThirdPull = resolve;
    });

    // A legitimate async list stream, deliberately independent of gen-rows.
    // The finite guard makes a missing cancellation check fail quickly and
    // deterministically by pull count instead of hanging for 50,000 rows.
    async function* slowRows() {
      while (pulls < 64) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        pulls += 1;
        if (pulls === 3) signalThirdPull();
        yield {
          kind: 'record' as const,
          fields: { n: { kind: 'number' as const, value: pulls } },
        };
      }
    }

    const data: PipelineData = { kind: 'list-stream', rows: slowRows() };
    const handle = runBlock(data, (frame) => frames.push(frame), ac.signal);
    await thirdPull;
    ac.abort();
    await handle.done;

    // At most the row already in flight may settle after abort. Without the
    // per-pull seam the 50k drain target consumes all 64 guarded rows first.
    expect(pulls).toBeLessThanOrEqual(4);
    expect(progress(frames).at(-1)).toMatchObject({ type: 'progress', done: true });
    expect(progress(frames).at(-1)?.count).toBeGreaterThan(0);
    expect(frames.some((frame) => frame.type === 'cancelled')).toBe(true);
    expect(frames.some((frame) => frame.type === 'end')).toBe(false);
  });

  it('renders a scalar value as a text block', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    // The Phase-1 grammar has no scalar-producing command, so synthesize a scalar
    // PipelineData directly to exercise the `text` shape path.
    const data: PipelineData = { kind: 'value', value: { kind: 'number', value: 42 } };

    const handle = runBlock(data, (f) => frames.push(f), signal);
    handle.handleControl({ type: 'requestRows', start: 0, count: 1 });
    await handle.done;

    const schema = frames.find((f) => f.type === 'schema');
    expect(schema).toMatchObject({ type: 'schema', shape: 'text', columns: [{ name: 'value' }] });
    const sent = chunks(frames);
    expect(sent[0].rows[0]).toEqual({ value: 42 });
  });

  it('renders an external byte stream as an html text block (ANSI → sanitized HTML)', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    const ESC = '\x1b';
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode(`${ESC}[31mhello`); // red
      yield new TextEncoder().encode(' world<script>');
    }
    const data: PipelineData = { kind: 'byte-stream', bytes: gen() };

    const handle = runBlock(data, (f) => frames.push(f), signal);
    handle.handleControl({ type: 'requestRows', start: 0, count: 100 });
    await handle.done;
    await waitFor(() => chunks(frames).length > 0, 'html rows served');

    const schema = frames.find((f) => f.type === 'schema');
    expect(schema).toMatchObject({
      type: 'schema',
      shape: 'text',
      columns: [{ name: 'value', type: 'html' }],
    });

    const html = chunks(frames)
      .flatMap((c) => c.rows)
      .map((r) => r.value as string)
      .join('');
    expect(html).toContain('color:rgb(187,0,0)'); // red SGR converted
    expect(html).toContain('hello');
    expect(html).toContain('world');
    expect(html).not.toContain('<script>'); // sanitized
    expect(html).toContain('&lt;script&gt;');
    expect(frames.some((f) => f.type === 'end')).toBe(true);
  });

  it('handles an empty result (gen-rows 0): schema, zero rows, end', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    const data = evaluate(parse('gen-rows 0'), ctx(signal));

    const handle = runBlock(data, (f) => frames.push(f), signal);
    handle.handleControl({ type: 'requestRows', start: 0, count: 50 });
    await handle.done;
    await waitFor(() => chunks(frames).length > 0, 'empty window served');

    expect(frames.find((f) => f.type === 'schema')).toBeDefined();
    expect(progress(frames).at(-1)).toEqual({ type: 'progress', count: 0, done: true });
    expect(frames.some((f) => f.type === 'end')).toBe(true);
    const totalRowsSent = chunks(frames).reduce((sum, c) => sum + c.rows.length, 0);
    expect(totalRowsSent).toBe(0);
  });

  it('emits an `error` frame when the async source throws (and never `end`)', async () => {
    const frames: InterpreterFrame[] = [];
    const signal = new AbortController().signal;
    async function* boom(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('partial');
      throw new Error('kaboom');
    }
    const data: PipelineData = { kind: 'byte-stream', bytes: boom() };

    const handle = runBlock(data, (f) => frames.push(f), signal);
    await handle.done;

    expect(frames.find((f) => f.type === 'error')).toMatchObject({
      type: 'error',
      message: expect.stringContaining('kaboom'),
    });
    expect(progress(frames).at(-1)).toEqual({ type: 'progress', count: 1, done: true });
    expect(frames.some((f) => f.type === 'end')).toBe(false);
  });

  it('publishes structured rows retained after the last throttled progress before an error', async () => {
    const frames: InterpreterFrame[] = [];
    async function* rows() {
      for (let n = 1; n <= 3; n += 1) {
        yield {
          kind: 'record' as const,
          fields: { n: { kind: 'number' as const, value: n } },
        };
      }
      throw new Error('structured failure');
    }
    const data: PipelineData = { kind: 'list-stream', rows: rows() };

    const handle = runBlock(
      data,
      (frame) => frames.push(frame),
      new AbortController().signal,
    );
    await handle.done;

    expect(progress(frames).at(-1)).toEqual({ type: 'progress', count: 3, done: true });
    expect(frames.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('structured failure'),
    });
  });

  it('dispose() is idempotent and releases the source + runs cleanup once', async () => {
    let cleanups = 0;
    let returned = 0;
    async function* forever(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          yield new TextEncoder().encode('x');
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        returned += 1; // generator's finally runs when the iterator is returned
      }
    }
    const data: PipelineData = {
      kind: 'byte-stream',
      bytes: forever(),
      cleanup: async () => {
        cleanups += 1;
      },
    };
    const frames: InterpreterFrame[] = [];
    const handle = runBlock(data, (f) => frames.push(f), new AbortController().signal);
    // Pull at least one row so the source generator is genuinely mid-flight (its
    // try/finally is active) — only then does releasing it run the finally.
    handle.handleControl({ type: 'requestRows', start: 0, count: 1 });
    await waitFor(() => chunks(frames).some((c) => c.rows.length > 0), 'first row served');

    const firstDispose = handle.dispose();
    const secondDispose = handle.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;
    await handle.dispose(); // idempotent — no double cleanup / double release

    expect(cleanups).toBe(1);
    expect(returned).toBe(1);
  });

  it('retries a transient spill-directory removal before releasing structured cleanup', async () => {
    const frames: InterpreterFrame[] = [];
    let removeAttempts = 0;
    const signal = new AbortController().signal;
    const handle = runBlock(
      evaluate(parse('gen-rows 1'), ctx(signal)),
      (frame) => frames.push(frame),
      signal,
      {
        retentionFileSystem: {
          remove: async (path, options) => {
            removeAttempts += 1;
            if (removeAttempts === 1) {
              throw Object.assign(new Error('synthetic sharing violation'), { code: 'EBUSY' });
            }
            await rm(path, options);
          },
        },
        disposeRetryDelaysMs: [0],
      },
    );
    await handle.done;

    await handle.dispose();

    expect(removeAttempts).toBe(2);
    expect(frames.some((frame) => frame.type === 'end')).toBe(true);
  });

  it('still releases the row source when pipeline cleanup rejects', async () => {
    let returned = 0;
    async function* forever(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          yield new TextEncoder().encode('x');
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        returned += 1;
      }
    }
    const data: PipelineData = {
      kind: 'byte-stream',
      bytes: forever(),
      cleanup: async () => {
        throw new Error('cleanup failed');
      },
    };
    const frames: InterpreterFrame[] = [];
    const handle = runBlock(data, (frame) => frames.push(frame), new AbortController().signal);
    handle.handleControl({ type: 'requestRows', start: 0, count: 1 });
    await waitFor(() => chunks(frames).some((chunk) => chunk.rows.length > 0), 'first row served');

    await expect(handle.dispose()).rejects.toThrow('cleanup failed');
    expect(returned).toBe(1);
  });

  it('emits `cancelled` for an aborted byte stream and never `end`', async () => {
    const frames: InterpreterFrame[] = [];
    const ac = new AbortController();
    let yields = 0;
    // An infinite external-like stream: never exhausts, so it is mid-flight when
    // we cancel. Yields are observed directly (the progress drain only reports in
    // 5000-row batches, which a slow stream never fills).
    async function* gen(): AsyncGenerator<Uint8Array> {
      for (;;) {
        if (ac.signal.aborted) return;
        yields += 1;
        yield new TextEncoder().encode('tick\n');
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const data: PipelineData = { kind: 'byte-stream', bytes: gen() };

    const handle = runBlock(data, (f) => frames.push(f), ac.signal);
    await waitFor(() => yields > 0, 'stream producing'); // genuinely mid-flight
    ac.abort();
    await handle.done;

    expect(frames.some((f) => f.type === 'cancelled')).toBe(true);
    expect(frames.some((f) => f.type === 'end')).toBe(false);
  });

  it('starts cleanup on abort so a quiet pending iterator cannot deadlock cancellation', async () => {
    const frames: InterpreterFrame[] = [];
    const ac = new AbortController();
    let resolvePending: ((result: IteratorResult<Uint8Array>) => void) | null = null;
    let cleanups = 0;
    const bytes: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            return new Promise((resolve) => {
              resolvePending = resolve;
            });
          },
        };
      },
    };
    const data: PipelineData = {
      kind: 'byte-stream',
      bytes,
      cleanup: async () => {
        cleanups += 1;
        resolvePending?.({ done: true, value: undefined });
      },
    };
    const handle = runBlock(data, (frame) => frames.push(frame), ac.signal);
    await waitFor(() => resolvePending !== null, 'quiet iterator pending');

    ac.abort();
    await handle.done;

    expect(cleanups).toBe(1);
    expect(frames.some((frame) => frame.type === 'cancelled')).toBe(true);
    expect(frames.some((frame) => frame.type === 'end')).toBe(false);
    await handle.dispose();
  });
});
