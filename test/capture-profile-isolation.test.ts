import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PROFILE_COPY_SKIP,
  inertPath,
  providerDescendants,
  repositoryFingerprint,
  sanitizeCopiedDatabase,
} from '../scripts/capture-profile-isolation.mjs';

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedDatabase(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, executable_path TEXT NOT NULL,
      health TEXT NOT NULL CHECK (health IN ('unknown', 'ready', 'unavailable', 'incompatible', 'error')), health_detail TEXT) STRICT;
    CREATE TABLE schedules (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))) STRICT;
    CREATE TABLE command_outbox (command_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'applied', 'delivery-uncertain', 'failed')), detail TEXT) STRICT;
    INSERT INTO providers VALUES ('codex', 'C:/Users/me/AppData/Roaming/npm/codex.cmd', 'ready', NULL);
    INSERT INTO providers VALUES ('claude', 'C:/Users/me/.local/bin/claude.exe', 'ready', NULL);
    INSERT INTO schedules VALUES ('nightly', 1);
    INSERT INTO command_outbox VALUES ('a', 'pending', NULL), ('b', 'sent', NULL), ('c', 'delivery-uncertain', NULL), ('d', 'applied', NULL);
    CREATE TABLE planning_execution_projects (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
    CREATE TABLE planning_execution_runs (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state_json TEXT NOT NULL) STRICT;
    CREATE TABLE planning_execution_attempt_refs (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL) STRICT;
    CREATE TABLE planning_execution_receipts (receipt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL) STRICT;
    INSERT INTO planning_execution_projects VALUES ('p', 3);
    INSERT INTO planning_execution_runs VALUES ('run-1', 'p', '{}'), ('run-2', 'p', '{}');
    INSERT INTO planning_execution_attempt_refs VALUES ('attempt-1', 'run-1');
    INSERT INTO planning_execution_receipts VALUES ('receipt-1', 'run-1');
  `);
  db.close();
}

describe('capture profile isolation', () => {
  it('never copies state that would act on the real repositories or real credentials', () => {
    for (const entry of [
      'managed-merge-candidates', 'managed-merge-candidates.json', 'project-map-jobs.json', 'orchestration-recovery',
      'remote-token.json', 'orchestration.sqlite3', 'orchestration.sqlite3-wal', 'orchestration.sqlite3-shm',
    ]) expect(PROFILE_COPY_SKIP.has(entry), entry).toBe(true);
  });

  it('points every provider at a missing executable, stops schedules and settles pending commands', () => {
    const root = scratch('ezterminal-capture-db-');
    const file = join(root, 'orchestration.sqlite3');
    const inert = join(root, 'inert-providers');
    seedDatabase(file);

    const summary = sanitizeCopiedDatabase(file, inert);
    expect(summary.planningRuns).toBe(2);

    expect(summary.originalProviderPaths).toEqual([
      'C:/Users/me/.local/bin/claude.exe',
      'C:/Users/me/AppData/Roaming/npm/codex.cmd',
    ]);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const providers = db.prepare('SELECT id, executable_path, health FROM providers ORDER BY id').all() as { id: string; executable_path: string; health: string }[];
      for (const provider of providers) {
        expect(provider.executable_path.startsWith(inert)).toBe(true);
        expect(existsSync(provider.executable_path)).toBe(false);
        expect(provider.health).toBe('unavailable');
      }
      expect(db.prepare('SELECT enabled FROM schedules').all()).toEqual([{ enabled: 0 }]);
      // A recovered run can integrate results into the real repository without any provider: none survive.
      for (const table of ['planning_execution_projects', 'planning_execution_runs', 'planning_execution_attempt_refs', 'planning_execution_receipts']) {
        expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }
      expect(db.prepare('SELECT command_id, state FROM command_outbox ORDER BY command_id').all()).toEqual([
        { command_id: 'a', state: 'failed' },
        { command_id: 'b', state: 'failed' },
        { command_id: 'c', state: 'failed' },
        { command_id: 'd', state: 'applied' },
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps provider CLIs off PATH so CLI-history readers cannot start the real CLI', () => {
    const present = new Set([join(String.raw`C:\npm`, 'codex.cmd'), join(String.raw`C:\tools`, 'claude.exe')]);
    const exists = (file: string): boolean => present.has(file);
    expect(inertPath(String.raw`C:\Windows;C:\npm;C:\tools;C:\git\cmd`, exists)).toBe(String.raw`C:\Windows;C:\git\cmd`);
  });

  it('flags only provider processes that descend from the launched app', () => {
    const processes = [
      { pid: 10, ppid: 1, name: 'electron.exe', executablePath: 'C:/repo/node_modules/electron/dist/electron.exe', commandLine: 'electron.exe main.js' },
      { pid: 11, ppid: 10, name: 'electron.exe', executablePath: 'C:/repo/node_modules/electron/dist/electron.exe', commandLine: 'electron.exe --type=renderer' },
      { pid: 12, ppid: 11, name: 'cmd.exe', executablePath: 'C:/Windows/System32/cmd.exe', commandLine: 'cmd.exe /d /s /c "C:/Users/me/AppData/Roaming/npm/codex.cmd app-server"' },
      { pid: 13, ppid: 10, name: 'pwsh.exe', executablePath: 'C:/Program Files/PowerShell/7/pwsh.exe', commandLine: 'pwsh.exe -NoLogo' },
      { pid: 14, ppid: 13, name: 'claude.exe', executablePath: 'C:/Users/me/.local/bin/claude.exe', commandLine: 'claude.exe --resume abc' },
      // The user's own installed app runs Codex too: not a descendant, never flagged.
      { pid: 20, ppid: 1, name: 'EZTerminal.exe', executablePath: 'C:/Program Files/EZTerminal/EZTerminal.exe', commandLine: 'EZTerminal.exe' },
      { pid: 21, ppid: 20, name: 'codex.exe', executablePath: 'C:/Users/me/AppData/Roaming/npm/node_modules/codex/codex.exe', commandLine: 'codex.exe app-server' },
    ];

    const flagged = providerDescendants(processes, 10, ['C:/Users/me/AppData/Roaming/npm/codex.cmd', 'C:/Users/me/.local/bin/claude.exe']);

    expect(flagged.map((entry) => entry.pid)).toEqual([12, 14]);
  });

  it('fingerprints branches, HEAD and worktrees but not ordinary file edits', () => {
    const repo = scratch('ezterminal-capture-repo-');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'capture@example.invalid');
    git('config', 'user.name', 'capture');
    writeFileSync(join(repo, 'a.txt'), 'one');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'one');

    const before = repositoryFingerprint(repo);
    writeFileSync(join(repo, 'a.txt'), 'edited by the user while capturing');
    expect(repositoryFingerprint(repo)).toBe(before);

    git('worktree', 'add', '-q', '-b', 'side', join(scratch('ezterminal-capture-wt-'), 'side'));
    expect(repositoryFingerprint(repo)).not.toBe(before);
  });
});
