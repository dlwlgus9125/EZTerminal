[CmdletBinding()]
param(
    [string]$Api29Avd = 'EZTerminalApi29',
    [string]$Api35Avd = 'EZTerminalApi35',

    [Parameter(Mandatory = $true)]
    [string]$PerformanceBaselinePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string]$PerformanceBaselineBuildSha
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adb = Join-Path $androidHome 'platform-tools\adb.exe'
$emulator = Join-Path $androidHome 'emulator\emulator.exe'
$mainApk = Join-Path $repoRoot 'mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $repoRoot 'mobile\android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
$results = [Collections.Generic.List[object]]::new()

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $repoRoot)
    Push-Location $WorkingDirectory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed ($LASTEXITCODE): $File $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Assert-EmbeddedBuildSha {
    param([string]$ExpectedSha)
    foreach ($bundlePath in @('.vite/build/main.js', '.vite/build/preload.js')) {
        if (-not (Test-Path -LiteralPath $bundlePath)) {
            throw "Exact-SHA build did not produce $bundlePath."
        }
        $bundle = Get-Content -LiteralPath $bundlePath -Raw
        if ($bundle.IndexOf($ExpectedSha, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "$bundlePath does not contain the exact source SHA $ExpectedSha."
        }
        if ($bundle -match 'buildSha\s*:\s*["'']dev["'']') {
            throw "$bundlePath still contains buildSha=dev."
        }
    }
}

function Assert-CleanGitTree {
    param([string]$Phase)
    $dirty = @(git status --porcelain --untracked-files=all)
    if ($dirty.Count -ne 0) {
        $dirty | ForEach-Object { Write-Host $_ }
        throw "The RC gate must have a clean, frozen commit ($Phase)."
    }
}

function Assert-FileEvidence {
    param(
        [object]$Evidence,
        [string]$ExpectedLogicalPath,
        [string]$ActualPath,
        [string]$Label
    )
    if (-not (Test-Path -LiteralPath $ActualPath -PathType Leaf)) {
        throw "$Label source file is missing: $ActualPath"
    }
    $actualHash = (Get-FileHash -LiteralPath $ActualPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $actualBytes = (Get-Item -LiteralPath $ActualPath).Length
    if (
        [string]$Evidence.path -cne $ExpectedLogicalPath -or
        [string]$Evidence.sha256 -cne $actualHash -or
        [int64]$Evidence.bytes -ne $actualBytes
    ) {
        throw "$Label does not match $ExpectedLogicalPath."
    }
}

function Assert-CandidatePerformanceProvenance {
    param([object]$Report, [string]$ExpectedSha, [string]$ExpectedVersion)

    $releaseVersion = Get-Content -LiteralPath (Join-Path $repoRoot 'release\version.json') -Raw |
        ConvertFrom-Json
    $product = $Report.provenance.product
    $harness = $Report.provenance.harness
    if (
        [int]$Report.schemaVersion -ne 2 -or
        [string]$Report.evidenceMode -cne 'release' -or
        [string]$Report.buildSha -cne $ExpectedSha -or
        [string]$product.name -cne 'EZTerminal' -or
        [string]$product.version -cne $ExpectedVersion -or
        [int]$product.protocolVersion -ne [int]$releaseVersion.protocolVersion -or
        [string]$product.buildSha -cne $ExpectedSha -or
        [string]$product.source.gitHeadSha -cne $ExpectedSha -or
        [bool]$product.source.workingTreeDirty -or
        [string]$harness.source.gitHeadSha -cne $ExpectedSha -or
        [bool]$harness.source.workingTreeDirty
    ) {
        throw 'The desktop performance report has invalid exact-SHA product or clean-tree provenance.'
    }

    $electronVersion = (
        Get-Content -LiteralPath (Join-Path $repoRoot 'node_modules\electron\package.json') -Raw |
            ConvertFrom-Json
    ).version
    $playwrightVersion = (
        Get-Content -LiteralPath (Join-Path $repoRoot 'node_modules\@playwright\test\package.json') -Raw |
            ConvertFrom-Json
    ).version
    $runnerNodeVersion = (& node -p 'process.versions.node').Trim()
    if (
        [string]$product.runtime.electron -cne [string]$electronVersion -or
        [string]$harness.runner.playwright -cne [string]$playwrightVersion -or
        [string]$harness.runner.node -cne [string]$runnerNodeVersion
    ) {
        throw 'The desktop performance report tool versions differ from the installed RC toolchain.'
    }

    Assert-FileEvidence $product.lock 'pnpm-lock.yaml' `
        (Join-Path $repoRoot 'pnpm-lock.yaml') 'product lock evidence'
    Assert-FileEvidence $harness.lock 'pnpm-lock.yaml' `
        (Join-Path $repoRoot 'pnpm-lock.yaml') 'harness lock evidence'
    Assert-FileEvidence $harness.spec 'e2e/release-performance.spec.ts' `
        (Join-Path $repoRoot 'e2e\release-performance.spec.ts') 'performance harness evidence'

    $expectedFixtures = @(
        [ordered]@{
            id = 'largePlainOutput'
            path = 'e2e/fixtures/large-plain-output.js'
            actual = Join-Path $repoRoot 'e2e\fixtures\large-plain-output.js'
            stdoutBytes = 1101119
            stdoutSha256 = 'bbab0e75bbec8e2b80d281ab814a67d841e03167099d787a407d69a038ed717a'
            marker = 'LARGE-OUTPUT-DONE'
        },
        [ordered]@{
            id = 'retentionPressureOutput'
            path = 'e2e/fixtures/retention-pressure-output.js'
            actual = Join-Path $repoRoot 'e2e\fixtures\retention-pressure-output.js'
            stdoutBytes = 12012025
            stdoutSha256 = '8f4d6337d2637244a47991f82383f798e78b36a145b579c01c027b6a3bdeced7'
            marker = 'RETENTION-PRESSURE-DONE'
        }
    )
    $reportedFixtures = @($harness.fixtures)
    if ($reportedFixtures.Count -ne $expectedFixtures.Count) {
        throw 'The desktop performance report fixture set is incomplete.'
    }
    for ($index = 0; $index -lt $expectedFixtures.Count; $index += 1) {
        $expected = $expectedFixtures[$index]
        $reported = $reportedFixtures[$index]
        Assert-FileEvidence $reported $expected.path $expected.actual "fixture evidence $($expected.id)"
        if (
            [string]$reported.id -cne $expected.id -or
            [int64]$reported.stdoutBytes -ne $expected.stdoutBytes -or
            [string]$reported.stdoutSha256 -cne $expected.stdoutSha256 -or
            [string]$reported.completionMarker -cne $expected.marker
        ) {
            throw "Fixture output metadata differs for $($expected.id)."
        }
    }

    $viteRoot = Join-Path $repoRoot '.vite'
    $expectedArtifacts = @(
        'build/main.js',
        'build/preload.js',
        'build/interpreter-process.js',
        'build/script-host.js',
        'build/packet-capture-host.js'
    ) | ForEach-Object {
        [ordered]@{
            path = $_
            actual = Join-Path $viteRoot ($_.Replace('/', '\'))
        }
    }
    $expectedArtifacts += @(
        Get-ChildItem -LiteralPath (Join-Path $viteRoot 'renderer\main_window') -Recurse -File |
            ForEach-Object {
                [ordered]@{
                    path = $_.FullName.Substring($viteRoot.Length + 1).Replace('\', '/')
                    actual = $_.FullName
                }
            }
    )
    $reportedArtifacts = @($product.launchArtifacts.files)
    if (
        [string]$product.launchArtifacts.entry -cne 'build/main.js' -or
        $reportedArtifacts.Count -ne $expectedArtifacts.Count
    ) {
        throw 'The desktop performance report launch artifact set is incomplete.'
    }
    foreach ($expected in $expectedArtifacts) {
        $matches = @($reportedArtifacts | Where-Object { [string]$_.path -ceq $expected.path })
        if ($matches.Count -ne 1) {
            throw "The desktop performance report does not uniquely identify $($expected.path)."
        }
        Assert-FileEvidence $matches[0] $expected.path $expected.actual `
            "launch artifact evidence $($expected.path)"
    }
}

function Invoke-Adb {
    param([string]$Serial, [string[]]$Arguments)
    $output = & $adb -s $Serial @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "adb failed for $Serial`: $output"
    }
    return $output.Trim()
}

function Wait-ForAndroidBoot {
    param([string]$Serial, [int]$ExpectedApi)
    & $adb -s $Serial wait-for-device
    if ($LASTEXITCODE -ne 0) { throw "Device $Serial did not become available." }
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    do {
        $booted = (& $adb -s $Serial shell getprop sys.boot_completed 2>$null | Out-String).Trim()
        if ($booted -eq '1') { break }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for $Serial to boot." }
        Start-Sleep -Seconds 2
    } while ($true)
    $api = [int](Invoke-Adb $Serial @('shell', 'getprop', 'ro.build.version.sdk'))
    if ($api -ne $ExpectedApi) { throw "$Serial is API $api; expected API $ExpectedApi." }
}

function Invoke-Instrumentation {
    param([string]$Serial)
    Invoke-Adb $Serial @('install', '-r', '-t', $mainApk) | Write-Host
    Invoke-Adb $Serial @('install', '-r', '-t', $testApk) | Write-Host
    $output = Invoke-Adb $Serial @(
        'shell', 'am', 'instrument', '-w',
        'com.ezterminal.remote.test/androidx.test.runner.AndroidJUnitRunner'
    )
    Write-Host $output
    if ($output -notmatch '(?m)^OK \(' -or $output -match 'FAILURES|INSTRUMENTATION_FAILED') {
        throw "Android instrumentation failed on $Serial."
    }
}

function Invoke-MobileE2e {
    param([string]$Serial, [switch]$Full, [switch]$Soak)
    $previousSerial = $env:ANDROID_SERIAL
    $previousRemotePort = $env:EZTERMINAL_REMOTE_PORT
    $previousOpenClawProxyPort = $env:EZTERMINAL_OPENCLAW_PROXY_PORT
    $previousVpnInterface = $env:EZTERMINAL_REMOTE_VPN_INTERFACE
    $previousHostUrl = $env:EZTERMINAL_MOBILE_E2E_HOST_URL
    $env:ANDROID_SERIAL = $Serial
    $env:EZTERMINAL_REMOTE_PORT = '17420'
    $env:EZTERMINAL_OPENCLAW_PROXY_PORT = '17421'
    $env:EZTERMINAL_REMOTE_VPN_INTERFACE = '127.0.0.1'
    $env:EZTERMINAL_MOBILE_E2E_HOST_URL = 'ws://127.0.0.1:17420'
    try {
        Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:smoke')
        Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:stabilization')
        if ($Full) {
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:parity')
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:theme-effects')
        }
        if ($Soak) {
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:release-soak')
        }
    } finally {
        $env:ANDROID_SERIAL = $previousSerial
        $env:EZTERMINAL_REMOTE_PORT = $previousRemotePort
        $env:EZTERMINAL_OPENCLAW_PROXY_PORT = $previousOpenClawProxyPort
        $env:EZTERMINAL_REMOTE_VPN_INTERFACE = $previousVpnInterface
        $env:EZTERMINAL_MOBILE_E2E_HOST_URL = $previousHostUrl
    }
}

function Invoke-AvdGate {
    param([string]$Avd, [int]$Api, [int]$Port, [switch]$Soak)
    $serial = "emulator-$Port"
    $knownAvds = @(& $emulator -list-avds)
    if ($knownAvds -notcontains $Avd) {
        throw "Required API $Api AVD '$Avd' does not exist. Create it before the RC gate."
    }
    if ((& $adb devices) -match "(?m)^$([regex]::Escape($serial))\s") {
        throw "$serial is already in use. Stop it before running the RC gate."
    }

    $stdout = Join-Path $env:TEMP "ezterminal-$serial.out.log"
    $stderr = Join-Path $env:TEMP "ezterminal-$serial.err.log"
    $process = Start-Process -FilePath $emulator -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -ArgumentList @(
            '-avd', $Avd, '-port', $Port, '-no-window', '-no-audio',
            '-no-boot-anim', '-no-snapshot-load', '-no-snapshot-save',
            '-gpu', 'swiftshader_indirect'
        )
    try {
        Wait-ForAndroidBoot $serial $Api
        Invoke-Instrumentation $serial
        Invoke-MobileE2e $serial -Full
        if ($Soak) {
            $env:EZTERMINAL_SOAK_DURATION_MS = '1800000'
            $env:EZTERMINAL_SOAK_QUIESCENCE_MS = '15000'
            $env:EZTERMINAL_SOAK_REPORT_PATH = Join-Path $repoRoot 'release-assets\mobile-soak-report.json'
            Invoke-MobileE2e $serial -Soak
        }
        $results.Add([ordered]@{ device = $serial; api = $Api; avd = $Avd; status = 'passed' })
    } finally {
        try { Invoke-Adb $serial @('emu', 'kill') | Out-Null } catch { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        if (-not $process.WaitForExit(30000)) {
            try {
                Stop-Process -Id $process.Id -Force -ErrorAction Stop
            } catch {
                if (-not $process.HasExited) { throw }
            }
            if (-not $process.WaitForExit(30000)) {
                throw "Emulator process $($process.Id) for $serial did not exit after forced teardown."
            }
        }
        $deviceDeadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $attachedDevices = & $adb devices
            if ($LASTEXITCODE -ne 0) {
                throw "adb devices failed while verifying teardown of $serial."
            }
            $deviceStillAttached = $attachedDevices -match "(?m)^$([regex]::Escape($serial))\s"
            if (-not $deviceStillAttached) { break }
            Start-Sleep -Seconds 1
        } while ([DateTime]::UtcNow -lt $deviceDeadline)
        if ($deviceStillAttached) {
            throw "$serial remained attached after emulator teardown."
        }
    }
}

if (-not (Test-Path -LiteralPath $adb) -or -not (Test-Path -LiteralPath $emulator)) {
    throw "Android SDK platform-tools and emulator are required below $androidHome."
}
Push-Location $repoRoot
try {
    Assert-CleanGitTree 'before validation'
    $sha = (& git rev-parse HEAD).Trim()
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $expectedNodeVersion = (Get-Content .nvmrc -Raw).Trim().TrimStart('v')
    $actualNodeVersion = (& node -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or $actualNodeVersion -cne $expectedNodeVersion) {
        throw "Release validation requires Node $expectedNodeVersion; current Node is $actualNodeVersion."
    }
    $env:EZTERMINAL_PLAYWRIGHT_RETRIES = '0'
    $env:EZTERMINAL_RUN_RELEASE_PERFORMANCE = '1'
    $env:EZTERMINAL_BUILD_SHA = $sha
    $env:VITE_BUILD_SHA = $sha
    $env:ANDROID_HOME = $androidHome
    $env:ANDROID_SDK_ROOT = $androidHome

    $reportDirectory = Join-Path $repoRoot 'release-assets'
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $resolvedPerformanceBaseline = (Resolve-Path -LiteralPath $PerformanceBaselinePath).Path
    $normalizedPerformanceBaselineBuildSha = $PerformanceBaselineBuildSha.ToLowerInvariant()
    $performanceBaseline = Get-Content -LiteralPath $resolvedPerformanceBaseline -Raw |
        ConvertFrom-Json
    if (
        [int]$performanceBaseline.schemaVersion -ne 2 -or
        [string]$performanceBaseline.evidenceMode -cne 'release' -or
        [string]$performanceBaseline.buildSha -cne $normalizedPerformanceBaselineBuildSha -or
        [string]$performanceBaseline.provenance.product.buildSha -cne `
            $normalizedPerformanceBaselineBuildSha -or
        [string]$performanceBaseline.provenance.product.source.gitHeadSha -cne `
            $normalizedPerformanceBaselineBuildSha -or
        [string]$performanceBaseline.provenance.harness.runner.node -cne $actualNodeVersion -or
        [string]$performanceBaseline.environment.hostFingerprint.algorithm -cne `
            'windows-machine-guid-sha256-v1' -or
        [string]$performanceBaseline.environment.hostFingerprint.sha256 -cnotmatch `
            '^[0-9a-f]{64}$' -or
        [string]$performanceBaseline.environment.powerPlan.schemeGuid -cnotmatch `
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        [string]$performanceBaseline.environment.powerPlan.powerSource -cnotmatch `
            '^(ac|dc)$' -or
        [string]$performanceBaseline.environment.powerPlan.effectivePowerMode -cnotmatch `
            '^(battery-saver|better-battery|balanced|high-performance|max-performance)$' -or
        [string]$performanceBaseline.environment.powerPlan.baseSettingsSha256 -cnotmatch `
            '^[0-9a-f]{64}$' -or
        [string]$performanceBaseline.environment.powerPlan.effectiveSettingsSha256 -cnotmatch `
            '^[0-9a-f]{64}$'
    ) {
        throw 'The baseline report is not same-host/power-plan schema-v2 evidence for this Node toolchain and -PerformanceBaselineBuildSha.'
    }
    $performanceReportPath = Join-Path $reportDirectory 'desktop-performance-report.json'
    if (Test-Path -LiteralPath $performanceReportPath) {
        Remove-Item -LiteralPath $performanceReportPath -Force
    }
    $env:EZTERMINAL_PERFORMANCE_REPORT_PATH = $performanceReportPath

    Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
    Invoke-Checked 'pnpm' @('verify:version')
    Invoke-Checked 'pnpm' @('typecheck')
    Invoke-Checked 'pnpm' @('lint')
    1..3 | ForEach-Object {
        Write-Host "Desktop unit stability run $_/3"
        Invoke-Checked 'pnpm' @('test')
    }
    Invoke-Checked 'pnpm' @('audit', '--prod', '--audit-level=low')
    Invoke-Checked 'pnpm' @('audit', '--audit-level=low')
    # Force an exact-SHA Vite build before Playwright. Its ordinary global
    # setup may reuse mtime-fresh local artifacts, which is valid for
    # development but not for release evidence.
    Invoke-Checked 'pnpm' @('package')
    Assert-EmbeddedBuildSha $sha
    Invoke-Checked 'pnpm' @('e2e')
    if (-not (Test-Path -LiteralPath $performanceReportPath)) {
        throw 'The desktop E2E gate did not produce desktop-performance-report.json.'
    }
    $performanceReport = Get-Content -LiteralPath $performanceReportPath -Raw | ConvertFrom-Json
    if (
        [int]$performanceReport.schemaVersion -ne 2 -or
        [string]$performanceReport.evidenceMode -cne 'release' -or
        [string]$performanceReport.buildSha -cne $sha -or
        [int]$performanceReport.warmupRuns -ne 5 -or
        [int]$performanceReport.measurementRuns -ne 25 -or
        (@($performanceReport.metricOrder) -join ',') -cne (
            'cancellationLatencyMs,rows100kCompletionMs,' +
            'plainOutput1_1MiBCompletionMs,plainOutput12MiBRetentionPressureMs'
        )
    ) {
        throw 'The desktop performance report is not schema-v2 exact-SHA evidence using the approved ordered 5/25 protocol.'
    }
    Assert-CandidatePerformanceProvenance $performanceReport $sha $version
    $performanceComparisonJson = & node scripts/verify-performance-report.mjs `
        --baseline $resolvedPerformanceBaseline `
        --candidate $performanceReportPath `
        --max-regression-percent 5 `
        --min-target-improvement-percent 15 `
        --expected-baseline-build-sha $normalizedPerformanceBaselineBuildSha `
        --expected-candidate-build-sha $sha `
        --target-metrics plainOutput12MiBRetentionPressureMs | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host $performanceComparisonJson
        throw 'The desktop performance report exceeded its relative or absolute budget.'
    }
    $performanceComparison = $performanceComparisonJson | ConvertFrom-Json
    if ($performanceComparison.ok -ne $true) {
        throw 'The desktop performance comparison did not report a passing result.'
    }
    Assert-CleanGitTree 'after desktop performance measurement'
    $performanceBaselineHash = (
        Get-FileHash -LiteralPath $resolvedPerformanceBaseline -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    $performanceReportHash = (
        Get-FileHash -LiteralPath $performanceReportPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()

    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'build:e2e')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'cap:sync')
    Invoke-Checked (Join-Path $repoRoot 'mobile\android\gradlew.bat') `
        @('assembleDebug', 'assembleDebugAndroidTest', '--no-daemon', '--stacktrace') `
        (Join-Path $repoRoot 'mobile\android')

    Invoke-AvdGate $Api29Avd 29 5556
    Invoke-AvdGate $Api35Avd 35 5558 -Soak

    $soakReportPath = Join-Path $repoRoot 'release-assets\mobile-soak-report.json'
    if (-not (Test-Path -LiteralPath $soakReportPath)) {
        throw 'The API 35 emulator soak did not produce mobile-soak-report.json.'
    }
    $soak = Get-Content -LiteralPath $soakReportPath -Raw | ConvertFrom-Json
    $soakGrowthFailures = @($soak.growthChecks | Where-Object { $_.passed -ne $true })
    if (
        $soak.status -ne 'passed' -or
        [string]$soak.releaseIdentity.buildSha -ne $sha -or
        [string]$soak.releaseIdentity.appVersion -ne $version -or
        [int64]$soak.config.durationMs -lt 1800000 -or
        [int]$soak.config.sessionCount -ne 8 -or
        @($soak.cycles).Count -ne 20 -or
        $soak.markerAudit.passed -ne $true -or
        $soakGrowthFailures.Count -ne 0 -or
        @($soak.cleanupErrors).Count -ne 0
    ) {
        throw 'The API 35 emulator soak report does not satisfy the exact-SHA gate.'
    }
    $soakReportHash = (Get-FileHash -LiteralPath $soakReportPath -Algorithm SHA256).Hash.ToLowerInvariant()

    # Restore the exact production web assets after the E2E-only APK gate.
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'build:release')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'cap:sync')
    $androidStatus = @(git status --porcelain --untracked-files=all -- mobile/android)
    if ($androidStatus.Count -ne 0) {
        $androidStatus | ForEach-Object { Write-Host $_ }
        throw 'Production Capacitor sync changed Android source. Commit generated updates before release.'
    }
    Assert-CleanGitTree 'after all candidate validation'

    $reportPath = Join-Path $reportDirectory 'local-rc-report.json'
    [ordered]@{
        schemaVersion = 1
        appVersion = $version
        buildSha = $sha
        completedAtUtc = [DateTime]::UtcNow.ToString('o')
        validationPolicy = 'current-windows-host-and-api-29-35-emulators'
        acceptedResidualRisks = @(
            'Windows 10, Home, Enterprise, domain and MDM policy paths are not validated.',
            'Elevated service install, removal and firewall policy paths are not physically validated.',
            'Physical Android devices, OEM codecs, TalkBack and hardware keyboards are not validated.',
            'Multi-monitor, HDR and vendor-specific GPU encoder paths are not validated.',
            'The 10 Mbps and 80 ms physical network scenario is not validated.'
        )
        knownFunctionalLimits = @(
            'Lock and UAC secure-desktop capture and input are not supported in 1.0.3.',
            'Software SAS and Ctrl+Alt+Delete are not supported in 1.0.3.',
            'GDI capture, OpenH264 encoding and SendInput injection remain in the normal-user transport.'
        )
        playwrightRetries = 0
        mobileConnectionAttemptsPerScenario = 1
        mobileSocketAttemptsBeforeInitialAuth = 1
        mobileTransport = 'adb-reverse-loopback'
        mobileRemotePort = 17420
        emulatorBootMode = 'cold-no-snapshot'
        desktopPerformance = [ordered]@{
            status = 'passed'
            schemaVersion = 2
            baselineBuildSha = $normalizedPerformanceBaselineBuildSha
            candidateBuildSha = $sha
            baselineReportSha256 = $performanceBaselineHash
            candidateReportSha256 = $performanceReportHash
            maxP95RegressionPercent = 5
            minTargetP95ImprovementPercent = 15
            targetMetrics = @('plainOutput12MiBRetentionPressureMs')
            results = @($performanceComparison.results)
            candidate = $performanceReport
        }
        devices = $results
        mobileSoak = [ordered]@{
            status = [string]$soak.status
            buildSha = [string]$soak.releaseIdentity.buildSha
            appVersion = [string]$soak.releaseIdentity.appVersion
            durationMs = [int64]$soak.config.durationMs
            sessionCount = [int]$soak.config.sessionCount
            recoveryCycles = @($soak.cycles).Count
            memoryPassed = ($soakGrowthFailures.Count -eq 0)
            markerAuditPassed = [bool]$soak.markerAudit.passed
            cleanupPassed = (@($soak.cleanupErrors).Count -eq 0)
            reportSha256 = $soakReportHash
        }
    } | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $reportPath -Encoding utf8
    $reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Local RC gate passed for EZTerminal $version at $sha."
    Write-Host "RC report: $reportPath"
    Write-Host "RC report SHA-256: $reportHash"
    Write-Host 'After reviewing the report, publish its approval to the protected GitHub Environment:'
    Write-Host "gh variable set EZTERMINAL_LOCAL_RC_APPROVED_SHA --env release --body `"$sha`""
    Write-Host "gh variable set EZTERMINAL_LOCAL_RC_REPORT_SHA256 --env release --body `"$reportHash`""
    Write-Host "[Convert]::ToBase64String([IO.File]::ReadAllBytes(`"$reportPath`")) | gh secret set EZTERMINAL_LOCAL_RC_REPORT_BASE64 --env release"
} finally {
    Pop-Location
}
