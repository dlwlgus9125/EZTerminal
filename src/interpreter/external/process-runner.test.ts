import { spawn as nodeSpawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { runProcess, type RunOptions, type SpawnFn } from './process-runner';

// These tests spawn the REAL node binary (process.execPath) so the streaming +
// cancellation behavior is exercised against an actual OS process, not a mock.

function opts(signal: AbortSignal): RunOptions {
  return { cwd: process.cwd(), env: process.env, signal };
}

async function collectText(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of bytes) out += decoder.decode(chunk, { stream: true });
  out += decoder.decode();
  return out;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess', () => {
  it('streams stdout and stderr merged as a byte stream, exit code 0', async () => {
    const proc = runProcess(
      process.execPath,
      ['-e', "process.stdout.write('out-A'); process.stderr.write('err-B')"],
      opts(new AbortController().signal),
    );
    const text = await collectText(proc.bytes);
    expect(text).toContain('out-A');
    expect(text).toContain('err-B');
    const { code } = await proc.exit;
    expect(code).toBe(0);
  });

  it('surfaces a non-zero exit code', async () => {
    const proc = runProcess(
      process.execPath,
      ['-e', 'process.exit(3)'],
      opts(new AbortController().signal),
    );
    await collectText(proc.bytes);
    const { code } = await proc.exit;
    expect(code).toBe(3);
  });

  it('KILLS the child on abort — the OS process actually terminates (no leak)', async () => {
    const ac = new AbortController();
    // Runs forever until killed.
    const proc = runProcess(
      process.execPath,
      ['-e', 'setInterval(() => process.stdout.write("tick\\n"), 50)'],
      opts(ac.signal),
    );

    const pid = proc.pid;
    expect(typeof pid).toBe('number');
    expect(isAlive(pid as number)).toBe(true);

    // Drain in the background like a real consumer, and wait for first output so
    // we know the child is genuinely running before we cancel.
    let bytesSeen = 0;
    const drained = (async () => {
      for await (const chunk of proc.bytes) bytesSeen += chunk.length;
    })();
    await waitFor(() => bytesSeen > 0, 'first output from forever-child');

    ac.abort();

    // The exit promise resolves (the child exited) and the stream completes.
    await proc.exit;
    await drained;

    // Strong no-leak assertion: the OS process id is gone (ESRCH).
    await waitFor(() => !isAlive(pid as number), 'child process terminated');
    expect(isAlive(pid as number)).toBe(false);
  });

  it('rejects the byte stream on spawn failure; exit never rejects', async () => {
    const proc = runProcess(
      'C:/no/such/binary-xyz.exe',
      [],
      opts(new AbortController().signal),
    );
    await expect(collectText(proc.bytes)).rejects.toThrow();
    // exit resolves (does not reject) so an unconsumed promise can't crash us.
    await expect(proc.exit).resolves.toBeDefined();
  });

  // AC-8: an external command with nothing wired to its stdin must not hang
  // waiting for input (e.g. when it is the destination of a pipe into a builtin).
  it('spawns with array-form stdio that closes stdin (not the "ignore" shorthand, which would also drop stdout/stderr capture)', async () => {
    let captured: SpawnOptions | undefined;
    const spy: SpawnFn = (file, args, options) => {
      captured = options;
      return nodeSpawn(file, args, options);
    };
    const proc = runProcess(
      process.execPath,
      ['-e', "process.stdout.write('ok')"],
      opts(new AbortController().signal),
      spy,
    );
    await collectText(proc.bytes);
    await proc.exit;
    expect(captured?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('does not hang waiting for stdin — the child sees immediate EOF', async () => {
    const proc = runProcess(
      process.execPath,
      [
        '-e',
        'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.exit(42)); process.stdin.resume();',
      ],
      opts(new AbortController().signal),
    );
    await collectText(proc.bytes);
    const { code } = await proc.exit;
    expect(code).toBe(42);
  });
});
