// M0a spike (measurement only — no production code touched): records the raw byte
// sequences representative CLIs emit under a real ConPTY, so the M0b Codex gate has
// real data instead of assumptions about which DEC private-mode signals are safe
// upgrade triggers for the adaptive-render design (see .omc/plans/cli-parity-auto-pty.md).
//
// Batch shims (claude.cmd / codex.cmd) are launched via a one-off `cmd.exe /c <path>`
// spawn — `buildCmdLine` doesn't exist yet (that's M1), so this intentionally does not
// depend on it (no circular dependency with the plan's own M1 step).
//
// Outputs:
//   .omc/research/captures/<name>.raw  — concatenated raw bytes
//   .omc/research/captures/<name>.hex  — timestamped chunks, escaped for readability
//   stdout — per-command signal counts + spawn-latency summary (fed into the report)

import * as pty from 'node-pty';
import crossSpawn from 'cross-spawn';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CAPTURES_DIR = path.join(ROOT, '.omc', 'research', 'captures');
mkdirSync(CAPTURES_DIR, { recursive: true });

const COLS = 80;
const ROWS = 24;
const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function resolveOnPath(cmd) {
  const result = spawnSync('where', [cmd], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (
    result.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0] ?? null
  );
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Spawn one command under a real ConPTY and capture raw bytes with timestamps. */
function capturePty({
  file,
  args,
  cwd,
  durationMs = DEFAULT_DURATION_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  inputs = [],
}) {
  return new Promise((resolve) => {
    const chunks = [];
    const start = performance.now();
    let totalBytes = 0;
    let proc;
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd,
        env: cleanEnv(),
        encoding: null,
      });
    } catch (err) {
      resolve({ error: String(err), chunks: [], endedReason: 'spawn-failed', totalBytes: 0 });
      return;
    }

    let done = false;
    const inputTimers = inputs.map(({ afterMs, data }) =>
      setTimeout(() => {
        try {
          proc.write(data);
        } catch {
          // process may have already exited
        }
      }, afterMs),
    );

    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const t of inputTimers) clearTimeout(t);
      try {
        proc.kill();
      } catch {
        // already exited
      }
      resolve({ chunks, endedReason: reason, totalBytes, wallMs: performance.now() - start });
    };

    const timer = setTimeout(() => finish('timeout'), durationMs);

    proc.onData((d) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8');
      chunks.push({ tMs: performance.now() - start, bytes: buf });
      totalBytes += buf.length;
      if (totalBytes >= maxBytes) finish('max-bytes');
    });

    proc.onExit(({ exitCode }) => finish(`exit:${exitCode}`));
  });
}

function escapeVisual(buf) {
  let s = '';
  for (const byte of buf) {
    if (byte === 0x1b) s += '\\x1b';
    else if (byte === 0x0d) s += '\\r';
    else if (byte === 0x0a) s += '\\n\n';
    else if (byte === 0x07) s += '\\a';
    else if (byte === 0x09) s += '\\t';
    else if (byte >= 0x20 && byte < 0x7f) s += String.fromCharCode(byte);
    else s += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return s;
}

function saveCaptures(name, result) {
  const raw = Buffer.concat(result.chunks.map((c) => c.bytes));
  writeFileSync(path.join(CAPTURES_DIR, `${name}.raw`), raw);
  let hex = `# ${name} — endedReason=${result.endedReason} totalBytes=${result.totalBytes} wallMs=${(result.wallMs ?? 0).toFixed(1)}\n`;
  for (const { tMs, bytes } of result.chunks) {
    hex += `\n--- chunk t=${tMs.toFixed(1)}ms len=${bytes.length} ---\n`;
    hex += escapeVisual(bytes) + '\n';
  }
  writeFileSync(path.join(CAPTURES_DIR, `${name}.hex`), hex);
  return raw;
}

const SIGNAL_PATTERNS = {
  altScreen_1049: /\x1b\[\?1049[hl]/g,
  altScreen_47: /\x1b\[\?47[hl]/g,
  cursorHide_25: /\x1b\[\?25[hl]/g,
  mouseTracking: /\x1b\[\?(1000|1001|1002|1003|1004|1005|1006)[hl]/g,
  bracketedPaste_2004: /\x1b\[\?2004[hl]/g,
  appCursorKeys_1: /\x1b\[\?1[hl]/g,
  cursorUp_CSInA: /\x1b\[\d*A/g,
  absolutePos_CSIrcH: /\x1b\[\d+;\d+[Hf]/g,
  eraseInLine: /\x1b\[[0-2]?K/g,
};

function analyze(raw) {
  const text = raw.toString('latin1');
  const found = {};
  for (const [key, re] of Object.entries(SIGNAL_PATTERNS)) {
    const matches = text.match(re) ?? [];
    found[key] = { count: matches.length, samples: [...new Set(matches)].slice(0, 5) };
  }
  found.bareCarriageReturn = { count: (text.match(/\r(?!\n)/g) ?? []).length };
  return found;
}

/** git --version via node-pty vs cross-spawn, N iterations each: ms to first byte. */
async function measureSpawnLatency(file, args, cwd, iterations = 5) {
  const ptyLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const ms = await new Promise((resolve) => {
      let resolved = false;
      const p = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols: COLS,
        rows: ROWS,
        cwd,
        env: cleanEnv(),
        encoding: null,
      });
      p.onData(() => {
        if (!resolved) {
          resolved = true;
          resolve(performance.now() - t0);
        }
      });
      p.onExit(() => {
        if (!resolved) {
          resolved = true;
          resolve(-1);
        }
      });
    });
    ptyLatencies.push(ms);
  }

  const crossSpawnLatencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const ms = await new Promise((resolve) => {
      let resolved = false;
      const child = crossSpawn(file, args, { cwd, env: cleanEnv() });
      child.stdout.once('data', () => {
        if (!resolved) {
          resolved = true;
          resolve(performance.now() - t0);
        }
      });
      child.on('exit', () => {
        if (!resolved) {
          resolved = true;
          resolve(-1);
        }
      });
    });
    crossSpawnLatencies.push(ms);
  }

  return { ptyLatencies, crossSpawnLatencies };
}

async function run(name, spec) {
  console.log(`\n[spike] === ${name} ===`);
  const result = await capturePty(spec);
  if (result.error) {
    console.log(`[spike] ${name}: SPAWN FAILED — ${result.error}`);
    return { name, skipped: true, reason: result.error };
  }
  const raw = saveCaptures(name, result);
  const signals = analyze(raw);
  console.log(
    `[spike] ${name}: endedReason=${result.endedReason} bytes=${result.totalBytes} wallMs=${(result.wallMs ?? 0).toFixed(1)}`,
  );
  for (const [key, v] of Object.entries(signals)) {
    if (v.count > 0) console.log(`  ${key}: count=${v.count} samples=${JSON.stringify(v.samples ?? '')}`);
  }
  return { name, result, signals };
}

async function main() {
  const targets = [];

  // 1. claude (ink) — batch shim, one-off cmd.exe /c launch (no buildCmdLine dependency).
  const claudeCmd = resolveOnPath('claude.cmd') ?? resolveOnPath('claude');
  if (claudeCmd) {
    targets.push([
      'claude',
      { file: 'cmd.exe', args: ['/c', claudeCmd], cwd: ROOT, durationMs: 10_000 },
    ]);
  } else {
    console.log('[spike] claude: NOT FOUND on PATH — skipped');
  }

  // 2. codex (ratatui) — same pattern.
  const codexCmd = resolveOnPath('codex.cmd') ?? resolveOnPath('codex');
  if (codexCmd) {
    targets.push([
      'codex',
      { file: 'cmd.exe', args: ['/c', codexCmd], cwd: ROOT, durationMs: 10_000 },
    ]);
  } else {
    console.log('[spike] codex: NOT FOUND on PATH — skipped');
  }

  // 3. npm install progress bar (single-line spinner-style renderer).
  const npmCmd = resolveOnPath('npm.cmd') ?? resolveOnPath('npm');
  if (npmCmd) {
    const npmDir = mkdtempSync(path.join(tmpdir(), 'ezterm-spike-npm-'));
    try {
      spawnSync(npmCmd, ['init', '-y'], { cwd: npmDir, stdio: 'ignore' });
      targets.push([
        'npm-install',
        { file: 'cmd.exe', args: ['/c', npmCmd, 'install', 'left-pad'], cwd: npmDir, durationMs: 20_000 },
      ]);
    } catch (err) {
      console.log(`[spike] npm-install: setup failed — ${err}`);
    }
  }

  // 4. pnpm add progress renderer (multi-line, different from npm's).
  const pnpmCmd = resolveOnPath('pnpm.cmd') ?? resolveOnPath('pnpm');
  if (pnpmCmd) {
    const pnpmDir = mkdtempSync(path.join(tmpdir(), 'ezterm-spike-pnpm-'));
    try {
      spawnSync(pnpmCmd, ['init'], { cwd: pnpmDir, stdio: 'ignore' });
      targets.push([
        'pnpm-add',
        { file: 'cmd.exe', args: ['/c', pnpmCmd, 'add', 'left-pad'], cwd: pnpmDir, durationMs: 20_000 },
      ]);
    } catch (err) {
      console.log(`[spike] pnpm-add: setup failed — ${err}`);
    }
  }

  // 5. git status --color=always — instant, plain, no pager.
  const gitExe = resolveOnPath('git.exe') ?? resolveOnPath('git');
  if (gitExe) {
    targets.push([
      'git-status-color',
      { file: gitExe, args: ['status', '--color=always'], cwd: ROOT, durationMs: 5_000 },
    ]);

    // 6. git log — pager (alt-screen candidate).
    targets.push(['git-log-pager', { file: gitExe, args: ['log'], cwd: ROOT, durationMs: 8_000 }]);

    // 10. instant-exit plain command.
    targets.push([
      'git-version-instant',
      { file: gitExe, args: ['--version'], cwd: ROOT, durationMs: 3_000 },
    ]);
  }

  // 7. node REPL — line-buffered input via write().
  const nodeExe = resolveOnPath('node.exe') ?? resolveOnPath('node');
  if (nodeExe) {
    targets.push([
      'node-repl',
      {
        file: nodeExe,
        args: [],
        cwd: ROOT,
        durationMs: 5_000,
        inputs: [
          { afterMs: 800, data: '1+1\r' },
          { afterMs: 1600, data: '.exit\r' },
        ],
      },
    ]);

    // 9. line-oriented readline prompt (B-R4 case: input-wait rendering).
    targets.push([
      'node-readline-prompt',
      {
        file: nodeExe,
        args: [
          '-e',
          "const r=require('readline').createInterface({input:process.stdin,output:process.stdout});r.question('name? ',a=>{console.log('hi '+a);r.close()})",
        ],
        cwd: ROOT,
        durationMs: 4_000,
        inputs: [{ afterMs: 700, data: 'EZTerminal\r' }],
      },
    ]);

    // 11. credential-style hidden-echo prompt. SUBSTITUTE for `git push`: a real
    // `git push` risks an unintended push to the actual GitHub remote for this repo
    // (or hangs on real network auth), so this simulates git's masked-input credential
    // prompt shape with a local script instead — same line-oriented-prompt signal
    // shape without touching the real remote. Documented in the report.
    targets.push([
      'credential-prompt-simulated',
      {
        file: nodeExe,
        args: [
          '-e',
          "process.stdout.write('Password for \\'https://github.com\\': ');process.stdin.setRawMode&&process.stdin.setRawMode(true);let buf='';process.stdin.on('data',d=>{if(d[0]===13){process.stdout.write('\\r\\n');process.exit(0);}buf+=d;});",
        ],
        cwd: ROOT,
        durationMs: 3_000,
        inputs: [{ afterMs: 700, data: 'hunter2\r' }],
      },
    ]);
  }

  // 8. python REPL.
  const pythonExe = resolveOnPath('python.exe') ?? resolveOnPath('python');
  if (pythonExe) {
    targets.push([
      'python-repl',
      {
        file: pythonExe,
        args: [],
        cwd: ROOT,
        durationMs: 5_000,
        inputs: [
          { afterMs: 1000, data: '1+1\r' },
          { afterMs: 2000, data: 'exit()\r' },
        ],
      },
    ]);
  } else {
    console.log('[spike] python: NOT FOUND on PATH — skipped');
  }

  const results = [];
  for (const [name, spec] of targets) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await run(name, spec));
  }

  // Spawn latency: git --version via node-pty vs cross-spawn, 5 iterations each.
  if (gitExe) {
    console.log('\n[spike] === spawn latency: git --version (pty vs cross-spawn) ===');
    const latency = await measureSpawnLatency(gitExe, ['--version'], ROOT, 5);
    console.log(`  pty ms-to-first-byte: ${JSON.stringify(latency.ptyLatencies.map((n) => Math.round(n)))}`);
    console.log(
      `  cross-spawn ms-to-first-byte: ${JSON.stringify(latency.crossSpawnLatencies.map((n) => Math.round(n)))}`,
    );
    writeFileSync(
      path.join(CAPTURES_DIR, 'spawn-latency.json'),
      JSON.stringify(latency, null, 2),
    );
  }

  console.log('\n[spike] done. Captures in .omc/research/captures/');
  console.log(
    JSON.stringify(
      results.map((r) => ({ name: r.name, skipped: !!r.skipped, endedReason: r.result?.endedReason })),
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[spike] FATAL', err);
  process.exit(1);
});
