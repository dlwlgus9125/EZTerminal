import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  OutputRetentionRuntime,
  pruneOrphanRuntimeDirectories,
} from './output-retention-runtime';

const roots: string[] = [];
const runtimes: OutputRetentionRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.cleanupSync();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ezterminal-retention-runtime-test-'));
  roots.push(root);
  return root;
}

describe('OutputRetentionRuntime lifecycle', () => {
  it('prunes a dead-PID runtime directory without touching the current process', () => {
    const base = tempRoot();
    const orphan = join(base, 'runtime-2147483647-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const current = join(
      base,
      `runtime-${process.pid}-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    );
    mkdirSync(orphan);
    mkdirSync(current);

    pruneOrphanRuntimeDirectories(base);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(current)).toBe(true);
  });

  it('removes its complete random runtime tree on cleanup', () => {
    const runtime = new OutputRetentionRuntime({
      baseDirectory: tempRoot(),
      registerExitCleanup: false,
    });
    runtimes.push(runtime);
    const run = runtime.createRunDirectory();

    expect(existsSync(runtime.directory)).toBe(true);
    expect(existsSync(run)).toBe(true);
    runtime.cleanupSync();
    expect(existsSync(runtime.directory)).toBe(false);
  });
});
