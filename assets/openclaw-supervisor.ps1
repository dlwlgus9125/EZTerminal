# EZTerminal-owned OpenClaw desired-state supervisor (schema v1).
# This script intentionally uses only Windows PowerShell 5.1 built-ins and the
# official OpenClaw CLI. It never installs/updates OpenClaw, resets data,
# generates tokens, weakens authentication, or invokes doctor --force.
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
  [switch]$RunOnce,

  [ValidateRange(1, 300)]
  [int]$ReadyTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'EZTerminal OpenClaw Supervisor'
$TaskDescription = 'EZTerminal-owned OpenClaw desired-state supervisor v1'
$LegacyTaskName = 'OpenClaw Gateway Watchdog'
$SchemaVersion = 1
$MaxAttempts = 3
$LifecycleCommandTimeoutSeconds = 90
$QuickHealthSeconds = 15
$DeepHealthSeconds = 300
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
$BackupRoot = Join-Path $StateDirectory 'recovery'
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
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $TimeoutSeconds))
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
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
    return [ordered]@{ code = -1; stdout = ''; stderr = 'process launch failed'; timedOut = $false }
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

function Test-StartupReady {
  param([int]$Port)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Get `
      -Uri "http://127.0.0.1:$Port/startupz" -TimeoutSec 5
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-AuthenticatedStatus {
  param([int]$Port)
  $result = Invoke-OpenClaw -Arguments @('gateway', 'status', '--require-rpc', '--json') -TimeoutSeconds 30
  if ($result.code -ne 0) {
    return [ordered]@{ ready = $false; status = (New-Status -State 'stopped' -Port $Port); raw = $null }
  }
  try {
    $parsed = $result.stdout | ConvertFrom-Json
    if ($parsed.rpc.ok -ne $true) {
      return [ordered]@{ ready = $false; status = (New-Status -State 'unknown' -Port $Port); raw = $parsed }
    }
    return [ordered]@{
      ready = $true
      status = (New-Status -State 'running' -Port $Port -Version ([string]$parsed.cli.version))
      raw = $parsed
    }
  } catch {
    return [ordered]@{ ready = $false; status = (New-Status -State 'unknown' -Port $Port); raw = $null }
  }
}

function Wait-GatewayReady {
  param($Intent, [int]$Port, [int]$TimeoutSeconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) {
      return [ordered]@{ ready = $false; superseded = $true; status = (New-Status -State 'unknown' -Port $Port) }
    }
    if (Test-StartupReady -Port $Port) {
      $first = Get-AuthenticatedStatus -Port $Port
      if ($first.ready) {
        Start-Sleep -Seconds 5
        if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) {
          return [ordered]@{ ready = $false; superseded = $true; status = $first.status }
        }
        if (Test-StartupReady -Port $Port) {
          $second = Get-AuthenticatedStatus -Port $Port
          if ($second.ready) {
            return [ordered]@{ ready = $true; superseded = $false; status = $second.status }
          }
        }
      }
    }
    Start-Sleep -Milliseconds 2500
  }
  $state = if (Test-StartupReady -Port $Port) { 'unknown' } else { 'stopped' }
  return [ordered]@{ ready = $false; superseded = $false; status = (New-Status -State $state -Port $Port) }
}

function Test-StablyStopped {
  param($Intent, [int]$Port)
  if (Test-StartupReady -Port $Port) { return $false }
  Start-Sleep -Seconds 5
  if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return $false }
  return -not (Test-StartupReady -Port $Port)
}

function Test-CliCapabilities {
  if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
    return New-Issue -Code 'cli-missing' `
      -Detail 'The OpenClaw CLI is missing or cannot be opened.' `
      -Remediation 'Install a compatible OpenClaw CLI and press Start again.'
  }
  $doctor = Invoke-OpenClaw -Arguments @('doctor', '--help') -TimeoutSeconds 30
  $status = Invoke-OpenClaw -Arguments @('gateway', 'status', '--help') -TimeoutSeconds 30
  $restart = Invoke-OpenClaw -Arguments @('gateway', 'restart', '--help') -TimeoutSeconds 30
  $start = Invoke-OpenClaw -Arguments @('gateway', 'start', '--help') -TimeoutSeconds 30
  $stop = Invoke-OpenClaw -Arguments @('gateway', 'stop', '--help') -TimeoutSeconds 30
  if ($doctor.code -ne 0 -or $doctor.stdout -notmatch '--fix' -or $doctor.stdout -notmatch '--non-interactive' -or
      $status.code -ne 0 -or $status.stdout -notmatch '--require-rpc' -or
      $restart.code -ne 0 -or $restart.stdout -notmatch '--safe' -or $restart.stdout -notmatch '--force' -or
      $start.code -ne 0 -or $start.stdout -notmatch '--json' -or
      $stop.code -ne 0 -or $stop.stdout -notmatch '--force' -or $stop.stdout -notmatch '--json') {
    return New-Issue -Code 'cli-incompatible' `
      -Detail 'The installed OpenClaw CLI does not provide the required safe lifecycle commands.' `
      -Remediation 'Install a compatible OpenClaw release, then press Start again.'
  }
  return $null
}

function Get-StringsRecursively {
  param($Value)
  $found = New-Object Collections.Generic.List[string]
  function Visit($Current) {
    if ($Current -is [string]) {
      if ($Current.EndsWith('.jsonl', [StringComparison]::OrdinalIgnoreCase)) { $found.Add($Current) }
      return
    }
    if ($null -eq $Current) { return }
    if ($Current -is [Collections.IEnumerable] -and -not ($Current -is [string])) {
      foreach ($item in $Current) { Visit $item }
      return
    }
    foreach ($property in $Current.PSObject.Properties) { Visit $property.Value }
  }
  Visit $Value
  return $found
}

function Copy-VerifiedFile {
  param(
    [string]$Source,
    [string]$Destination,
    [string]$DestinationRoot,
    [Collections.Generic.List[object]]$Manifest
  )
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { return }
  [IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  $sourceInfo = Get-Item -LiteralPath $Source
  $destinationInfo = Get-Item -LiteralPath $Destination
  if ($sourceInfo.Length -ne $destinationInfo.Length) { throw 'backup length verification failed' }
  $sourceHash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
  $destinationHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
  if ($sourceHash -ne $destinationHash) { throw 'backup hash verification failed' }
  $Manifest.Add([ordered]@{
    source = $Source
    destination = $Destination.Substring($DestinationRoot.TrimEnd('\').Length).TrimStart('\')
    bytes = $sourceInfo.Length
    sha256 = $sourceHash
  })
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

function New-RecoveryBackup {
  param($Intent)
  [IO.Directory]::CreateDirectory($BackupRoot) | Out-Null
  $generationMarker = Join-Path $BackupRoot ("generation-{0}.json" -f [int64]$Intent.generation)
  if (Test-Path -LiteralPath $generationMarker -PathType Leaf) { return $true }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
  $partial = Join-Path $BackupRoot ("$stamp-g$($Intent.generation).partial")
  $complete = $partial.Substring(0, $partial.Length - '.partial'.Length)
  [IO.Directory]::CreateDirectory($partial) | Out-Null
  $manifest = New-Object Collections.Generic.List[object]
  try {
    # Establish the restricted inheritable ACL before any sensitive child is
    # created. Existing-child ACL propagation differs across Windows images.
    Protect-BackupAcl -Directory $partial
    $stateRoot = Get-OpenClawStateRoot
    Copy-VerifiedFile -Source (Join-Path $stateRoot 'openclaw.json') `
      -Destination (Join-Path $partial 'openclaw.json') -DestinationRoot $partial -Manifest $manifest
    Copy-VerifiedFile -Source (Join-Path $stateRoot 'exec-approvals.json') `
      -Destination (Join-Path $partial 'exec-approvals.json') -DestinationRoot $partial -Manifest $manifest
    Copy-VerifiedFile -Source (Join-Path $stateRoot 'gateway.cmd') `
      -Destination (Join-Path $partial 'service\gateway.cmd') -DestinationRoot $partial -Manifest $manifest
    Copy-VerifiedFile -Source (Join-Path $stateRoot 'gateway.vbs') `
      -Destination (Join-Path $partial 'service\gateway.vbs') -DestinationRoot $partial -Manifest $manifest

    $taskXml = & schtasks.exe /Query /TN 'OpenClaw Gateway' /XML 2>$null | Out-String
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($taskXml)) {
      [IO.Directory]::CreateDirectory((Join-Path $partial 'service')) | Out-Null
      $taskBackupPath = Join-Path $partial 'service\OpenClaw-Gateway.xml'
      [IO.File]::WriteAllText($taskBackupPath, $taskXml, (New-Object Text.UTF8Encoding($false)))
      $taskBackupInfo = Get-Item -LiteralPath $taskBackupPath
      $manifest.Add([ordered]@{
        source = 'scheduled-task:OpenClaw Gateway'
        destination = 'service\OpenClaw-Gateway.xml'
        bytes = $taskBackupInfo.Length
        sha256 = (Get-FileHash -LiteralPath $taskBackupPath -Algorithm SHA256).Hash
      })
    }

    $sessionStores = Get-ChildItem -LiteralPath (Join-Path $stateRoot 'agents') `
      -Filter 'sessions.json' -File -Recurse -ErrorAction SilentlyContinue
    foreach ($store in $sessionStores) {
      $sessionsDirectory = $store.Directory.FullName
      $agentDirectory = Split-Path -Parent $sessionsDirectory
      $agentName = Split-Path -Leaf $agentDirectory
      $destinationDirectory = Join-Path $partial ("agents\$agentName\sessions")
      Copy-VerifiedFile -Source $store.FullName `
        -Destination (Join-Path $destinationDirectory 'sessions.json') `
        -DestinationRoot $partial -Manifest $manifest
      $parsed = Read-JsonFile -Path $store.FullName
      foreach ($reference in (Get-StringsRecursively -Value $parsed | Select-Object -Unique)) {
        try {
          $candidate = if ([IO.Path]::IsPathRooted($reference)) {
            [IO.Path]::GetFullPath($reference)
          } else {
            [IO.Path]::GetFullPath((Join-Path $sessionsDirectory $reference))
          }
          $rootPrefix = $stateRoot.TrimEnd('\') + '\'
          if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { continue }
          $stateRelativePath = $candidate.Substring($rootPrefix.Length)
          Copy-VerifiedFile -Source $candidate `
            -Destination (Join-Path $partial (Join-Path 'referenced' $stateRelativePath)) `
            -DestinationRoot $partial -Manifest $manifest
        } catch {
          # Invalid references are doctor diagnostics, not backup escape hatches.
        }
      }
    }
    if ($manifest.Count -eq 0) { throw 'no OpenClaw data was available to back up' }
    Write-AtomicJson -Path (Join-Path $partial 'manifest.json') -Value ([ordered]@{
      schemaVersion = 1
      generation = [int64]$Intent.generation
      createdAt = [DateTime]::UtcNow.ToString('o')
      files = $manifest
    })
    Move-Item -LiteralPath $partial -Destination $complete
    Write-AtomicJson -Path $generationMarker -Value ([ordered]@{ path = $complete; verified = $true })
    Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*.partial' } |
      Sort-Object Name -Descending |
      Select-Object -Skip 3 |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    return $true
  } catch {
    return $false
  }
}

function Save-Diagnostic {
  param($Intent, [int]$Attempt, [string]$Text)
  $directory = Join-Path $StateDirectory 'diagnostics'
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $safe = $Text
  if ($safe.Length -gt 1048576) { $safe = $safe.Substring($safe.Length - 1048576) }
  $path = Join-Path $directory ("g{0}-a{1}-{2}.json" -f $Intent.generation, $Attempt, (New-DiagnosticId))
  [IO.File]::WriteAllText($path, $safe, (New-Object Text.UTF8Encoding($false)))
}

function Diagnose-CriticalIssue {
  param($Intent, [int]$Attempt, [int]$Port)
  $diagnostic = Invoke-OpenClaw -Arguments @('gateway', 'status', '--deep', '--json') -TimeoutSeconds 45
  if (-not [string]::IsNullOrWhiteSpace($diagnostic.stdout)) {
    Save-Diagnostic -Intent $Intent -Attempt $Attempt -Text $diagnostic.stdout
  }
  try {
    $parsed = $diagnostic.stdout | ConvertFrom-Json
    $listeners = @($parsed.port.listeners)
    if ($parsed.rpc.ok -ne $true -and $listeners.Count -gt 0) {
      $knownOpenClaw = $false
      $gatewayPid = try { [int64]$parsed.service.runtime.pid } catch { 0 }
      foreach ($listener in $listeners) {
        $description = "$(($listener.processName)) $(($listener.command))"
        $listenerPid = try { [int64]$listener.pid } catch { -1 }
        if ($description -match '(?i)openclaw' -or ($gatewayPid -gt 0 -and $listenerPid -eq $gatewayPid)) {
          $knownOpenClaw = $true
        }
      }
      if (-not $knownOpenClaw) {
        return New-Issue -Code 'port-conflict' `
          -Detail "Another application owns the configured OpenClaw gateway port $Port." `
          -Remediation 'Stop or reconfigure that application, then press Start again.'
      }
    }
  } catch {
    # Unparseable diagnostics remain local evidence; safe repair can still run.
  }
  return $null
}

function Invoke-LegacyExecApprovalsMigration {
  param($Intent)
  $legacyPath = Join-Path (Get-OpenClawStateRoot) 'exec-approvals.json'
  if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) { return $true }

  $stagedPath = Join-Path $StateDirectory `
    ("exec-approvals-g{0}-{1}.json" -f [int64]$Intent.generation, (New-DiagnosticId))
  $moved = $false
  $imported = $false
  try {
    $sourceInfo = Get-Item -LiteralPath $legacyPath
    if ($sourceInfo.Length -gt 4194304) { throw 'legacy exec approvals exceed the migration limit' }
    $sourceHash = (Get-FileHash -LiteralPath $legacyPath -Algorithm SHA256).Hash
    Move-Item -LiteralPath $legacyPath -Destination $stagedPath
    $moved = $true
    if ((Get-FileHash -LiteralPath $stagedPath -Algorithm SHA256).Hash -ne $sourceHash) {
      throw 'legacy exec approvals staging verification failed'
    }

    $raw = [IO.File]::ReadAllText($stagedPath)
    $set = Invoke-OpenClaw -Arguments @('approvals', 'set', '--stdin', '--json') `
      -TimeoutSeconds 60 -StandardInput $raw
    if ($set.code -ne 0) { return $false }
    $verify = Invoke-OpenClaw -Arguments @('approvals', 'get', '--json') -TimeoutSeconds 60
    if ($verify.code -ne 0) { return $false }

    $imported = $true
    Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  } finally {
    if (-not $imported -and $moved -and
        (Test-Path -LiteralPath $stagedPath -PathType Leaf) -and
        -not (Test-Path -LiteralPath $legacyPath)) {
      Move-Item -LiteralPath $stagedPath -Destination $legacyPath -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-TargetedStateMigrations {
  param($Intent)
  # OpenClaw 2026.8.1 can skip Doctor-owned migrations in a non-interactive
  # task. Its dedicated session importer and approvals CLI remain supported.
  $sessions = Invoke-OpenClaw `
    -Arguments @('doctor', '--session-sqlite', 'import', '--session-sqlite-all-agents', '--yes') `
    -TimeoutSeconds 300
  if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return $false }
  $approvals = Invoke-LegacyExecApprovalsMigration -Intent $Intent
  return $sessions.code -eq 0 -and $approvals
}

function Invoke-SafeRepair {
  param($Intent, [int]$Attempt, [int]$Port)
  if ($Attempt -eq 1) {
    Invoke-TargetedStateMigrations -Intent $Intent | Out-Null
    if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return $false }
  }
  $doctor = Invoke-OpenClaw -Arguments @('doctor', '--fix', '--non-interactive', '--yes') -TimeoutSeconds 300
  if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return $false }
  if ($Attempt -ge 2) {
    $install = Invoke-OpenClaw `
      -Arguments @('gateway', 'install', '--force', '--json', '--port', [string]$Port) `
      -TimeoutSeconds 90
    if ($install.code -ne 0 -and $doctor.code -ne 0) { return $false }
  }
  return $doctor.code -eq 0 -or $Attempt -ge 2
}

function Invoke-RestartCommand {
  $safe = Invoke-OpenClaw -Arguments @('gateway', 'restart', '--safe', '--json') `
    -TimeoutSeconds $LifecycleCommandTimeoutSeconds
  if ($safe.code -eq 0) { return $safe }
  return Invoke-OpenClaw -Arguments @('gateway', 'restart', '--force', '--json') `
    -TimeoutSeconds $LifecycleCommandTimeoutSeconds
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

function Invoke-Reconcile {
  param($Intent, [int]$ResumeAttempt = 0)
  $port = Get-GatewayPort
  $initialStatus = New-Status -State 'unknown' -Port $port
  $capabilityIssue = Test-CliCapabilities
  if ($null -ne $capabilityIssue) {
    Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $ResumeAttempt `
      -Status $initialStatus -Issue $capabilityIssue
    return
  }

  if ([string]$Intent.action -eq 'stop') {
    for ($attempt = [Math]::Max(1, $ResumeAttempt + 1); $attempt -le $MaxAttempts; $attempt++) {
      if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return }
      Write-Runtime -Intent $Intent -Phase 'stopping' -Attempt $attempt -Status $initialStatus
      Invoke-OpenClaw -Arguments @('gateway', 'stop', '--force', '--json') `
        -TimeoutSeconds $LifecycleCommandTimeoutSeconds | Out-Null
      if (Test-StablyStopped -Intent $Intent -Port $port) {
        Write-Runtime -Intent $Intent -Phase 'idle' -Attempt $attempt `
          -Status (New-Status -State 'stopped' -Port $port) -Terminal
        Complete-LegacyWatchdogMigration
        return
      }
    }
    $issue = New-Issue -Code 'repair-exhausted' `
      -Detail 'OpenClaw could not be stopped after three verified attempts.' `
      -Remediation 'Close the identified OpenClaw process and press Stop again.'
    Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $MaxAttempts `
      -Status (New-Status -State 'unknown' -Port $port) -Issue $issue
    return
  }

  for ($attempt = [Math]::Max(1, $ResumeAttempt + 1); $attempt -le $MaxAttempts; $attempt++) {
    if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return }
    $phase = if ([string]$Intent.action -eq 'restart' -and $attempt -eq 1) { 'restarting' } else { 'starting' }
    Write-Runtime -Intent $Intent -Phase $phase -Attempt $attempt -Status $initialStatus
    if ([string]$Intent.action -eq 'restart' -and $attempt -eq 1) {
      Invoke-RestartCommand | Out-Null
    } else {
      Invoke-OpenClaw -Arguments @('gateway', 'start', '--json') `
        -TimeoutSeconds $LifecycleCommandTimeoutSeconds | Out-Null
    }
    if (-not (Test-CurrentGeneration -Generation ([int64]$Intent.generation))) { return }

    Write-Runtime -Intent $Intent -Phase 'verifying' -Attempt $attempt -Status $initialStatus
    $ready = Wait-GatewayReady -Intent $Intent -Port $port -TimeoutSeconds $ReadyTimeoutSeconds
    if ($ready.superseded) { return }
    if ($ready.ready) {
      Write-Runtime -Intent $Intent -Phase 'idle' -Attempt $attempt -Status $ready.status -Terminal
      Complete-LegacyWatchdogMigration
      return
    }

    Write-Runtime -Intent $Intent -Phase 'diagnosing' -Attempt $attempt -Status $ready.status
    $critical = Diagnose-CriticalIssue -Intent $Intent -Attempt $attempt -Port $port
    if ($null -ne $critical) {
      Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $attempt -Status $ready.status -Issue $critical
      return
    }
    if ($attempt -eq $MaxAttempts) { break }

    Write-Runtime -Intent $Intent -Phase 'backing-up' -Attempt $attempt -Status $ready.status
    if (-not (New-RecoveryBackup -Intent $Intent)) {
      $backupIssue = New-Issue -Code 'backup-failed' `
        -Detail 'EZTerminal could not create and verify a safe OpenClaw recovery backup.' `
        -Remediation 'Free disk space or repair folder permissions, then press Start again.'
      Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $attempt `
        -Status $ready.status -Issue $backupIssue
      return
    }

    Write-Runtime -Intent $Intent -Phase 'repairing' -Attempt $attempt -Status $ready.status
    Invoke-SafeRepair -Intent $Intent -Attempt $attempt -Port $port | Out-Null
  }

  $issue = New-Issue -Code 'repair-exhausted' `
    -Detail 'OpenClaw did not become RPC-ready after three safe recovery attempts.' `
    -Remediation 'Review the diagnostic ID and recovery backup, then press Start for a new request.'
  Write-Runtime -Intent $Intent -Phase 'blocked' -Attempt $MaxAttempts `
    -Status (New-Status -State 'stopped' -Port $port) -Issue $issue
}

function Test-OwnedTask {
  param($Task)
  if ($null -eq $Task -or [string]$Task.Description -ne $TaskDescription) { return $false }
  $actions = @($Task.Actions)
  $ownedScriptPath = [IO.Path]::GetFullPath((Join-Path $StateDirectory 'openclaw-supervisor.ps1'))
  return $actions.Count -eq 1 -and
    [string]$actions[0].Execute -match '(?i)powershell.exe$' -and
    [string]$actions[0].Arguments -like "*$ownedScriptPath*"
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
    if ((Get-FileHash -LiteralPath $expectedScript -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $legacyScriptBackup -Algorithm SHA256).Hash) {
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
    $action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
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

function Run-SupervisorLoop {
  [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
  $lastQuickCheck = [DateTime]::MinValue
  $lastDeepCheck = [DateTime]::MinValue
  while ($true) {
    try {
      $intent = Get-Intent
      if ($null -eq $intent) {
        if ($RunOnce) { return }
        Start-Sleep -Seconds 1
        continue
      }
      $runtime = Read-JsonFile -Path $RuntimePath
      $runtimeGeneration = if ($null -ne $runtime -and $null -ne $runtime.generation) {
        [int64]$runtime.generation
      } else { 0 }
      $blocked = $null -ne $runtime -and $null -ne $runtime.issue -and
        $null -ne $runtime.operation -and [string]$runtime.operation.phase -eq 'blocked' -and
        [int64]$runtime.operation.generation -eq [int64]$intent.generation
      $needsReconcile = $null -eq $runtime -or
        $runtimeGeneration -ne [int64]$intent.generation -or
        [string]$runtime.desiredState -ne [string]$intent.desiredState -or
        ($null -ne $runtime.operation -and -not $blocked)
      if ($needsReconcile) {
        $resumeAttempt = if ($null -ne $runtime -and $null -ne $runtime.operation -and
          [int64]$runtime.operation.generation -eq [int64]$intent.generation) {
          [int]$runtime.operation.attempt
        } else { 0 }
        Invoke-Reconcile -Intent $intent -ResumeAttempt $resumeAttempt
        $lastQuickCheck = [DateTime]::UtcNow
        $lastDeepCheck = [DateTime]::UtcNow
        if ($RunOnce) { return }
        continue
      }
      if ($blocked) {
        if ($RunOnce) { return }
        Start-Sleep -Seconds 1
        continue
      }

      $now = [DateTime]::UtcNow
      $port = Get-GatewayPort
      if (($now - $lastQuickCheck).TotalSeconds -ge $QuickHealthSeconds) {
        $lastQuickCheck = $now
        $startupReady = Test-StartupReady -Port $port
        if (([string]$intent.desiredState -eq 'running' -and -not $startupReady) -or
            ([string]$intent.desiredState -eq 'stopped' -and $startupReady)) {
          Invoke-Reconcile -Intent $intent
          if ($RunOnce) { return }
          continue
        }
      }
      if ([string]$intent.desiredState -eq 'running' -and
          ($now - $lastDeepCheck).TotalSeconds -ge $DeepHealthSeconds) {
        $lastDeepCheck = $now
        $deep = Get-AuthenticatedStatus -Port $port
        if (-not $deep.ready) {
          Invoke-Reconcile -Intent $intent
          if ($RunOnce) { return }
          continue
        }
        Write-Runtime -Intent $intent -Phase 'idle' -Attempt 0 -Status $deep.status -Terminal
      }
    } catch {
      # Task Scheduler restarts the process if this loop itself crashes; a
      # transient iteration error must not reset persisted operation attempts.
    }
    if ($RunOnce) { return }
    Start-Sleep -Seconds 1
  }
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

if ($RunSupervisor) {
  Run-SupervisorLoop
  exit 0
}

Write-CommandResult -Ok $false `
  -Issue (New-Issue -Code 'supervisor-failed' -Detail 'No supervisor mode was selected.' -Remediation 'Start OpenClaw from EZTerminal.') `
  -ExitCode 2
