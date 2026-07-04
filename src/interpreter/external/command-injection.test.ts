import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandResolver } from './command-resolver';
import { runProcess, type RunOptions, type SpawnFn } from './process-runner';

// ── SEC-HIGH-1 regression: command injection via .bat/.cmd arguments ────────────
//
// PoC shape (reviewer): an external `.cmd`/`.bat` target is invoked with an arg
// like `foo&echo INJECTED`. The OLD path returned `cmd.exe /d /s /c <file> <args>`
// and spawned it with no escaping, so cmd.exe treated the `&`/`|`/`>` as command
// separators/redirects → a SECOND command executed (a side-effect/marker file).
//
// The FIX routes spawning through cross-spawn (the default SpawnFn), which wraps
// `.bat`/`.cmd` in cmd.exe AND `^`-escapes every metachar, so the arg is passed
// literally and NO injected command runs.
//
// These tests run real cmd.exe + a real .cmd, so they only run on Windows.
const onWindows = process.platform === 'win32';

let dir: string;
let target: string; // the .cmd we invoke
let marker: string; // the file an injected command would create

function opts(signal: AbortSignal): RunOptions {
  // killTree:true mirrors how external-command runs a shell (.cmd) target.
  return { cwd: dir, env: process.env, signal, killTree: true };
}

async function drain(bytes: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of bytes) out += decoder.decode(chunk, { stream: true });
  out += decoder.decode();
  return out;
}

/** A deliberately-naive, VULNERABLE spawner that mimics the OLD cmd.exe wrapping
 *  (no escaping). Used only to PROVE each payload is genuinely dangerous. */
const naiveCmdSpawn: SpawnFn = (file, args, options) =>
  nodeSpawn('cmd.exe', ['/d', '/s', '/c', file, ...args], options);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ezterm-inject-'));
  target = join(dir, 'target.cmd');
  marker = join(dir, 'INJECTED.txt');
  // The script does NOT echo %* / %1 (that would be a separate, in-script %1
  // injection that no spawner can prevent). It just proves it ran. The security
  // question is purely: did a command beyond `target.cmd` execute at the spawn
  // boundary (i.e. was the marker created)?
  await writeFile(target, '@echo off\r\necho BATRAN\r\n');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Each payload tries to run `echo INJECTED > marker` as a smuggled second command.
// `make` is built lazily from the live marker path (assigned in beforeAll).
const payloads: ReadonlyArray<{ name: string; make: (m: string) => string }> = [
  { name: 'ampersand (&)', make: (m) => `foo&echo INJECTED>${m}` },
  { name: 'pipe (|)', make: (m) => `foo|echo INJECTED>${m}` },
  { name: 'quote breakout ("&...&")', make: (m) => `"&echo INJECTED>${m}&"` },
];

describe.skipIf(!onWindows)('command injection via .bat/.cmd args (SEC-HIGH-1)', () => {
  // Sanity: the payloads are genuinely exploitable through a naive `cmd.exe` spawn
  // (the OLD path — no escaping; the quote-breakout in particular defeats Node's
  // own arg quoting, the documented CVE-2024-27980 vector). This proves the
  // safe-path assertions below are meaningful, not vacuously true.
  it('CONTROL: the naive (old) spawner IS exploitable — a marker gets created', async () => {
    let anyFired = false;
    for (const p of payloads) {
      await rm(marker, { force: true });
      const proc = runProcess(target, [p.make(marker)], opts(new AbortController().signal), naiveCmdSpawn);
      await drain(proc.bytes);
      await proc.exit;
      if (existsSync(marker)) anyFired = true;
    }
    await rm(marker, { force: true });
    expect(anyFired).toBe(true); // the unescaped cmd.exe path IS injectable
  });

  for (const { name, make } of payloads) {
    it(`is SAFE through cross-spawn: ${name} — no injected command runs`, async () => {
      await rm(marker, { force: true });
      const arg = make(marker);

      // Full seam: resolve the .cmd, then run it through the DEFAULT spawner
      // (cross-spawn) exactly as production does.
      const spec = new CommandResolver({ PATH: dir, PATHEXT: '.CMD;.BAT' }).resolve('target', [arg]);
      expect(spec).not.toBeNull();
      expect(spec!.shell).toBe(true);

      const proc = runProcess(spec!.file, spec!.args, opts(new AbortController().signal));
      const out = await drain(proc.bytes);
      await proc.exit;

      // The script ran (so the arg WAS delivered) ...
      expect(out).toContain('BATRAN');
      // ... but the smuggled `echo INJECTED > marker` did NOT execute.
      expect(existsSync(marker)).toBe(false);
    });
  }
});
