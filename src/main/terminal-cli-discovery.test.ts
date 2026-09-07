import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { terminalCliInstalled } from './terminal-cli-discovery';

it('recognizes an older npm CLI shim without executing it or requiring an SDK-compatible version', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'terminal-cli-'));
  try {
    writeFileSync(path.join(directory, 'claude.cmd'), '@echo Claude Code 1.0.0');
    writeFileSync(path.join(directory, 'codex.cmd'), '@echo codex-cli 0.1.0');
    expect(terminalCliInstalled('claude', { Path: `"${directory}"` }, 'win32')).toBe(true);
    expect(terminalCliInstalled('codex', { Path: directory }, 'win32')).toBe(true);
    expect(terminalCliInstalled('missing', { PATH: directory }, 'win32')).toBe(false);
    expect(terminalCliInstalled('codex', { PATH: '' }, 'win32')).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
