import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import path from 'node:path';

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:EZTERMINAL_AUTHENTICODE_PATH
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing signature target.' }
function Get-CertificateSha256($certificate) {
  if ($null -eq $certificate) { return $null }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha256.ComputeHash($certificate.RawData)) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}
$signature = Get-AuthenticodeSignature -LiteralPath $target
$publisher = if ($null -eq $signature.SignerCertificate) {
  $null
} else {
  $signature.SignerCertificate.GetNameInfo(
    [Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
}
[ordered]@{
  status = $signature.Status.ToString()
  publisher = $publisher
  signerCertificateSha256 = Get-CertificateSha256 $signature.SignerCertificate
  timestamped = $null -ne $signature.TimeStamperCertificate
  timestampCertificateSha256 = Get-CertificateSha256 $signature.TimeStamperCertificate
} | ConvertTo-Json -Compress
`;

const ENCODED_SCRIPT = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const VERIFY_TIMEOUT_MS = 15_000;

export interface WindowsAuthenticodeVerification {
  readonly status: string;
  readonly publisher: string | null;
  readonly signerCertificateSha256: string | null;
  readonly timestamped: boolean;
  readonly timestampCertificateSha256: string | null;
}

function nullableDigest(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('Invalid Authenticode certificate digest.');
  }
  return value.toLowerCase();
}

function parseVerification(value: unknown): WindowsAuthenticodeVerification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Authenticode verifier output.');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== 'string'
    || (typeof record.publisher !== 'string' && record.publisher !== null)
    || typeof record.timestamped !== 'boolean'
  ) throw new Error('Invalid Authenticode verifier fields.');
  return {
    status: record.status,
    publisher: record.publisher,
    signerCertificateSha256: nullableDigest(record.signerCertificateSha256),
    timestamped: record.timestamped,
    timestampCertificateSha256: nullableDigest(record.timestampCertificateSha256),
  };
}

export async function verifyWindowsAuthenticode(
  filePath: string,
): Promise<WindowsAuthenticodeVerification> {
  if (process.platform !== 'win32' || !path.isAbsolute(filePath)) {
    throw new Error('Authenticode verification requires an absolute Windows path.');
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
      {
        encoding: 'utf8',
        env: { ...process.env, EZTERMINAL_AUTHENTICODE_PATH: filePath },
        maxBuffer: OUTPUT_LIMIT_BYTES,
        timeout: VERIFY_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, output) => error ? reject(error) : resolve(output),
    );
  });
  return parseVerification(JSON.parse(stdout.trim()) as unknown);
}
