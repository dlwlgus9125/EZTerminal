import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
// T1 added the interpreter utilityProcess as a separate build entry; E4 added
// the script-host utilityProcess as a fourth. All three artifacts must exist
// for the e2e suite to pass.
const INTERPRETER_ENTRY = path.join(ROOT, '.vite', 'build', 'interpreter-process.js');
const SCRIPT_HOST_ENTRY = path.join(ROOT, '.vite', 'build', 'script-host.js');

// Playwright launches the standalone Electron build (.vite/build/main.js), which
// loads the production renderer from .vite/renderer. Those artifacts are emitted
// by `electron-forge package`, so build them once if they are missing.
//
// The Forge CLI is invoked through Node directly (no shell) for cross-platform
// safety: the bin path is resolved from the package manifest rather than relying
// on a platform-specific shim in node_modules/.bin.
export default function globalSetup(): void {
  if (existsSync(MAIN_ENTRY) && existsSync(INTERPRETER_ENTRY) && existsSync(SCRIPT_HOST_ENTRY)) {
    return;
  }

  const require = createRequire(__filename);
  const manifestPath = require.resolve('@electron-forge/cli/package.json');
  const manifest = require('@electron-forge/cli/package.json') as {
    bin: string | Record<string, string>;
  };
  const binRel =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin['electron-forge'];
  const forgeCli = path.join(path.dirname(manifestPath), binRel);

  execFileSync(process.execPath, [forgeCli, 'package'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
}
