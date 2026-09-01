import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve("scripts", "release-evidence-bundle.ps1");
const temporaryRoots: string[] = [];
const evidenceNames = [
  "local-rc-report.json",
  "mobile-soak-report.json",
  "desktop-performance-baseline.json",
  "desktop-performance-report.json",
] as const;

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function arrayExpression(values: readonly string[]): string {
  return `@(${values.map(quotePowerShell).join(",")})`;
}

interface PowerShellResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runPowerShell(source: string): Promise<PowerShellResult> {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function powerShellDiagnostics(result: PowerShellResult): string {
  return `${result.stdout}\n${result.stderr}`
    .replaceAll("_x000D__x000A_", "")
    .replace(/<\/S>\s*<S S="Error">/g, "");
}

function runPowerShellWithoutGetFileHash(source: string) {
  return runPowerShell(
    "Import-Module Microsoft.PowerShell.Utility; " +
      "Remove-Item Function:\\Get-FileHash; " +
      "$PSModuleAutoLoadingPreference = 'None'; " +
      source,
  );
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ezterminal-release-evidence-"));
  temporaryRoots.push(root);
  const sources = evidenceNames.map((name, index) => {
    const pathname = path.join(root, `source-${index}.json`);
    writeFileSync(pathname, `${JSON.stringify({ name, index })}\n`, "utf8");
    return pathname;
  });
  return { root, sources };
}

function createBundle(
  bundle: string,
  sources: readonly string[],
  names: readonly string[],
) {
  return runPowerShell(
    `& ${quotePowerShell(helper)} -Create ` +
      `-BundlePath ${quotePowerShell(bundle)} ` +
      `-SourcePaths ${arrayExpression(sources)} ` +
      `-EntryNames ${arrayExpression(names)}`,
  );
}

function extractBundle(
  bundle: string,
  destination: string,
  names: readonly string[],
) {
  return runPowerShell(
    `& ${quotePowerShell(helper)} -Extract ` +
      `-BundlePath ${quotePowerShell(bundle)} ` +
      `-DestinationDirectory ${quotePowerShell(destination)} ` +
      `-ExpectedEntryNames ${arrayExpression(names)}`,
  );
}

function patchCentralDirectoryLength(
  bundle: string,
  entryName: string,
  claimedLength: number,
): void {
  const bytes = readFileSync(bundle);
  const signature = 0x02014b50;
  let offset = 0;
  let patched = false;
  while (offset <= bytes.length - 46) {
    if (bytes.readUInt32LE(offset) !== signature) {
      offset += 1;
      continue;
    }
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    if (name === entryName) {
      bytes.writeUInt32LE(claimedLength, offset + 24);
      patched = true;
      break;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(patched).toBe(true);
  writeFileSync(bundle, bytes);
}

function deterministicBytes(length: number): Buffer {
  const output = Buffer.alloc(length);
  let offset = 0;
  for (let counter = 0; offset < length; counter += 1) {
    const block = createHash("sha256")
      .update(`ezterminal-evidence-${counter}`)
      .digest();
    offset += block.copy(output, offset);
  }
  return output;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("release evidence bundle helper", () => {
  it("does not depend on the optional Get-FileHash module function", async () => {
    const { root, sources } = createFixture();
    const bundle = path.join(root, "module-independent.zip");
    const result = await runPowerShellWithoutGetFileHash(
      `& ${quotePowerShell(helper)} -Create ` +
        `-BundlePath ${quotePowerShell(bundle)} ` +
        `-SourcePaths ${arrayExpression(sources)} ` +
        `-EntryNames ${arrayExpression(evidenceNames)}`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      operation: "create",
      bundlePath: realpathSync.native(bundle),
    });
  }, 30_000);

  it("returns control to its caller after bundle creation", async () => {
    const { root, sources } = createFixture();
    const bundle = path.join(root, "caller.zip");
    const result = await runPowerShell(
      `$result = & ${quotePowerShell(helper)} -Create ` +
        `-BundlePath ${quotePowerShell(bundle)} ` +
        `-SourcePaths ${arrayExpression(sources)} ` +
        `-EntryNames ${arrayExpression(evidenceNames)} | Out-String; ` +
        `if ([string]::IsNullOrWhiteSpace($result)) { throw 'No helper result.' }; ` +
        `Write-Output 'CALLER_CONTINUED'`,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("CALLER_CONTINUED");
  }, 30_000);

  it("creates a deterministic exact-entry bundle and extracts the same bytes", async () => {
    const { root, sources } = createFixture();
    const firstBundle = path.join(root, "first.zip");
    const secondBundle = path.join(root, "second.zip");

    const first = await createBundle(firstBundle, sources, evidenceNames);
    const second = await createBundle(secondBundle, sources, evidenceNames);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);

    const firstResult = JSON.parse(first.stdout) as {
      readonly bundleSha256: string;
      readonly base64Length: number;
    };
    const secondResult = JSON.parse(second.stdout) as {
      readonly bundleSha256: string;
    };
    expect(firstResult.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstResult.bundleSha256).toBe(secondResult.bundleSha256);
    expect(firstResult.base64Length).toBeLessThanOrEqual(48_000);

    const destination = path.join(root, "extracted");
    const extracted = await extractBundle(
      firstBundle,
      destination,
      evidenceNames,
    );
    expect(extracted.status, extracted.stderr).toBe(0);
    const extractResult = JSON.parse(extracted.stdout) as {
      readonly files: readonly unknown[];
    };
    expect(extractResult.files).toHaveLength(4);
    for (let index = 0; index < evidenceNames.length; index += 1) {
      expect(
        readFileSync(path.join(destination, evidenceNames[index])),
      ).toEqual(readFileSync(sources[index]));
    }
  }, 30_000);

  it("rejects an extra entry before creating the extraction directory", async () => {
    const { root, sources } = createFixture();
    const extraSource = path.join(root, "extra.json");
    writeFileSync(extraSource, "{}\n", "utf8");
    const bundle = path.join(root, "extra.zip");
    const created = await createBundle(
      bundle,
      [...sources, extraSource],
      [...evidenceNames, "unexpected.json"],
    );
    expect(created.status, created.stderr).toBe(0);

    const destination = path.join(root, "extra-extracted");
    const extracted = await extractBundle(bundle, destination, evidenceNames);
    expect(extracted.status).not.toBe(0);
    expect(powerShellDiagnostics(extracted)).toContain(
      "Evidence bundle entry count mismatch",
    );
    expect(existsSync(destination)).toBe(false);
  }, 30_000);

  it("rejects a traversal entry without writing outside the destination", async () => {
    const { root } = createFixture();
    const bundle = path.join(root, "traversal.zip");
    const created = await runPowerShell(`
      Add-Type -AssemblyName System.IO.Compression
      $stream = [IO.File]::Open(
        ${quotePowerShell(bundle)},
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
          $entry = $archive.CreateEntry('../escape.json')
          $writer = [IO.StreamWriter]::new($entry.Open())
          try { $writer.Write('{}') } finally { $writer.Dispose() }
        } finally {
          $archive.Dispose()
        }
      } finally {
        $stream.Dispose()
      }
    `);
    expect(created.status, created.stderr).toBe(0);

    const destination = path.join(root, "traversal-extracted");
    const extracted = await extractBundle(bundle, destination, ["escape.json"]);
    expect(extracted.status).not.toBe(0);
    expect(powerShellDiagnostics(extracted)).toContain(
      "unsafe or duplicate entry name",
    );
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(path.join(root, "escape.json"))).toBe(false);
  }, 30_000);

  it("rejects actual decompressed bytes beyond a forged central-directory length", async () => {
    const { root, sources } = createFixture();
    writeFileSync(sources[0], "A".repeat(1024), "utf8");
    const bundle = path.join(root, "forged-length.zip");
    const created = await createBundle(bundle, sources, evidenceNames);
    expect(created.status, created.stderr).toBe(0);
    patchCentralDirectoryLength(bundle, evidenceNames[0], 2);

    const destination = path.join(root, "forged-length-extracted");
    const extracted = await runPowerShell(
      `& ${quotePowerShell(helper)} -Extract ` +
        `-BundlePath ${quotePowerShell(bundle)} ` +
        `-DestinationDirectory ${quotePowerShell(destination)} ` +
        `-ExpectedEntryNames ${arrayExpression(evidenceNames)} ` +
        "-MaxEntryBytes 64 -MaxTotalBytes 256",
    );

    expect(extracted.status).not.toBe(0);
    expect(powerShellDiagnostics(extracted)).toContain(
      "decompressed byte limit",
    );
    expect(existsSync(destination)).toBe(false);
  }, 30_000);

  it("rejects a bundle too large for a Windows protected-secret environment value", async () => {
    const { root, sources } = createFixture();
    writeFileSync(sources[0], deterministicBytes(25_000));
    const bundle = path.join(root, "environment-limit.zip");
    const created = await createBundle(bundle, sources, evidenceNames);

    expect(created.status).not.toBe(0);
    expect(powerShellDiagnostics(created)).toContain(
      "protected-secret transport limit of 30000",
    );
    expect(existsSync(bundle)).toBe(false);
  }, 30_000);
});
