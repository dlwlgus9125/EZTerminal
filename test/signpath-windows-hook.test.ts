import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

interface SignHookConfiguration {
  readonly path: string;
  readonly hash: string;
  readonly isNest: boolean;
}

interface SignPathHook {
  classifySignTarget(file: string): string;
  sign(configuration: SignHookConfiguration): Promise<void>;
}

const require = createRequire(import.meta.url);
const hook = require('../scripts/electron-builder-signpath-hook.cjs') as SignPathHook;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.EZTERMINAL_SIGNPATH_MODE;
  delete process.env.EZTERMINAL_SIGNPATH_UNINSTALLER_PATH;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('electron-builder SignPath bridge', () => {
  it('allows only the three expected electron-builder targets', () => {
    expect(hook.classifySignTarget(path.join('resources', 'elevate.exe')))
      .toBe('electron-builder-helper');
    expect(hook.classifySignTarget(path.join('out', 'EZTerminal-Setup.__uninstaller.exe')))
      .toBe('uninstaller');
    expect(hook.classifySignTarget(path.join('out', 'EZTerminal-Setup.exe')))
      .toBe('installer');
    expect(hook.classifySignTarget(path.join('out', 'third-party.exe')))
      .toBe('unexpected');
  });

  it('captures the generated uninstaller and injects the signed replacement', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ezterminal-signpath-hook-'));
    temporaryDirectories.push(directory);
    const generated = path.join(directory, 'EZTerminal-Setup.__uninstaller.exe');
    const retained = path.join(directory, 'retained', 'Uninstall EZTerminal.exe');
    await writeFile(generated, 'unsigned');
    process.env.EZTERMINAL_SIGNPATH_UNINSTALLER_PATH = retained;
    process.env.EZTERMINAL_SIGNPATH_MODE = 'capture';
    await hook.sign({ path: generated, hash: 'sha256', isNest: false });
    expect(await readFile(retained, 'utf8')).toBe('unsigned');

    await writeFile(retained, 'signed');
    process.env.EZTERMINAL_SIGNPATH_MODE = 'inject';
    await hook.sign({ path: generated, hash: 'sha256', isNest: false });
    expect(await readFile(generated, 'utf8')).toBe('signed');
  });

  it('fails closed for an unexpected signing target', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ezterminal-signpath-hook-'));
    temporaryDirectories.push(directory);
    process.env.EZTERMINAL_SIGNPATH_MODE = 'capture';
    process.env.EZTERMINAL_SIGNPATH_UNINSTALLER_PATH = path.join(directory, 'uninstaller.exe');
    await expect(hook.sign({
      path: path.join(directory, 'third-party.exe'),
      hash: 'sha256',
      isNest: false,
    })).rejects.toThrow('Unexpected electron-builder signing target');
  });
});
