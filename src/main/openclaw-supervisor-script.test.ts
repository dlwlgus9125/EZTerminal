import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { OpenClawControlSnapshot } from '../shared/openclaw';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const httpServers: Server[] = [];
const stopWatchers: Array<() => Promise<void>> = [];
const describeWindows = process.platform === 'win32' ? describe : describe.skip;
const ACL_PROCESS_TIMEOUT_MS = 45_000;
const ACL_TEST_TIMEOUT_MS = 60_000;

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
  ], { timeout: ACL_PROCESS_TIMEOUT_MS, windowsHide: true });
}

afterEach(async () => {
  await Promise.all(stopWatchers.splice(0).map((stop) => stop()));
  await Promise.all(httpServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await execFileAsync('icacls.exe', [directory, '/reset', '/T', '/C', '/Q'], {
      windowsHide: true,
    }).catch(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }));
});


async function fixture(options: { running?: boolean; task?: boolean; enabled?: boolean; failStart?: boolean; foreign?: boolean; slowStart?: boolean; installStarts?: boolean; shortTaskPath?: boolean } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ezterminal-openclaw-launch-'));
  temporaryDirectories.push(directory);
  const marker = (name: string) => path.join(directory, name);
  const exists = async (name: string) => fs.access(marker(name)).then(() => true, () => false);
  for (const [name, value] of Object.entries(options)) {
    if (value) await fs.writeFile(marker(name), '1');
  }
  const server = createServer((_request, response) => {
    void exists('running').then((running) => {
      response.writeHead(running ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: running, status: running ? 'live' : 'starting' }));
    });
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  await fs.writeFile(marker('openclaw.json'), JSON.stringify({ gateway: { port: address.port } }));
  const cliPath = marker('openclaw.cmd');
  await fs.writeFile(cliPath, [
    '@echo off',
    'echo %*>>"%~dp0calls.log"',
    'if "%1 %2"=="gateway start" goto start',
    'if "%1 %2"=="gateway stop" goto stop',
    'if "%1 %2"=="gateway install" goto install',
    'echo unexpected diagnostic or management RPC command 1>&2',
    'exit /b 19',
    ':start',
    'if exist "%~dp0failStart" (echo fixture launch failed 1>&2 & exit /b 23)',
    'if exist "%~dp0slowStart" (type nul >"%~dp0starting" & exit /b 0)',
    'type nul >"%~dp0running"',
    'exit /b 0',
    ':stop',
    'if exist "%~dp0running" del /q "%~dp0running"',
    'if exist "%~dp0starting" del /q "%~dp0starting"',
    'exit /b 0',
    ':install',
    'type nul >"%~dp0task"',
    'if exist "%~dp0installStarts" type nul >"%~dp0running"',
    'exit /b 0',
  ].join('\r\n'));
  const requestedAt = new Date().toISOString();
  const intent = (action: 'start' | 'stop' | 'restart', generation = 1) => ({
    schemaVersion: 1, intentId: `intent-${generation}`, generation,
    desiredState: action === 'stop' ? 'stopped' : 'running', action, requestedAt,
  });
  const saveIntent = (action: 'start' | 'stop' | 'restart', generation = 1) =>
    fs.writeFile(marker('intent.json'), JSON.stringify(intent(action, generation)));
  const command = `
    $fixtureRoot = ${quotePowerShellLiteral(directory)}
    function Get-ScheduledTask {
      [CmdletBinding()] param([string]$TaskName)
      if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'task')) {
        $taskRoot = if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'shortTaskPath')) { (New-Object -ComObject Scripting.FileSystemObject).GetFolder($fixtureRoot).ShortPath } else { $fixtureRoot }
        return [pscustomobject]@{ TaskName=$TaskName; State='Ready';
          Settings=[pscustomobject]@{Enabled=(Test-Path -LiteralPath (Join-Path $fixtureRoot 'enabled'))};
          Actions=@([pscustomobject]@{Execute=(Join-Path $taskRoot 'gateway.vbs');Arguments=''}) }
      }
    }
    function Enable-ScheduledTask {
      param([string]$TaskName)
      [IO.File]::WriteAllText((Join-Path $fixtureRoot 'enabled'), '1')
      Add-Content -LiteralPath (Join-Path $fixtureRoot 'calls.log') -Value 'task enable'
    }
    function Disable-ScheduledTask {
      param([string]$TaskName)
      Remove-Item -LiteralPath (Join-Path $fixtureRoot 'enabled') -ErrorAction SilentlyContinue
      Add-Content -LiteralPath (Join-Path $fixtureRoot 'calls.log') -Value 'task disable'
    }
    function Get-NetTCPConnection {
      [CmdletBinding()] param($LocalPort,$State)
      if (Test-Path -LiteralPath (Join-Path $fixtureRoot 'foreign')) { [pscustomobject]@{OwningProcess=999999} }
    }
    function Get-CimInstance {
      [CmdletBinding()] param($ClassName,$Filter)
      if ((Test-Path -LiteralPath (Join-Path $fixtureRoot 'running')) -or (Test-Path -LiteralPath (Join-Path $fixtureRoot 'starting'))) {
        [pscustomobject]@{ProcessId=12345;CommandLine='node.exe C:\\fixture\\node_modules\\openclaw\\dist\\index.js gateway --port ${address.port}'}
      }
    }
    & ${quotePowerShellLiteral(path.resolve('assets/openclaw-supervisor.ps1'))} -RunSupervisor -RunOnce -ReadyTimeoutSeconds 1 -StateDirectory ${quotePowerShellLiteral(directory)} -CliPath ${quotePowerShellLiteral(cliPath)}
  `;
  return {
    directory, marker, exists, intent, saveIntent, port: address.port,
    run: () => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true, timeout: 60_000, env: { ...process.env, OPENCLAW_STATE_DIR: directory },
    }),
    watch: () => {
      const watcherCommand = command.replace('-RunOnce -ReadyTimeoutSeconds 1 ', '-HealthIntervalSeconds 1 -ReadyTimeoutSeconds 15 ');
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', watcherCommand], {
        windowsHide: true, env: { ...process.env, OPENCLAW_STATE_DIR: directory },
      });
      const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()); });
      stopWatchers.push(async () => { child.kill(); await closed; });
    },
    calls: async () => (await fs.readFile(marker('calls.log'), 'utf8').catch(() => '')).trim().split(/\r?\n/u).filter(Boolean),
    runtime: async () => JSON.parse(await fs.readFile(marker('runtime.json'), 'utf8')) as OpenClawControlSnapshot,
  };
}

describeWindows('openclaw-supervisor.ps1', { timeout: 30_000 }, () => {
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
    ], { timeout: ACL_PROCESS_TIMEOUT_MS, windowsHide: true })).rejects.toMatchObject({ code: 1 });

    await expect(fs.readFile(installedScriptPath, 'utf8')).resolves.toContain(
      'EZTerminal-owned OpenClaw desired-state supervisor',
    );
  }, ACL_TEST_TIMEOUT_MS);

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
    ], { timeout: ACL_PROCESS_TIMEOUT_MS, windowsHide: true });

    await expect(fs.readFile(installedScriptPath, 'utf8')).resolves.toContain(
      'EZTerminal-owned OpenClaw desired-state supervisor',
    );
  }, ACL_TEST_TIMEOUT_MS);


  it('keeps an HTTP-live gateway running when management RPC is unavailable', async () => {
    const f = await fixture({ running: true, task: true, enabled: true });
    await f.saveIntent('start');
    await f.run();
    expect(await f.runtime()).toMatchObject({ status: { state: 'running' }, operation: null, issue: null });
    expect(await f.calls()).toEqual([]);
  });

  it('owns a gateway task that names its launcher by the 8.3 alias of the state folder', async () => {
    const f = await fixture({ running: true, task: true, enabled: true, shortTaskPath: true });
    await f.saveIntent('start');
    await f.run();
    expect(await f.runtime()).toMatchObject({ status: { state: 'running' }, operation: null, issue: null });
    expect(await f.calls()).toEqual([]);
  });

  it.each([false, true])('upgrades only the exact supervisor and waits for its exit (foreign=%s)', async (foreign) => {
    const f = await fixture({ running: true });
    const launcher = path.join(f.directory, `openclaw-supervisor.ps1${foreign ? '.other' : ''}`);
    const command = `
      $global:fixtureStopRequestedAt = $null
      function Get-ScheduledTask {
        [CmdletBinding()] param([string]$TaskName)
        $stopped = $null -ne $global:fixtureStopRequestedAt -and ([DateTime]::UtcNow - $global:fixtureStopRequestedAt).TotalSeconds -ge 1
        if ($stopped) { [IO.File]::WriteAllText(${quotePowerShellLiteral(f.marker('supervisor-exited'))}, '1') }
        [pscustomobject]@{
          Description='EZTerminal-owned OpenClaw desired-state supervisor v1';
          State=$(if ($stopped) { 'Ready' } else { 'Running' });
          Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments=${quotePowerShellLiteral(`-File "${launcher}" -RunSupervisor`)}})
        }
      }
      function Stop-ScheduledTask {
        [CmdletBinding()] param([string]$TaskName)
        $global:fixtureStopRequestedAt = [DateTime]::UtcNow
        [IO.File]::WriteAllText(${quotePowerShellLiteral(f.marker('task-stopped'))}, $TaskName)
      }
      & ${quotePowerShellLiteral(path.resolve('assets/openclaw-supervisor.ps1'))} -PrepareUpgrade -StateDirectory ${quotePowerShellLiteral(f.directory)} -CliPath ${quotePowerShellLiteral(f.marker('openclaw.cmd'))}
    `;
    const result = execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 15_000,
    });
    if (foreign) {
      await expect(result).rejects.toMatchObject({ code: 1 });
      expect(await f.exists('task-stopped')).toBe(false);
    } else {
      await expect(result).resolves.toMatchObject({ stdout: expect.stringContaining('"ok":true') });
      expect(await f.exists('supervisor-exited')).toBe(true);
      expect(await fs.readFile(f.marker('task-stopped'), 'utf8')).toBe('EZTerminal OpenClaw Supervisor');
    }
    expect(await f.calls()).toEqual([]);
    expect(await f.exists('running')).toBe(true);
  });

  it('does not start twice when native registration already launched the gateway', async () => {
    const f = await fixture({ installStarts: true });
    await f.saveIntent('start');
    await f.run();
    expect(await f.runtime()).toMatchObject({ status: { state: 'running' }, operation: null, issue: null });
    expect(await f.calls()).toEqual([`gateway install --json --port ${f.port}`, 'task enable']);
  });

  it('registers a missing task and starts without diagnostics or data migration', async () => {
    const f = await fixture();
    const legacy = '{"version":1,"agents":{}}';
    await fs.writeFile(f.marker('exec-approvals.json'), legacy);
    await fs.writeFile(f.marker('openclaw-workspace-state.json'), legacy);
    await f.saveIntent('start');
    await f.run();
    expect(await f.calls()).toEqual([`gateway install --json --port ${f.port}`, 'task enable', 'gateway start --json']);
    expect(await f.runtime()).toMatchObject({ status: { state: 'running' }, operation: null, issue: null });
    expect(await fs.readFile(f.marker('exec-approvals.json'), 'utf8')).toBe(legacy);
    expect(await fs.readFile(f.marker('openclaw-workspace-state.json'), 'utf8')).toBe(legacy);
    expect(await f.exists('recovery')).toBe(false);
  });

  it('enables a disabled task before starting and disables it before stopping', async () => {
    const f = await fixture({ task: true });
    await f.saveIntent('start');
    await f.run();
    expect(await f.calls()).toEqual(['task enable', 'gateway start --json']);
    await f.saveIntent('stop', 2);
    await f.run();
    expect(await f.calls()).toEqual(['task enable', 'gateway start --json', 'task disable', 'gateway stop --force --json']);
    expect(await f.runtime()).toMatchObject({ desiredState: 'stopped', status: { state: 'stopped' }, issue: null });
    expect(await f.exists('enabled')).toBe(false);
    await f.run(); // next login retains Stop, without starting the gateway
    expect((await f.calls()).filter((call) => call === 'gateway start --json')).toHaveLength(1);
    expect(await f.exists('running')).toBe(false);
  });

  it('restarts with stop/start once and restores only running intent after supervisor restart', async () => {
    const f = await fixture({ task: true, enabled: true, running: true });
    await f.saveIntent('restart');
    await f.run();
    expect(await f.calls()).toEqual(['gateway stop --force --json', 'gateway start --json']);
    await f.run();
    expect(await f.calls()).toEqual(['gateway stop --force --json', 'gateway start --json']);
    await fs.unlink(f.marker('running')); // gateway disappeared while EZTerminal was closed
    await f.run();
    expect(await f.calls()).toEqual(['gateway stop --force --json', 'gateway start --json', 'gateway start --json']);
    expect(await f.runtime()).toMatchObject({ status: { state: 'running' }, issue: null });
  });

  it('discards a stale repairing operation at login and keeps a healthy process', async () => {
    const f = await fixture({ task: true, enabled: true, running: true });
    await f.saveIntent('start');
    await fs.writeFile(f.marker('runtime.json'), JSON.stringify({
      ...f.intent('start'), status: { state: 'stopped', port: f.port }, supervisorState: 'ready', issue: null,
      operation: { ...f.intent('start'), phase: 'repairing', attempt: 3, maxAttempts: 3 },
      updatedAt: '2026-09-01T00:00:00.000Z',
    }));
    await f.run();
    expect(await f.calls()).toEqual([]);
    expect(await f.runtime()).toMatchObject({ status: { state: 'running' }, operation: null, issue: null });
  });

  it('reports the real command failure after three launches without Doctor or reinstall', async () => {
    const f = await fixture({ task: true, enabled: true, failStart: true });
    await f.saveIntent('start');
    await f.run();
    expect(await f.calls()).toEqual(Array(3).fill('gateway start --json'));
    const runtime = await f.runtime();
    expect(runtime).toMatchObject({ status: { state: 'stopped' }, operation: { phase: 'blocked', attempt: 3 } });
    expect(runtime.issue?.detail).toContain('fixture launch failed');
    const diagnostic = JSON.parse(await fs.readFile(f.marker('diagnostics/last-command.json'), 'utf8'));
    expect(diagnostic).toMatchObject({ exitCode: 23, timedOut: false });
  }, 60_000);

  it('leaves an unrelated port owner alone and reports the conflict', async () => {
    const f = await fixture({ task: true, enabled: true, foreign: true });
    await f.saveIntent('start');
    await f.run();
    expect(await f.calls()).toEqual([]);
    expect(await f.runtime()).toMatchObject({ status: { state: 'unknown' }, issue: { code: 'port-conflict' } });
  });

  it('persists Stop in the native startup task even when an unrelated process owns the port', async () => {
    const f = await fixture({ task: true, enabled: true, foreign: true });
    await f.saveIntent('stop');
    await f.run();
    expect(await f.calls()).toEqual(['task disable']);
    expect(await f.exists('enabled')).toBe(false);
    expect(await f.runtime()).toMatchObject({ desiredState: 'stopped', issue: { code: 'port-conflict' } });
  });

  it('publishes separate heartbeat and observation times for reboot-safe state', async () => {
    const f = await fixture({ task: true, enabled: true, running: true });
    await f.saveIntent('start');
    await f.run();
    const first = await f.runtime();
    expect(first.statusObservedAt).toBeTruthy();
    expect(first.supervisorHeartbeatAt).toBeTruthy();
    expect(first.supervisorInstanceId).toBeTruthy();
    await f.run();
    expect((await f.runtime()).supervisorInstanceId).not.toBe(first.supervisorInstanceId);
  });

  it('reports a missing CLI without issuing any lifecycle or repair commands', async () => {
    const f = await fixture({ task: true, enabled: true });
    await f.saveIntent('start');
    await fs.unlink(f.marker('openclaw.cmd'));
    await f.run();
    expect(await f.calls()).toEqual([]);
    expect(await f.runtime()).toMatchObject({ operation: { phase: 'blocked', attempt: 0 }, issue: { code: 'cli-missing' } });
  });

  it('automatically restarts an exited gateway and respects a later Stop in the same watcher', async () => {
    const f = await fixture({ task: true, enabled: true });
    await f.saveIntent('start');
    f.watch();
    await expect.poll(f.runtime, { timeout: 15_000 }).toMatchObject({ status: { state: 'running' }, operation: null });
    await fs.unlink(f.marker('running'));
    await expect.poll(f.calls, { timeout: 15_000 }).toEqual(['gateway start --json', 'gateway start --json']);
    await expect.poll(f.runtime, { timeout: 15_000 }).toMatchObject({ status: { state: 'running' }, operation: null });
    await f.saveIntent('stop', 2);
    await expect.poll(f.runtime, { timeout: 15_000 }).toMatchObject({ generation: 2, status: { state: 'stopped' }, operation: null });
    expect(await f.exists('enabled')).toBe(false);
  }, 45_000);

  it('accepts Stop while a slow gateway is still starting without waiting for its readiness timeout', async () => {
    const f = await fixture({ task: true, enabled: true, slowStart: true });
    await f.saveIntent('start');
    f.watch();
    await expect.poll(() => f.exists('starting'), { timeout: 15_000 }).toBe(true);
    await f.saveIntent('stop', 2);
    await expect.poll(f.runtime, { timeout: 10_000 }).toMatchObject({ generation: 2, status: { state: 'stopped' }, operation: null });
    expect(await f.calls()).toEqual(['gateway start --json', 'task disable', 'gateway stop --force --json']);
  }, 30_000);
});
