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

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function removeAllAccessRules(filePath: string): Promise<void> {
  const command = [
    `$target = ${quotePowerShellLiteral(filePath)}`,
    '$acl = [IO.File]::GetAccessControl($target)',
    '$identities = @()',
    'foreach ($rule in $acl.Access) { $identities += $rule.IdentityReference }',
    '$acl.SetAccessRuleProtection($true, $false)',
    'foreach ($identity in $identities) { $acl.PurgeAccessRules($identity) }',
    '[IO.File]::SetAccessControl($target, $acl)',
  ].join('; ');
  await execFileAsync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], { timeout: 15_000, windowsHide: true });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await execFileAsync('icacls.exe', [directory, '/reset', '/T', '/C', '/Q'], {
      windowsHide: true,
    }).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

describeWindows('openclaw-supervisor.ps1', () => {
  it('keeps the installed supervisor script readable after protecting the state directory', async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-acl-'));
    temporaryDirectories.push(stateDirectory);
    const installedScriptPath = path.join(stateDirectory, 'openclaw-supervisor.ps1');
    await fs.copyFile(path.resolve('assets', 'openclaw-supervisor.ps1'), installedScriptPath);

    const stopAfterAcl = [
      'function Get-ScheduledTask {',
      '  [CmdletBinding()]',
      '  param([string]$TaskName)',
      "  throw 'stop-after-acl'",
      '}',
      `. ${quotePowerShellLiteral(installedScriptPath)}`,
      '-InstallTask',
      `-StateDirectory ${quotePowerShellLiteral(stateDirectory)}`,
      `-CliPath ${quotePowerShellLiteral('unused-openclaw.cmd')}`,
    ].join(' ');

    await expect(execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      stopAfterAcl,
    ], { timeout: 15_000, windowsHide: true })).rejects.toMatchObject({ code: 1 });

    await expect(fs.readFile(installedScriptPath, 'utf8')).resolves.toContain(
      'EZTerminal-owned OpenClaw desired-state supervisor',
    );
  }, 30_000);

  it('repairs the unreadable supervisor ACL left by the previous release', async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-acl-repair-'));
    temporaryDirectories.push(stateDirectory);
    const installedScriptPath = path.join(stateDirectory, 'openclaw-supervisor.ps1');
    const sourceScriptPath = path.resolve('assets', 'openclaw-supervisor.ps1');
    await fs.copyFile(sourceScriptPath, installedScriptPath);
    await removeAllAccessRules(installedScriptPath);
    await expect(fs.readFile(installedScriptPath, 'utf8')).rejects.toMatchObject({ code: 'EPERM' });

    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      sourceScriptPath,
      '-RepairStateAcl',
      '-StateDirectory',
      stateDirectory,
      '-CliPath',
      'unused-openclaw.cmd',
    ], { timeout: 15_000, windowsHide: true });

    await expect(fs.readFile(installedScriptPath, 'utf8')).resolves.toContain(
      'EZTerminal-owned OpenClaw desired-state supervisor',
    );
  }, 30_000);

  it('forces the non-interactive gateway stop command', async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-stop-'));
    temporaryDirectories.push(stateDirectory);
    const cliPath = path.join(stateDirectory, 'fake-openclaw.cmd');
    await fs.writeFile(cliPath, [
      '@echo off',
      'echo %*>>"%~dp0calls.log"',
      'if "%1"=="doctor" echo --fix --non-interactive --session-sqlite --session-sqlite-all-agents',
      'if "%1 %2"=="gateway status" echo --require-rpc',
      'if "%1 %2"=="gateway restart" echo --safe --force',
      'if "%1 %2"=="gateway start" echo --json',
      'if "%1 %2"=="gateway stop" echo --force --json',
      'if "%1 %2 %3"=="approvals set --help" echo --stdin --json',
      'exit /b 0',
    ].join('\r\n'));
    await fs.writeFile(path.join(stateDirectory, 'intent.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-stop-1',
      generation: 1,
      desiredState: 'stopped',
      action: 'stop',
      requestedAt: '2026-09-02T00:00:00.000Z',
    }));

    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve('assets', 'openclaw-supervisor.ps1'),
      '-RunSupervisor',
      '-RunOnce',
      '-StateDirectory',
      stateDirectory,
      '-CliPath',
      cliPath,
    ], { timeout: 30_000, windowsHide: true });

    const calls = await fs.readFile(path.join(stateDirectory, 'calls.log'), 'utf8');
    expect(calls.split(/\r?\n/u)).toContain('gateway stop --force --json');
  }, 30_000);

  it('accepts authenticated RPC readiness observed by the final deep diagnostic', async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-late-ready-'));
    temporaryDirectories.push(stateDirectory);
    const cliPath = path.join(stateDirectory, 'fake-openclaw.cmd');
    await fs.writeFile(cliPath, [
      '@echo off',
      'echo %*>>"%~dp0calls.log"',
      'if "%1 %2 %3"=="gateway status --deep" goto deep_status',
      'if "%1"=="doctor" echo --fix --non-interactive --session-sqlite --session-sqlite-all-agents',
      'if "%1 %2"=="gateway status" echo --require-rpc',
      'if "%1 %2"=="gateway restart" echo --safe --force',
      'if "%1 %2"=="gateway start" echo --json',
      'if "%1 %2"=="gateway stop" echo --force --json',
      'if "%1 %2 %3"=="approvals set --help" echo --stdin --json',
      'exit /b 0',
      ':deep_status',
      'echo {"cli":{"version":"2026.8.1"},"service":{"runtime":{"status":"running","pid":1234}},"port":{"listeners":[]},"rpc":{"ok":true}}',
      'exit /b 0',
    ].join('\r\n'));
    const intent = {
      schemaVersion: 1,
      intentId: 'intent-late-ready-1',
      generation: 1,
      desiredState: 'running',
      action: 'start',
      requestedAt: '2026-09-02T00:00:00.000Z',
    } as const;
    await fs.writeFile(path.join(stateDirectory, 'intent.json'), JSON.stringify(intent));
    await fs.writeFile(path.join(stateDirectory, 'runtime.json'), JSON.stringify({
      ...intent,
      status: { state: 'stopped', port: 18789 },
      supervisorState: 'ready',
      operation: {
        intentId: intent.intentId,
        generation: intent.generation,
        action: intent.action,
        phase: 'diagnosing',
        attempt: 2,
        maxAttempts: 3,
        requestedAt: intent.requestedAt,
      },
      issue: null,
      updatedAt: intent.requestedAt,
    }));

    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve('assets', 'openclaw-supervisor.ps1'),
      '-RunSupervisor',
      '-RunOnce',
      '-ReadyTimeoutSeconds',
      '1',
      '-StateDirectory',
      stateDirectory,
      '-CliPath',
      cliPath,
    ], { timeout: 30_000, windowsHide: true });

    const runtime = JSON.parse(
      await fs.readFile(path.join(stateDirectory, 'runtime.json'), 'utf8'),
    ) as OpenClawControlSnapshot;
    expect(runtime).toMatchObject({
      intentId: intent.intentId,
      generation: intent.generation,
      desiredState: 'running',
      status: { state: 'running', port: 18789, version: '2026.8.1' },
      supervisorState: 'ready',
      operation: null,
      issue: null,
    });
  }, 30_000);

  it('uses supported non-interactive migrations after a verified recovery backup', async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-migrate-'));
    temporaryDirectories.push(stateDirectory);
    const openClawStateDirectory = path.join(stateDirectory, 'openclaw-state');
    await fs.mkdir(openClawStateDirectory);
    await fs.writeFile(
      path.join(openClawStateDirectory, 'exec-approvals.json'),
      JSON.stringify({ version: 1, agents: {} }),
    );
    const cliPath = path.join(stateDirectory, 'fake-openclaw.cmd');
    await fs.writeFile(cliPath, [
      '@echo off',
      'echo %*>>"%~dp0calls.log"',
      'if "%1"=="doctor" echo --fix --non-interactive --session-sqlite --session-sqlite-all-agents',
      'if "%1 %2"=="gateway status" echo --require-rpc',
      'if "%1 %2"=="gateway restart" echo --safe --force',
      'if "%1 %2"=="gateway start" echo --json',
      'if "%1 %2"=="gateway stop" echo --force --json',
      'if "%1 %2 %3"=="approvals set --help" echo --stdin --json',
      'exit /b 0',
    ].join('\r\n'));
    await fs.writeFile(path.join(stateDirectory, 'intent.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-migrate-1',
      generation: 1,
      desiredState: 'running',
      action: 'start',
      requestedAt: '2026-09-02T00:00:00.000Z',
    }));

    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve('assets', 'openclaw-supervisor.ps1'),
      '-RunSupervisor',
      '-RunOnce',
      '-ReadyTimeoutSeconds',
      '1',
      '-StateDirectory',
      stateDirectory,
      '-CliPath',
      cliPath,
    ], {
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: openClawStateDirectory },
    });

    const calls = (await fs.readFile(path.join(stateDirectory, 'calls.log'), 'utf8')).split(/\r?\n/u);
    const sessionMigration = 'doctor --session-sqlite import --session-sqlite-all-agents --yes';
    if (!calls.includes(sessionMigration)) {
      const runtime = await fs.readFile(path.join(stateDirectory, 'runtime.json'), 'utf8')
        .catch((error: unknown) => `unavailable: ${String(error)}`);
      const diagnosticDirectory = path.join(stateDirectory, 'diagnostics');
      const diagnostics = await fs.readdir(diagnosticDirectory)
        .then(async (entries) => (await Promise.all(entries.map(async (entry) => fs.readFile(
          path.join(diagnosticDirectory, entry),
          'utf8',
        )))).join('\n'))
        .catch((error: unknown) => `unavailable: ${String(error)}`);
      throw new Error([
        `session migration was not invoked; calls=${JSON.stringify(calls)}`,
        `runtime=${runtime}`,
        `diagnostics=${diagnostics}`,
      ].join('\n'));
    }
    expect(calls).toContain('approvals set --stdin --json');
    expect(calls).toContain('approvals get --json');
    await expect(fs.stat(path.join(openClawStateDirectory, 'exec-approvals.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const recoveryEntries = await fs.readdir(path.join(stateDirectory, 'recovery'), {
      withFileTypes: true,
    });
    const completedBackup = recoveryEntries.find((entry) => entry.isDirectory());
    expect(completedBackup).toBeDefined();
    await expect(fs.readFile(path.join(
      stateDirectory,
      'recovery',
      completedBackup?.name ?? '',
      'exec-approvals.json',
    ), 'utf8')).resolves.toContain('"version":1');
  }, 60_000);

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
    await fs.writeFile(path.join(stateDirectory, 'runtime.json'), JSON.stringify({
      schemaVersion: 1,
      intentId: 'intent-script-old',
      generation: 6,
      status: { state: 'stopped', port: 18789 },
      desiredState: 'stopped',
      supervisorState: 'ready',
      operation: null,
      issue: null,
      updatedAt: '2026-08-31T00:00:00.000Z',
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
