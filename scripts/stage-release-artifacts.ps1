[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$AndroidApkPath,

    [Parameter(Mandatory = $true)]
    [string]$AndroidMetadataPath,

    [Parameter(Mandatory = $true)]
    [string]$AndroidCertSha256,

    [string]$LocalRcReportSha256 = '',

    [string]$LocalRcReportPath = '',

    [string]$MobileSoakReportPath = '',

    [string]$PerformanceBaselineReportPath = '',

    [string]$PerformanceCandidateReportPath = '',

    [string]$EvidenceBundleSha256 = '',

    [string]$ExpectedCommit = $env:GITHUB_SHA,
    [string]$ReleaseAssetsPath = '',
    [ValidateSet('candidate', 'release')]
    [string]$ArtifactStage = 'candidate',
    [ValidateSet('NotSigned', 'Valid')]
    [string]$ExpectedWindowsSignature = 'NotSigned',
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

    function Assert-CleanReleaseTree {
        param([string]$Phase, [string]$ExpectedSha)
        $head = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
            throw "Could not resolve the release source HEAD ($Phase)."
        }
        if ($head -cne $ExpectedSha) {
            throw "Release source HEAD changed from $ExpectedSha to $head ($Phase)."
        }
        $status = @(git status --porcelain --untracked-files=all)
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect the release source tree ($Phase)."
        }
        if ($status.Count -ne 0) {
            $status | ForEach-Object { Write-Host $_ }
            throw "Release source contains tracked or untracked changes ($Phase)."
        }
    }

    function Get-BytesSha256 {
        param([byte[]]$Bytes)
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return (
                [BitConverter]::ToString($sha256.ComputeHash($Bytes)) -replace '-', ''
            ).ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    }

    function Resolve-NormalEvidenceFile {
        param([string]$Path, [string]$Label)
        if ([string]::IsNullOrWhiteSpace($Path)) {
            throw "$Label path is required."
        }
        $resolved = (Resolve-Path -LiteralPath $Path).Path
        $item = Get-Item -LiteralPath $resolved -Force
        if (
            $item.PSIsContainer -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        ) {
            throw "$Label must be a normal file: $resolved"
        }
        if ($item.Length -lt 1 -or $item.Length -gt 16777216) {
            throw "$Label must be between 1 and 16777216 bytes: $resolved"
        }
        return $item.FullName
    }

    & node scripts/verify-version-contract.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'Version contract verification failed.'
    }
    $versionContract = Get-Content release/version.json -Raw | ConvertFrom-Json
    $Version = [string]$versionContract.version
    $AndroidVersionCode = [int]$versionContract.androidVersionCode
    $ProtocolVersion = [int]$versionContract.protocolVersion
    $ValidationProfile = [string]$versionContract.validationProfile
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Version must be a three-part semantic version, got '$Version'."
    }
    if ($ValidationProfile -notin @('full', 'functional-hotfix')) {
        throw "Unsupported release validation profile '$ValidationProfile'."
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
    if ($ArtifactStage -eq 'release' -and -not $RequireCleanTree) {
        throw 'Release artifact staging requires -RequireCleanTree.'
    }
    if ($RequireCleanTree) {
        Assert-CleanReleaseTree 'before release evidence verification' $commit
    }

    $normalizedRcReportHash = $null
    $normalizedEvidenceBundleHash = $null
    $localRcReportBytes = $null
    $localRcReport = $null
    $mobileSoakReportBytes = $null
    $performanceBaselineReportBytes = $null
    $performanceCandidateReportBytes = $null
    $sourceEvidence = $null
    if ($ValidationProfile -eq 'full') {
        $normalizedRcReportHash = (
            $LocalRcReportSha256 -replace '[^0-9A-Fa-f]', ''
        ).ToLowerInvariant()
        if ($normalizedRcReportHash -notmatch '^[0-9a-f]{64}$') {
            throw 'LocalRcReportSha256 must contain exactly 64 hexadecimal digits.'
        }
        $resolvedRcReport = Resolve-NormalEvidenceFile `
            $LocalRcReportPath 'Local RC report'
        $localRcReportBytes = [IO.File]::ReadAllBytes($resolvedRcReport)
        $actualRcReportHash = (
            Get-FileHash -LiteralPath $resolvedRcReport -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        Assert-Equal $actualRcReportHash $normalizedRcReportHash 'local RC report SHA-256'
        try {
            $localRcReportJson = (
                [Text.Encoding]::UTF8.GetString($localRcReportBytes)
            ).TrimStart([char]0xFEFF)
            $localRcReport = $localRcReportJson | ConvertFrom-Json
        } catch {
            throw 'LocalRcReportPath does not contain valid UTF-8 JSON.'
        }
        Assert-Equal ([int]$localRcReport.schemaVersion) 2 'local RC report schema'
        Assert-Equal ([string]$localRcReport.appVersion) $Version 'local RC report appVersion'
        Assert-Equal ([string]$localRcReport.releaseStage) $ArtifactStage 'local RC report releaseStage'
        $expectedEvidenceCompleteness = if ($ArtifactStage -eq 'candidate') {
            'functional-complete-performance-pending'
        } else {
            'complete'
        }
        Assert-Equal (
            [string]$localRcReport.evidenceCompleteness
        ) $expectedEvidenceCompleteness 'local RC evidence completeness'
        Assert-Equal (
            [string]$localRcReport.validationPolicy
        ) 'current-windows-host-and-api-29-35-emulators' 'local RC validation policy'
        $resolvedMobileSoakReport = Resolve-NormalEvidenceFile `
            $MobileSoakReportPath 'Mobile soak source evidence'
        $sourceEvidenceArguments = @(
            'scripts/verify-release-source-evidence.mjs',
            '--report', $resolvedRcReport,
            '--mobile-soak', $resolvedMobileSoakReport,
            '--expected-version', $Version,
            '--expected-build-sha', $commit,
            '--expected-stage', $ArtifactStage
        )
        if ($ArtifactStage -eq 'candidate') {
            if (
                -not [string]::IsNullOrWhiteSpace($PerformanceBaselineReportPath) -or
                -not [string]::IsNullOrWhiteSpace($PerformanceCandidateReportPath) -or
                -not [string]::IsNullOrWhiteSpace($EvidenceBundleSha256)
            ) {
                throw 'Candidate staging must not attach final performance or bundle evidence.'
            }
        } else {
            $resolvedPerformanceBaselineReport = Resolve-NormalEvidenceFile `
                $PerformanceBaselineReportPath 'Performance baseline source evidence'
            $resolvedPerformanceCandidateReport = Resolve-NormalEvidenceFile `
                $PerformanceCandidateReportPath 'Performance candidate source evidence'
            $normalizedEvidenceBundleHash = (
                $EvidenceBundleSha256 -replace '[^0-9A-Fa-f]', ''
            ).ToLowerInvariant()
            if ($normalizedEvidenceBundleHash -notmatch '^[0-9a-f]{64}$') {
                throw 'EvidenceBundleSha256 must contain exactly 64 hexadecimal digits.'
            }
            $sourceEvidenceArguments += @(
                '--performance-baseline', $resolvedPerformanceBaselineReport,
                '--performance-candidate', $resolvedPerformanceCandidateReport
            )
        }
        $sourceEvidenceJson = & node @sourceEvidenceArguments | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-Host $sourceEvidenceJson
            throw 'Release source evidence validation failed.'
        }
        $sourceEvidence = $sourceEvidenceJson | ConvertFrom-Json
        if ($sourceEvidence.ok -ne $true) {
            throw 'Release source-evidence validator did not report success.'
        }
        $mobileSoakReportBytes = [IO.File]::ReadAllBytes(
            $resolvedMobileSoakReport
        )
        Assert-Equal (
            Get-BytesSha256 $mobileSoakReportBytes
        ) ([string]$localRcReport.mobileSoak.reportSha256) `
            'mobile soak source SHA-256'
        if ($ArtifactStage -eq 'release') {
            $performanceBaselineReportBytes = [IO.File]::ReadAllBytes(
                $resolvedPerformanceBaselineReport
            )
            $performanceCandidateReportBytes = [IO.File]::ReadAllBytes(
                $resolvedPerformanceCandidateReport
            )
            Assert-Equal (
                Get-BytesSha256 $performanceBaselineReportBytes
            ) ([string]$localRcReport.desktopPerformance.baselineReportSha256) `
                'performance baseline source SHA-256'
            Assert-Equal (
                Get-BytesSha256 $performanceCandidateReportBytes
            ) ([string]$localRcReport.desktopPerformance.candidateReportSha256) `
                'performance candidate source SHA-256'
        }
    $requiredFunctionalLimits = @(
        'Lock and UAC secure-desktop capture and input are not supported.',
        'Software SAS and Ctrl+Alt+Delete are not supported.',
        'GDI capture, OpenH264 encoding and SendInput injection remain in the normal-user transport.'
    )
    foreach ($limit in $requiredFunctionalLimits) {
        if (@($localRcReport.knownFunctionalLimits) -notcontains $limit) {
            throw "Local RC report omits the required functional limit: $limit"
        }
    }
    $desktopPerformance = $localRcReport.desktopPerformance
    if ($ArtifactStage -eq 'candidate') {
        if ($null -eq $desktopPerformance) {
            throw 'Candidate staging requires an explicit pending desktop performance state.'
        }
        $candidatePerformanceProperties = @(
            $desktopPerformance.PSObject.Properties |
                ForEach-Object { [string]$_.Name }
        )
        $expectedCandidatePerformanceProperties = @('status', 'reason')
        if (
            $candidatePerformanceProperties.Count -ne
                $expectedCandidatePerformanceProperties.Count -or
            @($expectedCandidatePerformanceProperties | Where-Object {
                $candidatePerformanceProperties -notcontains $_
            }).Count -ne 0
        ) {
            throw (
                'Candidate staging accepts only status/reason desktop performance fields; ' +
                'stale performance evidence must not be attached.'
            )
        }
        Assert-Equal (
            [string]$desktopPerformance.status
        ) 'pending-final-release-measurement' 'candidate desktop performance status'
        Assert-Equal (
            [string]$desktopPerformance.reason
        ) 'not-requested-for-this-local-rc' 'candidate desktop performance reason'
    } else {
    Assert-Equal ([string]$desktopPerformance.status) 'passed' 'desktop performance status'
    Assert-Equal ([int]$desktopPerformance.schemaVersion) 2 'desktop performance comparison schema'
    if ([string]$desktopPerformance.baselineBuildSha -notmatch '^[0-9a-f]{40}$') {
        throw 'The local RC performance evidence is missing its expected baseline build SHA.'
    }
    Assert-Equal (
        [string]$desktopPerformance.candidateBuildSha
    ) ([string]$localRcReport.buildSha) 'desktop performance candidate SHA'
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
    Assert-Equal ([int]$candidatePerformance.schemaVersion) 2 'desktop performance schema'
    Assert-Equal ([string]$candidatePerformance.evidenceMode) 'release' 'desktop performance evidence mode'
    Assert-Equal (
        [string]$candidatePerformance.buildSha
    ) ([string]$localRcReport.buildSha) 'desktop performance buildSha'
    Assert-Equal ([int]$candidatePerformance.warmupRuns) 5 'desktop performance warmup count'
    Assert-Equal ([int]$candidatePerformance.measurementRuns) 25 'desktop performance measurement count'
    $performanceMetricOrder = @(
        'cancellationLatencyMs',
        'rows100kCompletionMs',
        'plainOutput1_1MiBCompletionMs',
        'plainOutput12MiBRetentionPressureMs'
    )
    Assert-Equal (
        (@($candidatePerformance.metricOrder) -join ',')
    ) ($performanceMetricOrder -join ',') 'desktop performance metric order'
    $productProvenance = $candidatePerformance.provenance.product
    $harnessProvenance = $candidatePerformance.provenance.harness
    Assert-Equal ([string]$productProvenance.name) 'EZTerminal' 'performance product name'
    Assert-Equal ([string]$productProvenance.version) $Version 'performance product version'
    Assert-Equal ([int]$productProvenance.protocolVersion) $ProtocolVersion 'performance protocol version'
    Assert-Equal (
        [string]$productProvenance.buildSha
    ) ([string]$localRcReport.buildSha) 'performance product build SHA'
    Assert-Equal (
        [string]$productProvenance.source.gitHeadSha
    ) ([string]$localRcReport.buildSha) 'performance product source SHA'
    Assert-Equal (
        [string]$harnessProvenance.source.gitHeadSha
    ) ([string]$localRcReport.buildSha) 'performance harness source SHA'
    if (
        $productProvenance.source.workingTreeDirty -ne $false -or
        $harnessProvenance.source.workingTreeDirty -ne $false
    ) {
        throw 'Desktop performance evidence was collected from a dirty product or harness tree.'
    }
    $lockHash = (Get-FileHash pnpm-lock.yaml -Algorithm SHA256).Hash.ToLowerInvariant()
    $harnessHash = (
        Get-FileHash e2e/release-performance.spec.ts -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    Assert-Equal ([string]$productProvenance.lock.sha256) $lockHash 'performance product lock hash'
    Assert-Equal ([string]$harnessProvenance.lock.sha256) $lockHash 'performance harness lock hash'
    Assert-Equal ([string]$harnessProvenance.spec.sha256) $harnessHash 'performance harness hash'
    $installedElectronVersion = [string](
        Get-Content node_modules/electron/package.json -Raw | ConvertFrom-Json
    ).version
    $installedPlaywrightVersion = [string](
        Get-Content node_modules/@playwright/test/package.json -Raw | ConvertFrom-Json
    ).version
    $releaseNodeVersion = (& node -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not resolve the release build Node version.'
    }
    Assert-Equal (
        [string]$productProvenance.runtime.electron
    ) $installedElectronVersion 'performance Electron version'
    Assert-Equal (
        [string]$harnessProvenance.runner.playwright
    ) $installedPlaywrightVersion 'performance Playwright version'
    Assert-Equal (
        [string]$harnessProvenance.runner.node
    ) $releaseNodeVersion 'performance/release build Node version'
    if ([string]::IsNullOrWhiteSpace([string]$productProvenance.runtime.node)) {
        throw 'Desktop performance evidence is missing the launched Electron Node version.'
    }
    if (
        [string]$productProvenance.launchArtifacts.entry -ne 'build/main.js' -or
        @($productProvenance.launchArtifacts.files).Count -lt 8 -or
        @($productProvenance.launchArtifacts.files | Where-Object {
            [string]$_.sha256 -notmatch '^[0-9a-f]{64}$' -or [int64]$_.bytes -lt 1
        }).Count -ne 0
    ) {
        throw 'Desktop performance evidence is missing launch artifact hashes.'
    }
    $viteRoot = (Resolve-Path -LiteralPath '.vite').Path
    $actualLaunchArtifacts = @(
        'build/main.js',
        'build/preload.js',
        'build/interpreter-process.js',
        'build/script-host.js',
        'build/packet-capture-host.js'
    ) | ForEach-Object {
        [ordered]@{
            path = $_
            actual = (Resolve-Path -LiteralPath (
                Join-Path $viteRoot ($_.Replace('/', '\'))
            )).Path
        }
    }
    $actualLaunchArtifacts += @(
        Get-ChildItem -LiteralPath (Join-Path $viteRoot 'renderer\main_window') -Recurse -File |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($viteRoot.Length + 1).Replace('\', '/')
                    actual = $_.FullName
                }
            }
    )
    $reportedLaunchArtifacts = @($productProvenance.launchArtifacts.files)
    if ($reportedLaunchArtifacts.Count -ne $actualLaunchArtifacts.Count) {
        throw 'Release .vite artifact count differs from the benchmarked launch artifact set.'
    }
    foreach ($actualArtifact in $actualLaunchArtifacts) {
        $reportedMatches = @($reportedLaunchArtifacts | Where-Object {
            [string]$_.path -ceq [string]$actualArtifact.path
        })
        if ($reportedMatches.Count -ne 1) {
            throw "Release .vite does not uniquely match benchmark artifact $($actualArtifact.path)."
        }
        $reportedArtifact = $reportedMatches[0]
        $actualFile = Get-Item -LiteralPath $actualArtifact.actual
        $actualHash = (
            Get-FileHash -LiteralPath $actualFile.FullName -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        if (
            [int64]$reportedArtifact.bytes -ne [int64]$actualFile.Length -or
            [string]$reportedArtifact.sha256 -cne $actualHash
        ) {
            throw "Release .vite bytes differ from benchmark artifact $($actualArtifact.path)."
        }
    }
    $reportedFixtures = @($harnessProvenance.fixtures)
    $largeFixtureHash = (
        Get-FileHash e2e/fixtures/large-plain-output.js -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    $retentionFixtureHash = (
        Get-FileHash e2e/fixtures/retention-pressure-output.js -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if (
        $reportedFixtures.Count -ne 2 -or
        @($reportedFixtures | Where-Object {
            [string]$_.id -eq 'largePlainOutput' -and
            [string]$_.path -eq 'e2e/fixtures/large-plain-output.js' -and
            [string]$_.sha256 -eq $largeFixtureHash -and
            [int64]$_.stdoutBytes -eq 1101119 -and
            [string]$_.stdoutSha256 -eq 'bbab0e75bbec8e2b80d281ab814a67d841e03167099d787a407d69a038ed717a' -and
            [string]$_.completionMarker -eq 'LARGE-OUTPUT-DONE'
        }).Count -ne 1 -or
        @($reportedFixtures | Where-Object {
            [string]$_.id -eq 'retentionPressureOutput' -and
            [string]$_.path -eq 'e2e/fixtures/retention-pressure-output.js' -and
            [string]$_.sha256 -eq $retentionFixtureHash -and
            [int64]$_.stdoutBytes -eq 12012025 -and
            [string]$_.stdoutSha256 -eq '8f4d6337d2637244a47991f82383f798e78b36a145b579c01c027b6a3bdeced7' -and
            [string]$_.completionMarker -eq 'RETENTION-PRESSURE-DONE'
        }).Count -ne 1
    ) {
        throw 'Desktop performance fixture output metadata is incomplete.'
    }
    Assert-Equal ([string]$candidatePerformance.environment.platform) 'win32' 'desktop performance platform'
    Assert-Equal ([string]$candidatePerformance.environment.arch) 'x64' 'desktop performance architecture'
    if (
        [string]::IsNullOrWhiteSpace([string]$candidatePerformance.environment.osRelease) -or
        [string]::IsNullOrWhiteSpace([string]$candidatePerformance.environment.cpuModel) -or
        [int]$candidatePerformance.environment.logicalCpuCount -lt 1 -or
        [int]$candidatePerformance.environment.totalMemoryGiB -lt 1 -or
        [string]$candidatePerformance.environment.hostFingerprint.algorithm -cne
            'windows-machine-guid-sha256-v1' -or
        [string]$candidatePerformance.environment.hostFingerprint.sha256 -cnotmatch
            '^[0-9a-f]{64}$' -or
        [string]$candidatePerformance.environment.powerPlan.schemeGuid -cnotmatch
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        [string]$candidatePerformance.environment.powerPlan.powerSource -cnotmatch
            '^(ac|dc)$' -or
        [string]$candidatePerformance.environment.powerPlan.effectivePowerMode -cnotmatch
            '^(battery-saver|better-battery|balanced|high-performance|max-performance)$' -or
        [string]$candidatePerformance.environment.powerPlan.baseSettingsSha256 -cnotmatch
            '^[0-9a-f]{64}$' -or
        [string]$candidatePerformance.environment.powerPlan.effectiveSettingsSha256 -cnotmatch
            '^[0-9a-f]{64}$'
    ) {
        throw 'Desktop performance evidence is missing same-host or power-plan identity.'
    }
    foreach ($metricName in $performanceMetricOrder) {
        $metric = $candidatePerformance.metrics.$metricName
        if (
            $null -eq $metric -or
            [int]$metric.warmupRuns -ne 5 -or
            @($metric.samples).Count -ne 25
        ) {
            throw "Desktop performance metric '$metricName' does not contain the exact 5/25 protocol."
        }
    }
    $performanceResultNames = @($desktopPerformance.results | ForEach-Object { [string]$_.name })
    foreach ($metricName in $performanceMetricOrder) {
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
    }
    } elseif (
        -not [string]::IsNullOrWhiteSpace($LocalRcReportSha256) -or
        -not [string]::IsNullOrWhiteSpace($LocalRcReportPath) -or
        -not [string]::IsNullOrWhiteSpace($MobileSoakReportPath) -or
        -not [string]::IsNullOrWhiteSpace($PerformanceBaselineReportPath) -or
        -not [string]::IsNullOrWhiteSpace($PerformanceCandidateReportPath) -or
        -not [string]::IsNullOrWhiteSpace($EvidenceBundleSha256)
    ) {
        throw 'functional-hotfix staging must not attach or claim full source evidence.'
    }

    if ($ValidationProfile -eq 'full') {
    Assert-Equal ([string]$localRcReport.buildSha) $commit 'local RC report buildSha'
    Assert-Equal ([int]$localRcReport.playwrightRetries) 0 'local RC Playwright retry count'
    Assert-Equal (
        [int]$localRcReport.mobileConnectionAttemptsPerScenario
    ) 1 'local RC mobile connection-attempt count'
    Assert-Equal (
        [int]$localRcReport.mobileSocketAttemptsBeforeInitialAuth
    ) 1 'local RC mobile pre-auth socket-attempt count'
    Assert-Equal (
        [string]$localRcReport.mobileTransport
    ) 'adb-reverse-loopback' 'local RC mobile transport'
    Assert-Equal (
        [int]$localRcReport.mobileRemotePort
    ) 17420 'local RC mobile remote port'
    Assert-Equal (
        [string]$localRcReport.emulatorBootMode
    ) 'cold-no-snapshot' 'local RC emulator boot mode'
    $passedApi29 = @($localRcReport.devices | Where-Object {
        $_.status -eq 'passed' -and $_.avd -and [int]$_.api -eq 29
    })
    $passedApi35 = @($localRcReport.devices | Where-Object {
        $_.status -eq 'passed' -and $_.avd -and [int]$_.api -eq 35
    })
    if ($passedApi29.Count -lt 1 -or $passedApi35.Count -lt 1) {
        throw 'Local RC report lacks passing API 29 and API 35 emulator evidence.'
    }
    foreach ($device in @($passedApi29 + $passedApi35)) {
        $deviceLanes = @($device.lanes | ForEach-Object { [string]$_ })
        foreach ($requiredLane in @(
            'instrumentation',
            'qr-scanner',
            'smoke',
            'stabilization',
            'parity',
            'theme-effects',
            'handoff-surfaces'
        )) {
            if ($deviceLanes -notcontains $requiredLane) {
                throw "Local RC device evidence for API $($device.api) omits '$requiredLane'."
            }
        }
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
    }
    if ($RequireCleanTree) {
        Assert-CleanReleaseTree 'before artifact staging' $commit
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

    $sha8 = $commit.Substring(0, 8)
    $expectedAssetsName = if ($ArtifactStage -eq 'candidate') {
        "$Version-rc-$sha8"
    } else {
        "$Version-release-$sha8"
    }
    $repoPrefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $releaseAssetsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'release-assets'))
    $requestedAssetsPath = if ([string]::IsNullOrWhiteSpace($ReleaseAssetsPath)) {
        Join-Path $releaseAssetsRoot $expectedAssetsName
    } elseif ([IO.Path]::IsPathRooted($ReleaseAssetsPath)) {
        $ReleaseAssetsPath
    } else {
        Join-Path $repoRoot $ReleaseAssetsPath
    }
    $assets = [IO.Path]::GetFullPath($requestedAssetsPath)
    if (-not $assets.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "ReleaseAssetsPath must remain inside the repository: $assets"
    }
    if (
        -not [string]::Equals(
            [IO.Path]::GetDirectoryName($assets),
            $releaseAssetsRoot,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
            [IO.Path]::GetFileName($assets),
            $expectedAssetsName,
            [StringComparison]::OrdinalIgnoreCase
        )
    ) {
        throw (
            'ReleaseAssetsPath must be the exact version/SHA-scoped child ' +
            "$expectedAssetsName below release-assets: $assets"
        )
    }
    if (
        (Test-Path -LiteralPath $releaseAssetsRoot) -and
        ((Get-Item -LiteralPath $releaseAssetsRoot -Force).Attributes -band
            [IO.FileAttributes]::ReparsePoint)
    ) {
        throw "release-assets must not be a reparse point: $releaseAssetsRoot"
    }
    if (Test-Path -LiteralPath $assets) {
        $existingAssets = Get-Item -LiteralPath $assets -Force
        if (
            -not $existingAssets.PSIsContainer -or
            ($existingAssets.Attributes -band [IO.FileAttributes]::ReparsePoint)
        ) {
            throw "The scoped release target must be a normal directory: $assets"
        }
        $unsafeChildren = @(
            Get-ChildItem -LiteralPath $assets -Force |
                Where-Object {
                    $_.PSIsContainer -or
                    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
                }
        )
        if ($unsafeChildren.Count -ne 0) {
            throw "The scoped release target contains unsafe nested or linked entries: $assets"
        }
        Remove-Item -LiteralPath $assets -Recurse -Force
    }
    New-Item -ItemType Directory -Path $assets | Out-Null

    if ($ValidationProfile -eq 'full') {
        [IO.File]::WriteAllBytes(
            (Join-Path $assets 'local-rc-report.json'),
            $localRcReportBytes
        )
        [IO.File]::WriteAllBytes(
            (Join-Path $assets 'mobile-soak-report.json'),
            $mobileSoakReportBytes
        )
        if ($ArtifactStage -eq 'release') {
            [IO.File]::WriteAllBytes(
                (Join-Path $assets 'desktop-performance-baseline.json'),
                $performanceBaselineReportBytes
            )
            [IO.File]::WriteAllBytes(
                (Join-Path $assets 'desktop-performance-report.json'),
                $performanceCandidateReportBytes
            )
        }
    }

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

    $manifestArtifacts = @(
        'EZTerminal-Setup.exe',
        'sbom.cdx.json',
        $androidName,
        "$androidName.sha256"
    )
    if ($ValidationProfile -eq 'full') {
        $sourceArtifacts = @(
            'EZTerminal-Setup.exe',
            'local-rc-report.json',
            'mobile-soak-report.json',
            'sbom.cdx.json',
            $androidName,
            "$androidName.sha256"
        )
        if ($ArtifactStage -eq 'release') {
            $sourceArtifacts = @(
                'EZTerminal-Setup.exe',
                'local-rc-report.json',
                'mobile-soak-report.json',
                'desktop-performance-baseline.json',
                'desktop-performance-report.json',
                'sbom.cdx.json',
                $androidName,
                "$androidName.sha256"
            )
        }
        $manifestArtifacts = $sourceArtifacts
    }

    $manifest = [ordered]@{
        appVersion = $Version
        androidVersionCode = $AndroidVersionCode
        protocolVersion = [int]$versionContract.protocolVersion
        validationProfile = $ValidationProfile
        artifactStage = if ($ArtifactStage -eq 'candidate') {
            'local-release-candidate'
        } else {
            'release'
        }
        publicationEligible = ($ArtifactStage -eq 'release')
        evidenceCompleteness = if ($ArtifactStage -eq 'candidate') {
            'functional-complete-performance-pending'
        } else {
            'complete'
        }
        buildSha = $commit
        embeddedBuildShaVerified = $true
        localRcReportSha256 = $normalizedRcReportHash
        localRcReportVerified = ($ValidationProfile -eq 'full')
        sourceEvidence = if ($ValidationProfile -eq 'full') {
            [ordered]@{
                verified = $true
                approvalBundleSha256 = $normalizedEvidenceBundleHash
                mobileSoakReportSha256 = [string]$localRcReport.mobileSoak.reportSha256
                performanceBaselineReportSha256 = if ($ArtifactStage -eq 'release') {
                    [string]$localRcReport.desktopPerformance.baselineReportSha256
                } else {
                    $null
                }
                performanceCandidateReportSha256 = if ($ArtifactStage -eq 'release') {
                    [string]$localRcReport.desktopPerformance.candidateReportSha256
                } else {
                    $null
                }
            }
        } else {
            $null
        }
        generatedAtUtc = [DateTime]::UtcNow.ToString('o')
        validation = [ordered]@{
            commonFunctionalGates = 'passed'
            performanceBenchmark = if (
                $ValidationProfile -eq 'full' -and $ArtifactStage -eq 'candidate'
            ) {
                'pending-final-release-measurement'
            } elseif ($ValidationProfile -eq 'full') {
                'passed'
            } else {
                'not-run-by-explicit-operator-request'
            }
            mobileSoak = if ($ValidationProfile -eq 'full') {
                'passed'
            } else {
                'not-run-for-functional-hotfix'
            }
        }
        windowsAuthenticode = [ordered]@{
            expected = $ExpectedWindowsSignature
            app = $appSignature
            setup = $setupSignature
        }
        androidSigningCertSha256 = ($AndroidCertSha256 -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
        artifacts = $manifestArtifacts
    }
    $manifest | ConvertTo-Json -Depth 6 |
        Set-Content -LiteralPath (Join-Path $assets 'release-manifest.json') -Encoding utf8

    $hashLines = Get-ChildItem -LiteralPath $assets -File |
        Where-Object Name -ne 'SHA256SUMS.txt' |
        Sort-Object Name |
        ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($_.Name)"
        }
    $hashLines | Set-Content -LiteralPath (Join-Path $assets 'SHA256SUMS.txt') -Encoding ascii

    if ($RequireCleanTree) {
        Assert-CleanReleaseTree 'after artifact staging' $commit
    }
    Write-Host "Staged verified release assets for $Version from $commit"
    Get-ChildItem -LiteralPath $assets -File | Sort-Object Name |
        Select-Object Name, Length | Format-Table -AutoSize
} finally {
    Pop-Location
}
