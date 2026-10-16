# EZTerminal-owned OpenClaw desired-state supervisor (schema v1).
# This script intentionally uses only Windows PowerShell 5.1 built-ins and the
# official OpenClaw lifecycle CLI. It never runs Doctor, imports data, updates
# the package, generates tokens, or changes authentication.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$StateDirectory,

  [Parameter(Mandatory = $true)]
  [string]$CliPath,

  [switch]$InstallTask,
  [switch]$RunSupervisor,
  [switch]$RemoveTask,
  [switch]$RepairStateAcl,
  [switch]$PrepareUpgrade,
  [switch]$RunOnce,

  [ValidateRange(1, 300)]
  [int]$ReadyTimeoutSeconds = 120,
  [ValidateRange(1, 300)]
  [int]$HealthIntervalSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'EZTerminal OpenClaw Supervisor'
$TaskDescription = 'EZTerminal-owned OpenClaw desired-state supervisor v2'
$LegacyTaskName = 'OpenClaw Gateway Watchdog'
$SchemaVersion = 1
$MaxAttempts = 3
$LifecycleCommandTimeoutSeconds = 90
$QuickHealthSeconds = $HealthIntervalSeconds
$SupervisorInstanceId = [Guid]::NewGuid().ToString('N')
$script:ActiveGeneration = 0
$script:LastHeartbeat = [DateTime]::MinValue
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$stateDirectoryRoot = [IO.Path]::GetPathRoot($StateDirectory).TrimEnd('\')
$normalizedStateDirectory = $StateDirectory.TrimEnd('\')
$normalizedUserHome = [IO.Path]::GetFullPath($HOME).TrimEnd('\')
if ([string]::IsNullOrWhiteSpace($normalizedStateDirectory) -or
    $normalizedStateDirectory -eq $stateDirectoryRoot -or
    $normalizedStateDirectory -eq $normalizedUserHome) {
  throw 'Unsafe OpenClaw supervisor state directory'
}
$IntentPath = Join-Path $StateDirectory 'intent.json'
$RuntimePath = Join-Path $StateDirectory 'runtime.json'
$LegacyMarkerPath = Join-Path $StateDirectory 'legacy-watchdog.pending.json'

function New-DiagnosticId {
  return [Guid]::NewGuid().ToString('N')
}

function New-Issue {
  param(
    [string]$Code,
    [string]$Detail,
    [string]$Remediation
  )
  return [ordered]@{
    code = $Code
    detail = $Detail
    remediation = $Remediation
    diagnosticId = New-DiagnosticId
  }
}

function Write-CommandResult {
  param(
    [bool]$Ok,
    $Issue,
    [int]$ExitCode
  )
  [ordered]@{ ok = $Ok; issue = $Issue } |
    ConvertTo-Json -Depth 8 -Compress |
    Write-Output
  exit $ExitCode
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-AtomicJson {
  param([string]$Path, $Value)
  $parent = Split-Path -Parent $Path
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = "$Path.tmp"
  $json = $Value | ConvertTo-Json -Depth 16 -Compress
  [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
  if (Test-Path -LiteralPath $Path) {
    # Windows PowerShell 5.1 rejects a null backup path even though newer .NET
    # runtimes accept it. A same-directory backup keeps replacement atomic.
    $backup = "$Path.bak"
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    [IO.File]::Replace($temporary, $Path, $backup, $true)
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  } else {
    [IO.File]::Move($temporary, $Path)
  }
}

function Get-FileSha256 {
  param([string]$Path)
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Test-IntentShape {
  param($Intent)
  if ($null -eq $Intent) { return $false }
  return $Intent.schemaVersion -eq $SchemaVersion -and
    $Intent.generation -is [ValueType] -and
    [int64]$Intent.generation -gt 0 -and
    @('start', 'stop', 'restart') -contains [string]$Intent.action -and
    @('running', 'stopped') -contains [string]$Intent.desiredState -and
    -not [string]::IsNullOrWhiteSpace([string]$Intent.intentId)
}

function Get-Intent {
  $intent = Read-JsonFile -Path $IntentPath
  if (Test-IntentShape -Intent $intent) { return $intent }
  return $null
}

function Test-CurrentGeneration {
  param([int64]$Generation)
  $intent = Get-Intent
  return $null -ne $intent -and [int64]$intent.generation -eq $Generation
}

function Get-OpenClawStateRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_STATE_DIR)) {
    return [IO.Path]::GetFullPath($env:OPENCLAW_STATE_DIR)
  }
  return [IO.Path]::GetFullPath((Join-Path $HOME '.openclaw'))
}

function Get-GatewayPort {
  $configPath = Join-Path (Get-OpenClawStateRoot) 'openclaw.json'
  $config = Read-JsonFile -Path $configPath
  try {
    $candidate = [int]$config.gateway.port
    if ($candidate -ge 1 -and $candidate -le 65535) { return $candidate }
  } catch {
    # The service default remains authoritative when config omits the port.
  }
  return 18789
}

function New-Status {
  param(
    [string]$State,
    [int]$Port,
    [string]$Version = ''
  )
  $status = [ordered]@{ state = $State; port = $Port }
  if (-not [string]::IsNullOrWhiteSpace($Version)) { $status.version = $Version }
  return $status
}

function New-Operation {
  param($Intent, [string]$Phase, [int]$Attempt)
  return [ordered]@{
    intentId = [string]$Intent.intentId
    generation = [int64]$Intent.generation
    action = [string]$Intent.action
    phase = $Phase
    attempt = $Attempt
    maxAttempts = $MaxAttempts
    requestedAt = [string]$Intent.requestedAt
  }
}

function Write-Runtime {
  param(
    $Intent,
    [string]$Phase,
    [int]$Attempt,
    $Status,
    $Issue = $null,
    [switch]$Terminal
  )
  $operation = if ($Terminal -and $null -eq $Issue) {
    $null
  } else {
    New-Operation -Intent $Intent -Phase $Phase -Attempt $Attempt
  }
  $runtime = [ordered]@{
    schemaVersion = $SchemaVersion
    intentId = [string]$Intent.intentId
    generation = [int64]$Intent.generation
    status = $Status
    desiredState = [string]$Intent.desiredState
    supervisorState = if ($null -eq $Issue) { 'ready' } else { 'error' }
    operation = $operation
    issue = $Issue
    updatedAt = [DateTime]::UtcNow.ToString('o')
    statusObservedAt = [DateTime]::UtcNow.ToString('o')
    supervisorHeartbeatAt = [DateTime]::UtcNow.ToString('o')
    supervisorInstanceId = $SupervisorInstanceId
  }
  Write-AtomicJson -Path $RuntimePath -Value $runtime
}

function Read-BoundedText {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $text = [IO.File]::ReadAllText($Path)
  if ($text.Length -gt 1048576) { return $text.Substring($text.Length - 1048576) }
  return $text
}

function Invoke-BoundedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [int]$TimeoutSeconds,
    [AllowNull()]
    [string]$StandardInput = $null
  )
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  $id = [Guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $StateDirectory "command-$id.stdout"
  $stderrPath = Join-Path $StateDirectory "command-$id.stderr"
  $stdinPath = Join-Path $StateDirectory "command-$id.stdin"
  try {
    $start = @{
      FilePath = $FilePath
      ArgumentList = $Arguments
      WindowStyle = 'Hidden'
      PassThru = $true
      RedirectStandardOutput = $stdoutPath
      RedirectStandardError = $stderrPath
    }
    if ($null -ne $StandardInput) {
      [IO.File]::WriteAllText($stdinPath, $StandardInput, (New-Object Text.UTF8Encoding($false)))
      $start.RedirectStandardInput = $stdinPath
    }
    $process = Start-Process @start
    # Keep the process handle alive: Windows PowerShell otherwise loses the
    # exit code when HasExited/Refresh observes a short-lived cmd shim first.
    $null = $process.Handle
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      Update-SupervisorHeartbeat
      if ($script:ActiveGeneration -gt 0 -and -not (Test-CurrentGeneration -Generation $script:ActiveGeneration)) { break }
      Start-Sleep -Milliseconds 200
      $process.Refresh()
    }
    $timedOut = -not $process.HasExited
    if ($timedOut) {
      & taskkill.exe /PID $process.Id /T /F *> $null
      try { $process.WaitForExit(5000) | Out-Null } catch {}
    } else {
      $process.WaitForExit()
    }
    return [ordered]@{
      code = if ($timedOut) { -1 } else { [int]$process.ExitCode }
      stdout = Read-BoundedText -Path $stdoutPath
      stderr = Read-BoundedText -Path $stderrPath
      timedOut = $timedOut
    }
  } catch {
    return [ordered]@{ code = -1; stdout = ''; stderr = (Protect-CommandText -Text $_.Exception.Message); timedOut = $false }
  } finally {
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stdinPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-OpenClaw {
  param(
    [string[]]$Arguments,
    [int]$TimeoutSeconds = 30,
    [AllowNull()]
    [string]$StandardInput = $null
  )
  return Invoke-BoundedProcess -FilePath $CliPath -Arguments $Arguments `
    -TimeoutSeconds $TimeoutSeconds -StandardInput $StandardInput
}


function Protect-CommandText {
  param([string]$Text)
  $safe = $Text -replace '(?i)(bearer\s+)[^\s"\x27]+', '$1[redacted]'
  $safe = $safe -replace '(?i)((?:token|api[_-]?key|password|secret)["\x27\s:=]+)[^\s,"\x27}\]]+', '$1[redacted]'
  if ($safe.Length -gt 8192) { $safe = $safe.Substring($safe.Length - 8192) }
  return $safe.Trim()
}

function Update-SupervisorHeartbeat {
  if (([DateTime]::UtcNow - $script:LastHeartbeat).TotalSeconds -lt 5) { return }
  $runtime = Read-JsonFile -Path $RuntimePath
  if ($null -eq $runtime -or -not $runtime.PSObject.Properties['supervisorInstanceId'] -or
      [string]$runtime.supervisorInstanceId -ne $SupervisorInstanceId) { return }
  $runtime.supervisorHeartbeatAt = [DateTime]::UtcNow.ToString('o')
  Write-AtomicJson -Path $RuntimePath -Value $runtime
  $script:LastHeartbeat = [DateTime]::UtcNow
}

function Invoke-GatewayCommand {
  param([string[]]$Arguments)
  $result = Invoke-OpenClaw -Arguments $Arguments -TimeoutSeconds $LifecycleCommandTimeoutSeconds
  $directory = Join-Path $StateDirectory 'diagnostics'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $record = [ordered]@{
    arguments = $Arguments; exitCode = $result.code; timedOut = $result.timedOut
    stdout = Protect-CommandText -Text $result.stdout
    stderr = Protect-CommandText -Text $result.stderr
    at = [DateTime]::UtcNow.ToString('o')
  }
  Write-AtomicJson -Path (Join-Path $directory 'last-command.json') -Value $record
  return $result
}

function New-CommandIssue {
  param($Result, [string]$Action)
  $output = Protect-CommandText -Text ($Result.stderr + "`n" + $Result.stdout)
  if ([string]::IsNullOrWhiteSpace($output)) { $output = "Exit code $($Result.code)." }
  return New-Issue -Code 'gateway-unhealthy' -Detail "OpenClaw $Action failed: $output" `
    -Remediation 'Review the command output in details, correct the reported cause, then retry. Manual repair: openclaw doctor --fix.'
}

function Get-GatewayTaskName {
  if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_WINDOWS_TASK_NAME)) { return $env:OPENCLAW_WINDOWS_TASK_NAME }
  if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_PROFILE) -and $env:OPENCLAW_PROFILE -ne 'default') {
    return "OpenClaw Gateway ($($env:OPENCLAW_PROFILE))"
  }
  return 'OpenClaw Gateway'
}

function Test-GatewayTaskOwned {
  param($Task)
  if ($null -eq $Task) { return $false }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { return $false }
  $root = Get-OpenClawStateRoot
  foreach ($name in @('gateway.vbs', 'gateway.cmd')) {
    $launcher = [IO.Path]::GetFullPath((Join-Path $root $name))
    if ([string]$actions[0].Execute -eq $launcher) { return $true }
    # WScript/cmd tasks must name the exact launcher, not a matching substring.
    $arguments = [string]$actions[0].Arguments
    if ([string]$actions[0].Execute -match '(?i)(?:^|\\)(?:wscript|cscript|cmd)(?:\.exe)?$' -and
        ($arguments -eq "`"$launcher`"" -or $arguments -eq $launcher -or
         $arguments -eq "/c `"$launcher`"")) { return $true }
  }
  return $false
}

function Set-GatewayAutostart {
  param([bool]$Enabled, [int]$Port)
  $name = Get-GatewayTaskName
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($null -eq $task -and $Enabled) {
    $install = Invoke-GatewayCommand -Arguments @('gateway', 'install', '--json', '--port', [string]$Port)
    if ($install.code -ne 0) { return New-CommandIssue -Result $install -Action 'registration' }
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
      return New-Issue -Code 'supervisor-failed' -Detail 'OpenClaw did not register its Windows startup task.' `
        -Remediation 'Check Windows task registration permissions and retry Start.'
    }
  }
  if ($null -eq $task) { return $null }
  if (-not (Test-GatewayTaskOwned -Task $task)) {
    return New-Issue -Code 'watchdog-conflict' -Detail "The task '$name' belongs to a different launcher." `
      -Remediation 'Review the conflicting task. EZTerminal has left it unchanged.'
  }
  if ($Enabled -and -not $task.Settings.Enabled) { Enable-ScheduledTask -TaskName $name | Out-Null }
  if (-not $Enabled -and $task.Settings.Enabled) { Disable-ScheduledTask -TaskName $name | Out-Null }
  return $null
}

function Get-GatewayObservation {
  param([int]$Port)
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
    $body = $health.Content | ConvertFrom-Json
    if ([int]$health.StatusCode -ge 200 -and [int]$health.StatusCode -lt 300 -and $body.ok -eq $true) {
      $ready = $false
      try {
        $startup = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/startupz" -TimeoutSec 3
        $ready = [int]$startup.StatusCode -ge 200 -and [int]$startup.StatusCode -lt 300
      } catch {
        # Older gateways have liveness but no separate startup endpoint.
        if ($null -ne $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { $ready = $true }
      }
      return @{ ready = $ready; alive = $true; absent = $false; issue = $null
        status = (New-Status -State $(if ($ready) { 'running' } else { 'starting' }) -Port $Port) }
    }
  } catch { }
  # A refused socket is not proof of process exit during cold startup.
  try {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
    $owned = @($processes | Where-Object {
      $command = [string]$_.CommandLine
      $command -match '(?i)openclaw(?:[\\/]|\.(?:mjs|cjs|js))' -and
      $command -match '(?i)(?:^|\s)gateway(?:\s|$)' -and
      ($command -match "(?:^|\s)--port(?:=|\s+)`"?$Port(?:`"|\s|$)" -or
        ($Port -eq 18789 -and $command -notmatch '(?:^|\s)--port(?:=|\s+)'))
    })
    foreach ($listener in $listeners) {
      if (@($owned | Where-Object { [int64]$_.ProcessId -eq [int64]$listener.OwningProcess }).Count -eq 0) {
        return @{ ready = $false; alive = $false; absent = $false
          status = (New-Status -State 'unknown' -Port $Port)
          issue = (New-Issue -Code 'port-conflict' -Detail "Another application is listening on port $Port." `
            -Remediation 'Stop that application or choose a different OpenClaw port, then retry Start.') }
      }
    }
    $task = Get-ScheduledTask -TaskName (Get-GatewayTaskName) -ErrorAction SilentlyContinue
    $taskActive = (Test-GatewayTaskOwned -Task $task) -and [string]$task.State -in @('Running', 'Queued', '4', '2')
    $absent = $owned.Count -eq 0 -and $listeners.Count -eq 0 -and -not $taskActive
    return @{ ready = $false; alive = -not $absent; absent = $absent; issue = $null
      status = (New-Status -State $(if ($absent) { 'stopped' } else { 'starting' }) -Port $Port) }
  } catch {
    return @{ ready = $false; alive = $false; absent = $false
      status = (New-Status -State 'unknown' -Port $Port)
      issue = (New-Issue -Code 'permission-denied' -Detail 'Windows could not inspect the OpenClaw process.' `
        -Remediation 'Check process inspection permissions and retry. No process was stopped.') }
  }
}

function Wait-GatewayState {
  param($Intent, [int]$Port, [bool]$Running)
  $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  do {
    if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return $null }
    Update-SupervisorHeartbeat
    $observed = Get-GatewayObservation -Port $Port
    if ($null -ne $observed.issue -or ($Running -and $observed.ready) -or (-not $Running -and $observed.absent)) { return $observed }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  return $observed
}

function Invoke-Reconcile {
  param($Intent, [bool]$ExplicitRestart = $false)
  $port = Get-GatewayPort
  $script:ActiveGeneration = [int64]$Intent.generation
  $observed = Get-GatewayObservation -Port $port
  if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
    $issue = New-Issue -Code 'cli-missing' -Detail 'The OpenClaw CLI cannot be found.' -Remediation 'Install OpenClaw, then retry Start.'
    Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt 0 -Status $observed.status -Issue $issue
    return
  }
  $running = [string]$Intent.desiredState -eq 'running'
  Write-Runtime -Intent $Intent -Phase $(if ($running) { 'starting' } else { 'stopping' }) -Attempt 0 -Status $observed.status
  # Stop must disable future native launches even if another process owns the port.
  if ($running -and $null -ne $observed.issue) {
    Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt 0 -Status $observed.status -Issue $observed.issue
    return
  }
  $registration = Set-GatewayAutostart -Enabled $running -Port $port
  if (-not (Test-CurrentGeneration -Generation $script:ActiveGeneration)) { return }
  if ($null -ne $registration) {
    Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt 0 -Status $observed.status -Issue $registration
    return
  }
  # Registration can also start the native task on some CLI versions.
  $observed = Get-GatewayObservation -Port $port
  if ($null -ne $observed.issue) {
    Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt 0 -Status $observed.status -Issue $observed.issue
    return
  }
  if ($ExplicitRestart -and -not $observed.absent) {
    Write-Runtime -Intent $Intent -Phase 'restarting' -Attempt 1 -Status $observed.status
    $stop = Invoke-GatewayCommand -Arguments @('gateway', 'stop', '--force', '--json')
    if (-not (Test-CurrentGeneration -Generation $script:ActiveGeneration)) { return }
    $observed = Wait-GatewayState -Intent $Intent -Port $port -Running $false
    if ($null -eq $observed) { return }
    if (-not $observed.absent) {
      $issue = New-CommandIssue -Result $stop -Action 'stop before restart'
      Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt 1 -Status $observed.status -Issue $issue
      return
    }
  }
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    if (-not (Test-CurrentGeneration -Generation $script:ActiveGeneration)) { return }
    if (($running -and $observed.ready) -or (-not $running -and $observed.absent)) {
      Write-Runtime -Intent $Intent -Phase 'idle' -Attempt 0 -Status $observed.status -Terminal
      Complete-LegacyWatchdogMigration
      return
    }
    $phase = if ($running) { 'starting' } else { 'stopping' }
    Write-Runtime -Intent $Intent -Phase $phase -Attempt $attempt -Status $observed.status
    # An existing process gets startup time, never a duplicate start or Doctor.
    $result = @{ code = 0; stdout = ''; stderr = ''; timedOut = $false }
    if (-not $running) {
      $result = Invoke-GatewayCommand -Arguments @('gateway', 'stop', '--force', '--json')
    } elseif ($observed.absent) {
      $result = Invoke-GatewayCommand -Arguments @('gateway', 'start', '--json')
    }
    if (-not (Test-CurrentGeneration -Generation $script:ActiveGeneration)) { return }
    $observed = Get-GatewayObservation -Port $port
    if ($result.code -eq 0 -or ($running -and -not $observed.absent)) {
      $observed = Wait-GatewayState -Intent $Intent -Port $port -Running $running
    }
    if ($null -eq $observed) { return }
    if (($running -and $observed.ready) -or (-not $running -and $observed.absent)) {
      Write-Runtime -Intent $Intent -Phase 'idle' -Attempt $attempt -Status $observed.status -Terminal
      Complete-LegacyWatchdogMigration
      return
    }
    if ($null -ne $observed.issue) {
      Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $attempt -Status $observed.status -Issue $observed.issue
      return
    }
    if ($running -and -not $observed.absent) {
      $issue = New-Issue -Code 'gateway-unhealthy' -Detail 'OpenClaw is running but its HTTP server has not finished starting.' `
        -Remediation 'Review the OpenClaw log or press Restart. Management RPC does not trigger a restart.'
      Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $attempt -Status $observed.status -Issue $issue
      return
    }
    if ($attempt -lt $MaxAttempts) {
      $retryAt = [DateTime]::UtcNow.AddSeconds($(if ($attempt -eq 1) { 5 } else { 15 }))
      while ([DateTime]::UtcNow -lt $retryAt) {
        if (-not (Test-CurrentGeneration -Generation $script:ActiveGeneration)) { return }
        Update-SupervisorHeartbeat
        Start-Sleep -Milliseconds 200
      }
    }
  }
  if ($result.code -eq 0) { $result.stderr = 'The command exited successfully but the requested process state was not reached.' }
  Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $MaxAttempts -Status $observed.status `
    -Issue (New-CommandIssue -Result $result -Action $phase)
}
function Protect-BackupAcl {
  param([string]$Directory)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  # Protect the root and let its inheritable ACEs flow to children. Applying
  # /inheritance:r recursively removes the only effective ACEs from files.
  & icacls.exe $Directory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'backup ACL application failed' }
}

function Repair-StateDirectoryAcl {
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $StateDirectory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'state root ACL repair failed' }

    # v1.0.41 recursively removed inherited ACEs from existing files. Grant
    # access without changing child inheritance so upgrades can replace them.
    & icacls.exe $StateDirectory /grant "${identity}:F" 'SYSTEM:F' /T /C *> $null
    if ($LASTEXITCODE -ne 0) { throw 'state child ACL repair failed' }
    return $null
  } catch [UnauthorizedAccessException] {
    return New-Issue -Code 'permission-denied' `
      -Detail 'Windows denied repair of the OpenClaw supervisor files.' `
      -Remediation 'Check the EZTerminal user-data folder permissions, then press Start again.'
  } catch {
    return New-Issue -Code 'supervisor-failed' `
      -Detail 'EZTerminal could not repair the OpenClaw supervisor files.' `
      -Remediation 'Check the EZTerminal user-data folder permissions, then press Start again.'
  }
}

function Complete-LegacyWatchdogMigration {
  if (-not (Test-Path -LiteralPath $LegacyMarkerPath -PathType Leaf)) { return }
  try {
    $legacy = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
    if ($null -ne $legacy) { Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false }
    Remove-Item -LiteralPath $LegacyMarkerPath -Force
  } catch {
    # The disabled, backed-up legacy task is harmless; retry on the next success.
  }
}

function Test-OwnedTask {
  param($Task)
  if ($null -eq $Task -or [string]$Task.Description -notin @($TaskDescription, 'EZTerminal-owned OpenClaw desired-state supervisor v1')) { return $false }
  $actions = @($Task.Actions)
  $ownedScriptPath = [IO.Path]::GetFullPath((Join-Path $StateDirectory 'openclaw-supervisor.ps1'))
  if ($actions.Count -ne 1 -or [string]$actions[0].Execute -notmatch '(?i)(?:^|\\)powershell\.exe$') { return $false }
  $match = [regex]::Match([string]$actions[0].Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
  if (-not $match.Success) { return $false }
  $launcher = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
  return [IO.Path]::GetFullPath($launcher) -eq $ownedScriptPath
}

function Prepare-LegacyWatchdogMigration {
  $legacy = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
  if ($null -eq $legacy) { return $null }
  $actions = @($legacy.Actions)
  $expectedScript = [IO.Path]::GetFullPath((Join-Path (Get-OpenClawStateRoot) 'gateway-watchdog.ps1'))
  $actualScript = $null
  if ($actions.Count -eq 1 -and [string]$actions[0].Execute -match '(?i)powershell(.exe)?$') {
    $match = [regex]::Match([string]$actions[0].Arguments, '(?i)-File\s+(?:"([^"]+)"|(\S+))')
    if ($match.Success) { $actualScript = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value } }
  }
  if ($null -eq $actualScript -or [IO.Path]::GetFullPath($actualScript) -ne $expectedScript) {
    return New-Issue -Code 'watchdog-conflict' `
      -Detail 'A task named OpenClaw Gateway Watchdog exists but is not the known legacy EZTerminal watcher.' `
      -Remediation 'Rename or remove that task manually, then press Start again.'
  }
  $backupDirectory = Join-Path $StateDirectory ('legacy-watchdog-backup\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
  [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
  Export-ScheduledTask -TaskName $LegacyTaskName |
    Set-Content -LiteralPath (Join-Path $backupDirectory 'task.xml') -Encoding UTF8
  if (Test-Path -LiteralPath $expectedScript -PathType Leaf) {
    $legacyScriptBackup = Join-Path $backupDirectory 'gateway-watchdog.ps1'
    Copy-Item -LiteralPath $expectedScript -Destination $legacyScriptBackup -Force
    if ((Get-FileSha256 -Path $expectedScript) -ne
        (Get-FileSha256 -Path $legacyScriptBackup)) {
      throw 'legacy watchdog backup verification failed'
    }
  }
  Protect-BackupAcl -Directory $backupDirectory
  Stop-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName $LegacyTaskName | Out-Null
  Write-AtomicJson -Path $LegacyMarkerPath -Value ([ordered]@{
    taskName = $LegacyTaskName
    backupPath = $backupDirectory
  })
  return $null
}

function Install-SupervisorTask {
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # Do not recurse with /inheritance:r: existing files (including this
    # supervisor) would lose their inherited access entries while executing.
    & icacls.exe $StateDirectory /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'state ACL failed' }

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $existing -and -not (Test-OwnedTask -Task $existing)) {
      return New-Issue -Code 'watchdog-conflict' `
        -Detail 'The EZTerminal OpenClaw supervisor task name is owned by an unknown task.' `
        -Remediation 'Rename or remove the conflicting task, then press Start again.'
    }
    $legacyIssue = Prepare-LegacyWatchdogMigration
    if ($null -ne $legacyIssue) { return $legacyIssue }

    $powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -RunSupervisor -StateDirectory `"$StateDirectory`" -CliPath `"$CliPath`""
    if ($null -ne $existing -and [string]$existing.Description -eq $TaskDescription -and
        [string]$existing.Actions[0].Execute -eq $powerShell -and
        [string]$existing.Actions[0].Arguments -eq $arguments) {
      if (-not $existing.Settings.Enabled) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
      return $null
    }
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval ([TimeSpan]::FromMinutes(1))
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings `
      -Principal $principal -Description $TaskDescription
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    return $null
  } catch [UnauthorizedAccessException] {
    return New-Issue -Code 'permission-denied' `
      -Detail 'Windows denied current-user OpenClaw supervisor registration.' `
      -Remediation 'Check Task Scheduler and user-data permissions, then press Start again.'
  } catch {
    return New-Issue -Code 'supervisor-failed' `
      -Detail 'The current-user OpenClaw supervisor task could not be registered.' `
      -Remediation 'Open Task Scheduler diagnostics, then press Start again.'
  }
}

function Remove-SupervisorTask {
  try {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) { return $null }
    if (-not (Test-OwnedTask -Task $existing)) {
      return New-Issue -Code 'watchdog-conflict' `
        -Detail 'The supervisor task no longer matches the EZTerminal-owned definition.' `
        -Remediation 'Inspect the task manually before removing it.'
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    return $null
  } catch {
    return New-Issue -Code 'permission-denied' `
      -Detail 'Windows denied removal of the EZTerminal OpenClaw supervisor task.' `
      -Remediation 'Remove the exact EZTerminal-owned task from Task Scheduler.'
  }
}


function Prepare-SupervisorUpgrade {
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { return $null }
    if (-not (Test-OwnedTask -Task $task)) {
      return New-Issue -Code 'watchdog-conflict' -Detail 'The supervisor task belongs to a different launcher.' -Remediation 'Review the task before updating it.'
    }
    # Do not interrupt a Doctor/data import admitted by the previous release.
    $deadline = [DateTime]::UtcNow.AddSeconds(330)
    do {
      $runtime = Read-JsonFile -Path $RuntimePath
      $maintenance = $null -ne $runtime -and $null -ne $runtime.operation -and
        [string]$runtime.operation.phase -in @('repairing', 'backing-up') -and [string]$task.State -eq 'Running'
      if (-not $maintenance) { break }
      if ([DateTime]::UtcNow -ge $deadline) {
        return New-Issue -Code 'supervisor-failed' -Detail 'An earlier OpenClaw data repair is still active.' `
          -Remediation 'Allow that repair to finish, then retry Start. It has not been interrupted.'
      }
      Start-Sleep -Seconds 1
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } while ($true)
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $exitDeadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($null -eq $task -or [string]$task.State -notin @('Running', 'Queued', '4', '2')) { return $null }
      Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $exitDeadline)
    return New-Issue -Code 'supervisor-failed' -Detail 'The previous OpenClaw supervisor has not exited yet.' `
      -Remediation 'Retry Start once the previous supervisor has stopped. The gateway has not been restarted.'
  } catch {
    return New-Issue -Code 'supervisor-failed' -Detail 'The previous OpenClaw supervisor could not be replaced.' -Remediation 'Check task permissions and retry Start.'
  }
}

function Run-SupervisorLoop {
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  # A file lock works across Windows sessions and is released after a crash.
  try { $lock = [IO.File]::Open((Join-Path $StateDirectory 'supervisor.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { return }
  try {
    $first = $true
    $lastCheck = [DateTime]::MinValue
    while ($true) {
      $intent = Get-Intent
      if ($null -ne $intent) {
        try {
          $runtime = Read-JsonFile -Path $RuntimePath
          $newRequest = $null -eq $runtime -or [int64]$runtime.generation -ne [int64]$intent.generation
          if ($first -or $newRequest) {
            # A restart is an edge, not a durable instruction to stop every boot.
            Invoke-Reconcile -Intent $intent -ExplicitRestart ($newRequest -and [string]$intent.action -eq 'restart')
            $lastCheck = [DateTime]::UtcNow
            $first = $false
          } elseif (([DateTime]::UtcNow - $lastCheck).TotalSeconds -ge $QuickHealthSeconds) {
            $lastCheck = [DateTime]::UtcNow
            $observed = Get-GatewayObservation -Port (Get-GatewayPort)
            $blocked = $null -ne $runtime.operation -and [string]$runtime.operation.phase -eq 'blocked'
            if (([string]$intent.desiredState -eq 'running' -and $observed.ready) -or
                ([string]$intent.desiredState -eq 'stopped' -and $observed.absent)) {
              Write-Runtime -Intent $intent -Phase 'idle' -Attempt 0 -Status $observed.status -Terminal
            } elseif (-not $blocked -and $null -eq $observed.issue) {
              Invoke-Reconcile -Intent $intent
            } elseif ($null -ne $observed.issue) {
              Write-Runtime -Intent $intent -Phase 'blocked' -Attempt 0 -Status $observed.status -Issue $observed.issue
            }
          }
          Update-SupervisorHeartbeat
        } catch {
          $issue = New-Issue -Code 'supervisor-failed' -Detail (Protect-CommandText -Text $_.Exception.Message) `
            -Remediation 'Review the Windows execution error and retry the requested action.'
          Write-Runtime -Intent $intent -Phase 'blocked' -Attempt 0 -Status (New-Status -State 'unknown' -Port (Get-GatewayPort)) -Issue $issue
          $first = $false
        }
      }
      if ($RunOnce) { return }
      Start-Sleep -Milliseconds 500
    }
  } finally { $lock.Dispose() }
}

if ($PrepareUpgrade) {
  $issue = Prepare-SupervisorUpgrade
  Write-CommandResult -Ok ($null -eq $issue) -Issue $issue -ExitCode $(if ($null -eq $issue) { 0 } else { 1 })
}
if ($RepairStateAcl) {
  $issue = Repair-StateDirectoryAcl
  Write-CommandResult -Ok ($null -eq $issue) -Issue $issue -ExitCode $(if ($null -eq $issue) { 0 } else { 1 })
}
if ($InstallTask) {
  $issue = Install-SupervisorTask
  Write-CommandResult -Ok ($null -eq $issue) -Issue $issue -ExitCode $(if ($null -eq $issue) { 0 } else { 1 })
}
if ($RemoveTask) {
  $issue = Remove-SupervisorTask
  Write-CommandResult -Ok ($null -eq $issue) -Issue $issue -ExitCode $(if ($null -eq $issue) { 0 } else { 1 })
}
if ($RunSupervisor) { Run-SupervisorLoop; exit 0 }
Write-CommandResult -Ok $false -Issue (New-Issue -Code 'supervisor-failed' -Detail 'No supervisor mode was selected.' -Remediation 'Start OpenClaw from EZTerminal.') -ExitCode 2
