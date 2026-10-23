/*
 * Isolation for real-app captures that run against a COPY of the user's
 * profile. A copied database still names the user's real repositories and
 * real provider sessions, so a copy that starts like a normal profile would
 * resume conversations, replay queued commands, run schedules or clean up
 * worktrees in the real folders. These helpers keep the copy inert and let
 * the capture prove it stayed inert.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Profile entries a capture copy must not carry over. */
export const PROFILE_COPY_SKIP = new Set([
  // Caches, locks, logs.
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage',
  'Shared Dictionary', 'DevToolsActivePort', 'lockfile', 'logs', 'Network', 'Partitions', 'Session Storage',
  'SharedStorage', 'SharedStorage-wal', 'DIPS', 'DIPS-wal', 'Dictionaries',
  // Credentials.
  'remote-token.json', 'remote-token.json.corrupt',
  // Snapshotted separately with VACUUM INTO.
  'orchestration.sqlite3', 'orchestration.sqlite3-wal', 'orchestration.sqlite3-shm',
  // Startup work that acts on the real repositories: merge-candidate cleanup runs
  // `git worktree remove` there, recovery records re-create worktrees, and
  // Project Map jobs write into the project folder.
  'managed-merge-candidates', 'managed-merge-candidates.json', 'orchestration-recovery', 'project-map-jobs.json',
]);

const PROVIDER_PROCESS_NAME = /^(?:codex|claude)(?:\.exe|\.cmd)?$/iu;
const PLANNING_EXECUTION_TABLES = [
  'planning_execution_receipts',
  'planning_execution_attempt_refs',
  'planning_execution_runs',
  'planning_execution_projects',
];

function normalize(value) {
  return String(value ?? '').replaceAll('\\', '/').toLowerCase();
}

function hasTable(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/**
 * Makes a copied orchestration database unable to start work: every provider
 * points at an executable that does not exist, schedules are off, and commands
 * that were waiting to be delivered are settled as failed instead of replayed.
 */
export function sanitizeCopiedDatabase(file, inertDirectory) {
  const db = new DatabaseSync(file);
  try {
    const originalProviderPaths = [];
    let providers = 0;
    let schedules = 0;
    let outbox = 0;
    if (hasTable(db, 'providers')) {
      const rows = db.prepare('SELECT id, executable_path FROM providers').all();
      const update = db.prepare("UPDATE providers SET executable_path = ?, health = 'unavailable', health_detail = ? WHERE id = ?");
      for (const row of rows) {
        originalProviderPaths.push(row.executable_path);
        const safeId = String(row.id).replace(/[^\w.-]/gu, '_');
        update.run(path.join(inertDirectory, `${safeId}.capture-disabled.exe`), 'Capture copy: provider execution disabled.', row.id);
        providers += 1;
      }
    }
    if (hasTable(db, 'schedules')) {
      schedules = Number(db.prepare('UPDATE schedules SET enabled = 0 WHERE enabled = 1').run().changes);
    }
    if (hasTable(db, 'command_outbox')) {
      outbox = Number(db.prepare(
        "UPDATE command_outbox SET state = 'failed', detail = 'Capture copy: not replayed.' WHERE state IN ('pending', 'sent', 'delivery-uncertain')",
      ).run().changes);
    }
    // A recovered subproject run can prepare worktrees, apply artifacts, run validation and
    // integrate into the real repository without starting any provider. The copy keeps none.
    let planningRuns = 0;
    for (const table of PLANNING_EXECUTION_TABLES) {
      if (!hasTable(db, table)) continue;
      const deleted = Number(db.prepare(`DELETE FROM ${table}`).run().changes);
      if (table === 'planning_execution_runs') planningRuns = deleted;
    }
    return { originalProviderPaths: originalProviderPaths.sort(), providers, schedules, outbox, planningRuns };
  } finally {
    db.close();
  }
}

/** Project and workspace roots named by a (copied) orchestration database. */
export function repositoryRoots(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const roots = new Set();
    for (const table of ['projects', 'workspaces']) {
      if (!hasTable(db, table)) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      if (!columns.includes('root_path')) continue;
      for (const row of db.prepare(`SELECT root_path AS root FROM ${table}`).all()) if (row.root) roots.add(row.root);
    }
    return [...roots].sort();
  } finally {
    db.close();
  }
}

/**
 * What a capture must never change in a real repository: HEAD, refs and the
 * worktree list. Ordinary file edits are excluded because the user may be
 * working in the same repository while a capture runs.
 */
export function repositoryFingerprint(repo) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
    } catch {
      return '';
    }
  };
  const hash = createHash('sha256');
  hash.update(git('rev-parse', 'HEAD'));
  hash.update('\0');
  hash.update(git('for-each-ref', '--format=%(refname) %(objectname)'));
  hash.update('\0');
  hash.update(git('worktree', 'list', '--porcelain'));
  return hash.digest('hex');
}

/** Provider processes started (directly or through shells) by the launched app. */
export function providerDescendants(processes, rootPid, providerPaths) {
  const children = new Map();
  for (const entry of processes) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const needles = providerPaths.map(normalize).filter(Boolean);
  const flagged = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set();
  while (queue.length > 0) {
    const entry = queue.shift();
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    const executable = normalize(entry.executablePath);
    const commandLine = normalize(entry.commandLine);
    if (PROVIDER_PROCESS_NAME.test(entry.name ?? '') || needles.some((needle) => executable === needle || commandLine.includes(needle))) {
      flagged.push(entry);
    }
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return flagged.sort((a, b) => a.pid - b.pid);
}

/** Windows process table for {@link providerDescendants}. */
export function listProcesses() {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  }).toString();
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    pid: entry.ProcessId,
    ppid: entry.ParentProcessId,
    name: entry.Name ?? '',
    executablePath: entry.ExecutablePath ?? '',
    commandLine: entry.CommandLine ?? '',
  }));
}
