[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GradleWrapper
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$diagnosticPath = $env:EZTERMINAL_SIGNING_DIAGNOSTIC_LOG
$maxDiagnosticText = $env:EZTERMINAL_SIGNING_MAX_DIAGNOSTIC_BYTES
$maxDiagnosticBytes = 0
if (
    [string]::IsNullOrWhiteSpace($diagnosticPath) -or
    -not [IO.Path]::IsPathRooted($diagnosticPath) -or
    -not [int]::TryParse($maxDiagnosticText, [ref]$maxDiagnosticBytes) -or
    $maxDiagnosticBytes -lt 1024 -or
    $maxDiagnosticBytes -gt 4194304
) {
    throw 'The bounded Android signing diagnostic channel is invalid.'
}

$resolvedGradleWrapper = (Resolve-Path -LiteralPath $GradleWrapper).Path
$gradleItem = Get-Item -LiteralPath $resolvedGradleWrapper -Force
if (
    $gradleItem.PSIsContainer -or
    ($gradleItem.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
    throw "Android Gradle wrapper must be a normal file: $resolvedGradleWrapper"
}

$diagnosticFullPath = [IO.Path]::GetFullPath($diagnosticPath)
$diagnosticParent = Split-Path -Parent $diagnosticFullPath
$resolvedDiagnosticParent = Get-Item -LiteralPath (
    Resolve-Path -LiteralPath $diagnosticParent
) -Force
if (
    -not $resolvedDiagnosticParent.PSIsContainer -or
    ($resolvedDiagnosticParent.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
    throw "Android signing diagnostic parent is unsafe: $diagnosticParent"
}
if (Test-Path -LiteralPath $diagnosticFullPath) {
    throw "Android signing diagnostic already exists: $diagnosticFullPath"
}

$sensitiveValues = @(
    $env:ANDROID_KEYSTORE_PATH,
    $env:ANDROID_KEYSTORE_PASSWORD,
    $env:ANDROID_KEY_ALIAS,
    $env:ANDROID_KEY_PASSWORD
) |
    Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
    ForEach-Object { [string]$_ } |
    Sort-Object Length -Descending -Unique
$encoding = [Text.UTF8Encoding]::new($false)
$diagnosticStream = [IO.File]::Open(
    $diagnosticFullPath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
)
$diagnosticBytesWritten = 0
$diagnosticTruncated = $false

function Write-SigningDiagnosticRecord {
    param([object]$Record)

    if ($diagnosticTruncated) {
        return
    }
    $line = [string]$Record
    foreach ($sensitiveValue in $sensitiveValues) {
        $line = $line.Replace($sensitiveValue, '[REDACTED]')
    }
    $line = $line -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '?'
    $recordBytes = $encoding.GetBytes(
        $line + [Environment]::NewLine
    )
    $remaining = $maxDiagnosticBytes - $diagnosticBytesWritten
    if ($recordBytes.Length -le $remaining) {
        $diagnosticStream.Write($recordBytes, 0, $recordBytes.Length)
        $script:diagnosticBytesWritten += $recordBytes.Length
        return
    }

    $truncationBytes = $encoding.GetBytes(
        "[diagnostic output truncated at $maxDiagnosticBytes bytes]" +
        [Environment]::NewLine
    )
    if ($truncationBytes.Length -le $remaining) {
        $diagnosticStream.Write(
            $truncationBytes,
            0,
            $truncationBytes.Length
        )
        $script:diagnosticBytesWritten += $truncationBytes.Length
    }
    $script:diagnosticTruncated = $true
}

$gradleExitCode = 1
try {
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell promotes native stderr to NativeCommandError when
        # ErrorActionPreference is Stop. Keep stderr as diagnostic data so the
        # native Gradle exit code remains authoritative.
        $ErrorActionPreference = 'Continue'
        & $resolvedGradleWrapper assembleRelease --no-daemon --stacktrace 2>&1 |
            ForEach-Object {
                Write-SigningDiagnosticRecord $_
            }
        $gradleExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($null -eq $gradleExitCode) {
        $gradleExitCode = 1
        Write-SigningDiagnosticRecord (
            'Android Gradle wrapper did not report a native exit code.'
        )
    }
} catch {
    Write-SigningDiagnosticRecord $_
    $gradleExitCode = 1
} finally {
    try {
        $diagnosticStream.Flush()
    } finally {
        try {
            $diagnosticStream.Dispose()
        } finally {
            $sensitiveValues = $null
        }
    }
}

exit ([int]$gradleExitCode)
