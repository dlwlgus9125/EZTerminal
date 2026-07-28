[CmdletBinding()]
param(
    [string]$Api29Avd = 'EZTerminalApi29',
    [string]$Api35Avd = 'EZTerminalApi35',

    [string]$PerformanceBaselinePath = '',

    [ValidatePattern('^$|^[0-9A-Fa-f]{40}$')]
    [string]$PerformanceBaselineBuildSha = '',

    [switch]$RunPerformanceMeasurement
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (
    -not $RunPerformanceMeasurement -and
    (
        -not [string]::IsNullOrWhiteSpace($PerformanceBaselinePath) -or
        -not [string]::IsNullOrWhiteSpace($PerformanceBaselineBuildSha)
    )
) {
    throw 'Performance baseline arguments require the explicit -RunPerformanceMeasurement switch.'
}
if (
    $RunPerformanceMeasurement -and
    (
        [string]::IsNullOrWhiteSpace($PerformanceBaselinePath) -or
        $PerformanceBaselineBuildSha -notmatch '^[0-9A-Fa-f]{40}$'
    )
) {
    throw (
        '-RunPerformanceMeasurement requires PerformanceBaselinePath and a complete ' +
        'PerformanceBaselineBuildSha.'
    )
}
if (
    -not $RunPerformanceMeasurement -and
    -not [string]::IsNullOrWhiteSpace($env:EZTERMINAL_RUN_RELEASE_PERFORMANCE)
) {
    throw (
        'The non-performance candidate refuses an inherited ' +
        'EZTERMINAL_RUN_RELEASE_PERFORMANCE value.'
    )
}
if (
    -not $RunPerformanceMeasurement -and
    -not [string]::IsNullOrWhiteSpace($env:EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC)
) {
    throw (
        'The non-performance candidate refuses an inherited ' +
        'EZTERMINAL_RUN_PERFORMANCE_DIAGNOSTIC value.'
    )
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adb = Join-Path $androidHome 'platform-tools\adb.exe'
$emulator = Join-Path $androidHome 'emulator\emulator.exe'
$mainApk = Join-Path $repoRoot 'mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$testApk = Join-Path $repoRoot 'mobile\android\app\build\outputs\apk\androidTest\debug\app-debug-androidTest.apk'
$results = [Collections.Generic.List[object]]::new()
$script:soakReportPath = Join-Path $repoRoot 'release-assets\mobile-soak-report.json'

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

function Assert-FrozenGitTree {
    param(
        [string]$Phase,
        [string]$ExpectedSha = ''
    )
    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
        throw "Could not resolve the exact Git HEAD ($Phase)."
    }
    if (
        -not [string]::IsNullOrWhiteSpace($ExpectedSha) -and
        $head -cne $ExpectedSha
    ) {
        throw "The RC source HEAD changed from $ExpectedSha to $head ($Phase)."
    }
    $dirty = @(git status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the Git worktree ($Phase)."
    }
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

function Invoke-AdbBounded {
    param(
        [string[]]$Arguments,
        [int]$TimeoutMs
    )

    if ($TimeoutMs -lt 1) {
        throw 'A bounded adb invocation requires a positive timeout.'
    }
    if (@($Arguments | Where-Object { $_ -match '[\s"]' }).Count -ne 0) {
        throw 'The bounded adb probe accepts only fixed, whitespace-free arguments.'
    }

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $adb
    $startInfo.Arguments = $Arguments -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $adbProcess = [Diagnostics.Process]::new()
    $adbProcess.StartInfo = $startInfo
    $started = $false
    $stdoutTask = $null
    $stderrTask = $null
    try {
        $started = $adbProcess.Start()
        if (-not $started) {
            throw "Could not start bounded adb: $($Arguments -join ' ')"
        }
        # Drain both streams asynchronously so a verbose adb failure cannot
        # block the process while the parent is enforcing its deadline.
        $stdoutTask = $adbProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $adbProcess.StandardError.ReadToEndAsync()
        $completedBeforeTimeout = $adbProcess.WaitForExit($TimeoutMs)
        $timedOut = -not $completedBeforeTimeout
        if ($timedOut) {
            try {
                if (-not $adbProcess.HasExited) { $adbProcess.Kill() }
            } catch [InvalidOperationException] {
                # The process exited between HasExited and Kill.
            }
            if (-not $adbProcess.WaitForExit(5000)) {
                throw "Timed out and could not terminate adb: $($Arguments -join ' ')"
            }
        }
        # Flush the redirected file handles only after bounded exit was proven.
        $adbProcess.WaitForExit()
        return [pscustomobject]@{
            TimedOut = $timedOut
            ExitCode = $adbProcess.ExitCode
            StdOut = $stdoutTask.Result
            StdErr = $stderrTask.Result
        }
    } finally {
        if ($started -and -not $adbProcess.HasExited) {
            try {
                $adbProcess.Kill()
                [void]$adbProcess.WaitForExit(5000)
            } catch {
                # Best effort here must not hide the bounded command failure.
            }
        }
        $adbProcess.Dispose()
    }
}

function Get-RemainingProbeTimeout {
    param(
        [DateTime]$Deadline,
        [int]$MaximumMs = 3000
    )

    $remainingMs = [int64][Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remainingMs -le 0) { return 0 }
    return [int][Math]::Min($remainingMs, $MaximumMs)
}

function Wait-ForAndroidBoot {
    param(
        [string]$Serial,
        [int]$ExpectedApi,
        [Diagnostics.Process]$EmulatorProcess
    )

    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    $lastObservation = 'adb did not report a device state'
    do {
        if ($EmulatorProcess.HasExited) {
            throw (
                "Emulator process $($EmulatorProcess.Id) for $Serial exited with code " +
                "$($EmulatorProcess.ExitCode) before the device became available."
            )
        }
        $probeTimeout = Get-RemainingProbeTimeout $deadline
        if ($probeTimeout -le 0) {
            throw "Timed out waiting for $Serial to become available ($lastObservation)."
        }
        $stateResult = Invoke-AdbBounded `
            -Arguments @('-s', $Serial, 'get-state') `
            -TimeoutMs $probeTimeout
        $lastObservation = if ($stateResult.TimedOut) {
            'adb get-state timed out'
        } elseif ($stateResult.ExitCode -ne 0) {
            "adb get-state exited $($stateResult.ExitCode): $($stateResult.StdErr.Trim())"
        } else {
            "adb get-state returned $($stateResult.StdOut.Trim())"
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for $Serial to become available ($lastObservation)."
        }
        if (
            -not $stateResult.TimedOut -and
            $stateResult.ExitCode -eq 0 -and
            $stateResult.StdOut.Trim() -ceq 'device'
        ) {
            break
        }
        $sleepMs = [Math]::Min(1000, (Get-RemainingProbeTimeout $deadline 1000))
        if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
    } while ($true)

    $lastObservation = 'sys.boot_completed was not observable'
    do {
        if ($EmulatorProcess.HasExited) {
            throw (
                "Emulator process $($EmulatorProcess.Id) for $Serial exited with code " +
                "$($EmulatorProcess.ExitCode) before Android completed booting."
            )
        }
        $probeTimeout = Get-RemainingProbeTimeout $deadline
        if ($probeTimeout -le 0) {
            throw "Timed out waiting for $Serial to boot ($lastObservation)."
        }
        $bootResult = Invoke-AdbBounded `
            -Arguments @('-s', $Serial, 'shell', 'getprop', 'sys.boot_completed') `
            -TimeoutMs $probeTimeout
        $lastObservation = if ($bootResult.TimedOut) {
            'sys.boot_completed probe timed out'
        } elseif ($bootResult.ExitCode -ne 0) {
            "sys.boot_completed probe exited $($bootResult.ExitCode): $($bootResult.StdErr.Trim())"
        } else {
            "sys.boot_completed=$($bootResult.StdOut.Trim())"
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for $Serial to boot ($lastObservation)."
        }
        if (
            -not $bootResult.TimedOut -and
            $bootResult.ExitCode -eq 0 -and
            $bootResult.StdOut.Trim() -ceq '1'
        ) {
            break
        }
        $sleepMs = [Math]::Min(2000, (Get-RemainingProbeTimeout $deadline 2000))
        if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
    } while ($true)

    $probeTimeout = Get-RemainingProbeTimeout $deadline 5000
    if ($probeTimeout -le 0) {
        throw "Timed out verifying the Android API level for $Serial."
    }
    $apiResult = Invoke-AdbBounded `
        -Arguments @('-s', $Serial, 'shell', 'getprop', 'ro.build.version.sdk') `
        -TimeoutMs $probeTimeout
    if (
        [DateTime]::UtcNow -ge $deadline -or
        $apiResult.TimedOut -or
        $apiResult.ExitCode -ne 0 -or
        $apiResult.StdOut.Trim() -notmatch '^[0-9]+$'
    ) {
        throw "Could not verify the Android API level for $Serial."
    }
    $api = [int]$apiResult.StdOut.Trim()
    if ($api -ne $ExpectedApi) { throw "$Serial is API $api; expected API $ExpectedApi." }
}

function Assert-EmulatedCameraAvailable {
    param([string]$Serial, [int]$ExpectedApi)

    if ($ExpectedApi -le 29) {
        # Current emulator hosts can publish qemu.sf.fake_camera just after the
        # API 29 legacy provider's 500 ms startup deadline. Restarting that
        # provider once the boot property is present makes the cold gate
        # deterministic; newer internal-camera providers do not have the race.
        $rootResult = Invoke-AdbBounded `
            -Arguments @('-s', $Serial, 'root') `
            -TimeoutMs 15000
        if ($rootResult.TimedOut -or $rootResult.ExitCode -ne 0) {
            throw (
                "Could not restart adbd as root for the API $ExpectedApi camera gate: " +
                "$($rootResult.StdOut)$($rootResult.StdErr)"
            )
        }
        $reconnectDeadline = [DateTime]::UtcNow.AddSeconds(30)
        $lastObservation = 'adb did not report a device state after root'
        do {
            $probeTimeout = Get-RemainingProbeTimeout $reconnectDeadline
            if ($probeTimeout -le 0) {
                throw (
                    "Device $Serial did not reconnect after enabling the API " +
                    "$ExpectedApi camera gate ($lastObservation)."
                )
            }
            $stateResult = Invoke-AdbBounded `
                -Arguments @('-s', $Serial, 'get-state') `
                -TimeoutMs $probeTimeout
            $lastObservation = if ($stateResult.TimedOut) {
                'adb get-state timed out'
            } elseif ($stateResult.ExitCode -ne 0) {
                "adb get-state exited $($stateResult.ExitCode): $($stateResult.StdErr.Trim())"
            } else {
                "adb get-state returned $($stateResult.StdOut.Trim())"
            }
            if ([DateTime]::UtcNow -ge $reconnectDeadline) {
                throw (
                    "Device $Serial did not reconnect after enabling the API " +
                    "$ExpectedApi camera gate ($lastObservation)."
                )
            }
            if (
                -not $stateResult.TimedOut -and
                $stateResult.ExitCode -eq 0 -and
                $stateResult.StdOut.Trim() -ceq 'device'
            ) {
                break
            }
            $sleepMs = [Math]::Min(
                1000,
                (Get-RemainingProbeTimeout $reconnectDeadline 1000)
            )
            if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
        } while ($true)
        $fakeCameraResult = Invoke-AdbBounded `
            -Arguments @('-s', $Serial, 'shell', 'getprop', 'qemu.sf.fake_camera') `
            -TimeoutMs 5000
        if (
            $fakeCameraResult.TimedOut -or
            $fakeCameraResult.ExitCode -ne 0 -or
            $fakeCameraResult.StdOut.Trim() -cne 'back'
        ) {
            throw "API $ExpectedApi AVD did not publish qemu.sf.fake_camera=back."
        }
        $restartResult = Invoke-AdbBounded `
            -Arguments @(
                '-s', $Serial, 'shell', 'setprop',
                'ctl.restart', 'vendor.camera-provider-2-4'
            ) `
            -TimeoutMs 5000
        if ($restartResult.TimedOut -or $restartResult.ExitCode -ne 0) {
            throw "Could not restart the API $ExpectedApi legacy camera provider."
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $lastObservation = 'camera service was not observable'
    do {
        $probeTimeout = Get-RemainingProbeTimeout $deadline 5000
        if ($probeTimeout -le 0) {
            throw "API $ExpectedApi AVD did not expose an emulated camera ($lastObservation)."
        }
        $cameraResult = Invoke-AdbBounded `
            -Arguments @('-s', $Serial, 'shell', 'dumpsys', 'media.camera') `
            -TimeoutMs $probeTimeout
        $lastObservation = if ($cameraResult.TimedOut) {
            'camera service probe timed out'
        } elseif ($cameraResult.ExitCode -ne 0) {
            "camera service probe exited $($cameraResult.ExitCode): $($cameraResult.StdErr.Trim())"
        } else {
            'camera service reported no emulated devices'
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "API $ExpectedApi AVD did not expose an emulated camera ($lastObservation)."
        }
        if (
            -not $cameraResult.TimedOut -and
            $cameraResult.ExitCode -eq 0 -and
            $cameraResult.StdOut -match '(?m)^Number of camera devices:\s+([1-9][0-9]*)\s*$'
        ) {
            return
        }
        $sleepMs = [Math]::Min(1000, (Get-RemainingProbeTimeout $deadline 1000))
        if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
    } while ($true)
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
        if ($Full) {
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:qr-scanner')
        }
        Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:smoke')
        Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:stabilization')
        if ($Full) {
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:parity')
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:theme-effects')
            Invoke-Checked 'pnpm' @('--dir', 'mobile', 'e2e:handoff-surfaces')
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
    $devicesResult = Invoke-AdbBounded -Arguments @('devices') -TimeoutMs 5000
    if ($devicesResult.TimedOut -or $devicesResult.ExitCode -ne 0) {
        throw "Could not inspect attached Android devices before starting $serial."
    }
    if ($devicesResult.StdOut -match "(?m)^$([regex]::Escape($serial))\s") {
        throw "$serial is already in use. Stop it before running the RC gate."
    }

    $stdout = Join-Path $env:TEMP "ezterminal-$serial.out.log"
    $stderr = Join-Path $env:TEMP "ezterminal-$serial.err.log"
    $emulatorArguments = @(
        '-avd', $Avd, '-port', $Port, '-no-window', '-no-audio',
        '-no-boot-anim', '-no-snapshot-load', '-no-snapshot-save',
        '-camera-back', 'emulated'
    )
    if ($Api -le 29) {
        $emulatorArguments += @(
            '-legacy-fake-camera',
            '-prop', 'qemu.sf.fake_camera=back'
        )
    }
    $emulatorArguments += @('-gpu', 'swiftshader_indirect')
    $process = Start-Process -FilePath $emulator -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
        -ArgumentList $emulatorArguments
    try {
        Wait-ForAndroidBoot $serial $Api $process
        Assert-EmulatedCameraAvailable $serial $Api
        Invoke-Instrumentation $serial
        Invoke-MobileE2e $serial -Full
        if ($Soak) {
            $previousSoakEnvironment = [ordered]@{
                EZTERMINAL_SOAK_DURATION_MS = $env:EZTERMINAL_SOAK_DURATION_MS
                EZTERMINAL_SOAK_QUIESCENCE_MS = $env:EZTERMINAL_SOAK_QUIESCENCE_MS
                EZTERMINAL_SOAK_REPORT_PATH = $env:EZTERMINAL_SOAK_REPORT_PATH
            }
            try {
                $env:EZTERMINAL_SOAK_DURATION_MS = '1800000'
                $env:EZTERMINAL_SOAK_QUIESCENCE_MS = '15000'
                $env:EZTERMINAL_SOAK_REPORT_PATH = $script:soakReportPath
                Invoke-MobileE2e $serial -Soak
            } finally {
                foreach ($name in $previousSoakEnvironment.Keys) {
                    [Environment]::SetEnvironmentVariable(
                        $name,
                        $previousSoakEnvironment[$name],
                        'Process'
                    )
                }
            }
        }
        $results.Add([ordered]@{
            device = $serial
            api = $Api
            avd = $Avd
            status = 'passed'
            lanes = @(
                'instrumentation',
                'qr-scanner',
                'smoke',
                'stabilization',
                'parity',
                'theme-effects',
                'handoff-surfaces'
            )
        })
    } finally {
        try {
            $killResult = Invoke-AdbBounded `
                -Arguments @('-s', $serial, 'emu', 'kill') `
                -TimeoutMs 5000
            if ($killResult.TimedOut -or $killResult.ExitCode -ne 0) {
                throw "adb could not stop $serial."
            }
        } catch {
            try {
                if (-not $process.HasExited) { $process.Kill() }
            } catch [InvalidOperationException] {
                # The emulator exited between HasExited and Kill.
            }
        }
        if (-not $process.WaitForExit(30000)) {
            try {
                if (-not $process.HasExited) { $process.Kill() }
            } catch [InvalidOperationException] {
                # The emulator exited between HasExited and Kill.
            }
            if (-not $process.WaitForExit(30000)) {
                throw "Emulator process $($process.Id) for $serial did not exit after forced teardown."
            }
        }
        $deviceDeadline = [DateTime]::UtcNow.AddSeconds(30)
        $lastObservation = 'adb devices was not observable'
        do {
            $probeTimeout = Get-RemainingProbeTimeout $deviceDeadline
            if ($probeTimeout -le 0) {
                throw "$serial teardown could not be verified ($lastObservation)."
            }
            $devicesResult = Invoke-AdbBounded -Arguments @('devices') -TimeoutMs $probeTimeout
            $lastObservation = if ($devicesResult.TimedOut) {
                'adb devices timed out'
            } elseif ($devicesResult.ExitCode -ne 0) {
                "adb devices exited $($devicesResult.ExitCode): $($devicesResult.StdErr.Trim())"
            } else {
                'adb still reported the emulator'
            }
            if ([DateTime]::UtcNow -ge $deviceDeadline) {
                throw "$serial teardown could not be verified ($lastObservation)."
            }
            if (
                -not $devicesResult.TimedOut -and
                $devicesResult.ExitCode -eq 0 -and
                $devicesResult.StdOut -notmatch "(?m)^$([regex]::Escape($serial))\s"
            ) {
                break
            }
            $sleepMs = [Math]::Min(1000, (Get-RemainingProbeTimeout $deviceDeadline 1000))
            if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }
        } while ($true)
    }
}

if (-not (Test-Path -LiteralPath $adb) -or -not (Test-Path -LiteralPath $emulator)) {
    throw "Android SDK platform-tools and emulator are required below $androidHome."
}
Push-Location $repoRoot
try {
    $sha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not resolve the exact 40-character candidate SHA.'
    }
    Assert-FrozenGitTree 'before validation' $sha
    $versionContract = Get-Content release/version.json -Raw | ConvertFrom-Json
    $version = [string]$versionContract.version
    $packageVersion = [string](Get-Content package.json -Raw | ConvertFrom-Json).version
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $packageVersion -cne $version) {
        throw 'The candidate version contract is invalid or differs from package.json.'
    }
    $expectedNodeVersion = (Get-Content .nvmrc -Raw).Trim().TrimStart('v')
    $actualNodeVersion = (& node -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or $actualNodeVersion -cne $expectedNodeVersion) {
        throw "Release validation requires Node $expectedNodeVersion; current Node is $actualNodeVersion."
    }
    $env:EZTERMINAL_PLAYWRIGHT_RETRIES = '0'
    $env:EZTERMINAL_BUILD_SHA = $sha
    $env:VITE_BUILD_SHA = $sha
    $env:ANDROID_HOME = $androidHome
    $env:ANDROID_SDK_ROOT = $androidHome

    $reportStage = if ($RunPerformanceMeasurement) { 'release' } else { 'candidate' }
    $sha8 = $sha.Substring(0, 8)
    $reportDirectory = Join-Path $repoRoot (
        "release-assets\.evidence-$version-$sha8-$reportStage"
    )
    $releaseAssetsRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'release-assets'))
    $resolvedReportDirectory = [IO.Path]::GetFullPath($reportDirectory)
    $releaseAssetsPrefix = (
        $releaseAssetsRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) +
        [IO.Path]::DirectorySeparatorChar
    )
    if (-not $resolvedReportDirectory.StartsWith(
        $releaseAssetsPrefix,
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Candidate evidence path escaped release-assets: $resolvedReportDirectory"
    }
    if (
        (Test-Path -LiteralPath $releaseAssetsRoot) -and
        ((Get-Item -LiteralPath $releaseAssetsRoot -Force).Attributes -band
            [IO.FileAttributes]::ReparsePoint)
    ) {
        throw "Candidate evidence root must not be a reparse point: $releaseAssetsRoot"
    }
    if (Test-Path -LiteralPath $resolvedReportDirectory) {
        $existingReportDirectory = Get-Item -LiteralPath $resolvedReportDirectory -Force
        if (
            -not $existingReportDirectory.PSIsContainer -or
            ($existingReportDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint)
        ) {
            throw "Candidate evidence directory must not be a reparse point: $resolvedReportDirectory"
        }
        $unsafeEvidenceChildren = @(
            Get-ChildItem -LiteralPath $resolvedReportDirectory -Force |
                Where-Object {
                    $_.PSIsContainer -or
                    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
                }
        )
        if ($unsafeEvidenceChildren.Count -ne 0) {
            throw "Candidate evidence directory contains unsafe nested or linked entries: $resolvedReportDirectory"
        }
        Remove-Item -LiteralPath $resolvedReportDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $script:soakReportPath = Join-Path $reportDirectory 'mobile-soak-report.json'
    $performanceReport = $null
    $performanceComparison = $null
    $normalizedPerformanceBaselineBuildSha = $null
    $performanceBaselineHash = $null
    $performanceReportHash = $null
    $performanceBaselineEvidencePath = $null
    $performanceReportPath = $null
    $evidenceBundlePath = $null
    if ($RunPerformanceMeasurement) {
        $baselineSourcePath = (
            Resolve-Path -LiteralPath $PerformanceBaselinePath
        ).Path
        $baselineSource = Get-Item -LiteralPath $baselineSourcePath -Force
        if (
            $baselineSource.PSIsContainer -or
            ($baselineSource.Attributes -band [IO.FileAttributes]::ReparsePoint)
        ) {
            throw "Performance baseline must be a normal file: $baselineSourcePath"
        }
        if ($baselineSource.Length -lt 1 -or $baselineSource.Length -gt 16777216) {
            throw (
                'Performance baseline must be between 1 and 16777216 bytes: ' +
                $baselineSourcePath
            )
        }
        $performanceBaselineEvidencePath = Join-Path (
            $reportDirectory
        ) 'desktop-performance-baseline.json'
        [IO.File]::WriteAllBytes(
            $performanceBaselineEvidencePath,
            [IO.File]::ReadAllBytes($baselineSourcePath)
        )
        $normalizedPerformanceBaselineBuildSha = (
            $PerformanceBaselineBuildSha.ToLowerInvariant()
        )
        $performanceBaselineHash = (
            Get-FileHash -LiteralPath $performanceBaselineEvidencePath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        $performanceBaseline = Get-Content `
            -LiteralPath $performanceBaselineEvidencePath -Raw |
            ConvertFrom-Json
        if (
            [int]$performanceBaseline.schemaVersion -ne 2 -or
            [string]$performanceBaseline.evidenceMode -cne 'release' -or
            [string]$performanceBaseline.buildSha -cne
                $normalizedPerformanceBaselineBuildSha -or
            [string]$performanceBaseline.provenance.product.buildSha -cne
                $normalizedPerformanceBaselineBuildSha -or
            [string]$performanceBaseline.provenance.product.source.gitHeadSha -cne
                $normalizedPerformanceBaselineBuildSha -or
            [string]$performanceBaseline.provenance.harness.runner.node -cne
                $actualNodeVersion -or
            [string]$performanceBaseline.environment.hostFingerprint.algorithm -cne
                'windows-machine-guid-sha256-v1' -or
            [string]$performanceBaseline.environment.hostFingerprint.sha256 -cnotmatch
                '^[0-9a-f]{64}$' -or
            [string]$performanceBaseline.environment.powerPlan.schemeGuid -cnotmatch
                '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
            [string]$performanceBaseline.environment.powerPlan.powerSource -cnotmatch
                '^(ac|dc)$' -or
            [string]$performanceBaseline.environment.powerPlan.effectivePowerMode -cnotmatch
                '^(battery-saver|better-battery|balanced|high-performance|max-performance)$' -or
            [string]$performanceBaseline.environment.powerPlan.baseSettingsSha256 -cnotmatch
                '^[0-9a-f]{64}$' -or
            [string]$performanceBaseline.environment.powerPlan.effectiveSettingsSha256 -cnotmatch
                '^[0-9a-f]{64}$'
        ) {
            throw (
                'The baseline report is not same-host/power-plan schema-v2 ' +
                'evidence for this Node toolchain and -PerformanceBaselineBuildSha.'
            )
        }
        $performanceReportPath = Join-Path (
            $reportDirectory
        ) 'desktop-performance-report.json'
        $env:EZTERMINAL_PERFORMANCE_REPORT_PATH = $performanceReportPath
    }

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
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'lint')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'typecheck')
    1..3 | ForEach-Object {
        Write-Host "Mobile unit stability run $_/3"
        Invoke-Checked 'pnpm' @('--dir', 'mobile', 'test')
    }
    Invoke-Checked 'pnpm' @('test:storybook')
    Invoke-Checked 'pnpm' @('storybook:build')
    Invoke-Checked 'pnpm' @('test:visual')
    Invoke-Checked 'cargo' @('fmt', '--all', '--', '--check') (
        Join-Path $repoRoot 'native\remote-host'
    )
    Invoke-Checked 'cargo' @('test', '--locked', '--all-targets') (
        Join-Path $repoRoot 'native\remote-host'
    )
    Invoke-Checked 'cargo' @('clippy', '--locked', '--all-targets', '--', '-D', 'warnings') (
        Join-Path $repoRoot 'native\remote-host'
    )
    Invoke-Checked 'cargo' @('audit', '--deny', 'warnings') (
        Join-Path $repoRoot 'native\remote-host'
    )
    Invoke-Checked 'cargo' @('deny', 'check') (
        Join-Path $repoRoot 'native\remote-host'
    )
    Invoke-Checked 'pnpm' @('build:remote-host')
    # Force an exact-SHA Vite build before Playwright. Its ordinary global
    # setup may reuse mtime-fresh local artifacts, which is valid for
    # development but not for release evidence.
    Invoke-Checked 'pnpm' @('package')
    Assert-EmbeddedBuildSha $sha
    Invoke-Checked 'pnpm' @('e2e')
    Invoke-Checked 'pnpm' @('make')
    Invoke-Checked 'pnpm' @('guard:native')
    Invoke-Checked 'pnpm' @('guard:native-cap')
    Invoke-Checked 'pnpm' @('guard:pty-routing')
    Invoke-Checked 'pnpm' @('guard:approval-privacy')
    Invoke-Checked 'pnpm' @('guard:pairing-offline')
    Invoke-Checked 'pnpm' @('guard:desktop-handoff')
    Invoke-Checked 'pnpm' @('test:e2e:packaged')
    if ($RunPerformanceMeasurement) {
        Invoke-Checked 'pnpm' @('e2e:performance')
        if (-not (Test-Path -LiteralPath $performanceReportPath)) {
            throw 'The desktop E2E gate did not produce desktop-performance-report.json.'
        }
        $performanceReportBytes = [IO.File]::ReadAllBytes($performanceReportPath)
        $performanceReportHash = (
            Get-FileHash -LiteralPath $performanceReportPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        $performanceReport = (
            [Text.Encoding]::UTF8.GetString($performanceReportBytes)
        ).TrimStart([char]0xFEFF) | ConvertFrom-Json
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
            throw (
                'The desktop performance report is not schema-v2 exact-SHA ' +
                'evidence using the approved ordered 5/25 protocol.'
            )
        }
        Assert-CandidatePerformanceProvenance $performanceReport $sha $version
        $performanceComparisonJson = & node scripts/verify-performance-report.mjs `
            --baseline $performanceBaselineEvidencePath `
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
        Assert-FrozenGitTree 'after desktop performance measurement' $sha
    } else {
        Write-Host (
            'Desktop performance remains pending: this local candidate was ' +
            'not authorized to run a performance measurement.'
        )
    }

    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'build:e2e')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'cap:sync')
    Invoke-Checked (Join-Path $repoRoot 'mobile\android\gradlew.bat') `
        @(
            'lintDebug',
            'lintRelease',
            'testDebugUnitTest',
            'testReleaseUnitTest',
            'assembleDebug',
            'assembleDebugAndroidTest',
            '--no-daemon',
            '--stacktrace'
        ) `
        (Join-Path $repoRoot 'mobile\android')

    Invoke-AvdGate $Api29Avd 29 5556
    Invoke-AvdGate $Api35Avd 35 5558 -Soak

    $soakReportPath = $script:soakReportPath
    if (-not (Test-Path -LiteralPath $soakReportPath)) {
        throw 'The API 35 emulator soak did not produce mobile-soak-report.json.'
    }
    $soakReportBytes = [IO.File]::ReadAllBytes($soakReportPath)
    $soak = (
        [Text.Encoding]::UTF8.GetString($soakReportBytes)
    ).TrimStart([char]0xFEFF) | ConvertFrom-Json
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
    $soakReportHash = (
        Get-FileHash -LiteralPath $soakReportPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()

    # Restore the exact production web assets after the E2E-only APK gate.
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'build:release')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'cap:sync')
    $androidStatus = @(git status --porcelain --untracked-files=all -- mobile/android)
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not inspect the restored production Android source.'
    }
    if ($androidStatus.Count -ne 0) {
        $androidStatus | ForEach-Object { Write-Host $_ }
        throw 'Production Capacitor sync changed Android source. Commit generated updates before release.'
    }
    Assert-FrozenGitTree 'after all candidate validation' $sha

    $reportPath = Join-Path $reportDirectory 'local-rc-report.json'
    $desktopPerformanceEvidence = if ($RunPerformanceMeasurement) {
        [ordered]@{
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
    } else {
        [ordered]@{
            status = 'pending-final-release-measurement'
            reason = 'not-requested-for-this-local-rc'
        }
    }
    $localRcReport = [ordered]@{
        schemaVersion = 2
        releaseStage = $reportStage
        evidenceCompleteness = if ($RunPerformanceMeasurement) {
            'complete'
        } else {
            'functional-complete-performance-pending'
        }
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
            'Lock and UAC secure-desktop capture and input are not supported.',
            'Software SAS and Ctrl+Alt+Delete are not supported.',
            'GDI capture, OpenH264 encoding and SendInput injection remain in the normal-user transport.'
        )
        playwrightRetries = 0
        mobileConnectionAttemptsPerScenario = 1
        mobileSocketAttemptsBeforeInitialAuth = 1
        mobileTransport = 'adb-reverse-loopback'
        mobileRemotePort = 17420
        emulatorBootMode = 'cold-no-snapshot'
        functionalLanes = @(
            'version-contract',
            'desktop-typecheck-lint-unit-x3-os',
            'mobile-typecheck-lint-unit-x3',
            'dependency-audit',
            'storybook-interaction-build-visual-axe',
            'rust-fmt-test-clippy-audit-deny',
            'desktop-e2e',
            'windows-make-and-packaged-smoke',
            'native-pty-and-handoff-security-guards',
            'android-api29-api35-instrumentation-and-handoff',
            'android-api29-api35-qr-scanner-camera-preview',
            'android-api35-functional-soak',
            'mobile-production-marker-gate'
        )
        desktopPerformance = $desktopPerformanceEvidence
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
    }
    $localRcReport | ConvertTo-Json -Depth 12 |
        Set-Content -LiteralPath $reportPath -Encoding utf8
    $reportHash = (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $sourceEvidenceArguments = @(
        'scripts/verify-release-source-evidence.mjs',
        '--report', $reportPath,
        '--mobile-soak', $soakReportPath,
        '--expected-version', $version,
        '--expected-build-sha', $sha,
        '--expected-stage', $reportStage
    )
    if ($RunPerformanceMeasurement) {
        $sourceEvidenceArguments += @(
            '--performance-baseline', $performanceBaselineEvidencePath,
            '--performance-candidate', $performanceReportPath
        )
    }
    $sourceEvidenceJson = & node @sourceEvidenceArguments | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Host $sourceEvidenceJson
        throw 'The local RC source evidence is not self-consistent.'
    }
    $sourceEvidence = $sourceEvidenceJson | ConvertFrom-Json
    if ($sourceEvidence.ok -ne $true) {
        throw 'The local RC source-evidence validator did not report success.'
    }

    $evidenceBundleHash = $null
    if ($RunPerformanceMeasurement) {
        $evidenceBundlePath = Join-Path $reportDirectory 'local-rc-evidence.zip'
        $bundleJson = & (Join-Path $PSScriptRoot 'release-evidence-bundle.ps1') `
            -Create `
            -BundlePath $evidenceBundlePath `
            -SourcePaths @(
                $reportPath,
                $soakReportPath,
                $performanceBaselineEvidencePath,
                $performanceReportPath
            ) `
            -EntryNames @(
                'local-rc-report.json',
                'mobile-soak-report.json',
                'desktop-performance-baseline.json',
                'desktop-performance-report.json'
            ) | Out-String
        $bundle = $bundleJson | ConvertFrom-Json
        if (
            [string]$bundle.operation -cne 'create' -or
            [string]$bundle.bundleSha256 -cnotmatch '^[0-9a-f]{64}$' -or
            [int]$bundle.base64Length -gt 30000
        ) {
            throw 'The approved local RC evidence bundle is invalid or too large.'
        }
        $evidenceBundleHash = [string]$bundle.bundleSha256
        $bundleVerificationDirectory = Join-Path (
            $reportDirectory
        ) '.bundle-verification'
        try {
            $roundTripJson = & (
                Join-Path $PSScriptRoot 'release-evidence-bundle.ps1'
            ) `
                -Extract `
                -BundlePath $evidenceBundlePath `
                -DestinationDirectory $bundleVerificationDirectory `
                -ExpectedEntryNames @(
                    'local-rc-report.json',
                    'mobile-soak-report.json',
                    'desktop-performance-baseline.json',
                    'desktop-performance-report.json'
                ) | Out-String
            $roundTrip = $roundTripJson | ConvertFrom-Json
            if (
                [string]$roundTrip.operation -cne 'extract' -or
                [string]$roundTrip.bundleSha256 -cne $evidenceBundleHash -or
                @($roundTrip.files).Count -ne 4
            ) {
                throw 'The local RC evidence bundle failed its extraction round trip.'
            }
            $roundTripReportPath = Join-Path (
                $bundleVerificationDirectory
            ) 'local-rc-report.json'
            $roundTripReportHash = (
                Get-FileHash -LiteralPath $roundTripReportPath -Algorithm SHA256
            ).Hash.ToLowerInvariant()
            if ($roundTripReportHash -cne $reportHash) {
                throw 'The approval bundle does not contain the approved local RC report.'
            }
            $roundTripEvidenceJson = & node `
                scripts/verify-release-source-evidence.mjs `
                --report $roundTripReportPath `
                --mobile-soak (
                    Join-Path $bundleVerificationDirectory 'mobile-soak-report.json'
                ) `
                --performance-baseline (
                    Join-Path (
                        $bundleVerificationDirectory
                    ) 'desktop-performance-baseline.json'
                ) `
                --performance-candidate (
                    Join-Path (
                        $bundleVerificationDirectory
                    ) 'desktop-performance-report.json'
                ) `
                --expected-version $version `
                --expected-build-sha $sha `
                --expected-stage release | Out-String
            if ($LASTEXITCODE -ne 0) {
                Write-Host $roundTripEvidenceJson
                throw 'The approval bundle source evidence failed round-trip validation.'
            }
            $roundTripEvidence = $roundTripEvidenceJson | ConvertFrom-Json
            if (
                $roundTripEvidence.ok -ne $true -or
                [string]$roundTripEvidence.reportSha256 -cne $reportHash
            ) {
                throw 'The approval bundle round trip did not preserve verified evidence.'
            }
        } finally {
            if (Test-Path -LiteralPath $bundleVerificationDirectory) {
                $resolvedBundleVerification = [IO.Path]::GetFullPath(
                    $bundleVerificationDirectory
                )
                $expectedBundleVerification = [IO.Path]::GetFullPath(
                    (Join-Path $reportDirectory '.bundle-verification')
                )
                if ($resolvedBundleVerification -cne $expectedBundleVerification) {
                    throw (
                        'Refusing to clean an unexpected bundle-verification path: ' +
                        $resolvedBundleVerification
                    )
                }
                Remove-Item `
                    -LiteralPath $resolvedBundleVerification `
                    -Recurse `
                    -Force
            }
        }
    }
    Assert-FrozenGitTree 'after source-evidence finalization' $sha

    Write-Host "Local RC gate passed for EZTerminal $version at $sha."
    Write-Host "RC report: $reportPath"
    Write-Host "RC report SHA-256: $reportHash"
    if ($RunPerformanceMeasurement) {
        Write-Host 'After reviewing the final report, publish its approval to the protected GitHub Environment:'
        Write-Host "gh variable set EZTERMINAL_LOCAL_RC_APPROVED_SHA --env release --body `"$sha`""
        Write-Host "gh variable set EZTERMINAL_LOCAL_RC_REPORT_SHA256 --env release --body `"$reportHash`""
        Write-Host "gh variable set EZTERMINAL_LOCAL_RC_EVIDENCE_SHA256 --env release --body `"$evidenceBundleHash`""
        Write-Host (
            "[Convert]::ToBase64String([IO.File]::ReadAllBytes(" +
            "`"$evidenceBundlePath`")) | gh secret set " +
            'EZTERMINAL_LOCAL_RC_EVIDENCE_BASE64 --env release'
        )
    } else {
        Write-Host 'Candidate is publication-ineligible until an explicitly requested performance measurement passes.'
    }
} finally {
    Pop-Location
}
