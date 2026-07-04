import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LogFile, pruneCrashDumps } from './diagnostics';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-diag-'));
}

describe('LogFile — size-cap rotation (B-M5)', () => {
  it('appends timestamped lines, creating the directory on demand', () => {
    const dir = makeDir();
    const log = new LogFile(path.join(dir, 'logs', 'main.log'));
    log.line('interpreter exited with code 1');
    const text = readFileSync(log.path, 'utf8');
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T.* interpreter exited with code 1\n$/);
  });

  it('rotates to .1 once the cap is exceeded and keeps appending', () => {
    const dir = makeDir();
    const file = path.join(dir, 'main.log');
    const log = new LogFile(file, 64); // tiny cap for the test
    log.line('a'.repeat(80)); // first write: no rotation (file did not exist)
    log.line('second'); // file now over cap → rotated before this append
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('aaaa');
    expect(readFileSync(file, 'utf8')).toContain('second');
  });

  it('overwrites the previous .1 on the next rotation (bounded disk use)', () => {
    const dir = makeDir();
    const file = path.join(dir, 'main.log');
    const log = new LogFile(file, 32);
    log.line('gen-one'.repeat(10));
    log.line('gen-two'.repeat(10)); // rotation 1: .1 = gen-one
    log.line('gen-three'); // rotation 2: .1 = gen-two
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('gen-two');
    expect(readFileSync(file, 'utf8')).toContain('gen-three');
  });
});

describe('pruneCrashDumps (B-M5, keep-last-N)', () => {
  it('keeps the newest N .dmp files across nested dirs and removes the rest', async () => {
    const dir = makeDir();
    const nested = path.join(dir, 'reports');
    mkdirSync(nested, { recursive: true });
    const base = Date.now() / 1000 - 1000;
    for (let i = 0; i < 5; i++) {
      const file = path.join(i % 2 === 0 ? dir : nested, `crash-${i}.dmp`);
      writeFileSync(file, `dump ${i}`);
      utimesSync(file, base + i, base + i); // older index = older mtime
    }
    writeFileSync(path.join(dir, 'not-a-dump.txt'), 'kept');

    await pruneCrashDumps(dir, 2);

    const survivors = [0, 1, 2, 3, 4].filter((i) =>
      existsSync(path.join(i % 2 === 0 ? dir : nested, `crash-${i}.dmp`)),
    );
    expect(survivors).toEqual([3, 4]); // newest two
    expect(existsSync(path.join(dir, 'not-a-dump.txt'))).toBe(true); // non-dumps untouched
  });

  it('is a no-op on a missing directory', async () => {
    await expect(pruneCrashDumps(path.join(makeDir(), 'nope'))).resolves.toBeUndefined();
  });
});
