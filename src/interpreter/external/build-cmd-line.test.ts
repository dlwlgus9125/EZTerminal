import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { buildCmdLine } from './build-cmd-line';
import { CommandResolver } from './command-resolver';
import { runPty, ptyCommandLine } from './pty-runner';

describe('buildCmdLine (pure)', () => {
  // Expected strings below were computed by running this exact ported algorithm
  // (same regexes as cross-spawn/lib/util/escape.js) rather than hand-derived, to
  // avoid baking a manual-arithmetic mistake into the test itself. The real
  // correctness assurance for the escaping is the node-pty pass-through suite
  // below, which asserts what a real cmd.exe + child process actually observes.
  it('no args', () => {
    expect(buildCmdLine('C:\\fixtures\\tool.cmd', [])).toBe('/d /s /c "C:\\fixtures\\tool.cmd"');
  });

  it('a plain argument', () => {
    expect(buildCmdLine('C:\\fixtures\\tool.cmd', ['hello'])).toBe(
      '/d /s /c "C:\\fixtures\\tool.cmd ^"hello^""',
    );
  });

  it.each([
    ['a space', 'a b', '^"a^ b^"'],
    ['&', 'a&b', '^"a^&b^"'],
    ['|', 'a|b', '^"a^|b^"'],
    ['^', 'a^b', '^"a^^b^"'],
    ['%VAR%', '%VAR%', '^"^%VAR^%^"'],
    ['nested "', 'say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['!', '!bang!', '^"^!bang^!^"'],
    ['< >', '<>', '^"^<^>^"'],
  ])('escapes %s so no bare metachar survives the wrap', (_label, rawArg, expectedEscaped) => {
    expect(buildCmdLine('C:\\fixtures\\tool.cmd', [rawArg])).toBe(
      `/d /s /c "C:\\fixtures\\tool.cmd ${expectedEscaped}"`,
    );
  });

  it('double-escapes metachars for a node_modules/.bin/*.cmd shim target', () => {
    expect(buildCmdLine('C:\\proj\\node_modules\\.bin\\tool.cmd', ['x'])).toBe(
      '/d /s /c "C:\\proj\\node_modules\\.bin\\tool.cmd ^^^"x^^^""',
    );
  });
});

// M0b gate: "node-pty 관통 적대 테스트는 buildCmdLine 출력 단언이 아니라 자식
// 프로세스가 관측한 argv를 단언" — spawn a real batch fixture through a real
// ConPTY and assert what the child process actually received, not what our own
// string-building code claims it produced.
describe('buildCmdLine — node-pty pass-through (real ConPTY, real cmd.exe)', () => {
  function makeArgvFixture(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-buildcmdline-'));
    const cmd = path.join(dir, 'argv-echo.cmd');
    // Batch's `%*` forwards all received parameters verbatim into the node
    // invocation; node -e's process.argv (minus execPath) is exactly those
    // parameters as cmd.exe's own tokenizer split them.
    writeFileSync(cmd, '@echo off\r\nnode -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n');
    return cmd;
  }

  // Strip ConPTY's own CSI/OSC noise (prelude + any repaint bracketing, see
  // .omc/research/pty-signal-measurements.md) so the JSON array can be found by a
  // simple bracket match instead of a regex that has to reason about escape codes.
  function stripAnsi(text: string): string {
    /* eslint-disable no-control-regex -- matching literal ESC/control bytes is the point */
    return text
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL|ST
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') // CSI ... letter
      .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, ''); // remaining control chars
    /* eslint-enable no-control-regex */
  }

  function capturePty(file: string, args: ReturnType<typeof ptyCommandLine>, cwd: string) {
    return new Promise<string>((resolve, reject) => {
      let out = '';
      const handle = runPty(file, args, {
        cwd,
        env: process.env,
        signal: new AbortController().signal,
        cols: 80,
        rows: 24,
      });
      const timer = setTimeout(() => reject(new Error(`timed out, got: ${out}`)), 15_000);
      handle.onData((b) => {
        out += Buffer.from(b).toString('utf8');
      });
      handle.onExit(() => {
        clearTimeout(timer);
        resolve(out);
      });
    });
  }

  it(
    'round-trips adversarial argv (&, |, ^, %VAR%, nested ", !, spaces) through cmd.exe unmangled',
    async () => {
      const fixture = makeArgvFixture();
      const cmdSpec = new CommandResolver(process.env).resolve('cmd.exe', []);
      expect(cmdSpec).not.toBeNull();

      const testArgs = [
        'a&b',
        'a|b',
        'a^b',
        '%PATH%',
        'say "hi" now',
        'bang!here',
        'with space',
        'plain',
      ];
      const out = await capturePty(
        cmdSpec!.file,
        ptyCommandLine(buildCmdLine(fixture, testArgs)),
        path.dirname(fixture),
      );

      const match = stripAnsi(out).match(/\[.*\]/s);
      expect(match).not.toBeNull();
      const observedArgv = JSON.parse(match![0]);
      expect(observedArgv).toEqual(testArgs);

      // The decisive SEC-HIGH-1 assertion: %PATH% must survive as the literal
      // string, NOT get expanded by cmd.exe into the real (much longer) PATH value.
      expect(observedArgv).toContain('%PATH%');
    },
    20_000,
  );
});
