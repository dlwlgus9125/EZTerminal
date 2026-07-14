[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApkPath,

    [Parameter(Mandatory = $true)]
    [string]$MetadataPath,

    [string]$ExpectedApplicationId = 'com.ezterminal.remote',
    [string]$ExpectedVersionName = '0.10.0',
    [int]$ExpectedVersionCode = 20,
    [string]$ExpectedCertSha256 = '',
    [string]$OutputPath = '',
    [switch]$RequireSignature
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ($Actual -ne $Expected) {
        throw "$Label mismatch: expected '$Expected', got '$Actual'."
    }
}

function Get-BuildTool {
    param([Parameter(Mandatory = $true)][string]$Name)

    $androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    if ([string]::IsNullOrWhiteSpace($androidHome)) {
        $localProperties = Join-Path (Split-Path -Parent $PSScriptRoot) 'local.properties'
        if (Test-Path -LiteralPath $localProperties) {
            $sdkLine = Get-Content -LiteralPath $localProperties |
                Where-Object { $_ -match '^sdk\.dir=' } |
                Select-Object -First 1
            if ($sdkLine) {
                $androidHome = $sdkLine.Substring('sdk.dir='.Length).Replace('\:', ':').Replace('\\', '\')
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($androidHome)) {
        throw 'ANDROID_HOME or ANDROID_SDK_ROOT is required to verify an APK.'
    }

    $buildToolsRoot = Join-Path $androidHome 'build-tools'
    $candidate = Get-ChildItem -LiteralPath $buildToolsRoot -Directory |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName $Name } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1

    if (-not $candidate) {
        throw "Could not find $Name below $buildToolsRoot."
    }
    return $candidate
}

$resolvedApk = (Resolve-Path -LiteralPath $ApkPath).Path
$resolvedMetadata = (Resolve-Path -LiteralPath $MetadataPath).Path
$metadata = Get-Content -LiteralPath $resolvedMetadata -Raw | ConvertFrom-Json

Assert-Equal $metadata.applicationId $ExpectedApplicationId 'metadata applicationId'
if ($metadata.elements.Count -ne 1) {
    throw "Expected exactly one APK metadata element, got $($metadata.elements.Count)."
}
$element = $metadata.elements[0]
Assert-Equal ([int]$element.versionCode) $ExpectedVersionCode 'metadata versionCode'
Assert-Equal ([string]$element.versionName) $ExpectedVersionName 'metadata versionName'
Assert-Equal ([string]$element.outputFile) ([IO.Path]::GetFileName($resolvedApk)) 'metadata outputFile'

$aapt2 = Get-BuildTool 'aapt2.exe'
$badging = (& $aapt2 dump badging $resolvedApk 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
    throw "aapt2 could not inspect the APK: $badging"
}
$packageMatch = [regex]::Match(
    $badging,
    "package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']*)'"
)
if (-not $packageMatch.Success) {
    throw 'aapt2 output did not contain the expected package identity.'
}
Assert-Equal $packageMatch.Groups[1].Value $ExpectedApplicationId 'APK applicationId'
Assert-Equal ([int]$packageMatch.Groups[2].Value) $ExpectedVersionCode 'APK versionCode'
Assert-Equal $packageMatch.Groups[3].Value $ExpectedVersionName 'APK versionName'

if ($RequireSignature -or -not [string]::IsNullOrWhiteSpace($ExpectedCertSha256)) {
    $apksigner = Get-BuildTool 'apksigner.bat'
    $signatureOutput = @(& $apksigner verify --verbose --print-certs $resolvedApk 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "apksigner verification failed: $($signatureOutput -join [Environment]::NewLine)"
    }

    $digestPattern = '^(?:Signer #\d+|V\d+ Signer): certificate SHA-256 digest:\s*([0-9a-fA-F:]+)\s*$'
    $digestLine = $signatureOutput | Where-Object {
        $_ -match $digestPattern
    } | Select-Object -First 1
    if (-not $digestLine) {
        throw 'apksigner did not report a SHA-256 certificate digest.'
    }
    $actualDigest = ([regex]::Match(
        $digestLine,
        $digestPattern
    ).Groups[1].Value -replace '[^0-9a-fA-F]', '').ToUpperInvariant()

    if (-not [string]::IsNullOrWhiteSpace($ExpectedCertSha256)) {
        $expectedDigest = ($ExpectedCertSha256 -replace '[^0-9a-fA-F]', '').ToUpperInvariant()
        if ($expectedDigest.Length -ne 64) {
            throw 'Expected certificate SHA-256 must contain exactly 64 hexadecimal digits.'
        }
        Assert-Equal $actualDigest $expectedDigest 'signing certificate SHA-256'
    }
    Write-Host "Verified signing certificate SHA-256: $actualDigest"
}

if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $outputDirectory = Split-Path -Parent $OutputPath
    if ($outputDirectory) {
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    }
    Copy-Item -LiteralPath $resolvedApk -Destination $OutputPath -Force
    $resolvedOutput = (Resolve-Path -LiteralPath $OutputPath).Path
    $hash = (Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($resolvedOutput))" |
        Set-Content -LiteralPath "$resolvedOutput.sha256" -Encoding ascii
    Write-Host "Staged APK: $resolvedOutput"
    Write-Host "SHA-256: $hash"
}

Write-Host "Verified $ExpectedApplicationId $ExpectedVersionName (versionCode $ExpectedVersionCode)."
