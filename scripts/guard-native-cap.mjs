// Guard: after `electron-forge package`, assert cap's native binary was
// unpacked from app.asar into app.asar.unpacked (Phase 2B packet capture).
//
// Why this guard is mandatory: cap loads its classic node-gyp `.node` addon
// (and, at load time, Windows' wpcap.dll from a Npcap install) by real
// filesystem path — none of which can run from inside app.asar. This guard
// runs in CI/local after `pnpm package` and fails loudly if the binary is
// missing from the unpacked tree (same failure mode node-pty's guard exists
// for — see guard-native-pty.mjs).
//
// It searches recursively so it is resilient to pnpm's nested `.pnpm/...`
// layout (the runtime-resolved path differs from the top-level symlink).

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PRODUCT = 'EZTerminal';
const platform = process.platform;
const arch = process.arch;

// Mirrors e2e-packaged/paths.ts packaging layout: out/<Product>-<platform>-<arch>/
const packagedDir = path.join(ROOT, 'out', `${PRODUCT}-${platform}-${arch}`);
const resourcesDir = path.join(packagedDir, 'resources');
const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');
const asarFile = path.join(resourcesDir, 'app.asar');

function fail(msg) {
  console.error(`[guard:native-cap] FAIL — ${msg}`);
  process.exit(1);
}

if (!existsSync(packagedDir)) {
  fail(`packaged app not found at ${packagedDir}. Run \`pnpm package\` first.`);
}
if (!existsSync(asarFile)) {
  fail(`app.asar not found at ${asarFile} (asar packaging expected).`);
}
if (!existsSync(unpackedRoot)) {
  fail(`app.asar.unpacked not found at ${unpackedRoot}. cap was not unpacked from asar.`);
}

// Recursively collect basenames (and their relative paths) under the unpacked root.
/** @type {Map<string, string[]>} */
const found = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    // pnpm uses junctions/symlinks; resolve them so we descend real dirs.
    if (entry.isSymbolicLink()) {
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) {
      walk(abs);
    } else {
      const rel = path.relative(unpackedRoot, abs).split(path.sep).join('/');
      const list = found.get(entry.name) ?? [];
      list.push(rel);
      found.set(entry.name, list);
    }
  }
}
walk(unpackedRoot);

// cap.node is only platform-specific insofar as it's always freshly built for
// the current platform/arch (no shipped prebuilds directory like node-pty's),
// so just require it under a `cap/` path — any hit is the current build.
const hits = (found.get('cap.node') ?? []).filter((rel) => rel.includes('cap'));

if (hits.length === 0) {
  console.error('[guard:native-cap] FAIL — cap.node MISSING from app.asar.unpacked');
  console.error(`[guard:native-cap] searched under: ${unpackedRoot}`);
  fail('cap.node not unpacked.');
}

console.log('[guard:native-cap] OK — cap.node unpacked under app.asar.unpacked:');
for (const rel of hits) console.log(`  - cap.node -> ${rel}`);
process.exit(0);
