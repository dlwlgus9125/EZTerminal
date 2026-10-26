import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { completeLine } from './core/complete';
import { completionSource, listCompletionDirectory, listPathExecutables } from './completion-fs';

let root: string;
let tools: string;

beforeAll(() => {
  // The runner's TEMP can be an 8.3 alias; work in the long path, as the shell would show it.
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ez-complete-')));
  mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true });
  mkdirSync(path.join(root, 'Program Files', 'Tool'), { recursive: true });
  mkdirSync(path.join(root, '한글 폴더'));
  writeFileSync(path.join(root, 'setup.cmd'), '@echo off\r\n');
  writeFileSync(path.join(root, '.env'), 'X=1');
  writeFileSync(path.join(root, 'src', 'render.ts'), '');
  try { symlinkSync(path.join(root, 'src'), path.join(root, 'src-link'), 'junction'); } catch { /* Junctions need no privilege; ignore if refused. */ }
  tools = path.join(root, 'tools');
  mkdirSync(tools);
  writeFileSync(path.join(tools, 'ezfake.exe'), '');
  writeFileSync(path.join(tools, 'ezfake.cmd'), '');
  writeFileSync(path.join(tools, 'ezother.bat'), '');
  writeFileSync(path.join(tools, 'ezreadme.txt'), '');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({ PATH: tools, PATHEXT: '.EXE;.BAT;.CMD', ...extra });

describe('completion on the real filesystem', () => {
  it('lists a folder, a junction to a folder counting as a folder', async () => {
    const entries = await listCompletionDirectory(root, Date.now() + 5_000);
    const byName = new Map(entries!.map((entry) => [entry.name, entry.directory]));
    expect(byName.get('src')).toBe(true);
    expect(byName.get('setup.cmd')).toBe(false);
    if (byName.has('src-link')) expect(byName.get('src-link')).toBe(true);
    expect(await listCompletionDirectory(path.join(root, 'missing'), Date.now() + 5_000)).toBeNull();
  });

  it('finds PATH executables by PATHEXT, once per name, without the extension', async () => {
    const names = await listPathExecutables(env(), Date.now() + 5_000);
    expect([...names].sort()).toEqual(['ezfake', 'ezother']);
  });

  it('completes names with spaces and Korean letters into words the shell reads back', async () => {
    const source = () => completionSource({ cwd: root, env: env(), builtins: ['cd', 'ls'], budgetMs: 5_000 });
    const spaced = await completeLine('cd Prog', 7, source());
    expect(spaced).toMatchObject({ ok: true, commonText: '"Program Files\\\\"', commonCaretBack: 1 });
    const korean = await completeLine('cd 한', 4, source());
    expect(korean).toMatchObject({ ok: true, commonText: '"한글 폴더\\\\"', commonCaretBack: 1 });
    const nested = await completeLine('ls src\\re', 9, source());
    if (!nested.ok) throw new Error('expected candidates');
    expect(nested.candidates.map((candidate) => candidate.label)).toEqual(['renderer\\', 'render.ts']);
    const command = await completeLine('ezf', 3, source());
    expect(command).toMatchObject({ ok: true, commonText: 'ezfake ' });
    const absolute = await completeLine(`ls ${root}\\set`, root.length + 7, source());
    expect(absolute).toMatchObject({ ok: true });
  });
});
