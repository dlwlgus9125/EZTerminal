import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';

import { packagedExePath } from './paths';

// ── E4 packaged smoke: the script-host bundle ships inside app.asar ────────────
//
// Like packaged-smoke.spec.ts's interpreter-fork proof, driving `run-script`
// through the UI of the FUSED exe is impossible for Playwright here (the Node
// inspector fuse is off, so `electron.launch` against the real binary hangs —
// see that file's header for the full explanation). Unlike the interpreter
// (forked once at app startup, with a boot-log line to grep), the script-host
// is forked LAZILY per `run-script` invocation, so there is no startup
// evidence to look for without driving the UI.
//
// What THIS test verifies without UI: the 4th Vite build entry (script-host.js,
// forge.config.ts) is genuinely packaged inside app.asar at the exact relative
// path main.ts resolves it from (`path.join(__dirname, 'script-host.js')`,
// sibling of main.js/interpreter-process.js) — i.e. `electron-forge package`
// did not silently drop the entry. It does NOT prove `utilityProcess.fork`
// itself succeeds for THIS entry under the fuses at runtime — that fact is
// covered by analogy: packaged-smoke.spec.ts already proves
// `utilityProcess.fork`-from-asar works for the sibling interpreter-process.js
// entry under the IDENTICAL fuses (C1/C2's load-bearing constraint), and
// script-host.js is built the same way (plain JS, no native deps, target
// 'main'). Documented honestly rather than faked.

function asarPath(): string {
  return path.join(path.dirname(packagedExePath()), 'resources', 'app.asar');
}

test('packaged EXE: script-host.js is bundled inside app.asar (4th Vite build entry)', async () => {
  // @electron/asar is a transitive dep of @electron-forge/cli — not declared
  // directly, so resolve it the same way global-setup resolves the Forge CLI.
  const require = createRequire(__filename);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const asar = require('@electron/asar') as typeof import('@electron/asar');

  const entries = asar.listPackage(asarPath(), { isPack: false });
  const normalized = entries.map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, ''));

  expect(normalized, `app.asar entries:\n${normalized.join('\n')}`).toContain('.vite/build/script-host.js');
});
