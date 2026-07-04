import { describe, expect, it, vi } from 'vitest';

import type { InterpreterFrame } from '../shared/ipc';
import { ShellSession } from './shell-session';
import type { EvalContext, ScriptStreamData } from './core';
import {
  EZ_RUN_ROWS_CAP,
  SCRIPT_PRINT_CAP_BYTES,
  runScriptSession,
  type HostChannel,
  type HostToInterpreterMsg,
  type InterpreterToHostMsg,
  type SpawnHost,
} from './script-runner';

function ctxFor(signal: AbortSignal): EvalContext {
  return new ShellSession(process.cwd()).createContext(signal);
}

function collect() {
  const frames: InterpreterFrame[] = [];
  return { frames, emit: (f: InterpreterFrame) => frames.push(f) };
}

function scriptData(overrides: Partial<ScriptStreamData> = {}): ScriptStreamData {
  return { kind: 'script-stream', scriptPath: 'C:/scripts/fake.js', args: [], ...overrides };
}

/** A fake HostChannel the test drives directly (mirrors pty-session.test.ts's fake PtyHandle). */
function makeFakeChannel() {
  let messageListener: ((msg: HostToInterpreterMsg) => void) | null = null;
  const closedListeners: Array<() => void> = [];
  const sent: InterpreterToHostMsg[] = [];
  const calls = { killed: 0 };
  const channel: HostChannel = {
    onMessage(l) {
      messageListener = l;
    },
    onClosed(l) {
      closedListeners.push(l);
    },
    postMessage(msg) {
      sent.push(msg);
    },
    kill() {
      calls.killed += 1;
    },
  };
  return {
    channel,
    sent,
    calls,
    emitMessage: (msg: HostToInterpreterMsg) => messageListener?.(msg),
    emitClosed: () => closedListeners.forEach((l) => l()),
  };
}

type FakeChannel = ReturnType<typeof makeFakeChannel>;

/** A SpawnHost whose promise resolves once `resolveSpawn()` is called (default: immediately). */
function makeSpawnHost(opts: { immediate?: boolean } = {}): {
  spawnHost: SpawnHost;
  fakes: FakeChannel[];
  resolveSpawn: () => void;
} {
  const fakes: FakeChannel[] = [];
  let resolvers: Array<() => void> = [];
  const spawnHost: SpawnHost = () => {
    const fake = makeFakeChannel();
    fakes.push(fake);
    if (opts.immediate === false) {
      return new Promise((resolve) => {
        resolvers.push(() => resolve(fake.channel));
      });
    }
    return Promise.resolve(fake.channel);
  };
  return {
    spawnHost,
    fakes,
    resolveSpawn: () => {
      const rs = resolvers;
      resolvers = [];
      rs.forEach((r) => r());
    },
  };
}

/** Drain the microtask/macrotask queue once. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('runScriptSession — spawn + lifecycle', () => {
  it('an already-aborted signal never spawns and emits cancelled immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();

    expect(fakes).toHaveLength(0);
    expect(frames).toEqual([{ type: 'cancelled' }]);
  });

  it('spawn failure settles as an error', async () => {
    const ac = new AbortController();
    const spawnHost: SpawnHost = () => Promise.reject(new Error('boom'));
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'error' });
    expect((frames[0] as { message: string }).message).toContain('boom');
  });

  it('cancel BEFORE the spawn resolves kills the host on arrival (no zombie)', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes, resolveSpawn } = makeSpawnHost({ immediate: false });
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    ac.abort(); // cancel raced ahead of the spawn round-trip
    resolveSpawn(); // the host "arrives" only now
    await flush();

    expect(frames).toEqual([{ type: 'cancelled' }]);
    expect(fakes[0].calls.killed).toBe(1);
  });

  it('cancel AFTER the channel is wired kills it and emits cancelled once', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    ac.abort();

    expect(frames).toEqual([{ type: 'cancelled' }]);
    expect(fakes[0].calls.killed).toBe(1);
  });

  it('the host closing before done/error settles as an error, not a hang', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitClosed();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'error' });
  });

  it('dispose before settling kills the host without emitting a terminal frame', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    const session = runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    session.dispose();

    expect(fakes[0].calls.killed).toBe(1);
    expect(frames).toHaveLength(0);

    // idempotent + a late close after dispose does not emit anything either
    fakes[0].emitClosed();
    expect(frames).toHaveLength(0);
  });
});

describe('runScriptSession — script-done result shapes', () => {
  it('done with rows renders a table block (schema shape=table) and kills the host', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    const session = runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'script-done', rows: [{ n: 1 }, { n: 2 }] });
    await flush();

    expect(fakes[0].calls.killed).toBe(1);
    const schema = frames.find((f) => f.type === 'schema');
    expect(schema).toMatchObject({ shape: 'table' });

    session.handleControl({ type: 'requestRows', start: 0, count: 10 });
    await flush();
    const chunk = frames.find((f) => f.type === 'chunk') as { rows: unknown[] } | undefined;
    expect(chunk?.rows).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('done with no rows renders the collected print text as a text block', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    const session = runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'script-print', text: 'hello ' });
    fakes[0].emitMessage({ type: 'script-print', text: 'world' });
    fakes[0].emitMessage({ type: 'script-done' });
    await flush();

    const schema = frames.find((f) => f.type === 'schema');
    expect(schema).toMatchObject({ shape: 'text' });

    session.handleControl({ type: 'setViewport', start: 0, count: 10 });
    await flush();
    const chunk = frames.find((f) => f.type === 'chunk') as { rows: Array<{ value: string }> } | undefined;
    expect(chunk?.rows[0]?.value).toBe('hello world');
  });

  it('script-error settles as an error and kills the host', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'script-error', message: 'boom: line 3' });
    await flush();

    expect(fakes[0].calls.killed).toBe(1);
    expect(frames).toEqual([{ type: 'error', message: 'boom: line 3' }]);
  });
});

describe('runScriptSession — ez.run', () => {
  it('runs the pipeline inline against the session and replies with rows', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'ez-run', id: 'r1', command: 'gen-rows 3 | where n > 1' });
    await vi.waitFor(() => {
      if (!fakes[0].sent.some((m) => m.id === 'r1')) throw new Error('not replied yet');
    });

    const reply = fakes[0].sent.find((m) => m.id === 'r1');
    expect(reply?.error).toBeUndefined();
    expect(reply?.rows).toEqual([{ n: 2, name: 'row-2' }, { n: 3, name: 'row-3' }]);
  });

  it('serializes concurrent ez.run requests — replies arrive in REQUEST order even when the first is slower', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'ez-run', id: 'slow', command: 'gen-rows 5000' });
    fakes[0].emitMessage({ type: 'ez-run', id: 'fast', command: 'gen-rows 1' });
    await vi.waitFor(() => {
      if (fakes[0].sent.length < 2) throw new Error('not both replied yet');
    });

    expect(fakes[0].sent.map((m) => m.id)).toEqual(['slow', 'fast']);
  });

  it('the 100k-row cap errors only that ez.run call — the session stays alive', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'ez-run', id: 'over', command: `gen-rows ${EZ_RUN_ROWS_CAP + 1}` });
    await vi.waitFor(
      () => {
        if (!fakes[0].sent.some((m) => m.id === 'over')) throw new Error('not replied yet');
      },
      { timeout: 10_000 },
    );

    const overReply = fakes[0].sent.find((m) => m.id === 'over');
    expect(overReply?.rows).toBeUndefined();
    expect(overReply?.error).toContain('100,000-row cap');
    expect(fakes[0].calls.killed).toBe(0); // the cap is a per-call error, not fatal to the session

    fakes[0].emitMessage({ type: 'ez-run', id: 'ok', command: 'gen-rows 2' });
    await vi.waitFor(() => {
      if (!fakes[0].sent.some((m) => m.id === 'ok')) throw new Error('not replied yet');
    });
    expect(fakes[0].sent.find((m) => m.id === 'ok')?.rows).toHaveLength(2);
  }, 15_000);

  it('cancel while an ez.run is queued drops the reply and settles cancelled once', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'ez-run', id: 'r1', command: 'gen-rows 3' });
    // Synchronous abort: the ez-run is only QUEUED (processEzRun runs on a later
    // microtask), so this happens before any evaluate/reply.
    ac.abort();
    await flush();

    expect(fakes[0].sent).toHaveLength(0);
    expect(frames).toEqual([{ type: 'cancelled' }]);
    expect(fakes[0].calls.killed).toBe(1);
  });

  it("rejects '!' interactive and byte-stream (external) targets as not row-shaped", async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'ez-run', id: 'bad', command: 'run-script other.js' });
    await vi.waitFor(() => {
      if (!fakes[0].sent.some((m) => m.id === 'bad')) throw new Error('not replied yet');
    });

    expect(fakes[0].sent.find((m) => m.id === 'bad')?.error).toContain('nested run-script');
  });
});

describe('runScriptSession — print cap', () => {
  it('exceeding the 8MB combined stdout/stderr cap kills the host with a hard error', async () => {
    const ac = new AbortController();
    const { spawnHost, fakes } = makeSpawnHost();
    const { frames, emit } = collect();

    runScriptSession(scriptData(), ctxFor(ac.signal), emit, ac.signal, spawnHost);
    await flush();
    fakes[0].emitMessage({ type: 'script-print', text: 'x'.repeat(SCRIPT_PRINT_CAP_BYTES + 1) });
    await flush();

    expect(fakes[0].calls.killed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'error' });
    expect((frames[0] as { message: string }).message).toContain('8MB cap');
  });
});
