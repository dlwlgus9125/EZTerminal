import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { packagedExePath } from './paths';

const ROOT = path.resolve(__dirname, '..');

// ARCH-P0: the standard e2e suite launches the UNPACKED `.vite/build/main.js`, so
// the PRODUCTION path — `utilityProcess.fork` from inside app.asar under Fuses
// (OnlyLoadAppFromAsar, RunAsNode off) — is never exercised. This setup produces
// the real packaged app (`electron-forge package` → `out/<product>-<platform>-<arch>/`)
// so the smoke spec can launch the actual EXE and prove the interpreter forks from
// asar. Packaging is invoked through Node directly (no shell) for cross-platform safety.
export default function globalSetup(): void {
  const exe = packagedExePath();
  if (!existsSync(exe)) {
    const require = createRequire(__filename);
    const manifestPath = require.resolve('@electron-forge/cli/package.json');
    const manifest = require('@electron-forge/cli/package.json') as {
      bin: string | Record<string, string>;
    };
    const binRel =
      typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['electron-forge'];
    const forgeCli = path.join(path.dirname(manifestPath), binRel);

    execFileSync(process.execPath, [forgeCli, 'package'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  }

  // Phase 2: fail fast if node-pty's native binaries did not unpack from asar — a
  // green packaged run with broken PTY packaging would otherwise be misleading.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'guard-native-pty.mjs')], {
    stdio: 'inherit',
    cwd: ROOT,
  });

  // Phase 2B: same guarantee for cap (packet capture) — fail fast if its
  // native binary did not unpack from asar.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'guard-native-cap.mjs')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}
