[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Path,

    [Parameter(Mandatory = $true)]
    [ValidateSet('NotSigned', 'Valid')]
    [string]$ExpectedStatus,

    [string]$ExpectedPublisher = '',
    [switch]$RequireTimestamp,
    [string]$ExpectedProductName = 'EZTerminal',
    [string]$ExpectedProductVersion = '',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-CertificateSha256 {
    param([Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    if ($null -eq $Certificate) { return $null }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($Certificate.RawData)) -replace '-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

if ($Path.Count -lt 1) {
    throw 'At least one Windows executable path is required.'
}
if ($ExpectedStatus -eq 'Valid' -and [string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'ExpectedPublisher is required for Valid signatures.'
}

$results = @()
foreach ($candidate in $Path) {
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Signature target must be a normal file: $resolved"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    $actualStatus = $signature.Status.ToString()
    if ($actualStatus -cne $ExpectedStatus) {
        throw "Authenticode status for $resolved must be $ExpectedStatus, got $actualStatus."
    }

    $publisher = if ($null -eq $signature.SignerCertificate) {
        $null
    } else {
        $signature.SignerCertificate.GetNameInfo(
            [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
            $false
        )
    }
    $timestamped = $null -ne $signature.TimeStamperCertificate
    if ($ExpectedStatus -eq 'Valid') {
        if ($publisher -cne $ExpectedPublisher) {
            throw "Authenticode publisher for $resolved must be '$ExpectedPublisher', got '$publisher'."
        }
        if ($RequireTimestamp -and -not $timestamped) {
            throw "Authenticode timestamp is required for $resolved."
        }
    } elseif ($null -ne $signature.SignerCertificate -or $timestamped) {
        throw "Unsigned target unexpectedly contains certificate evidence: $resolved"
    }

    $productName = [string]$item.VersionInfo.ProductName
    $productVersion = [string]$item.VersionInfo.ProductVersion
    if (-not [string]::IsNullOrWhiteSpace($ExpectedProductName) -and $productName -cne $ExpectedProductName) {
        throw "ProductName for $resolved must be '$ExpectedProductName', got '$productName'."
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedProductVersion) -and $productVersion -cne $ExpectedProductVersion) {
        throw "ProductVersion for $resolved must be '$ExpectedProductVersion', got '$productVersion'."
    }

    $results += [ordered]@{
        name = $item.Name
        sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
        status = $actualStatus
        publisher = $publisher
        signerCertificateSha256 = Get-CertificateSha256 $signature.SignerCertificate
        timestamped = $timestamped
        timestampCertificateSha256 = Get-CertificateSha256 $signature.TimeStamperCertificate
        productName = $productName
        productVersion = $productVersion
    }
}

$evidence = [ordered]@{
    expectedStatus = $ExpectedStatus
    expectedPublisher = if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { $null } else { $ExpectedPublisher }
    timestampRequired = [bool]$RequireTimestamp
    files = $results
}
$json = $evidence | ConvertTo-Json -Depth 6
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $parent = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $json | Set-Content -LiteralPath $OutputPath -Encoding utf8
}
$json
