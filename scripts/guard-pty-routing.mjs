// Guard: CLI-parity auto-PTY invariants (plan .omc/plans/cli-parity-auto-pty.md, M5).
//
// Locks four behaviors that, if silently regressed, would reopen exactly the bugs
// this feature fixed (claude/codex failing to launch, batch-shim injection, pipes
// hanging on stdin):
//   (a) a batch (.bat/.cmd) target is NOT rejected on the interactive PTY path
//       (external-command-pty.test.ts — pre-M1 behavior threw here)
//   (b) buildCmdLine's adversarial escaping is pinned to fixed outputs AND proven
//       through a REAL node-pty + cmd.exe round trip, not just string assertions
//       (build-cmd-line.test.ts — SEC-HIGH-1 / CVE-2024-27980 class of bug)
//   (c) a single-stage, non-builtin command auto-routes to interactive PTY
//       execution without requiring `!` (interactive-trigger.test.ts — M2)
//   (d) a piped external command's stdin is closed with the array-form
//       `stdio: ['ignore','pipe','pipe']`, not left open-but-unwritten
//       (process-runner.test.ts — M4, AC-8)
//
// These are already exercised in full by `pnpm test`; this guard re-runs just
// that subset as a fast, named, always-green regression gate (CI-visible
// alongside guard:native) rather than re-implementing the assertions.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

const INVARIANT_FILES = [
  'src/interpreter/external/external-command-pty.test.ts', // (a)
  'src/interpreter/external/build-cmd-line.test.ts', // (b)
  'src/interpreter/core/interactive-trigger.test.ts', // (c)
  'src/interpreter/external/process-runner.test.ts', // (d)
];

function fail(msg) {
  console.error(`[guard:pty-routing] FAIL — ${msg}`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('vitest/package.json');
const manifest = require('vitest/package.json');
const binRel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.vitest;
const vitestCli = path.join(path.dirname(manifestPath), binRel);

try {
  execFileSync(process.execPath, [vitestCli, 'run', ...INVARIANT_FILES], {
    stdio: 'inherit',
    cwd: ROOT,
  });
} catch {
  fail(
    `one or more CLI-parity PTY-routing invariants failed — see vitest output above. ` +
      `Files checked: ${INVARIANT_FILES.join(', ')}`,
  );
}

console.log('[guard:pty-routing] OK — batch-PTY, buildCmdLine, auto-interactive routing, and pipe-stdin invariants hold.');
process.exit(0);
