import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';

import { packagedExePath } from './paths';
import { buildCmdLine } from '../src/interpreter/external/build-cmd-line';

// M5 packaged smoke +1: proves the M1 batch-shim PTY path (cmd.exe + buildCmdLine
// + node-pty's Windows single-string args) works against the REAL packaged
// node-pty binary, not just under vitest. Mirrors pty-packaged.spec.ts's pattern
// — load node-pty directly from app.asar.unpacked, since driving the actual UI is
// impossible under the production fuses (see that file's header comment) — but
// spawns through the exact cmd.exe + buildCmdLine shape M1's resolveExternal
// produces, against the same real .cmd fixture e2e/pty.spec.ts's dev-mode
// batch-shim test uses.

const require = createRequire(__filename);
const CMD_FIXTURE = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'pty-echo.cmd');

function unpackedNodePtyDir(): string {
  return path.join(
    path.dirname(packagedExePath()),
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  );
}

test('packaged batch shim: cmd.exe + buildCmdLine + packaged node-pty spawns a real .cmd TUI', async () => {
  const dir = unpackedNodePtyDir();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require(dir) as typeof import('node-pty');

  const commandLine = buildCmdLine(CMD_FIXTURE, []);
  const comspec = process.env.ComSpec ?? 'cmd.exe';
  const proc = pty.spawn(comspec, commandLine, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: path.dirname(CMD_FIXTURE),
    env: process.env as Record<string, string>,
  });

  const output = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`packaged batch-shim PTY spawn timed out; got: ${JSON.stringify(buf)}`)),
      15_000,
    );
    proc.onData((d) => {
      buf += d;
      if (buf.includes('READY')) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
    proc.onExit(() => {
      clearTimeout(timer);
      resolve(buf);
    });
  });

  expect(output).toContain('READY');
  // Resume-then-kill (pty-runner.ts's `killOnce` pattern): a bare kill() on a
  // live ConPTY can race its internal console-list teardown helper and print a
  // benign but noisy "AttachConsole failed" crash to stderr.
  try {
    proc.resume();
  } catch {
    // Socket already gone.
  }
  try {
    proc.kill();
  } catch {
    // Already exited / handle released.
  }
});
