[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$ExpectedCommit
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot
try {
    function Assert-Source {
        $head = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $head -cne $ExpectedCommit) {
            throw 'Local installer source HEAD changed.'
        }
        $dirty = @(git status --porcelain --untracked-files=all)
        if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
            throw 'Local installers require a clean source tree.'
        }
    }
    Assert-Source
    & node scripts/verify-version-contract.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Version contract verification failed.' }
    $contract = Get-Content -LiteralPath release/version.json -Raw | ConvertFrom-Json
    if ([string]$contract.windowsSigningMode -cne 'unsigned') {
        throw 'The local installer path does not replace the signed release workflow.'
    }
    $version = [string]$contract.version
    $code = [int]$contract.androidVersionCode
    $cert = (Get-Content -LiteralPath mobile/android/signing-certificate.sha256 -Raw).Trim()
    $setup = 'out/make/nsis/x64/EZTerminal-Setup.exe'
    $app = 'out/EZTerminal-win32-x64/EZTerminal.exe'
    $hostExe = 'out/EZTerminal-win32-x64/resources/ezterminal-remote-host.exe'
    $uninstaller = 'out/signpath/retained/Uninstall EZTerminal.exe'
    $windows = (& "$PSScriptRoot/verify-windows-signatures.ps1" `
        -Path @($app, $hostExe, $uninstaller, $setup) `
        -ExpectedStatus NotSigned -ExpectedProductVersion $version) | ConvertFrom-Json

    & "$repoRoot/mobile/android/scripts/verify-apk.ps1" `
        -ApkPath 'mobile/android/app/build/outputs/apk/release/app-release.apk' `
        -MetadataPath 'mobile/android/app/build/outputs/apk/release/output-metadata.json' `
        -ExpectedVersionName $version -ExpectedVersionCode $code `
        -ExpectedCertSha256 $cert -RequireSignature `
        -RequiredText @($ExpectedCommit) `
        -ForbiddenText @('__EZTERMINAL_TEST_API__', '__EZTERMINAL_E2E__', 'ws://127.0.0.1:18765')
    if ($LASTEXITCODE -ne 0) { throw 'Signed APK verification failed.' }

    # A new isolated directory on every run; never replace an older installer.
    $artifactDirectory = Join-Path $repoRoot (
        "release-assets/$version-local-$($ExpectedCommit.Substring(0, 8))-" +
        [Guid]::NewGuid().ToString('N').Substring(0, 8)
    )
    New-Item -ItemType Directory -Path $artifactDirectory | Out-Null
    Copy-Item -LiteralPath $setup -Destination (Join-Path $artifactDirectory 'EZTerminal-Setup.exe')
    Copy-Item -LiteralPath 'mobile/android/app/build/outputs/apk/release/app-release.apk' `
        -Destination (Join-Path $artifactDirectory "EZTerminal-Android-$version-vc$code.apk")
    & node scripts/generate-sbom.mjs --output (Join-Path $artifactDirectory 'sbom.cdx.json')
    if ($LASTEXITCODE -ne 0) { throw 'SBOM generation failed.' }
    Assert-Source
    $files = @(Get-ChildItem -LiteralPath $artifactDirectory -File | Sort-Object Name | ForEach-Object {
        [ordered]@{
            name = $_.Name
            bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
    $receipt = [ordered]@{
        schemaVersion = 1
        artifactStage = 'local-installers'
        publicationEligible = $false
        version = $version
        androidVersionCode = $code
        protocolVersion = [int]$contract.protocolVersion
        buildSha = $ExpectedCommit
        createdAt = [DateTime]::UtcNow.ToString('o')
        verification = [ordered]@{
            cleanSource = $true
            windowsSignatures = $windows
            androidCertificateSha256 = $cert
            apkIdentityAndProductionAssets = 'passed'
            fullReleaseValidation = 'not-certified-by-this-receipt'
            deviceValidation = 'not-claimed'
            performanceMeasurement = 'not-run'
            lifecycleSoak = 'not-run'
        }
        files = $files
    }
    $receipt | ConvertTo-Json -Depth 10 | Set-Content `
        -LiteralPath (Join-Path $artifactDirectory 'local-build-receipt.json') -Encoding utf8
    Get-ChildItem -LiteralPath $artifactDirectory -File | Sort-Object Name | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    } | Set-Content -LiteralPath (Join-Path $artifactDirectory 'SHA256SUMS.txt') -Encoding ascii
    Write-Host "Local installers: $artifactDirectory"
    Write-Host 'publicationEligible=false; this is not a formal release validation certificate.'
} finally { Pop-Location }
