import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';

import { packagedExePath } from './paths';

// ── Phase 2 PTY: packaged native-module proof ───────────────────────────────────
//
// The packaging risk (project memory): node-pty's native binaries work in DEV (no
// asar) but can be MISSING/broken ONLY in the packaged app — Forge+Vite ships no
// node_modules, so node-pty is brought in by a packageAfterPrune hook and kept on
// disk by asar.unpack. `guard:native` (run in global-setup) proves the files EXIST;
// this test proves they LOAD + FUNCTION: it requires node-pty from the packaged
// `app.asar.unpacked` tree and spawns a real PTY. The NAPI .node load + ConPTY
// spawn here exercise the identical resolution the packaged interpreter uses.
//
// (Driving the PTY through the fused EXE's UI is impossible — Playwright needs the
// Node inspector that `EnableNodeCliInspectArguments:false` disables, and
// `RunAsNode:false` blocks running the EXE as Node. So we load the packaged module
// directly in the test runner; the interpreter-fork-from-asar fact is covered by
// packaged-smoke.spec.ts and the live renderer round-trip by e2e/pty.spec.ts.)

const require = createRequire(__filename);

function unpackedNodePtyDir(): string {
  return path.join(
    path.dirname(packagedExePath()),
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
  );
}

test('packaged node-pty: loads from app.asar.unpacked and spawns a working PTY', async () => {
  const dir = unpackedNodePtyDir();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require(dir) as typeof import('node-pty');

  const marker = `PKG_PTY_OK_${process.pid}`;
  const proc = pty.spawn(
    process.execPath,
    ['-e', `process.stdout.write(${JSON.stringify(marker)})`],
    {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    },
  );

  const output = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`packaged PTY spawn timed out; got: ${JSON.stringify(buf)}`)),
      15_000,
    );
    proc.onData((d) => {
      buf += d;
    });
    proc.onExit(() => {
      clearTimeout(timer);
      resolve(buf);
    });
  });

  expect(output).toContain(marker);
});

// Stage C (gate B4): prove pause()/resume() backpressure on the REAL packaged
// native stack (ConPTY worker hop — gate F1′). The dev e2e proves the
// app-level ack protocol; only this packaged run proves the native pause
// propagation the whole design rests on.
//
// Empirically confirmed 2026-07-02 on this packaged stack (two wedge runs):
//   (a) pause() is real native backpressure — a firehose child genuinely
//       blocks (received count stops growing, ~0 CPU) through the worker
//       pipe hop (gate F1′ confirmed).
//   (b) In THIS plain-node runner process, calling kill() on a firehose PTY
//       with stuffed pipes synchronously WEDGES the event loop — raw
//       kill-while-paused AND resume-immediately-then-kill both froze so hard
//       that neither the test's own 10s exit race nor Playwright's 180s test
//       timeout ever fired (ClosePseudoConsole blocks until the conout pipe
//       drains, and the drainer is the very event loop the call blocks).
// The APP's teardown is NOT this path: inside the Electron utilityProcess the
// identical resume-then-kill contract (pty-session.ts `resumeThenKill`,
// pty-runner.ts `killOnce`) passes the same scenario live — the dev e2e
// firehose test cancels a paused firehose and reaches `cancelled` in <5s.
// So in-suite we terminate the child COOPERATIVELY (Ctrl+C through the pty —
// input flows on a separate socket even while paused) and never call kill()
// on a hot firehose from this runner: that probe cannot fail gracefully.
test('packaged node-pty: pause() freezes and resume() restores a firehose; Ctrl+C exits', async () => {
  const dir = unpackedNodePtyDir();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require(dir) as typeof import('node-pty');

  const proc = pty.spawn(
    process.execPath,
    ['-e', `for(;;)process.stdout.write('y'.repeat(8192))`],
    {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    },
  );

  let received = 0;
  let exited = false;
  proc.onData((d) => {
    received += d.length;
  });
  const exitPromise = new Promise<void>((resolve) => {
    proc.onExit(() => {
      exited = true;
      resolve();
    });
  });
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // Firehose is really flowing…
  const deadline = Date.now() + 10_000;
  while (received < 256 * 1024 && Date.now() < deadline) await sleep(100);
  expect(received).toBeGreaterThan(256 * 1024);

  // …pause, let in-flight buffers (worker pipe hop) drain, then assert FROZEN.
  proc.pause();
  await sleep(1_000);
  const afterSettle = received;
  await sleep(2_000);
  expect(received).toBe(afterSettle); // no growth while paused = real backpressure
  expect(exited).toBe(false);

  // resume() restores the flow — the other half of the backpressure contract.
  proc.resume();
  const resumedFrom = received;
  const flowDeadline = Date.now() + 10_000;
  while (received <= resumedFrom && Date.now() < flowDeadline) await sleep(100);
  expect(received).toBeGreaterThan(resumedFrom);

  // Cooperative termination (see header comment): Ctrl+C through the pty ends
  // the child; onExit then fires with nothing left for kill() to wedge on.
  proc.write('\x03');
  await Promise.race([
    exitPromise,
    sleep(10_000).then(() => {
      throw new Error('onExit did not fire within 10s after Ctrl+C');
    }),
  ]);
  expect(exited).toBe(true);
});
