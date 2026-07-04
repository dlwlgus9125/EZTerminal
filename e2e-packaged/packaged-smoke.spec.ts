import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

import { packagedExePath } from './paths';

// ── ARCH-P0: packaged-EXE smoke (the §9-P0 unknown) ─────────────────────────────
//
// The standard `pnpm e2e` launches the UNPACKED `.vite/build/main.js`, so the
// PRODUCTION-only path — `utilityProcess.fork` of the interpreter from INSIDE
// app.asar, under the Fuses (OnlyLoadAppFromAsar:true, RunAsNode:false) — is never
// exercised. This test launches the REAL packaged binary and proves that fork works.
//
// Why this is a direct child_process launch and NOT `electron.launch`: Playwright
// drives the Electron MAIN process over the Node inspector, which the production
// fuse `EnableNodeCliInspectArguments:false` disables — so `electron.launch` against
// the fused binary hangs forever and can never attach. We therefore launch the EXE
// directly (the genuine production binary, all fuses intact) and verify the
// fork-from-asar fact from the OS process tree + the app's own boot logs. The UI
// streaming/cancel paths run identical renderer+interpreter bundles and are already
// covered by `pnpm e2e`; the ONLY packaged delta is the asar-fork, verified here.

const EXE = packagedExePath();

/** Collected stdout+stderr text of a child, for log-line assertions. */
function captureOutput(child: ChildProcess): { text: () => string } {
  let buf = '';
  child.stdout?.on('data', (d: Buffer) => (buf += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (buf += d.toString()));
  return { text: () => buf };
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** Command lines of all live EZTerminal.exe processes (parent + child services). */
function ezterminalProcessCommandLines(): string {
  try {
    return execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='EZTerminal.exe'\" | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: 'utf8' },
    );
  } catch {
    return '';
  }
}

function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

test('packaged EXE: interpreter utilityProcess forks from app.asar under fuses', async () => {
  const child = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = captureOutput(child);
  let exitCode: number | null | undefined;
  child.on('exit', (code) => (exitCode = code));

  try {
    // 1) The packaged main process boots under the fuses and forks the interpreter
    //    from inside app.asar (not from disk).
    await waitFor(() => out.text().includes('[main] EZTerminal main process ready'), 30_000, 'main ready');
    await waitFor(
      () => /\[main\] spawning interpreter at:.*app\.asar/.test(out.text()),
      30_000,
      'interpreter forked from app.asar',
    );

    // 2) THE §9-P0 FACT: a real `utilityProcess.fork` node service exists as a child
    //    of the packaged EXE. If forking from asar had failed under the fuses, no
    //    `--type=utility --utility-sub-type=node*` process would be present.
    await waitFor(
      () => /--type=utility\s+--utility-sub-type=node/i.test(ezterminalProcessCommandLines()),
      20_000,
      'interpreter node utilityProcess present in the process tree',
    );

    // 3) No fork error / crash: the interpreter did not immediately exit, and the
    //    main process is still alive after a settle window.
    await new Promise((r) => setTimeout(r, 1500));
    expect(out.text(), 'interpreter must not have exited (fork error)').not.toMatch(
      /interpreter exited with code/,
    );
    expect(exitCode, 'packaged app must still be running').toBeUndefined();
  } finally {
    killTree(child.pid);
  }
});
