$ephemeralSigningJobType = 'EZTerminal.Release.EphemeralSigningJob' -as [type]
if ($null -eq $ephemeralSigningJobType) {
    Add-Type -Path (Join-Path $PSScriptRoot 'ephemeral-signing-job.cs')
}

function Invoke-EphemeralSigningProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [Diagnostics.ProcessStartInfo]$StartInfo,

        [Parameter(Mandatory = $true)]
        [Collections.IDictionary]$EphemeralEnvironment,

        [ValidateRange(1, 7200000)]
        [int]$TimeoutMilliseconds = 3600000,

        [string]$DiagnosticLogPath = '',

        [ValidateRange(1024, 4194304)]
        [int]$MaxDiagnosticBytes = 262144,

        [Threading.CancellationToken]$CancellationToken = (
            [Threading.CancellationToken]::None
        )
    )

    if ($StartInfo.UseShellExecute) {
        throw 'Ephemeral signing processes must disable shell execution.'
    }
    if ($EphemeralEnvironment.Count -lt 1) {
        throw 'At least one ephemeral signing environment value is required.'
    }

    $environmentNames = @(
        $EphemeralEnvironment.Keys |
            ForEach-Object {
                $name = [string]$_
                if ([string]::IsNullOrWhiteSpace($name)) {
                    throw 'Ephemeral signing environment names must not be empty.'
                }
                $name
            }
    )
    $process = $null
    $job = $null
    $started = $false
    $processExitCode = $null
    $diagnosticFullPath = $null
    $diagnosticEnvironmentNames = @(
        'EZTERMINAL_SIGNING_DIAGNOSTIC_LOG',
        'EZTERMINAL_SIGNING_MAX_DIAGNOSTIC_BYTES'
    )
    $sensitiveValues = @(
        $EphemeralEnvironment.Values |
            ForEach-Object { [string]$_ } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object Length -Descending -Unique
    )
    try {
        $job = [EZTerminal.Release.EphemeralSigningJob]::new()
        if (-not [string]::IsNullOrWhiteSpace($DiagnosticLogPath)) {
            if (-not [IO.Path]::IsPathRooted($DiagnosticLogPath)) {
                throw 'DiagnosticLogPath must be an absolute path.'
            }
            $diagnosticFullPath = [IO.Path]::GetFullPath($DiagnosticLogPath)
            $diagnosticParent = Split-Path -Parent $diagnosticFullPath
            $resolvedDiagnosticParent = Get-Item -LiteralPath (
                Resolve-Path -LiteralPath $diagnosticParent
            ) -Force
            if (
                -not $resolvedDiagnosticParent.PSIsContainer -or
                ($resolvedDiagnosticParent.Attributes -band
                    [IO.FileAttributes]::ReparsePoint)
            ) {
                throw "Diagnostic log parent is unsafe: $diagnosticParent"
            }
            if (Test-Path -LiteralPath $diagnosticFullPath) {
                throw "Diagnostic log already exists: $diagnosticFullPath"
            }
            $StartInfo.EnvironmentVariables[
                'EZTERMINAL_SIGNING_DIAGNOSTIC_LOG'
            ] = $diagnosticFullPath
            $StartInfo.EnvironmentVariables[
                'EZTERMINAL_SIGNING_MAX_DIAGNOSTIC_BYTES'
            ] = [string]$MaxDiagnosticBytes
        }
        foreach ($name in $environmentNames) {
            $value = [string]$EphemeralEnvironment[$name]
            if ([string]::IsNullOrWhiteSpace($value)) {
                throw "Ephemeral signing environment value '$name' is empty."
            }
            $StartInfo.EnvironmentVariables[$name] = $value
        }

        $process = $job.StartSuspendedAndAssign($StartInfo)
        $started = $true
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
        while (-not $process.WaitForExit(100)) {
            if ($CancellationToken.IsCancellationRequested) {
                throw [OperationCanceledException]::new(
                    'The ephemeral signing process was cancelled.',
                    $CancellationToken
                )
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw [TimeoutException]::new(
                    "The ephemeral signing process exceeded $TimeoutMilliseconds ms."
                )
            }
        }
        $processExitCode = [int]$process.ExitCode
        if ($processExitCode -ne 0) {
            throw (
                "Ephemeral signing process failed with exit code " +
                "$processExitCode."
            )
        }
    } finally {
        $cleanupError = $null
        try {
            if ($null -ne $job) {
                $job.TerminateAndWait(30000)
            }
        } catch {
            $cleanupError = $_
        } finally {
            if ($null -ne $job) {
                $job.Dispose()
            }
            if (
                $started -and
                -not $process.HasExited -and
                -not $process.WaitForExit(30000) -and
                $null -eq $cleanupError
            ) {
                $cleanupError = [Management.Automation.ErrorRecord]::new(
                    [TimeoutException]::new(
                        "Ephemeral signing process $($process.Id) did not exit."
                    ),
                    'EphemeralSigningProcessDidNotExit',
                    [Management.Automation.ErrorCategory]::OperationTimeout,
                    $process
                )
            }
            if ($null -ne $diagnosticFullPath) {
                try {
                    if (-not (Test-Path -LiteralPath $diagnosticFullPath)) {
                        if ($processExitCode -eq 0) {
                            throw (
                                'The successful signing process did not create ' +
                                'its bounded diagnostic log.'
                            )
                        }
                    } else {
                        $diagnosticItem = Get-Item -LiteralPath (
                            $diagnosticFullPath
                        ) -Force
                        if (
                            $diagnosticItem.PSIsContainer -or
                            ($diagnosticItem.Attributes -band
                                [IO.FileAttributes]::ReparsePoint) -or
                            $diagnosticItem.Length -gt $MaxDiagnosticBytes
                        ) {
                            throw (
                                'The Android signing diagnostic log is unsafe ' +
                                'or exceeds its byte limit.'
                            )
                        }
                        $diagnosticBytes = [IO.File]::ReadAllBytes(
                            $diagnosticItem.FullName
                        )
                        $diagnosticText = (
                            [Text.UTF8Encoding]::new($false, $true)
                        ).GetString($diagnosticBytes)
                        foreach ($sensitiveValue in $sensitiveValues) {
                            $diagnosticText = $diagnosticText.Replace(
                                $sensitiveValue,
                                '[REDACTED]'
                            )
                        }
                        $diagnosticText = $diagnosticText -replace (
                            '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
                        ), '?'
                        foreach ($diagnosticLine in (
                            $diagnosticText -split '\r?\n'
                        )) {
                            if ($diagnosticLine.Length -gt 0) {
                                Write-Output (
                                    "[android-signing] $diagnosticLine"
                                )
                            }
                        }
                        $diagnosticBytes = $null
                        $diagnosticText = $null
                    }
                } catch {
                    if ($null -eq $cleanupError) {
                        $cleanupError = $_
                    }
                } finally {
                    try {
                        if (Test-Path -LiteralPath $diagnosticFullPath) {
                            $cleanupItem = Get-Item -LiteralPath (
                                $diagnosticFullPath
                            ) -Force
                            if ($cleanupItem.PSIsContainer) {
                                throw (
                                    'Refusing to recursively remove an unsafe ' +
                                    'signing diagnostic path.'
                                )
                            }
                            Remove-Item -LiteralPath $diagnosticFullPath -Force
                        }
                    } catch {
                        if ($null -eq $cleanupError) {
                            $cleanupError = $_
                        }
                    }
                }
            }
            foreach ($name in $environmentNames) {
                $StartInfo.EnvironmentVariables.Remove($name)
                if ($EphemeralEnvironment.Contains($name)) {
                    $EphemeralEnvironment[$name] = $null
                }
            }
            foreach ($name in $diagnosticEnvironmentNames) {
                $StartInfo.EnvironmentVariables.Remove($name)
            }
            $EphemeralEnvironment.Clear()
            $sensitiveValues = $null
            if ($null -ne $process) {
                $process.Dispose()
            }
        }
        if ($null -ne $cleanupError) {
            throw $cleanupError
        }
    }
}
