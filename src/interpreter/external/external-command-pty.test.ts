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

  it('non-interactive external still returns a byte-stream (text path unchanged)', () => {
    const resolve = createExternalResolver();
    const data = resolve(makeCommand('node'), makeCtx());
    expect(data.kind).toBe('byte-stream');
  });
});
