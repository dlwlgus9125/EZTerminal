import { describe, it, expect } from 'vitest';
import * as pty from 'node-pty';

// M1 guard: proves the node-pty NAPI prebuild actually loads AND round-trips a
// real PTY spawn under the test runtime. The packaged/Electron ABI path is
// covered separately by the packaged smoke test (M6); this proves the module is
// installed, native binaries resolve, and a PTY produces output + exits.
describe('node-pty native module', () => {
  it('loads and round-trips a real PTY spawn', async () => {
    const marker = `PTY_OK_${process.pid}`;
    const proc = pty.spawn(
      process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(marker)})`],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
      },
    );

    const output = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new Error(`node-pty spawn timed out; got: ${JSON.stringify(buf)}`)),
        10_000,
      );
      proc.onData((d) => {
        buf += d;
      });
      proc.onExit(() => {
        clearTimeout(timer);
        resolve(buf);
      });
    });

    // ConPTY wraps output in terminal control sequences, so assert containment.
    expect(output).toContain(marker);
  }, 15_000);
});
