import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

// productName from package.json — electron-forge packages into
// `out/<productName>-<platform>-<arch>/<productName>(.exe)`.
const PRODUCT = 'EZTerminal';

/** Absolute path to the packaged executable for the current platform/arch. */
export function packagedExePath(): string {
  const dir = path.join(ROOT, 'out', `${PRODUCT}-${process.platform}-${process.arch}`);
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
