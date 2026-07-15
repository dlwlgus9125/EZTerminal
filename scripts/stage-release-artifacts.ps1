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
    [int]$ProtocolVersion = 1,
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

    $rootVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $mobileVersion = (Get-Content mobile/package.json -Raw | ConvertFrom-Json).version
    $gradle = Get-Content mobile/android/app/build.gradle -Raw
    $gradleVersion = [regex]::Match($gradle, 'versionName\s+"([^"]+)"').Groups[1].Value
    $gradleCode = [int][regex]::Match($gradle, 'versionCode\s+(\d+)').Groups[1].Value
    Assert-Equal $rootVersion $Version 'root package version'
    Assert-Equal $mobileVersion $Version 'mobile package version'
    Assert-Equal $gradleVersion $Version 'Android versionName'
    Assert-Equal $gradleCode $AndroidVersionCode 'Android versionCode'

    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') {
        throw 'Could not resolve the release source commit.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit) -and
        -not $commit.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase) -and
        -not $ExpectedCommit.StartsWith($commit, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release source commit mismatch: expected '$ExpectedCommit', got '$commit'."
    }
    Assert-Equal ([string]$localRcReport.buildSha) $commit 'local RC report buildSha'
    if ($RequireCleanTree) {
        $status = @(git status --porcelain --untracked-files=all)
        if ($status.Count -ne 0) {
            $status | ForEach-Object { Write-Host $_ }
            throw 'Release source contains tracked changes after the build.'
        }
    }

    $appExe = (Resolve-Path -LiteralPath 'out/EZTerminal-win32-x64/EZTerminal.exe').Path
    $appAsar = (Resolve-Path -LiteralPath 'out/EZTerminal-win32-x64/resources/app.asar').Path
    $squirrelRoot = (Resolve-Path -LiteralPath 'out/make/squirrel.windows/x64').Path
    $setupExe = (Resolve-Path -LiteralPath (Join-Path $squirrelRoot 'EZTerminal-Setup.exe')).Path
    $releasesFile = (Resolve-Path -LiteralPath (Join-Path $squirrelRoot 'RELEASES')).Path
    $nupkgFiles = @(Get-ChildItem -LiteralPath $squirrelRoot -File -Filter "*-$Version-full.nupkg")
    if ($nupkgFiles.Count -ne 1) {
        throw "Expected exactly one Squirrel full package for $Version, found $($nupkgFiles.Count)."
    }
    $nupkg = $nupkgFiles[0]

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

    $releaseLine = Get-Content -LiteralPath $releasesFile |
        Where-Object { $_ -match "\s$([regex]::Escape($nupkg.Name))\s" } |
        Select-Object -First 1
    if (-not $releaseLine -or $releaseLine -notmatch '^([0-9A-Fa-f]{40})\s+(\S+)\s+(\d+)$') {
        throw "Squirrel RELEASES does not contain a valid entry for $($nupkg.Name)."
    }
    Assert-Equal $Matches[2] $nupkg.Name 'Squirrel package filename'
    Assert-Equal ([int64]$Matches[3]) $nupkg.Length 'Squirrel package length'
    $actualSha1 = (Get-FileHash -LiteralPath $nupkg.FullName -Algorithm SHA1).Hash
    Assert-Equal $actualSha1 $Matches[1].ToUpperInvariant() 'Squirrel package SHA-1'

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
    Copy-Item -LiteralPath $nupkg.FullName -Destination (Join-Path $assets $nupkg.Name)
    Copy-Item -LiteralPath $releasesFile -Destination (Join-Path $assets 'RELEASES')

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
            $nupkg.Name,
            'RELEASES',
            'local-rc-report.json',
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
