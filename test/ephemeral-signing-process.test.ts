import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const helper = path.resolve('scripts', 'invoke-ephemeral-signing-process.ps1');
const androidSigningChild = path.resolve(
  'scripts',
  'invoke-android-gradle-signing-child.ps1',
);
const temporaryRoots: string[] = [];

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodedCommand(source: string): string {
  return Buffer.from(source, 'utf16le').toString('base64');
}

function runPowerShell(source: string) {
  const guardedSource = `
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    ${source}
  `;
  return spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand(guardedSource),
    ],
    { encoding: 'utf8' },
  );
}

function startInfoSource(childSource: string): string {
  return `
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Process -Id $PID).Path
    $startInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ${
      encodedCommand(childSource)
    }'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
  `;
}

function environmentWasClearedSource(): string {
  return `
    if ($startInfo.EnvironmentVariables.ContainsKey(
      'EZTERMINAL_TEST_SIGNING_SECRET'
    )) {
      throw 'ProcessStartInfo retained the signing secret.'
    }
    if ($ephemeral.Count -ne 0) {
      throw 'The ephemeral signing environment retained secret values.'
    }
  `;
}

function isProcessAlive(pid: number): boolean {
  const result = runPowerShell(
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 }; exit 1`,
  );
  return result.status === 0;
}

function stopProcessTree(pid: number): void {
  spawnSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(pid), '/T', '/F'],
    { encoding: 'utf8', windowsHide: true },
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')(
  'ephemeral signing child process',
  () => {
    it('removes signing values after a successful child exit', () => {
      const child = `
        if (
          $env:EZTERMINAL_TEST_SIGNING_SECRET -cne 'ephemeral-secret'
        ) { exit 91 }
      `;
      const result = runPowerShell(`
        . ${quotePowerShell(helper)}
        ${startInfoSource(child)}
        $ephemeral = [ordered]@{
          EZTERMINAL_TEST_SIGNING_SECRET = 'ephemeral-secret'
        }
        Invoke-EphemeralSigningProcess -StartInfo $startInfo -EphemeralEnvironment $ephemeral -TimeoutMilliseconds 10000
        ${environmentWasClearedSource()}
        Write-Output 'SIGNING_CHILD_CLEAN'
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('SIGNING_CHILD_CLEAN');
    }, 20_000);

    it('kills secret-bearing descendants after a successful root exit', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'ezterminal-signing-child-'));
      temporaryRoots.push(root);
      const pidPath = path.join(root, 'pids.txt');
      const grandchild = encodedCommand('Start-Sleep -Seconds 30');
      const child = `
        $ErrorActionPreference = 'Stop'
        $self = (Get-Process -Id $PID).Path
        $grandchildArguments = @(
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          '${grandchild}'
        )
        $grandchild = Start-Process -FilePath $self -WindowStyle Hidden -PassThru -ArgumentList $grandchildArguments
        [IO.File]::WriteAllText(
          $env:EZTERMINAL_TEST_PID_PATH,
          "$($grandchild.Id),$(
            $env:EZTERMINAL_TEST_SIGNING_SECRET -ceq 'ephemeral-secret'
          )"
        )
      `;
      const result = runPowerShell(`
        . ${quotePowerShell(helper)}
        ${startInfoSource(child)}
        $startInfo.EnvironmentVariables['EZTERMINAL_TEST_PID_PATH'] = ${
          quotePowerShell(pidPath)
        }
        $ephemeral = [ordered]@{
          EZTERMINAL_TEST_SIGNING_SECRET = 'ephemeral-secret'
        }
        Invoke-EphemeralSigningProcess -StartInfo $startInfo -EphemeralEnvironment $ephemeral -TimeoutMilliseconds 10000
        ${environmentWasClearedSource()}
        Write-Output 'SIGNING_DESCENDANTS_CLEAN'
      `);

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const pidEvidence = readFileSync(pidPath, 'utf8').trim().split(',');
      const grandchildPid = Number(pidEvidence[0]);
      const survivors = [grandchildPid].filter(isProcessAlive);
      for (const pid of survivors) stopProcessTree(pid);

      expect(result.stdout.trim()).toBe('SIGNING_DESCENDANTS_CLEAN');
      expect(pidEvidence[1]).toBe('True');
      expect(survivors).toEqual([]);
    }, 30_000);

    it('removes signing values after a nonzero child exit', () => {
      const result = runPowerShell(`
        . ${quotePowerShell(helper)}
        ${startInfoSource('exit 7')}
        $ephemeral = [ordered]@{
          EZTERMINAL_TEST_SIGNING_SECRET = 'ephemeral-secret'
        }
        $failed = $false
        try {
          Invoke-EphemeralSigningProcess -StartInfo $startInfo -EphemeralEnvironment $ephemeral -TimeoutMilliseconds 10000
        } catch {
          if ($_.Exception.Message -notmatch 'exit code 7') { throw }
          $failed = $true
        }
        if (-not $failed) { throw 'The nonzero signing child did not fail.' }
        ${environmentWasClearedSource()}
        Write-Output 'SIGNING_FAILURE_CLEAN'
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('SIGNING_FAILURE_CLEAN');
    }, 20_000);

    it('forwards bounded stdout and stderr diagnostics with secrets redacted', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'ezterminal-signing-child-'));
      temporaryRoots.push(root);
      const fakeGradle = path.join(root, 'fake-gradle.cmd');
      const diagnosticLog = path.join(root, 'signing-diagnostic.log');
      writeFileSync(
        fakeGradle,
        [
          '@echo off',
          'echo CHILD_STDOUT_MARKER ephemeral-secret',
          'echo CHILD_STDERR_MARKER ephemeral-secret 1>&2',
          'exit /b 7',
          '',
        ].join('\r\n'),
        'utf8',
      );
      const child = `
        & ${quotePowerShell(androidSigningChild)} -GradleWrapper ${
          quotePowerShell(fakeGradle)
        }
        exit $LASTEXITCODE
      `;
      const result = runPowerShell(`
        . ${quotePowerShell(helper)}
        ${startInfoSource(child)}
        $ephemeral = [ordered]@{
          EZTERMINAL_TEST_SIGNING_SECRET = 'ephemeral-secret'
        }
        $failed = $false
        try {
          Invoke-EphemeralSigningProcess -StartInfo $startInfo -EphemeralEnvironment $ephemeral -TimeoutMilliseconds 10000 -DiagnosticLogPath ${
            quotePowerShell(diagnosticLog)
          } -MaxDiagnosticBytes 4096
        } catch {
          if ($_.Exception.Message -notmatch 'exit code 7') { throw }
          $failed = $true
        }
        if (-not $failed) { throw 'The fake Gradle child did not fail.' }
        ${environmentWasClearedSource()}
        Write-Output 'SIGNING_DIAGNOSTIC_CLEAN'
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        '[android-signing] CHILD_STDOUT_MARKER [REDACTED]',
      );
      expect(result.stdout).toContain(
        '[android-signing] CHILD_STDERR_MARKER [REDACTED]',
      );
      expect(result.stdout).toContain('SIGNING_DIAGNOSTIC_CLEAN');
      expect(result.stdout).not.toContain('ephemeral-secret');
      expect(existsSync(diagnosticLog)).toBe(false);
    }, 30_000);

    it('kills a timed-out signing process and removes its signing values', () => {
      const result = runPowerShell(`
        . ${quotePowerShell(helper)}
        ${startInfoSource('Start-Sleep -Seconds 30')}
        $ephemeral = [ordered]@{
          EZTERMINAL_TEST_SIGNING_SECRET = 'ephemeral-secret'
        }
        $timedOut = $false
        try {
          Invoke-EphemeralSigningProcess -StartInfo $startInfo -EphemeralEnvironment $ephemeral -TimeoutMilliseconds 500
        } catch [TimeoutException] {
          $timedOut = $true
        }
        if (-not $timedOut) { throw 'The signing child did not time out.' }
        ${environmentWasClearedSource()}
        Write-Output 'SIGNING_TIMEOUT_CLEAN'
      `);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('SIGNING_TIMEOUT_CLEAN');
    }, 20_000);

    it('kills a cancelled signing process tree and removes its signing values', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'ezterminal-signing-child-'));
      temporaryRoots.push(root);
      const pidPath = path.join(root, 'pids.txt');
      const grandchild = encodedCommand('Start-Sleep -Seconds 30');
      const child = `
        $ErrorActionPreference = 'Stop'
        $self = (Get-Process -Id $PID).Path
        $grandchildArguments = @(
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          '${grandchild}'
        )
        $grandchild = Start-Process -FilePath $self -WindowStyle Hidden -PassThru -ArgumentList $grandchildArguments
        [IO.File]::WriteAllText(
          $env:EZTERMINAL_TEST_PID_PATH,
          "$PID,$($grandchild.Id),$(
            $env:EZTERMINAL_TEST_SIGNING_SECRET -ceq 'ephemeral-secret'
          )"
        )
        Start-Sleep -Seconds 30
      `;
      const result = runPowerShell(`
        . ${quotePowerShell(helper)}
        ${startInfoSource(child)}
        $startInfo.EnvironmentVariables['EZTERMINAL_TEST_PID_PATH'] = ${
          quotePowerShell(pidPath)
        }
        $ephemeral = [ordered]@{
          EZTERMINAL_TEST_SIGNING_SECRET = 'ephemeral-secret'
        }
        $cancellation = [Threading.CancellationTokenSource]::new()
        $cancelled = $false
        try {
          $cancellation.CancelAfter(5000)
          Invoke-EphemeralSigningProcess -StartInfo $startInfo -EphemeralEnvironment $ephemeral -TimeoutMilliseconds 20000 -CancellationToken $cancellation.Token
        } catch [OperationCanceledException] {
          $cancelled = $true
        } finally {
          $cancellation.Dispose()
        }
        if (-not $cancelled) { throw 'The signing child was not cancelled.' }
        ${environmentWasClearedSource()}
        Write-Output 'SIGNING_CANCELLATION_CLEAN'
      `);

      expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
      const pidEvidence = readFileSync(pidPath, 'utf8').trim().split(',');
      const pids = pidEvidence.slice(0, 2).map(Number);
      const survivors = pids.filter(isProcessAlive);
      for (const pid of survivors) stopProcessTree(pid);

      expect(result.stdout.trim()).toBe('SIGNING_CANCELLATION_CLEAN');
      expect(pidEvidence[2]).toBe('True');
      expect(survivors).toEqual([]);
    }, 30_000);
  },
);
