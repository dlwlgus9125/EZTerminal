[CmdletBinding()]
param(
    [string]$Api29Avd = 'EZTerminalApi29',
    [string]$Api35Avd = 'EZTerminalApi35',

    [Parameter(Mandatory = $true)]
    [string]$PhysicalDeviceSerial,

    [Parameter(Mandatory = $true)]
    [switch]$PhysicalChecklistApproved
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
    $env:ANDROID_SERIAL = $Serial
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
    }
}

function Invoke-AvdGate {
    param([string]$Avd, [int]$Api, [int]$Port)
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
            '-no-boot-anim', '-no-snapshot-save', '-gpu', 'swiftshader_indirect'
        )
    try {
        Wait-ForAndroidBoot $serial $Api
        Invoke-Instrumentation $serial
        Invoke-MobileE2e $serial -Full
        $results.Add([ordered]@{ device = $serial; api = $Api; avd = $Avd; status = 'passed' })
    } finally {
        try { Invoke-Adb $serial @('emu', 'kill') | Out-Null } catch { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        $process.WaitForExit(30000) | Out-Null
    }
}

if (-not (Test-Path -LiteralPath $adb) -or -not (Test-Path -LiteralPath $emulator)) {
    throw "Android SDK platform-tools and emulator are required below $androidHome."
}
if (-not $PhysicalChecklistApproved) {
    throw 'The physical Fold checklist must be completed and explicitly approved for an RC gate.'
}

Push-Location $repoRoot
try {
    $dirty = @(git status --porcelain --untracked-files=all)
    if ($dirty.Count -ne 0) {
        $dirty | ForEach-Object { Write-Host $_ }
        throw 'The RC gate must start from a clean, frozen commit.'
    }
    $sha = (& git rev-parse HEAD).Trim()
    $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $env:EZTERMINAL_PLAYWRIGHT_RETRIES = '0'
    $env:EZTERMINAL_BUILD_SHA = $sha
    $env:VITE_BUILD_SHA = $sha
    $env:ANDROID_HOME = $androidHome
    $env:ANDROID_SDK_ROOT = $androidHome

    Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
    Invoke-Checked 'pnpm' @('package')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'build:e2e')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'cap:sync')
    Invoke-Checked (Join-Path $repoRoot 'mobile\android\gradlew.bat') `
        @('assembleDebug', 'assembleDebugAndroidTest', '--no-daemon', '--stacktrace') `
        (Join-Path $repoRoot 'mobile\android')

    Invoke-AvdGate $Api29Avd 29 5556
    Invoke-AvdGate $Api35Avd 35 5558

    if ($PhysicalDeviceSerial -match '^emulator-') {
        throw "PhysicalDeviceSerial must identify real hardware, not Android emulator '$PhysicalDeviceSerial'."
    }
    $physicalKernelQemu = Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.kernel.qemu')
    $physicalBootQemu = Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.boot.qemu')
    if ($physicalKernelQemu -eq '1' -or $physicalBootQemu -eq '1') {
        throw "Physical Fold gate rejected QEMU-backed device '$PhysicalDeviceSerial'."
    }
    $physicalApi = [int](Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.build.version.sdk'))
    if ($physicalApi -lt 29) { throw "Physical device $PhysicalDeviceSerial uses unsupported API $physicalApi." }
    $physicalManufacturer = Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.product.manufacturer')
    $physicalModel = Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.product.model')
    $physicalDevice = Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.product.device')
    $physicalCharacteristics = Invoke-Adb $PhysicalDeviceSerial @('shell', 'getprop', 'ro.build.characteristics')
    $physicalFoldStates = Invoke-Adb $PhysicalDeviceSerial @('shell', 'cmd', 'device_state', 'print-states')
    $physicalFoldStateIds = @(
        [regex]::Matches($physicalFoldStates, 'identifier\s*=\s*(\d+)') |
            ForEach-Object { $_.Groups[1].Value } |
            Sort-Object -Unique
    )
    if ($physicalFoldStateIds.Count -lt 2) {
        throw "Physical Fold gate requires hardware exposing at least two device posture states; '$physicalModel' reported $($physicalFoldStateIds.Count)."
    }
    Invoke-Instrumentation $PhysicalDeviceSerial
    $soakReportPath = Join-Path $repoRoot 'release-assets\mobile-soak-report.json'
    $physicalE2ePort = 17420
    $previousE2eHostUrl = $env:EZTERMINAL_MOBILE_E2E_HOST_URL
    $previousE2ePort = $env:EZTERMINAL_REMOTE_PORT
    $reverseInstalled = $false
    try {
        $env:EZTERMINAL_REMOTE_PORT = [string]$physicalE2ePort
        $env:EZTERMINAL_MOBILE_E2E_HOST_URL = "ws://127.0.0.1:$physicalE2ePort"
        Invoke-Adb $PhysicalDeviceSerial @('reverse', "tcp:$physicalE2ePort", "tcp:$physicalE2ePort") | Write-Host
        $reverseInstalled = $true
        $reverseList = Invoke-Adb $PhysicalDeviceSerial @('reverse', '--list')
        if ($reverseList -notmatch "tcp:$physicalE2ePort\s+tcp:$physicalE2ePort") {
            throw "adb reverse did not expose physical device loopback port $physicalE2ePort."
        }

        $env:EZTERMINAL_SOAK_DURATION_MS = '1800000'
        $env:EZTERMINAL_SOAK_QUIESCENCE_MS = '15000'
        $env:EZTERMINAL_SOAK_REPORT_PATH = $soakReportPath
        Invoke-MobileE2e $PhysicalDeviceSerial -Soak
        if (-not (Test-Path -LiteralPath $soakReportPath)) {
            throw 'The physical Fold soak did not produce mobile-soak-report.json.'
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
            throw 'The physical Fold release soak report does not satisfy the exact-SHA 1.0 gate.'
        }
        $soakReportHash = (Get-FileHash -LiteralPath $soakReportPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } finally {
        try {
            if ($reverseInstalled) {
                Invoke-Adb $PhysicalDeviceSerial @('reverse', '--remove', "tcp:$physicalE2ePort") | Out-Null
            }
        } finally {
            $env:EZTERMINAL_MOBILE_E2E_HOST_URL = $previousE2eHostUrl
            $env:EZTERMINAL_REMOTE_PORT = $previousE2ePort
        }
    }
    $results.Add([ordered]@{
        deviceKind = 'physical-fold'
        api = $physicalApi
        manufacturer = $physicalManufacturer
        model = $physicalModel
        productDevice = $physicalDevice
        buildCharacteristics = $physicalCharacteristics
        foldStateIds = $physicalFoldStateIds
        foldStateEvidence = $physicalFoldStates
        qemu = $false
        manualChecks = @('fold/unfold', 'portrait/landscape', 'display cutout', 'software keyboard', 'Android Back', 'TalkBack')
        manualApproval = [bool]$PhysicalChecklistApproved
        status = 'passed'
    })

    # Restore the exact production web assets after the E2E-only APK gate.
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'build:release')
    Invoke-Checked 'pnpm' @('--dir', 'mobile', 'cap:sync')
    $androidStatus = @(git status --porcelain --untracked-files=all -- mobile/android)
    if ($androidStatus.Count -ne 0) {
        $androidStatus | ForEach-Object { Write-Host $_ }
        throw 'Production Capacitor sync changed Android source. Commit generated updates before release.'
    }

    $reportDirectory = Join-Path $repoRoot 'release-assets'
    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    $reportPath = Join-Path $reportDirectory 'local-rc-report.json'
    [ordered]@{
        schemaVersion = 1
        appVersion = $version
        buildSha = $sha
        completedAtUtc = [DateTime]::UtcNow.ToString('o')
        playwrightRetries = 0
        mobileConnectionAttemptsPerScenario = 1
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
