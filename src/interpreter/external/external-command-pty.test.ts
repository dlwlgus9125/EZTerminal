import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import type { IPty } from 'node-pty';

import type { Command } from '../core/ast';
import { EvalError } from '../core/errors';
import type { EvalContext } from '../core/types';
import { createExternalResolver } from './external-command';
import type { PtyArgs, PtySpawnFn } from './pty-runner';

function makeCommand(name: string): Command {
  return { type: 'command', name, nameSpan: { start: 0, end: name.length }, args: [] };
}

/** Like {@link makeCommand}, but with positional string-literal user args. */
function commandWithArgs(name: string, userArgs: string[]): Command {
  return {
    type: 'command',
    name,
    nameSpan: { start: 0, end: name.length },
    args: userArgs.map((value) => ({
      kind: 'positional' as const,
      expr: { type: 'string' as const, value, span: { start: 0, end: value.length } },
    })),
  };
}

function makeCtx(): EvalContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
    // session is unused on the resolveExternal path.
    session: {} as EvalContext['session'],
  };
}

/** Minimal fake node-pty spawner so the test never spawns a real PTY. */
const fakePtySpawn: PtySpawnFn = () =>
  ({
    pid: 1,
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    write() {},
    resize() {},
    kill() {},
    clear() {},
    pause() {},
    resume() {},
  }) as unknown as IPty;

describe('createExternalResolver — interactive (PTY) path', () => {
  it('interactive non-batch external returns a pty-stream and spawns via the injected ptySpawn', () => {
    let spawnedFile: string | null = null;
    const spawn: PtySpawnFn = (file, args, options) => {
      spawnedFile = file;
      return fakePtySpawn(file, args, options);
    };
    const resolve = createExternalResolver(undefined, spawn);

    // `node` resolves to node.exe on PATH (non-batch) → pty-stream.
    const data = resolve(makeCommand('node'), makeCtx(), { interactive: true });
    expect(data.kind).toBe('pty-stream');
    if (data.kind === 'pty-stream') {
      data.spawn(80, 24); // lazy spawn → exercises runPty with the injected spawner
    }
    expect(spawnedFile).toMatch(/node(\.exe)?$/i);
  });

  it('interactive non-existent command throws command-not-found', () => {
    const resolve = createExternalResolver(undefined, fakePtySpawn);
    expect(() =>
      resolve(makeCommand('definitely-not-a-real-cmd-xyz'), makeCtx(), { interactive: true }),
    ).toThrow(EvalError);
  });

  // M1: batch (.bat/.cmd) shims now spawn via PTY too — cmd.exe as the spawned
  // file, a buildCmdLine()-assembled command-line string as args (node-pty's
  // Windows single-string args path, not the argv-array path).
  it('(M1) explicit `!` (forceXterm) on a batch (.bat/.cmd) returns a pty-stream spawned via cmd.exe', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-pty-'));
    const bat = path.join(dir, 'tool.bat');
    writeFileSync(bat, '@echo off\r\necho hi\r\n');

    let spawnedFile: string | null = null;
    let spawnedArgs: PtyArgs | null = null;
    const spawn: PtySpawnFn = (file, args, options) => {
      spawnedFile = file;
      spawnedArgs = args;
      return fakePtySpawn(file, args, options);
    };
    const resolve = createExternalResolver(undefined, spawn);
    const data = resolve(makeCommand(bat), makeCtx(), { interactive: true, forceXterm: true });
    expect(data.kind).toBe('pty-stream');
    if (data.kind === 'pty-stream') {
      expect(data.forceXterm).toBe(true);
      data.spawn(80, 24);
    }
    expect(spawnedFile).toMatch(/cmd\.exe$/i);
    expect(spawnedArgs).not.toBeNull();
    const args = spawnedArgs as unknown as PtyArgs;
    expect(args.kind).toBe('commandLine');
    if (args.kind === 'commandLine') {
      expect(args.commandLine).toMatch(/^\/d \/s \/c "/);
      expect(args.commandLine).toContain('tool.bat');
    }
  });

  it('(M1) auto-routed interactive batch (bare command, no `!`) also returns a pty-stream', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-pty-'));
    const bat = path.join(dir, 'tool.bat');
    writeFileSync(bat, '@echo off\r\necho hi\r\n');

    const resolve = createExternalResolver(undefined, fakePtySpawn);
    const data = resolve(makeCommand(bat), makeCtx(), { interactive: true });
    expect(data.kind).toBe('pty-stream');
    if (data.kind === 'pty-stream') {
      expect(data.forceXterm).toBeUndefined();
    }
  });

  // fix-ctrlc-treekill: a shim that de-sugars cleanly (shim-resolver.ts) spawns
  // its real target DIRECTLY via ptyArgv — no cmd.exe in between — so the
  // target becomes the PTY's console group leader and Ctrl+C's CTRL_C_EVENT
  // can't be intercepted by cmd.exe's batch-job terminator first.
  it('(fix-ctrlc-treekill) a node-form .cmd shim de-sugars to node.exe via ptyArgv, not cmd.exe', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-pty-'));
    const cmd = path.join(dir, 'shim.cmd');
    // Mirrors a real npm cmd-shim's launch line (shim-resolver.ts's node-form:
    // a quoted `%_prog%`/node.exe token immediately followed by a quoted
    // `%dp0%`-relative script path, then `%*`) — NOT the simpler `node "%~dp0x.js"
    // %*` shape the repo's own hand-written e2e fixtures use, which the real
    // resolver deliberately does not recognize (see shim-resolver.ts's doc
    // comment on the two shapes it confidently de-sugars).
    writeFileSync(
      cmd,
      '@echo off\r\nSETLOCAL\r\nSET "dp0=%~dp0"\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n',
    );

    let spawnedFile: string | null = null;
    let spawnedArgs: PtyArgs | null = null;
    const spawn: PtySpawnFn = (file, args, options) => {
      spawnedFile = file;
      spawnedArgs = args;
      return fakePtySpawn(file, args, options);
    };
    const resolve = createExternalResolver(undefined, spawn);
    const data = resolve(makeCommand(cmd), makeCtx(), { interactive: true, forceXterm: true });
    expect(data.kind).toBe('pty-stream');
    if (data.kind === 'pty-stream') {
      data.spawn(80, 24);
    }

    // Not cmd.exe: the resolved node target, spawned via the argv path (the
    // prefix arg is the shim's own cli.js, then the user's args — none here).
    expect(spawnedFile).toMatch(/node(\.exe)?$/i);
    expect(spawnedFile).not.toMatch(/cmd\.exe$/i);
    expect(spawnedArgs).not.toBeNull();
    const args = spawnedArgs as unknown as PtyArgs;
    expect(args.kind).toBe('argv');
    if (args.kind === 'argv') {
      expect(args.argv).toEqual([path.join(dir, 'cli.js')]);
    }
  });

  // fix-ctrlc-treekill: the de-sugared target's own prefixArgs (e.g. the
  // shim's cli.js) must come BEFORE the user's own args, not after or
  // interleaved — the prior test above passes zero user args, which can't
  // distinguish "prepend" from "append" or a swapped order.
  it('(fix-ctrlc-treekill) prefixArgs precede the user\'s own args in the final argv', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-pty-'));
    const cmd = path.join(dir, 'shim.cmd');
    writeFileSync(
      cmd,
      '@echo off\r\nSETLOCAL\r\nSET "dp0=%~dp0"\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\cli.js" %*\r\n',
    );

    let spawnedArgs: PtyArgs | null = null;
    const spawn: PtySpawnFn = (file, args, options) => {
      spawnedArgs = args;
      return fakePtySpawn(file, args, options);
    };
    const resolve = createExternalResolver(undefined, spawn);
    const data = resolve(commandWithArgs(cmd, ['--foo', 'bar']), makeCtx(), {
      interactive: true,
      forceXterm: true,
    });
    expect(data.kind).toBe('pty-stream');
    if (data.kind === 'pty-stream') {
      data.spawn(80, 24);
    }

    expect(spawnedArgs).not.toBeNull();
    const args = spawnedArgs as unknown as PtyArgs;
    expect(args.kind).toBe('argv');
    if (args.kind === 'argv') {
      expect(args.argv).toEqual([path.join(dir, 'cli.js'), '--foo', 'bar']);
    }
  });

  // Fallback preserved: an un-parseable shim (shim-resolver.ts returns null)
  // still routes through the pre-existing cmd.exe + buildCmdLine path — the
  // guard-pty-routing.mjs invariant this file already locks in.
  it('(fix-ctrlc-treekill) an un-parseable .cmd shim still falls back to cmd.exe + commandLine', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-pty-'));
    const bat = path.join(dir, 'tool.cmd');
    // Not the recognized `node "%~dp0<script>" %*` (or exe-form) shape —
    // shim-resolver.ts can't de-sugar this, so the fallback must fire.
    writeFileSync(bat, '@echo off\r\necho hi\r\n');

    let spawnedFile: string | null = null;
    let spawnedArgs: PtyArgs | null = null;
    const spawn: PtySpawnFn = (file, args, options) => {
      spawnedFile = file;
      spawnedArgs = args;
      return fakePtySpawn(file, args, options);
    };
    const resolve = createExternalResolver(undefined, spawn);
    const data = resolve(makeCommand(bat), makeCtx(), { interactive: true });
    expect(data.kind).toBe('pty-stream');
    if (data.kind === 'pty-stream') {
      data.spawn(80, 24);
    }

    expect(spawnedFile).toMatch(/cmd\.exe$/i);
    expect(spawnedArgs).not.toBeNull();
    const args = spawnedArgs as unknown as PtyArgs;
    expect(args.kind).toBe('commandLine');
    if (args.kind === 'commandLine') {
      expect(args.commandLine).toContain('tool.cmd');
    }
  });

  it('non-interactive external still returns a byte-stream (text path unchanged)', () => {
    const resolve = createExternalResolver();
    const data = resolve(makeCommand('node'), makeCtx());
    expect(data.kind).toBe('byte-stream');
  });
});
