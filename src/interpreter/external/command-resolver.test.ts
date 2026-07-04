import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandResolver, type EnvLike } from './command-resolver';

// Resolution probes the filesystem for existence only (it never runs anything),
// so empty files standing in for executables are enough to exercise PATHEXT,
// `.bat`/`.cmd` (raw path + shell flag), and direct `.exe` launch on Windows.
//
// NOTE: the resolver no longer hand-wraps `.bat`/`.cmd` in `cmd.exe /c` — it returns
// the RAW script path with `shell: true`, and the ProcessRunner spawns it via
// cross-spawn, which does the cmd.exe wrapping AND correct arg escaping (SEC-HIGH-1).

let dir: string;
const COMSPEC = 'C:\\Windows\\System32\\cmd.exe';

// The resolver returns the path with the extension case taken from PATHEXT
// (e.g. `native.EXE`). Windows paths are case-insensitive, so compare folded.
const lower = (s: string): string => s.toLowerCase();

function env(overrides: Partial<EnvLike> = {}): EnvLike {
  return {
    PATH: dir,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: COMSPEC,
    ...overrides,
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezterm-resolve-'));
  await writeFile(join(dir, 'native.exe'), '');
  await writeFile(join(dir, 'script.bat'), '');
  await writeFile(join(dir, 'helper.cmd'), '');
  // A name available as BOTH .exe and .cmd, to prove PATHEXT order decides.
  await writeFile(join(dir, 'dual.exe'), '');
  await writeFile(join(dir, 'dual.cmd'), '');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CommandResolver', () => {
  it('resolves a .exe directly with the user args (no shell string, no escaping)', () => {
    const spec = new CommandResolver(env()).resolve('native', ['--flag', 'value']);
    expect(spec).not.toBeNull();
    expect(lower(spec!.file)).toBe(lower(join(dir, 'native.exe')));
    expect(spec!.args).toEqual(['--flag', 'value']);
    expect(spec!.shell).toBe(false);
  });

  it('returns the RAW .bat path + shell flag (cmd.exe wrapping delegated to cross-spawn)', () => {
    const spec = new CommandResolver(env()).resolve('script', ['arg1']);
    expect(spec).not.toBeNull();
    expect(lower(spec!.file)).toBe(lower(join(dir, 'script.bat')));
    // The user's args are passed through unescaped — cross-spawn quotes them.
    expect(spec!.args).toEqual(['arg1']);
    expect(spec!.shell).toBe(true);
  });

  it('returns the RAW .cmd path + shell flag', () => {
    const spec = new CommandResolver(env()).resolve('helper', []);
    expect(spec).not.toBeNull();
    expect(lower(spec!.file)).toBe(lower(join(dir, 'helper.cmd')));
    expect(spec!.args).toEqual([]);
    expect(spec!.shell).toBe(true);
  });

  it('honors PATHEXT order: .EXE before .CMD picks the .exe', () => {
    const spec = new CommandResolver(env({ PATHEXT: '.EXE;.CMD' })).resolve('dual', []);
    expect(lower(spec!.file)).toBe(lower(join(dir, 'dual.exe')));
    expect(spec!.shell).toBe(false);
  });

  it('honors PATHEXT order: .CMD before .EXE picks the .cmd (shell target)', () => {
    const spec = new CommandResolver(env({ PATHEXT: '.CMD;.EXE' })).resolve('dual', []);
    expect(lower(spec!.file)).toBe(lower(join(dir, 'dual.cmd')));
    expect(spec!.shell).toBe(true);
  });

  it('searches multiple PATH directories in order', () => {
    const other = join(tmpdir(), 'definitely-not-a-real-dir-xyz');
    const spec = new CommandResolver(env({ PATH: `${other}${delimiter}${dir}` })).resolve(
      'native',
      [],
    );
    expect(lower(spec!.file)).toBe(lower(join(dir, 'native.exe')));
  });

  it('falls back to the default PATHEXT when unset', () => {
    const e = env();
    delete e.PATHEXT;
    const spec = new CommandResolver(e).resolve('script', []);
    expect(lower(spec!.file)).toBe(lower(join(dir, 'script.bat'))); // .BAT is in the default PATHEXT
    expect(spec!.shell).toBe(true);
  });

  it('does a case-insensitive env lookup (Windows Path/Pathext)', () => {
    const spec = new CommandResolver({
      Path: dir,
      Pathext: '.EXE',
      comspec: COMSPEC,
    }).resolve('native', []);
    expect(lower(spec!.file)).toBe(lower(join(dir, 'native.exe')));
  });

  it('returns null when the command is not found on PATH', () => {
    expect(new CommandResolver(env()).resolve('nonexistent-tool', [])).toBeNull();
  });
});
