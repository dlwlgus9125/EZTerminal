[CmdletBinding(DefaultParameterSetName = 'Create')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Create')]
    [switch]$Create,

    [Parameter(Mandatory = $true, ParameterSetName = 'Extract')]
    [switch]$Extract,

    [Parameter(Mandatory = $true)]
    [string]$BundlePath,

    [Parameter(Mandatory = $true, ParameterSetName = 'Create')]
    [string[]]$SourcePaths,

    [Parameter(Mandatory = $true, ParameterSetName = 'Create')]
    [string[]]$EntryNames,

    [Parameter(Mandatory = $true, ParameterSetName = 'Extract')]
    [string]$DestinationDirectory,

    [Parameter(Mandatory = $true, ParameterSetName = 'Extract')]
    [string[]]$ExpectedEntryNames,

    [ValidateRange(1, 67108864)]
    [int64]$MaxEntryBytes = 16777216,

    [ValidateRange(1, 134217728)]
    [int64]$MaxTotalBytes = 33554432,

    [ValidateRange(1, 30000)]
    [int]$MaxBase64Characters = 30000
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-SafeEntryNames {
    param([string[]]$Names, [string]$Label)

    if ($Names.Count -eq 0) {
        throw "$Label must contain at least one entry name."
    }
    $seen = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::Ordinal
    )
    foreach ($name in $Names) {
        if (
            [string]::IsNullOrWhiteSpace($name) -or
            $name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or
            $name.Contains('/') -or
            $name.Contains('\') -or
            -not $seen.Add($name)
        ) {
            throw "$Label contains an unsafe or duplicate entry name: '$name'."
        }
    }
}

function Get-FileEvidence {
    param([string]$Path, [string]$Name)

    $item = Get-Item -LiteralPath $Path -Force
    [ordered]@{
        name = $Name
        path = $item.FullName
        bytes = [int64]$item.Length
        sha256 = Get-FileSha256 $item.FullName
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

function Get-FileSha256 {
    param([string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return (
            [BitConverter]::ToString($sha256.ComputeHash($stream)) -replace '-', ''
        ).ToLowerInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-Base64Length {
    param([int64]$ByteLength)
    return [int64]([Math]::Ceiling($ByteLength / 3.0) * 4)
}

$bundleParent = Split-Path -Parent ([IO.Path]::GetFullPath($BundlePath))
if ([string]::IsNullOrWhiteSpace($bundleParent)) {
    throw "BundlePath has no parent directory: $BundlePath"
}
if (-not (Test-Path -LiteralPath $bundleParent -PathType Container)) {
    throw "Bundle parent directory does not exist: $bundleParent"
}
$resolvedBundleParent = Get-Item -LiteralPath (
    Resolve-Path -LiteralPath $bundleParent
) -Force
if ($resolvedBundleParent.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "Bundle parent directory must not be a reparse point: $bundleParent"
}
$resolvedBundle = [IO.Path]::GetFullPath(
    (Join-Path $resolvedBundleParent.FullName (
        [IO.Path]::GetFileName($BundlePath)
    ))
)

if ($PSCmdlet.ParameterSetName -eq 'Create') {
    Assert-SafeEntryNames $EntryNames 'EntryNames'
    if ($SourcePaths.Count -ne $EntryNames.Count) {
        throw 'SourcePaths and EntryNames must have the same number of entries.'
    }
    if (Test-Path -LiteralPath $resolvedBundle) {
        throw "Evidence bundle already exists: $resolvedBundle"
    }

    $sources = [Collections.Generic.List[object]]::new()
    $totalBytes = [int64]0
    for ($index = 0; $index -lt $SourcePaths.Count; $index += 1) {
        $resolvedSource = (Resolve-Path -LiteralPath $SourcePaths[$index]).Path
        $source = Get-Item -LiteralPath $resolvedSource -Force
        if (
            $source.PSIsContainer -or
            ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)
        ) {
            throw "Evidence source must be a normal file: $resolvedSource"
        }
        $sourceBytes = [IO.File]::ReadAllBytes($source.FullName)
        if (
            $sourceBytes.LongLength -lt 1 -or
            $sourceBytes.LongLength -gt $MaxEntryBytes
        ) {
            throw (
                "Evidence source '$resolvedSource' must be between 1 and " +
                "$MaxEntryBytes bytes."
            )
        }
        $totalBytes += $sourceBytes.LongLength
        if ($totalBytes -gt $MaxTotalBytes) {
            throw "Evidence sources exceed the $MaxTotalBytes-byte total limit."
        }
        $sources.Add([ordered]@{
            path = $source.FullName
            name = $EntryNames[$index]
            content = $sourceBytes
            bytes = [int64]$sourceBytes.LongLength
            sha256 = Get-BytesSha256 $sourceBytes
        })
    }

    try {
        $stream = [IO.File]::Open(
            $resolvedBundle,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        try {
            $archive = [IO.Compression.ZipArchive]::new(
                $stream,
                [IO.Compression.ZipArchiveMode]::Create,
                $true
            )
            try {
                foreach ($source in $sources) {
                    $entry = $archive.CreateEntry(
                        [string]$source.name,
                        [IO.Compression.CompressionLevel]::Optimal
                    )
                    $entry.LastWriteTime = [DateTimeOffset]::new(
                        1980,
                        1,
                        1,
                        0,
                        0,
                        0,
                        [TimeSpan]::Zero
                    )
                    $entryStream = $entry.Open()
                    try {
                        $content = [byte[]]$source.content
                        $entryStream.Write($content, 0, $content.Length)
                    } finally {
                        $entryStream.Dispose()
                    }
                }
            } finally {
                $archive.Dispose()
            }
        } finally {
            $stream.Dispose()
        }
    } catch {
        if (Test-Path -LiteralPath $resolvedBundle -PathType Leaf) {
            Remove-Item -LiteralPath $resolvedBundle -Force
        }
        throw
    }

    $bundle = Get-Item -LiteralPath $resolvedBundle -Force
    $base64Length = Get-Base64Length $bundle.Length
    if ($base64Length -gt $MaxBase64Characters) {
        Remove-Item -LiteralPath $resolvedBundle -Force
        throw (
            "Compressed evidence requires $base64Length base64 characters, " +
            "exceeding the Windows protected-secret transport limit of " +
            "$MaxBase64Characters."
        )
    }
    $files = @(
        foreach ($source in $sources) {
            [ordered]@{
                name = [string]$source.name
                path = [string]$source.path
                bytes = [int64]$source.bytes
                sha256 = [string]$source.sha256
            }
        }
    )
    [ordered]@{
        operation = 'create'
        bundlePath = $resolvedBundle
        bundleBytes = [int64]$bundle.Length
        bundleSha256 = Get-FileSha256 $resolvedBundle
        base64Length = $base64Length
        files = $files
    } | ConvertTo-Json -Depth 5 -Compress
    return
}

Assert-SafeEntryNames $ExpectedEntryNames 'ExpectedEntryNames'
$bundle = Get-Item -LiteralPath (Resolve-Path -LiteralPath $resolvedBundle).Path -Force
if (
    $bundle.PSIsContainer -or
    ($bundle.Attributes -band [IO.FileAttributes]::ReparsePoint)
) {
    throw "Evidence bundle must be a normal file: $resolvedBundle"
}
$bundleBase64Length = Get-Base64Length $bundle.Length
if ($bundle.Length -lt 1 -or $bundleBase64Length -gt $MaxBase64Characters) {
    throw (
        "Evidence bundle must be non-empty and require no more than " +
        "$MaxBase64Characters base64 characters."
    )
}
$destination = [IO.Path]::GetFullPath($DestinationDirectory)
if (Test-Path -LiteralPath $destination) {
    throw "Evidence extraction destination must not already exist: $destination"
}
$destinationParent = Split-Path -Parent $destination
if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
    throw "Evidence extraction parent does not exist: $destinationParent"
}
$resolvedDestinationParent = Get-Item -LiteralPath (
    Resolve-Path -LiteralPath $destinationParent
) -Force
if ($resolvedDestinationParent.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw (
        "Evidence extraction parent must not be a reparse point: " +
        "$destinationParent"
    )
}

$archive = [IO.Compression.ZipFile]::OpenRead($bundle.FullName)
$createdDestination = $false
try {
    $entries = @($archive.Entries)
    if ($entries.Count -ne $ExpectedEntryNames.Count) {
        throw (
            "Evidence bundle entry count mismatch: expected " +
            "$($ExpectedEntryNames.Count), got $($entries.Count)."
        )
    }
    $actualNames = @($entries | ForEach-Object { [string]$_.FullName })
    Assert-SafeEntryNames $actualNames 'Evidence bundle'
    foreach ($expected in $ExpectedEntryNames) {
        if ($actualNames -cnotcontains $expected) {
            throw "Evidence bundle is missing '$expected'."
        }
    }
    $declaredTotalBytes = [int64]0
    foreach ($entry in $entries) {
        if (
            $entry.FullName -cne $entry.Name -or
            $entry.Length -lt 1 -or
            $entry.Length -gt $MaxEntryBytes
        ) {
            throw "Evidence bundle contains an unsafe entry: '$($entry.FullName)'."
        }
        $declaredTotalBytes += $entry.Length
        if ($declaredTotalBytes -gt $MaxTotalBytes) {
            throw "Evidence bundle exceeds the $MaxTotalBytes-byte total limit."
        }
    }

    New-Item -ItemType Directory -Path $destination | Out-Null
    $createdDestination = $true
    $actualTotalBytes = [int64]0
    $copyBuffer = [byte[]]::new(81920)
    $files = @(
        foreach ($entry in $entries | Sort-Object FullName) {
            $target = Join-Path $destination $entry.Name
            $input = $entry.Open()
            try {
                $output = [IO.File]::Open(
                    $target,
                    [IO.FileMode]::CreateNew,
                    [IO.FileAccess]::Write,
                    [IO.FileShare]::None
                )
                try {
                    $actualEntryBytes = [int64]0
                    while (($read = $input.Read(
                        $copyBuffer,
                        0,
                        $copyBuffer.Length
                    )) -gt 0) {
                        $actualEntryBytes += $read
                        $actualTotalBytes += $read
                        if (
                            $actualEntryBytes -gt $MaxEntryBytes -or
                            $actualTotalBytes -gt $MaxTotalBytes
                        ) {
                            throw (
                                "Evidence bundle exceeded its decompressed byte limit " +
                                "while reading '$($entry.FullName)'."
                            )
                        }
                        $output.Write($copyBuffer, 0, $read)
                    }
                    if ($actualEntryBytes -ne [int64]$entry.Length) {
                        throw (
                            "Evidence bundle entry '$($entry.FullName)' decompressed " +
                            "to $actualEntryBytes bytes but declared $($entry.Length)."
                        )
                    }
                } finally {
                    $output.Dispose()
                }
            } finally {
                $input.Dispose()
            }
            Get-FileEvidence $target $entry.Name
        }
    )
    if ($actualTotalBytes -ne $declaredTotalBytes) {
        throw (
            "Evidence bundle decompressed to $actualTotalBytes bytes but declared " +
            "$declaredTotalBytes."
        )
    }
} catch {
    if ($createdDestination -and (Test-Path -LiteralPath $destination)) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
    throw
} finally {
    $archive.Dispose()
}

[ordered]@{
    operation = 'extract'
    bundlePath = $bundle.FullName
    bundleBytes = [int64]$bundle.Length
    bundleSha256 = Get-FileSha256 $bundle.FullName
    base64Length = $bundleBase64Length
    destinationDirectory = $destination
    files = $files
} | ConvertTo-Json -Depth 5 -Compress
