// M0 Stage-0 spike (measurement only — no production code touched): characterizes
// how an inbound Ctrl+C (\x03) is delivered to a raw-mode child under node-pty on
// Windows, across three spawn shapes and both ConPTY backends, so the M0 gate has
// real data instead of assumptions.
//
//   S1  direct node child                       (control: the proven-correct path)
//   S2  cmd.exe /d /s /c "<shim.cmd>"  → node   (the BUG shape: batch shim in group)
//   S3  de-sugared: node <survivor.js> directly (the PROPOSED FIX shape)
//
// each run twice: useConptyDll:true (bundled OpenConsole, app default) and false
// (OS ConPTY). The child (survivor.js) is a raw-mode reader that, on \x03, prints
// INTERRUPTED and STAYS ALIVE; on sentinel 'q' prints STILL-ALIVE then exit(0).
//
// Distinguishers recorded per run:
//   sawInterrupt          — child got \x03 as a BYTE (desired)
//   exitedOnCtrlC         — onExit fired right after \x03  (tree-kill, bug)
//   exitCodeOnCtrlC       — STATUS_CONTROL_C_EXIT = 0xC000013A (3221225786) ⇒ CTRL_C_EVENT
//   sawTerminateBatch     — cmd.exe printed "Terminate batch job (Y/N)?"
//   roundTripAfterCtrlC   — post-\x03 'q' round-tripped to STILL-ALIVE (alive AND responsive)
//
// Output: a results matrix to stdout. Fixtures are written to an OS temp dir (NOT
// committed to the repo) and cleaned up at the end.

import * as pty from 'node-pty';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STATUS_CONTROL_C_EXIT = 3221225786; // 0xC000013A

function resolveNodeExe() {
  // process.execPath is the running node — good enough for the spike.
  return process.execPath;
}

function makeFixtures() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ezterm-ctrlc-'));
  const jsPath = path.join(dir, 'survivor.js');
  const cmdPath = path.join(dir, 'survivor.cmd');

  // Raw-mode reader: announce READY, echo INTERRUPTED on \x03 (stay alive),
  // STILL-ALIVE + exit(0) on 'q'. Never exits on \x03 by itself — so if the
  // process dies right after \x03, something OUTSIDE the child (a CTRL_C_EVENT
  // to the group) killed it.
  const js = [
    "const out = process.stdout;",
    "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
    "process.stdin.resume();",
    "out.write('READY\\r\\n');",
    "process.stdin.on('data', (d) => {",
    "  for (const b of d) {",
    "    if (b === 0x03) { out.write('INTERRUPTED\\r\\n'); }",
    "    else if (b === 0x71 /* q */) { out.write('STILL-ALIVE\\r\\n'); process.exit(0); }",
    "  }",
    "});",
    "process.on('SIGINT', () => { out.write('GOT-SIGINT\\r\\n'); });",
    "setTimeout(() => { out.write('TIMEOUT-EXIT\\r\\n'); process.exit(3); }, 8000);",
  ].join('\n');
  writeFileSync(jsPath, js);

  // Batch shim that execs node on the survivor — the exact cmd.exe -> node.exe tree.
  const cmd = `@echo off\r\nnode "%~dp0survivor.js" %*\r\n`;
  writeFileSync(cmdPath, cmd);

  return { dir, jsPath, cmdPath };
}

const COLS = 80;
const ROWS = 24;

/** Run one scenario: spawn, wait for READY, send \x03, observe, then send 'q'. */
function runScenario({ label, file, args, useConptyDll }) {
  return new Promise((resolve) => {
    let acc = '';
    let ready = false;
    let exited = false;
    let exitCode = null;
    let ctrlCSentAt = null;
    let exitAfterCtrlCMs = null;
    let proc;

    const result = () => ({
      label,
      useConptyDll,
      sawInterrupt: /INTERRUPTED/.test(acc),
      sawStillAlive: /STILL-ALIVE/.test(acc),
      sawTerminateBatch: /Terminate batch job/i.test(acc),
      sawGotSigint: /GOT-SIGINT/.test(acc),
      exitedOnCtrlC: exitAfterCtrlCMs !== null && exitAfterCtrlCMs < 1500 && !/STILL-ALIVE/.test(acc),
      exitCode,
      exitCodeIsCtrlC: exitCode === STATUS_CONTROL_C_EXIT,
      roundTripAfterCtrlC: /STILL-ALIVE/.test(acc),
    });

    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd: path.dirname(file.endsWith('.exe') ? args[0] ?? file : file),
        env: cleanEnv(),
        encoding: null,
        useConptyDll,
      });
    } catch (err) {
      resolve({ label, useConptyDll, error: String(err) });
      return;
    }

    const hardStop = setTimeout(() => finish(), 10000);

    function finish() {
      clearTimeout(hardStop);
      try { proc.kill(); } catch { /* gone */ }
      resolve(result());
    }

    proc.onData((d) => {
      acc += Buffer.isBuffer(d) ? d.toString('latin1') : String(d);
      if (!ready && /READY/.test(acc)) {
        ready = true;
        // Send Ctrl+C shortly after the child is in raw mode.
        setTimeout(() => {
          ctrlCSentAt = Date.now();
          try { proc.write('\x03'); } catch { /* gone */ }
          // Then, after a grace period, send 'q' to test post-interrupt liveness.
          setTimeout(() => {
            try { proc.write('q'); } catch { /* gone */ }
            setTimeout(finish, 1200);
          }, 1200);
        }, 400);
      }
    });

    proc.onExit(({ exitCode: code }) => {
      exited = true;
      exitCode = code;
      if (ctrlCSentAt !== null) exitAfterCtrlCMs = Date.now() - ctrlCSentAt;
      // Give onData a tick to flush, then finish.
      setTimeout(finish, 100);
    });
  });
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return env;
}

function fmt(r) {
  if (r.error) return `${r.label} (conpty=${r.useConptyDll}): SPAWN ERROR — ${r.error}`;
  const verdict = r.roundTripAfterCtrlC
    ? 'SURVIVED (byte delivered, alive+responsive)'
    : r.exitCodeIsCtrlC
      ? 'TREE-KILL (CTRL_C_EVENT, exit 0xC000013A)'
      : r.exitedOnCtrlC
        ? 'DIED on Ctrl+C (no round-trip)'
        : 'INCONCLUSIVE';
  return [
    `${r.label} (conpty=${r.useConptyDll}): ${verdict}`,
    `    sawInterrupt=${r.sawInterrupt} roundTrip=${r.roundTripAfterCtrlC} terminateBatch=${r.sawTerminateBatch} gotSIGINT=${r.sawGotSigint} exitCode=${r.exitCode}`,
  ].join('\n');
}

async function main() {
  const nodeExe = resolveNodeExe();
  const { dir, jsPath, cmdPath } = makeFixtures();
  console.log(`[spike-ctrlc] node=${nodeExe}`);
  console.log(`[spike-ctrlc] fixtures in ${dir}\n`);

  const scenarios = [];
  for (const useConptyDll of [true, false]) {
    scenarios.push({ label: 'S1 direct-node    ', file: nodeExe, args: [jsPath], useConptyDll });
    scenarios.push({ label: 'S2 cmd.exe-shim   ', file: 'cmd.exe', args: `/d /s /c "${cmdPath}"`, useConptyDll });
    scenarios.push({ label: 'S3 de-sugared-node', file: nodeExe, args: [jsPath], useConptyDll });
  }

  const results = [];
  for (const s of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runScenario(s);
    console.log(fmt(r));
    results.push(r);
  }

  console.log('\n[spike-ctrlc] === GATE SUMMARY ===');
  const s1 = results.filter((r) => r.label.startsWith('S1'));
  const s2 = results.filter((r) => r.label.startsWith('S2'));
  const s3 = results.filter((r) => r.label.startsWith('S3'));
  const allSurvive = (rs) => rs.every((r) => r.roundTripAfterCtrlC);
  const anyKill = (rs) => rs.some((r) => r.exitCodeIsCtrlC || r.exitedOnCtrlC);
  console.log(`  S1 direct-node    survives both backends: ${allSurvive(s1)}`);
  console.log(`  S2 cmd.exe-shim   tree-kill observed:     ${anyKill(s2)}  (bug repro on THIS machine)`);
  console.log(`  S3 de-sugared     survives both backends: ${allSurvive(s3)}  (fix validation)`);
  console.log(
    allSurvive(s3)
      ? '  ⇒ GATE PASS: de-sugar path survives Ctrl+C. Proceed with M0 implementation.'
      : '  ⇒ GATE FAIL: de-sugar path did NOT survive — escalate (Candidate A insufficient).',
  );
  if (!anyKill(s2)) {
    console.log('  NOTE: S2 did not reproduce the tree-kill on THIS machine — final confirmation needs the affected PC.');
  }

  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

main().catch((err) => {
  console.error('[spike-ctrlc] FATAL', err);
  process.exit(1);
});
