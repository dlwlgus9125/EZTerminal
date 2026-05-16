/**
 * Verify that external module lists are synchronized across three config files:
 * - vite.main.config.ts (rollupOptions.external)
 * - scripts/build-e2e.mjs (esbuild --external flags)
 * - forge.config.ts (asar.unpack module list)
 *
 * Comparison baseline: actual imports in src/main/ (Node builtins excluded).
 * - Imported module missing from any config → FAIL (exit 1)
 * - Config-only module not imported in src → WARN (exit 0)
 *
 * Usage: node scripts/verify-externals.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

// --- 1. Scan src/main/ for actual external imports ---
function scanImports(dir) {
  const imports = new Set();
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf-8");
    for (const m of content.matchAll(/from\s+["']([^./][^"']*)["']/g)) {
      imports.add(m[1]);
    }
    for (const m of content.matchAll(/require\s*\(\s*["']([^./][^"']*)["']\s*\)/g)) {
      imports.add(m[1]);
    }
  }
  const externals = new Set();
  for (const mod of imports) {
    if (NODE_BUILTINS.has(mod)) continue;
    if (mod === "electron") continue;
    const pkg = mod.startsWith("@") ? mod.split("/").slice(0, 2).join("/") : mod.split("/")[0];
    externals.add(pkg);
  }
  return externals;
}

// --- 2. Parse vite.main.config.ts externals ---
function parseViteExternals() {
  const content = readFileSync(join(root, "vite.main.config.ts"), "utf-8");
  const externals = new Set();
  const re = /external:\s*\[([\s\S]*?)\]/;
  const match = content.match(re);
  if (!match) {
    console.error("FAIL: Could not parse external array from vite.main.config.ts");
    process.exit(1);
  }
  for (const m of match[1].matchAll(/["']([^"']+)["']/g)) {
    if (!NODE_BUILTINS.has(m[1]) && m[1] !== "electron") {
      externals.add(m[1]);
    }
  }
  return externals;
}

// --- 3. Parse build-e2e.mjs externals ---
function parseBuildE2eExternals() {
  const content = readFileSync(join(root, "scripts/build-e2e.mjs"), "utf-8");
  const externals = new Set();
  for (const m of content.matchAll(/--external:(\S+)/g)) {
    const mod = m[1].replace(/["',]/g, "");
    if (!NODE_BUILTINS.has(mod) && mod !== "electron") {
      externals.add(mod);
    }
  }
  return externals;
}

// --- 4. Parse forge.config.ts ASAR unpack modules ---
function parseForgeUnpack() {
  const content = readFileSync(join(root, "forge.config.ts"), "utf-8");
  const externals = new Set();
  // Match: **/node_modules/{mod1,mod2,mod3}/**
  const re = /node_modules\/\{([^}]+)\}/;
  const match = content.match(re);
  if (!match) {
    console.error("FAIL: Could not parse asar.unpack from forge.config.ts");
    process.exit(1);
  }
  const mods = match[1].split(",").map((s) => s.trim());
  for (const mod of mods) {
    if (mod && mod !== "electron") {
      externals.add(mod);
    }
  }
  return externals;
}

// --- 5. Compare ---
const srcImports = scanImports(join(root, "src/main"));
const viteExternals = parseViteExternals();
const e2eExternals = parseBuildE2eExternals();
const forgeUnpack = parseForgeUnpack();

console.log("src/main imports:", [...srcImports].sort().join(", "));
console.log("vite externals:  ", [...viteExternals].sort().join(", "));
console.log("e2e externals:   ", [...e2eExternals].sort().join(", "));
console.log("forge unpack:    ", [...forgeUnpack].sort().join(", "));
console.log();

let hasFail = false;
let hasWarn = false;

for (const mod of srcImports) {
  const inVite = viteExternals.has(mod);
  const inE2e = e2eExternals.has(mod);
  const inForge = forgeUnpack.has(mod);
  if (!inVite || !inE2e || !inForge) {
    const missing = [];
    if (!inVite) missing.push("vite.main.config.ts");
    if (!inE2e) missing.push("build-e2e.mjs");
    if (!inForge) missing.push("forge.config.ts");
    console.error(`FAIL: "${mod}" imported in src/main but missing from: ${missing.join(", ")}`);
    hasFail = true;
  }
}

const allConfig = new Set([...viteExternals, ...e2eExternals, ...forgeUnpack]);
for (const mod of allConfig) {
  if (!srcImports.has(mod)) {
    const locations = [];
    if (viteExternals.has(mod)) locations.push("vite");
    if (e2eExternals.has(mod)) locations.push("e2e");
    if (forgeUnpack.has(mod)) locations.push("forge");
    console.warn(`WARN: "${mod}" in [${locations.join(", ")}] but not imported in src/main`);
    hasWarn = true;
  }
}

if (hasFail) {
  console.error("\nFAIL: External module lists are out of sync.");
  process.exit(1);
}
if (hasWarn) {
  console.log("\nPASS (with warnings): All imported modules are synchronized.");
} else {
  console.log("\nPASS: All external module lists are synchronized.");
}
