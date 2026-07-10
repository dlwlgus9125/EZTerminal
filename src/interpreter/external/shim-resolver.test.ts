import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandResolver, type EnvLike } from './command-resolver';
import { resolveShimTarget } from './shim-resolver';

// Fixtures below are real captured shim text (see shim-resolver.ts module doc
// for where each was pulled from), plus a couple of synthetic variants to
// exercise .mjs / extensionless-`run` targets that weren't present verbatim
// in the installed shims this repo happened to have on hand.

const CLAUDE_CMD = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

const CODEX_CMD = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

const ESLINT_CMD = `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\eslint\\bin\\eslint.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\..\\eslint\\bin\\eslint.js" %*
)
`;

const MJS_CMD = `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\some-pkg\\bin\\cli.mjs" %*
) ELSE (
  node  "%~dp0\\..\\some-pkg\\bin\\cli.mjs" %*
)
`;

const RUN_CMD = `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\some-pkg\\bin\\run" %*
) ELSE (
  node  "%~dp0\\..\\some-pkg\\bin\\run" %*
)
`;

const CJS_CMD = `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\..\\some-pkg\\bin\\cli.cjs" %*
) ELSE (
  node  "%~dp0\\..\\some-pkg\\bin\\cli.cjs" %*
)
`;

// yarn-classic-shaped: a single unquoted `node`, no `_prog`/node.exe-check
// pattern — our node-form regex requires two adjacent quoted tokens, so this
// is deliberately unrecognized rather than guessed at.
const YARN_CLASSIC_CMD = `@ECHO off
SET "YARN_IGNORE_PATH=1"
SET PATHEXT=%PATHEXT:;.JS;=;%
node "%~dp0\\..\\lib\\cli.js" %*
`;

function pathEnv(dir: string): EnvLike {
  return { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
}

describe('resolveShimTarget', () => {
  it('a non-.cmd/.bat path returns null without reading the file', () => {
    let readCalled = false;
    const result = resolveShimTarget('C:\\tools\\thing.exe', {}, () => {
      readCalled = true;
      return '';
    });
    expect(result).toBeNull();
    expect(readCalled).toBe(false);
  });

  it('readFile throwing returns null', () => {
    const result = resolveShimTarget('C:\\npm\\claude.cmd', {}, () => {
      throw new Error('EPERM');
    });
    expect(result).toBeNull();
  });

  it('an unrecognized (yarn-classic-shaped) shim returns null', () => {
    expect(resolveShimTarget('C:\\npm\\yarn.cmd', {}, () => YARN_CLASSIC_CMD)).toBeNull();
  });

  it('garbage text returns null', () => {
    expect(resolveShimTarget('C:\\npm\\garbage.cmd', {}, () => 'not a shim at all')).toBeNull();
  });

  describe('direct form (claude.cmd)', () => {
    it('resolves the .exe target directly, with no prefixArgs', () => {
      const shimPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
      // The target is a fabricated path (no real disk backing it), so inject
      // `exists: () => true` to exercise the "target found" branch hermetically.
      const result = resolveShimTarget(shimPath, {}, () => CLAUDE_CMD, undefined, () => true);
      expect(result).toEqual({
        file: join(
          dirname(shimPath),
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'bin',
          'claude.exe',
        ),
        prefixArgs: [],
      });
    });

    it('returns null when the target does not exist (mis-installed shim)', () => {
      const shimPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
      const result = resolveShimTarget(shimPath, {}, () => CLAUDE_CMD, undefined, () => false);
      expect(result).toBeNull();
    });

    it('accepts a .bat extension too (not just .cmd)', () => {
      const shimPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.bat';
      const result = resolveShimTarget(shimPath, {}, () => CLAUDE_CMD, undefined, () => true);
      expect(result).toEqual({
        file: join(
          dirname(shimPath),
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'bin',
          'claude.exe',
        ),
        prefixArgs: [],
      });
    });
  });

  describe('node form', () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'ezterm-shim-'));
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('(codex.cmd, %_prog% shape) prefers a node.exe next to the shim', () => {
      writeFileSync(join(dir, 'node.exe'), '');
      const shimPath = join(dir, 'codex.cmd');
      // env is deliberately empty (no PATH) — if the code fell through to the
      // resolver fallback instead of using the local node.exe, this would
      // resolve to null, so a non-null result here proves the local branch won.
      const result = resolveShimTarget(shimPath, {}, () => CODEX_CMD);
      expect(result).toEqual({
        file: join(dir, 'node.exe'),
        prefixArgs: [join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')],
      });
    });

    it('(eslint.CMD shape, literal node.exe check) resolves the target .js, collapsing "..\\"', () => {
      const shimPath = join(dir, 'eslint.CMD');
      const result = resolveShimTarget(shimPath, {}, () => ESLINT_CMD);
      expect(result).toEqual({
        file: join(dir, 'node.exe'),
        prefixArgs: [join(dir, '..', 'eslint', 'bin', 'eslint.js')],
      });
    });

    it('resolves an .mjs target', () => {
      const shimPath = join(dir, 'thing.cmd');
      const result = resolveShimTarget(shimPath, {}, () => MJS_CMD);
      expect(result).toEqual({
        file: join(dir, 'node.exe'),
        prefixArgs: [join(dir, '..', 'some-pkg', 'bin', 'cli.mjs')],
      });
    });

    it('resolves a .cjs target', () => {
      const shimPath = join(dir, 'thing.cmd');
      const result = resolveShimTarget(shimPath, {}, () => CJS_CMD);
      expect(result).toEqual({
        file: join(dir, 'node.exe'),
        prefixArgs: [join(dir, '..', 'some-pkg', 'bin', 'cli.cjs')],
      });
    });

    it('resolves an extensionless "run" target', () => {
      const shimPath = join(dir, 'thing.cmd');
      const result = resolveShimTarget(shimPath, {}, () => RUN_CMD);
      expect(result).toEqual({
        file: join(dir, 'node.exe'),
        prefixArgs: [join(dir, '..', 'some-pkg', 'bin', 'run')],
      });
    });

    it('falls back to a PATH-resolved node when no local node.exe sits next to the shim', () => {
      const shimDir = mkdtempSync(join(tmpdir(), 'ezterm-shim-noNode-'));
      const nodeDir = mkdtempSync(join(tmpdir(), 'ezterm-shim-nodeOnPath-'));
      try {
        writeFileSync(join(nodeDir, 'node.exe'), '');
        const shimPath = join(shimDir, 'codex.cmd');
        const resolver = new CommandResolver(pathEnv(nodeDir));
        const result = resolveShimTarget(shimPath, {}, () => CODEX_CMD, resolver);
        // CommandResolver returns the PATHEXT-cased extension (e.g. `node.EXE`,
        // see command-resolver.test.ts) — compare the file path case-insensitively.
        expect(result?.file.toLowerCase()).toBe(join(nodeDir, 'node.exe').toLowerCase());
        expect(result?.prefixArgs).toEqual([
          join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        ]);
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
        rmSync(nodeDir, { recursive: true, force: true });
      }
    });

    it('returns null when neither a local node.exe nor a PATH-resolved node exists', () => {
      const shimDir = mkdtempSync(join(tmpdir(), 'ezterm-shim-noNode-'));
      try {
        const shimPath = join(shimDir, 'codex.cmd');
        const resolver = new CommandResolver(pathEnv(join(tmpdir(), 'ezterm-nowhere-xyz')));
        expect(resolveShimTarget(shimPath, {}, () => CODEX_CMD, resolver)).toBeNull();
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
      }
    });

    it('returns null when PATH resolves "node" to another shim (shell: true) instead of a real .exe', () => {
      const shimDir = mkdtempSync(join(tmpdir(), 'ezterm-shim-noNode-'));
      const nodeDir = mkdtempSync(join(tmpdir(), 'ezterm-shim-nodeShim-'));
      try {
        writeFileSync(join(nodeDir, 'node.cmd'), '');
        const shimPath = join(shimDir, 'codex.cmd');
        const resolver = new CommandResolver(pathEnv(nodeDir));
        expect(resolveShimTarget(shimPath, {}, () => CODEX_CMD, resolver)).toBeNull();
      } finally {
        rmSync(shimDir, { recursive: true, force: true });
        rmSync(nodeDir, { recursive: true, force: true });
      }
    });
  });
});
