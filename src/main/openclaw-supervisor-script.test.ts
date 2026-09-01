import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { OpenClawControlSnapshot } from '../shared/openclaw';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true,
  })));
});

describeWindows('openclaw-supervisor.ps1', () => {
  it('writes a truthful blocked snapshot for a critical missing CLI without mutating scheduled tasks', async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-supervisor-'));
    temporaryDirectories.push(stateDirectory);
    await fs.writeFile(path.join(stateDirectory, 'intent.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-script-1',
      generation: 7,
      desiredState: 'running',
      action: 'start',
      requestedAt: '2026-09-01T00:00:00.000Z',
    }));
    const scriptPath = path.resolve('assets', 'openclaw-supervisor.ps1');
    const missingCliPath = path.join(stateDirectory, 'missing-openclaw.cmd');

    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-RunSupervisor',
      '-RunOnce',
      '-StateDirectory',
      stateDirectory,
      '-CliPath',
      missingCliPath,
    ], { timeout: 15_000, windowsHide: true });

    const runtime = JSON.parse(
      await fs.readFile(path.join(stateDirectory, 'runtime.json'), 'utf8'),
    ) as OpenClawControlSnapshot;
    expect(runtime).toMatchObject({
      schemaVersion: 1,
      intentId: 'intent-script-1',
      generation: 7,
      desiredState: 'running',
      supervisorState: 'error',
      operation: { phase: 'blocked', attempt: 0 },
      issue: { code: 'cli-missing' },
    });
  });
});
