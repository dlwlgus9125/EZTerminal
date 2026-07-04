import { describe, it, expect, vi } from 'vitest';

import { runPty, ptyArgv, type PtyArgs, type PtySpawnFn, type KillTreeFn } from './pty-runner';

/** A fake killTree (Adapter seam): records calls instead of shelling out to a
 * real OS kill command — a real `taskkill` would target whatever process
 * happens to own the fake IPty's `pid`, which is exactly what must NOT happen
 * in a unit test. */
function makeFakeKillTree() {
  const pids: number[] = [];
  const killTree: KillTreeFn = (pid) => {
    pids.push(pid);
  };
  return { killTree, pids };
}

/** A fake node-pty IPty that records calls and lets the test drive data/exit. */
function makeFakeIPty() {
  const dataListeners: Array<(d: unknown) => void> = [];
  const exitListeners: Array<(e: { exitCode: number }) => void> = [];
  const calls = {
    file: '',
    args: { kind: 'argv', argv: [] } as PtyArgs,
    options: undefined as Record<string, unknown> | undefined,
    writes: [] as string[],
    resizes: [] as Array<[number, number]>,
    killed: 0,
  };
  const ipty = {
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: (l: (d: unknown) => void) => {
      dataListeners.push(l);
      return { dispose() {} };
    },
    onExit: (l: (e: { exitCode: number }) => void) => {
      exitListeners.push(l);
      return { dispose() {} };
    },
    write: (d: string) => {
      calls.writes.push(d);
    },
    resize: (c: number, r: number) => {
      calls.resizes.push([c, r]);
    },
    kill: () => {
      calls.killed += 1;
    },
    clear() {},
    pause() {},
    resume() {},
  };
  const spawn: PtySpawnFn = (file, args, options) => {
    calls.file = file;
    calls.args = args;
    calls.options = options as Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ipty as any;
  };
  return {
    spawn,
    calls,
    ipty,
    emitData: (d: unknown) => dataListeners.forEach((l) => l(d)),
    emitExit: (code: number) => exitListeners.forEach((l) => l({ exitCode: code })),
  };
}

describe('runPty (node-pty adapter)', () => {
  it('spawns with encoding:null + xterm-256color and filters undefined env', () => {
    const fake = makeFakeIPty();
    const ac = new AbortController();
    runPty(
      'node',
      ptyArgv(['-v']),
      { cwd: 'C:/tmp', env: { A: 'x', B: undefined }, signal: ac.signal, cols: 100, rows: 30 },
      fake.spawn,
    );
    expect(fake.calls.file).toBe('node');
    expect(fake.calls.options?.encoding).toBeNull();
    expect(fake.calls.options?.name).toBe('xterm-256color');
    expect(fake.calls.options?.cols).toBe(100);
    expect(fake.calls.options?.rows).toBe(30);
    expect(fake.calls.options?.env).toEqual({ A: 'x' }); // B (undefined) dropped
    // handleFlowControl must NOT be enabled (would intercept Ctrl+S/Ctrl+Q).
    expect(fake.calls.options?.handleFlowControl).toBeUndefined();
  });

  it('adapts onData payloads to Uint8Array', () => {
    const fake = makeFakeIPty();
    const handle = runPty('node', ptyArgv([]), emptyOpts(), fake.spawn);
    const received: Uint8Array[] = [];
    handle.onData((b) => received.push(b));
    fake.emitData(Buffer.from('hi', 'utf8'));
    fake.emitData('str'); // string fallback path
    expect(Buffer.from(received[0]).toString('utf8')).toBe('hi');
    expect(Buffer.from(received[1]).toString('utf8')).toBe('str');
  });

  it('write/resize delegate to the IPty; kill terminates via killTree, not proc.kill() directly (Windows crash workaround)', () => {
    const fake = makeFakeIPty();
    const fakeKill = makeFakeKillTree();
    const handle = runPty('node', ptyArgv([]), emptyOpts(), fake.spawn, fakeKill.killTree);
    handle.write('ls\r');
    handle.resize(120, 40);
    handle.kill();
    expect(fake.calls.writes).toEqual(['ls\r']);
    expect(fake.calls.resizes).toEqual([[120, 40]]);
    expect(fakeKill.pids).toEqual([fake.ipty.pid]);
    expect(fake.calls.killed).toBe(0);
  });

  it('kill: falls back to proc.kill() if onExit has not fired 5s after the external kill', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeIPty();
      const fakeKill = makeFakeKillTree();
      const handle = runPty('node', ptyArgv([]), emptyOpts(), fake.spawn, fakeKill.killTree);
      handle.kill();
      expect(fake.calls.killed).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(fake.calls.killed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill: skips the proc.kill() fallback once the external kill causes a natural exit', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeIPty();
      const fakeKill = makeFakeKillTree();
      const handle = runPty('node', ptyArgv([]), emptyOpts(), fake.spawn, fakeKill.killTree);
      handle.kill();
      fake.emitExit(0); // the external kill reaching the child, driving the natural-exit path
      vi.advanceTimersByTime(5000);
      expect(fake.calls.killed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborting the signal kills the pty via killTree (reuses the cancel seam)', () => {
    const fake = makeFakeIPty();
    const fakeKill = makeFakeKillTree();
    const ac = new AbortController();
    runPty('node', ptyArgv([]), { ...emptyOpts(), signal: ac.signal }, fake.spawn, fakeKill.killTree);
    expect(fakeKill.pids).toEqual([]);
    ac.abort();
    expect(fakeKill.pids).toEqual([fake.ipty.pid]);
  });

  it('an already-aborted signal kills immediately via killTree', () => {
    const fake = makeFakeIPty();
    const fakeKill = makeFakeKillTree();
    const ac = new AbortController();
    ac.abort();
    runPty('node', ptyArgv([]), { ...emptyOpts(), signal: ac.signal }, fake.spawn, fakeKill.killTree);
    expect(fakeKill.pids).toEqual([fake.ipty.pid]);
  });
});

function emptyOpts() {
  return { cwd: 'C:/tmp', env: {} as Record<string, string | undefined>, signal: new AbortController().signal, cols: 80, rows: 24 };
}
