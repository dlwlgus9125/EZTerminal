[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,

    [Parameter(Mandatory = $true)]
    [int]$AndroidVersionCode,

    [Parameter(Mandatory = $true)]
    [string]$AndroidApkPath,

    [Parameter(Mandatory = $true)]
    [string]$AndroidMetadataPath,

    [Parameter(Mandatory = $true)]
    [string]$AndroidCertSha256,

    [Parameter(Mandatory = $true)]
    [string]$LocalRcReportSha256,

    [Parameter(Mandatory = $true)]
    [string]$LocalRcReportPath,

    [string]$ExpectedCommit = $env:GITHUB_SHA,
    [string]$ReleaseAssetsPath = 'release-assets',
    [ValidateSet('NotSigned', 'Valid')]
    [string]$ExpectedWindowsSignature = 'NotSigned',
    [int]$ProtocolVersion = 2,
    [switch]$RequireCleanTree
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    function Assert-Equal {
        param($Actual, $Expected, [string]$Label)
        if ($Actual -ne $Expected) {
            throw "$Label mismatch: expected '$Expected', got '$Actual'."
        }
    }

    function Assert-ProductVersion {
        param([string]$Path, [string]$Expected)
        $actual = (Get-Item -LiteralPath $Path).VersionInfo.ProductVersion
        Assert-Equal $actual $Expected "ProductVersion for $Path"
    }

    function Assert-Authenticode {
        param([string]$Path, [string]$Expected)
        $actual = (Get-AuthenticodeSignature -LiteralPath $Path).Status.ToString()
        Assert-Equal $actual $Expected "Authenticode status for $Path"
        return $actual
    }

    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Version must be a three-part semantic version, got '$Version'."
    }
    $normalizedRcReportHash = ($LocalRcReportSha256 -replace '[^0-9A-Fa-f]', '').ToLowerInvariant()
    if ($normalizedRcReportHash -notmatch '^[0-9a-f]{64}$') {
        throw 'LocalRcReportSha256 must contain exactly 64 hexadecimal digits.'
    }
    $resolvedRcReport = (Resolve-Path -LiteralPath $LocalRcReportPath).Path
    $localRcReportBytes = [IO.File]::ReadAllBytes($resolvedRcReport)
    $actualRcReportHash = (Get-FileHash -LiteralPath $resolvedRcReport -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Equal $actualRcReportHash $normalizedRcReportHash 'local RC report SHA-256'
    try {
        $localRcReport = [Text.Encoding]::UTF8.GetString($localRcReportBytes) | ConvertFrom-Json
    } catch {
        throw 'LocalRcReportPath does not contain valid UTF-8 JSON.'
    }

    & node scripts/verify-version-contract.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'Version contract verification failed.'
    }
    $versionContract = Get-Content release/version.json -Raw | ConvertFrom-Json
    Assert-Equal ([string]$versionContract.version) $Version 'release contract version'
    Assert-Equal ([int]$versionContract.androidVersionCode) $AndroidVersionCode 'Android versionCode'
    Assert-Equal ([int]$versionContract.protocolVersion) $ProtocolVersion 'protocol version'
    Assert-Equal ([int]$localRcReport.schemaVersion) 1 'local RC report schema'
    Assert-Equal ([string]$localRcReport.appVersion) $Version 'local RC report appVersion'
    Assert-Equal (
        [string]$localRcReport.validationPolicy
    ) 'current-windows-host-and-api-29-35-emulators' 'local RC validation policy'
    $requiredFunctionalLimits = @(
        'Lock and UAC secure-desktop capture and input are not supported in 1.0.3.',
        'Software SAS and Ctrl+Alt+Delete are not supported in 1.0.3.',
        'GDI capture, OpenH264 encoding and SendInput injection remain in the normal-user transport.'
    )
    foreach ($limit in $requiredFunctionalLimits) {
        if (@($localRcReport.knownFunctionalLimits) -notcontains $limit) {
            throw "Local RC report omits the required functional limit: $limit"
        }
    }
    $desktopPerformance = $localRcReport.desktopPerformance
    Assert-Equal ([string]$desktopPerformance.status) 'passed' 'desktop performance status'
    Assert-Equal ([double]$desktopPerformance.maxP95RegressionPercent) 5 'desktop p95 regression budget'
    Assert-Equal ([double]$desktopPerformance.minTargetP95ImprovementPercent) 15 'target p95 improvement budget'
    if (@($desktopPerformance.targetMetrics) -notcontains 'plainOutput12MiBRetentionPressureMs') {
        throw 'The local RC report does not include the approved retention-pressure bottleneck target.'
    }
    if (
        [string]$desktopPerformance.baselineReportSha256 -notmatch '^[0-9a-f]{64}$' -or
        [string]$desktopPerformance.candidateReportSha256 -notmatch '^[0-9a-f]{64}$'
    ) {
        throw 'The local RC performance evidence is not bound to baseline/candidate report hashes.'
    }
    $candidatePerformance = $desktopPerformance.candidate
    Assert-Equal ([int]$candidatePerformance.schemaVersion) 1 'desktop performance schema'
    Assert-Equal (
        [string]$candidatePerformance.buildSha
    ) ([string]$localRcReport.buildSha) 'desktop performance buildSha'
    Assert-Equal ([int]$candidatePerformance.warmupRuns) 5 'desktop performance warmup count'
    Assert-Equal ([int]$candidatePerformance.measurementRuns) 25 'desktop performance measurement count'
    Assert-Equal ([string]$candidatePerformance.environment.platform) 'win32' 'desktop performance platform'
    Assert-Equal ([string]$candidatePerformance.environment.arch) 'x64' 'desktop performance architecture'
    if (
        [string]::IsNullOrWhiteSpace([string]$candidatePerformance.environment.osRelease) -or
        [string]::IsNullOrWhiteSpace([string]$candidatePerformance.environment.cpuModel) -or
        [int]$candidatePerformance.environment.logicalCpuCount -lt 1 -or
        [int]$candidatePerformance.environment.totalMemoryGiB -lt 1
    ) {
        throw 'Desktop performance evidence is missing its benchmark environment.'
    }
    foreach ($metricName in @(
        'cancellationLatencyMs',
        'rows100kCompletionMs',
        'plainOutput1_1MiBCompletionMs',
        'plainOutput12MiBRetentionPressureMs'
    )) {
        $metric = $candidatePerformance.metrics.$metricName
        if ($null -eq $metric -or @($metric.samples).Count -ne 25) {
            throw "Desktop performance metric '$metricName' does not contain 25 measurements."
        }
    }
    $performanceResultNames = @($desktopPerformance.results | ForEach-Object { [string]$_.name })
    foreach ($metricName in @(
        'cancellationLatencyMs',
        'rows100kCompletionMs',
        'plainOutput1_1MiBCompletionMs',
        'plainOutput12MiBRetentionPressureMs'
    )) {
        if ($performanceResultNames -notcontains $metricName) {
            throw "Desktop performance comparison is missing '$metricName'."
        }
    }
    $targetPerformanceResult = @($desktopPerformance.results | Where-Object {
        [string]$_.name -eq 'plainOutput12MiBRetentionPressureMs' -and $_.targeted -eq $true
    })
    if ($targetPerformanceResult.Count -ne 1) {
        throw 'Desktop retention-pressure comparison is not marked as the optimization target.'
    }
    $cancellationSamples = @(
        $candidatePerformance.metrics.cancellationLatencyMs.samples |
            ForEach-Object { [double]$_ } |
            Sort-Object
    )
    $cancellationP95 = if ($cancellationSamples.Count -eq 25) {
        $cancellationSamples[[Math]::Ceiling($cancellationSamples.Count * 0.95) - 1]
    } else {
        [double]::PositiveInfinity
    }
    $cancellationMax = if ($cancellationSamples.Count -gt 0) {
        ($cancellationSamples | Measure-Object -Maximum).Maximum
    } else {
        [double]::PositiveInfinity
    }
    if (
        [double]$cancellationP95 -gt 3000 -or
        [double]$cancellationMax -ge 5000
    ) {
        throw 'Desktop cancellation latency exceeds its absolute release budget.'
    }
    $failedPerformanceResults = @($desktopPerformance.results | Where-Object {
        [double]$_.deltaPercent -gt 5 -or
        ($_.targeted -eq $true -and [double]$_.deltaPercent -gt -15)
    })
    if ($failedPerformanceResults.Count -ne 0) {
        throw 'Desktop performance evidence exceeds a relative regression or target-improvement budget.'
    }

    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not resolve the release source commit.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit)) {
        if ($ExpectedCommit -notmatch '^[0-9A-Fa-f]{40}$') {
            throw "ExpectedCommit must be the complete 40-digit source SHA, got '$ExpectedCommit'."
        }
        Assert-Equal $commit $ExpectedCommit.ToLowerInvariant() 'release source commit'
    }
    Assert-Equal ([string]$localRcReport.buildSha) $commit 'local RC report buildSha'
    Assert-Equal ([int]$localRcReport.playwrightRetries) 0 'local RC Playwright retry count'
    Assert-Equal (
        [int]$localRcReport.mobileConnectionAttemptsPerScenario
    ) 1 'local RC mobile connection-attempt count'
    $passedApi29 = @($localRcReport.devices | Where-Object {
        $_.status -eq 'passed' -and $_.avd -and [int]$_.api -eq 29
    })
    $passedApi35 = @($localRcReport.devices | Where-Object {
        $_.status -eq 'passed' -and $_.avd -and [int]$_.api -eq 35
    })
    if ($passedApi29.Count -lt 1 -or $passedApi35.Count -lt 1) {
        throw 'Local RC report lacks passing API 29 and API 35 emulator evidence.'
    }
    Assert-Equal ([string]$localRcReport.mobileSoak.status) 'passed' 'mobile soak status'
    Assert-Equal ([string]$localRcReport.mobileSoak.buildSha) $commit 'mobile soak buildSha'
    Assert-Equal ([string]$localRcReport.mobileSoak.appVersion) $Version 'mobile soak appVersion'
    if (
        [int64]$localRcReport.mobileSoak.durationMs -lt 1800000 -or
        [int]$localRcReport.mobileSoak.sessionCount -ne 8 -or
        [int]$localRcReport.mobileSoak.recoveryCycles -ne 20 -or
        $localRcReport.mobileSoak.memoryPassed -ne $true -or
        $localRcReport.mobileSoak.markerAuditPassed -ne $true -or
        $localRcReport.mobileSoak.cleanupPassed -ne $true
    ) {
        throw 'Local RC report lacks the required 30-minute mobile soak evidence.'
    }
    if ($RequireCleanTree) {
        $status = @(git status --porcelain --untracked-files=all)
        if ($status.Count -ne 0) {
            $status | ForEach-Object { Write-Host $_ }
            throw 'Release source contains tracked changes after the build.'
        }
    }

    $appExe = (Resolve-Path -LiteralPath 'out/EZTerminal-win32-x64/EZTerminal.exe').Path
    $appAsar = (Resolve-Path -LiteralPath 'out/EZTerminal-win32-x64/resources/app.asar').Path
    $nsisRoot = (Resolve-Path -LiteralPath 'out/make/nsis/x64').Path
    $setupExe = (Resolve-Path -LiteralPath (Join-Path $nsisRoot 'EZTerminal-Setup.exe')).Path

    foreach ($bundlePath in @('.vite/build/main.js', '.vite/build/preload.js')) {
        $bundle = (Resolve-Path -LiteralPath $bundlePath).Path
        $bundleContent = Get-Content -LiteralPath $bundle -Raw
        if ($bundleContent.IndexOf($commit, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "$bundlePath does not contain the exact source SHA $commit."
        }
        if ($bundleContent -match 'buildSha\s*:\s*["'']dev["'']') {
            throw "$bundlePath still contains buildSha=dev."
        }
    }
    $asarContent = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($appAsar))
    if ($asarContent.IndexOf($commit, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Packaged app.asar does not contain the exact source SHA $commit."
    }

    Assert-ProductVersion $appExe $Version
    Assert-ProductVersion $setupExe $Version
    $appSignature = Assert-Authenticode $appExe $ExpectedWindowsSignature
    $setupSignature = Assert-Authenticode $setupExe $ExpectedWindowsSignature

    $assets = [IO.Path]::GetFullPath((Join-Path $repoRoot $ReleaseAssetsPath))
    $repoPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $assets.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "ReleaseAssetsPath must remain inside the repository: $assets"
    }
    if (Test-Path -LiteralPath $assets) {
        Remove-Item -LiteralPath $assets -Recurse -Force
    }
    New-Item -ItemType Directory -Path $assets | Out-Null

    [IO.File]::WriteAllBytes((Join-Path $assets 'local-rc-report.json'), $localRcReportBytes)

    Copy-Item -LiteralPath $setupExe -Destination (Join-Path $assets 'EZTerminal-Setup.exe')

    $androidName = "EZTerminal-Android-$Version-vc$AndroidVersionCode.apk"
    $verifyApk = Join-Path $repoRoot 'mobile/android/scripts/verify-apk.ps1'
    & $verifyApk `
        -ApkPath $AndroidApkPath `
        -MetadataPath $AndroidMetadataPath `
        -ExpectedVersionName $Version `
        -ExpectedVersionCode $AndroidVersionCode `
        -ExpectedMinSdk 29 `
        -ExpectedTargetSdk 35 `
        -ExpectedCertSha256 $AndroidCertSha256 `
        -ForbiddenText '[ez-e2e]' `
        -RequiredText $commit `
        -OutputPath (Join-Path $assets $androidName) `
        -RequireSignature
    if ($LASTEXITCODE -ne 0) {
        throw 'Android artifact verification failed.'
    }

    & node scripts/generate-sbom.mjs --output (Join-Path $assets 'sbom.cdx.json')
    if ($LASTEXITCODE -ne 0) {
        throw 'Dependency SBOM generation failed.'
    }

    $manifest = [ordered]@{
        appVersion = $Version
        androidVersionCode = $AndroidVersionCode
        protocolVersion = $ProtocolVersion
        buildSha = $commit
        embeddedBuildShaVerified = $true
        localRcReportSha256 = $normalizedRcReportHash
        localRcReportVerified = $true
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        windowsAuthenticode = [ordered]@{
            expected = $ExpectedWindowsSignature
            app = $appSignature
            setup = $setupSignature
        }
        androidSigningCertSha256 = ($AndroidCertSha256 -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
        artifacts = @(
            'EZTerminal-Setup.exe',
            'local-rc-report.json',
            'sbom.cdx.json',
            $androidName,
            "$androidName.sha256"
        )
    }
    $manifest | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $assets 'release-manifest.json') -Encoding utf8

    $hashLines = Get-ChildItem -LiteralPath $assets -File |
        Where-Object Name -ne 'SHA256SUMS.txt' |
        Sort-Object Name |
        ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($_.Name)"
        }
    $hashLines | Set-Content -LiteralPath (Join-Path $assets 'SHA256SUMS.txt') -Encoding ascii

    Write-Host "Staged verified release assets for $Version from $commit"
    Get-ChildItem -LiteralPath $assets -File | Sort-Object Name |
        Select-Object Name, Length | Format-Table -AutoSize
} finally {
    Pop-Location
}
