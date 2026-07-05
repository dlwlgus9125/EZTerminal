// Guard: after `electron-forge package`, assert node-pty's native binaries were
// unpacked from app.asar into app.asar.unpacked.
//
// Why this guard is mandatory: node-pty loads its NAPI `.node` addons and (in the
// useConptyDll path) ConPTY helper binaries (conpty.dll / OpenConsole.exe) by real
// filesystem path, and fork()s internal JS workers from its own dir. If those stay
// trapped inside app.asar, full-screen TUI spawn works in DEV (no asar) but fails
// ONLY in the packaged exe — the exact failure mode project memory warns about.
// This guard runs in CI/local after `pnpm package` and fails loudly if the binaries
// are missing from the unpacked tree.
//
// It searches recursively so it is resilient to pnpm's nested `.pnpm/...` layout
// (the runtime-resolved path differs from the top-level symlink).

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PRODUCT = 'EZTerminal';
const platform = process.platform;
const arch = process.arch;

// Mirrors forge.config.ts's `outDir: process.env.EZ_OUT_DIR` (default stays
// `out/`) and e2e-packaged/paths.ts's OUT_DIR — same env fallback, so this
// guard checks wherever THIS run actually packaged to, not always `out/`.
const OUT_DIR = process.env.EZ_OUT_DIR ?? 'out';

// Mirrors e2e-packaged/paths.ts packaging layout: <OUT_DIR>/<Product>-<platform>-<arch>/
const packagedDir = path.join(ROOT, OUT_DIR, `${PRODUCT}-${platform}-${arch}`);
const resourcesDir = path.join(packagedDir, 'resources');
const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');
const asarFile = path.join(resourcesDir, 'app.asar');

function fail(msg) {
  console.error(`[guard:native] FAIL — ${msg}`);
  process.exit(1);
}

if (!existsSync(packagedDir)) {
  fail(`packaged app not found at ${packagedDir}. Run \`pnpm package\` first.`);
}
if (!existsSync(asarFile)) {
  fail(`app.asar not found at ${asarFile} (asar packaging expected).`);
}
if (!existsSync(unpackedRoot)) {
  fail(`app.asar.unpacked not found at ${unpackedRoot}. node-pty was not unpacked from asar.`);
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

// Required at runtime on this platform/arch. The .node addons are essential; the
// ConPTY helpers are required for the useConptyDll path and are cheap to verify.
const required =
  platform === 'win32'
    ? ['pty.node', 'conpty.node', 'conpty_console_list.node', 'conpty.dll', 'OpenConsole.exe']
    : ['pty.node'];

const archTag = `prebuilds/${platform}-${arch}/`;
const missing = [];
const present = [];
for (const name of required) {
  const all = (found.get(name) ?? []).filter((rel) => rel.includes('node-pty'));
  // .node addons MUST be the current platform/arch build (the one the runtime
  // require()s); helper binaries (dll/exe) just need to exist under node-pty.
  const hits = name.endsWith('.node') ? all.filter((rel) => rel.includes(archTag)) : all;
  if (hits.length === 0) {
    missing.push(name.endsWith('.node') ? `${name} (under ${archTag})` : name);
  } else {
    present.push(`${name} -> ${hits[0]}`);
  }
}

if (missing.length > 0) {
  console.error('[guard:native] node-pty native files MISSING from app.asar.unpacked:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error(`[guard:native] searched under: ${unpackedRoot}`);
  fail(`${missing.length} required node-pty native file(s) not unpacked.`);
}

console.log(`[guard:native] OK — node-pty native binaries unpacked under app.asar.unpacked:`);
for (const p of present) console.log(`  - ${p}`);
process.exit(0);
