import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// productName from package.json — electron-forge packages into
// `out/<productName>-<platform>-<arch>/<productName>(.exe)`.
const PRODUCT = 'EZTerminal';

// Mirrors forge.config.ts's `outDir: process.env.EZ_OUT_DIR` (default stays
// `out/` — EZ_OUT_DIR exists because a stale handle from another session can
// EBUSY-lock out/EZTerminal-win32-x64).
const OUT_DIR = process.env.EZ_OUT_DIR ?? 'out';

/** Absolute path to the packaged executable for the current platform/arch. */
export function packagedExePath(): string {
  const dir = path.join(ROOT, OUT_DIR, `${PRODUCT}-${process.platform}-${process.arch}`);
  const exe =
    process.platform === 'win32'
      ? `${PRODUCT}.exe`
      : process.platform === 'darwin'
        ? path.join(`${PRODUCT}.app`, 'Contents', 'MacOS', PRODUCT)
        : PRODUCT;
  return path.join(dir, exe);
}

/** True once the packaged artifact exists on disk. */
export function packagedExeExists(): boolean {
  return existsSync(packagedExePath());
}
