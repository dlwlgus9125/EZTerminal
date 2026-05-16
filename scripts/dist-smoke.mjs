/**
 * Distribution smoke test: package the app and verify the exe survives 8 seconds.
 *
 * Usage:
 *   node scripts/dist-smoke.mjs              # package + smoke
 *   node scripts/dist-smoke.mjs --skip-package  # smoke only (exe must exist)
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const exePath = resolve(root, "out/EZTerminal-win32-x64/ezterminal.exe");
const SURVIVAL_SECONDS = 8;
const CRASH_PATTERNS = ["Cannot find module", "MODULE_NOT_FOUND", "ERR_REQUIRE_ESM", "SyntaxError"];

const skipPackage = process.argv.includes("--skip-package");

// --- 1. Package ---
if (!skipPackage) {
  console.log("dist-smoke: packaging app via electron-forge...");
  try {
    execFileSync("pnpm", ["package"], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
  } catch {
    console.error("FAIL: electron-forge package failed.");
    process.exit(1);
  }
}

// --- 2. Verify exe exists ---
if (!existsSync(exePath)) {
  console.error(`FAIL: exe not found at ${exePath}`);
  console.error("Run without --skip-package to build first.");
  process.exit(1);
}

// --- 3. Launch exe ---
console.log(`dist-smoke: launching ${exePath}`);
console.log(`dist-smoke: will monitor for ${SURVIVAL_SECONDS} seconds then terminate.`);

let stderrOutput = "";
let exited = false;
let exitCode = null;

const child = spawn(exePath, [], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  detached: false,
});

child.stderr.on("data", (chunk) => {
  stderrOutput += chunk.toString();
});

child.on("exit", (code) => {
  exited = true;
  exitCode = code;
});

child.on("error", (err) => {
  console.error(`FAIL: Could not launch exe: ${err.message}`);
  process.exit(1);
});

// --- 4. Wait and check ---
setTimeout(() => {
  if (exited) {
    // Process died before timeout
    console.error(`FAIL: exe exited early with code ${exitCode}`);
    checkStderr();
    process.exit(1);
  }

  // Process survived — check stderr for crash patterns
  const hasCrashPattern = CRASH_PATTERNS.some((p) => stderrOutput.includes(p));
  if (hasCrashPattern) {
    console.error("FAIL: exe survived but stderr contains crash patterns:");
    for (const p of CRASH_PATTERNS) {
      if (stderrOutput.includes(p)) {
        console.error(`  - ${p}`);
      }
    }
    cleanup(1);
    return;
  }

  console.log(`PASS: exe survived ${SURVIVAL_SECONDS}s without crash.`);
  cleanup(0);
}, SURVIVAL_SECONDS * 1000);

function checkStderr() {
  for (const p of CRASH_PATTERNS) {
    if (stderrOutput.includes(p)) {
      console.error(`  stderr match: ${p}`);
    }
  }
  if (stderrOutput.trim()) {
    console.error("  stderr output (first 500 chars):");
    console.error(`  ${stderrOutput.slice(0, 500)}`);
  }
}

function cleanup(code) {
  try {
    // Windows: kill process tree
    execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
    });
  } catch {
    // Process may have already exited
  }
  process.exit(code);
}
