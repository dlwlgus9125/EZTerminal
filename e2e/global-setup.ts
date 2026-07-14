import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import { areBuildArtifactsFresh, buildArtifactPaths, buildInputPaths } from './build-freshness';

const ROOT = path.resolve(__dirname, '..');

// Playwright launches the standalone Electron build (.vite/build/main.js), which
// loads the production renderer from .vite/renderer. Those artifacts are emitted
// by `electron-forge package`, so rebuild them when they are missing OR older
// than a renderer/main build input. Existence alone can silently test stale UI.
//
// The Forge CLI is invoked through Node directly (no shell) for cross-platform
// safety: the bin path is resolved from the package manifest rather than relying
// on a platform-specific shim in node_modules/.bin.
export default function globalSetup(): void {
  if (areBuildArtifactsFresh(buildArtifactPaths(ROOT), buildInputPaths(ROOT))) return;

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
