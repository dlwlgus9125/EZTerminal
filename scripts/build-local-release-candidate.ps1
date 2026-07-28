[CmdletBinding()]
param(
    [string]$Api29Avd = 'EZTerminalApi29',
    [string]$Api35Avd = 'EZTerminalApi35',
    [string]$KeystorePath = '.release-secrets/android-release.jks',
    [string]$EncryptedPasswordPath = '.release-secrets/android-release-password.dpapi.key',
    [string]$KeyAlias = 'ezterminal-release'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'invoke-ephemeral-signing-process.ps1')

function Resolve-RepoFile {
    param([string]$Path, [string]$Label)
    $candidate = if ([IO.Path]::IsPathRooted($Path)) {
        $Path
    } else {
        Join-Path $repoRoot $Path
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Label is missing: $candidate"
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Get-ExactGitHead {
    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not resolve the exact 40-character candidate SHA.'
    }
    return $head
}

function Assert-FrozenCandidate {
    param([string]$ExpectedSha, [string]$Phase)

    $currentHead = Get-ExactGitHead
    if ($currentHead -cne $ExpectedSha) {
        throw "Candidate HEAD changed from $ExpectedSha to $currentHead ($Phase)."
    }
    $dirty = @(git status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the candidate worktree ($Phase)."
    }
    if ($dirty.Count -ne 0) {
        $dirty | ForEach-Object { Write-Host $_ }
        throw "The candidate worktree is not clean ($Phase)."
    }
}

function Invoke-SignedAndroidReleaseBuild {
    param(
        [string]$Keystore,
        [string]$Password,
        [string]$Alias
    )

    $androidDirectory = Join-Path $repoRoot 'mobile\android'
    $gradleWrapper = Join-Path $androidDirectory 'gradlew.bat'
    if (-not (Test-Path -LiteralPath $gradleWrapper -PathType Leaf)) {
        throw "Android Gradle wrapper is missing: $gradleWrapper"
    }
    $childPowerShell = (Get-Process -Id $PID).Path
    if (-not (Test-Path -LiteralPath $childPowerShell -PathType Leaf)) {
        throw "Windows PowerShell executable is missing: $childPowerShell"
    }

    $signingChild = Join-Path (
        $PSScriptRoot
    ) 'invoke-android-gradle-signing-child.ps1'
    if (-not (Test-Path -LiteralPath $signingChild -PathType Leaf)) {
        throw "Android signing child script is missing: $signingChild"
    }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $childPowerShell
    $startInfo.Arguments = (
        '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
        "-File `"$signingChild`" " +
        "-GradleWrapper `"$gradleWrapper`""
    )
    $startInfo.WorkingDirectory = $androidDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $diagnosticLogPath = Join-Path (
        [IO.Path]::GetTempPath()
    ) (
        'ezterminal-android-signing-' +
        [Guid]::NewGuid().ToString('N') +
        '.log'
    )
    $ephemeralEnvironment = [ordered]@{
        ANDROID_KEYSTORE_PATH = $Keystore
        ANDROID_KEYSTORE_PASSWORD = $Password
        ANDROID_KEY_ALIAS = $Alias
        ANDROID_KEY_PASSWORD = $Password
    }
    try {
        Invoke-EphemeralSigningProcess `
            -StartInfo $startInfo `
            -EphemeralEnvironment $ephemeralEnvironment `
            -TimeoutMilliseconds 3600000 `
            -DiagnosticLogPath $diagnosticLogPath `
            -MaxDiagnosticBytes 262144
    } finally {
        try {
            if (Test-Path -LiteralPath $diagnosticLogPath) {
                $diagnosticItem = Get-Item -LiteralPath (
                    $diagnosticLogPath
                ) -Force
                if (-not $diagnosticItem.PSIsContainer) {
                    Remove-Item -LiteralPath $diagnosticLogPath -Force
                }
            }
        } finally {
            foreach ($name in @($ephemeralEnvironment.Keys)) {
                $ephemeralEnvironment[$name] = $null
            }
            $ephemeralEnvironment.Clear()
            $Password = $null
        }
    }
}

Push-Location $repoRoot
try {
    $sha = Get-ExactGitHead
    Assert-FrozenCandidate $sha 'before candidate validation'
    $contract = Get-Content -LiteralPath 'release/version.json' -Raw | ConvertFrom-Json
    $version = [string]$contract.version
    if (
        [int]$contract.schemaVersion -ne 1 -or
        $version -notmatch '^\d+\.\d+\.\d+$' -or
        [string]$contract.validationProfile -cne 'full'
    ) {
        throw 'The local signed candidate wrapper requires a valid full release contract.'
    }
    $sha8 = $sha.Substring(0, 8)

    & (Join-Path $PSScriptRoot 'verify-release-candidate.ps1') `
        -Api29Avd $Api29Avd `
        -Api35Avd $Api35Avd
    if ($LASTEXITCODE -ne 0) {
        throw 'Non-performance release-candidate validation failed.'
    }
    Assert-FrozenCandidate $sha 'after candidate validation and before signing'

    $evidenceDirectory = Join-Path $repoRoot (
        "release-assets\.evidence-$version-$sha8-candidate"
    )
    $reportPath = Join-Path $evidenceDirectory 'local-rc-report.json'
    $soakReportPath = Join-Path $evidenceDirectory 'mobile-soak-report.json'
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
        throw "Candidate validation did not produce $reportPath."
    }
    if (-not (Test-Path -LiteralPath $soakReportPath -PathType Leaf)) {
        throw "Candidate validation did not produce $soakReportPath."
    }
    $reportHash = (
        Get-FileHash -LiteralPath $reportPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()

    $resolvedKeystore = Resolve-RepoFile $KeystorePath 'Android release keystore'
    $resolvedPassword = Resolve-RepoFile $EncryptedPasswordPath 'DPAPI password'
    $encryptedPassword = Get-Content -LiteralPath $resolvedPassword -Raw
    try {
        $securePassword = ConvertTo-SecureString $encryptedPassword
        $credential = [PSCredential]::new('ezterminal-release', $securePassword)
        $plainPassword = $credential.GetNetworkCredential().Password
    } catch {
        throw (
            'The Android password could not be decrypted for this Windows user. ' +
            'Do not generate a replacement release key.'
        )
    }
    if ([string]::IsNullOrWhiteSpace($plainPassword)) {
        throw 'The decrypted Android release password is empty.'
    }

    $signingCert = (
        (Get-Content -LiteralPath 'mobile/android/signing-certificate.sha256' -Raw) `
            -replace '[^0-9A-Fa-f]', ''
    ).ToUpperInvariant()
    if ($signingCert -notmatch '^[0-9A-F]{64}$') {
        throw 'The committed Android signing certificate fingerprint is invalid.'
    }

    try {
        Invoke-SignedAndroidReleaseBuild `
            -Keystore $resolvedKeystore `
            -Password $plainPassword `
            -Alias $KeyAlias
    } finally {
        $plainPassword = $null
        $credential = $null
        $securePassword = $null
        $encryptedPassword = $null
    }
    Assert-FrozenCandidate $sha 'after signed Android assembly'

    & (Join-Path $PSScriptRoot 'stage-release-artifacts.ps1') `
        -AndroidApkPath 'mobile/android/app/build/outputs/apk/release/app-release.apk' `
        -AndroidMetadataPath 'mobile/android/app/build/outputs/apk/release/output-metadata.json' `
        -AndroidCertSha256 $signingCert `
        -LocalRcReportSha256 $reportHash `
        -LocalRcReportPath $reportPath `
        -MobileSoakReportPath $soakReportPath `
        -ExpectedCommit $sha `
        -ExpectedWindowsSignature NotSigned `
        -ArtifactStage candidate `
        -RequireCleanTree
    if ($LASTEXITCODE -ne 0) {
        throw 'Candidate artifact staging failed.'
    }
    Assert-FrozenCandidate $sha 'after candidate artifact staging'

    $artifactDirectory = Join-Path $repoRoot "release-assets\$version-rc-$sha8"
    $manifestPath = Join-Path $artifactDirectory 'release-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Candidate staging did not produce $manifestPath."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if (
        $manifest.publicationEligible -ne $false -or
        [string]$manifest.artifactStage -cne 'local-release-candidate' -or
        [string]$manifest.evidenceCompleteness -cne
            'functional-complete-performance-pending' -or
        [string]$manifest.validation.performanceBenchmark -cne
            'pending-final-release-measurement' -or
        [string]$manifest.sourceEvidence.mobileSoakReportSha256 -cnotmatch
            '^[0-9a-f]{64}$'
    ) {
        throw 'The staged local candidate is not explicitly publication-ineligible.'
    }
    Write-Host "Local release candidate: $artifactDirectory"
    Write-Host 'publicationEligible=false; desktop performance remains pending.'
} finally {
    Pop-Location
}
