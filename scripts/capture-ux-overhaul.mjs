/*
 * Real-app captures for the UX overhaul, run against a COPY of the user's
 * profile. The real profile is only read: SQLite is snapshotted with
 * `VACUUM INTO`, and settings that would touch the OS (login item, remote
 * bridge, keep-running) are switched off in the copy.
 *
 *   node scripts/capture-ux-overhaul.mjs <stage> [--build]
 *
 * Output: artifacts/ux-overhaul/<stage>/*.png
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';

const { _electron: electron } = playwright;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const stage = process.argv[2];
if (!stage || !/^[\w.-]+$/u.test(stage)) throw new Error('Usage: capture-ux-overhaul.mjs <stage> [--build]');
const output = path.join(ROOT, 'artifacts', 'ux-overhaul', stage);
const profile = path.join(ROOT, 'artifacts', 'ux-overhaul', `profile-${stage}`);
const source = process.env.EZTERMINAL_CAPTURE_SOURCE_PROFILE ?? path.join(process.env.APPDATA ?? '', 'EZTerminal');

/** Profile entries that are caches, locks, logs, or credentials the copy must not reuse. */
const SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage',
  'Shared Dictionary', 'DevToolsActivePort', 'lockfile', 'logs', 'remote-token.json', 'remote-token.json.corrupt',
  'Network', 'Partitions', 'Session Storage', 'SharedStorage', 'SharedStorage-wal', 'DIPS', 'DIPS-wal', 'Dictionaries',
  'orchestration.sqlite3', 'orchestration.sqlite3-wal', 'orchestration.sqlite3-shm',
]);

function newestMtime(dir, pattern) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full, pattern));
    else if (pattern.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

function ensureBuild() {
  const stale = !existsSync(MAIN_ENTRY)
    || newestMtime(path.join(ROOT, 'src'), /\.(?:css|html|ts|tsx|woff2)$/u) > statSync(MAIN_ENTRY).mtimeMs;
  if (!stale && !process.argv.includes('--build')) return;
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@electron-forge/cli/package.json');
  const manifest = require('@electron-forge/cli/package.json');
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['electron-forge'];
  execFileSync(process.execPath, [path.join(path.dirname(manifestPath), bin), 'package'], { stdio: 'inherit', cwd: ROOT });
}

function snapshotDatabase(from, to) {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(to);
  } finally {
    db.close();
  }
}

function copyProfile() {
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (SKIP.has(entry)) continue;
    // A running installed app holds Chromium LOCK files; a locked file is not
    // product state, so the copy skips it instead of failing.
    cpSync(path.join(source, entry), path.join(profile, entry), {
      recursive: true,
      filter: (from) => {
        try { readFileSync(from, { flag: 'r' }).length; return true; } catch (error) { return error.code === 'EISDIR'; }
      },
    });
  }
  const database = path.join(source, 'orchestration.sqlite3');
  if (existsSync(database)) snapshotDatabase(database, path.join(profile, 'orchestration.sqlite3'));
  const settingsFile = path.join(profile, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : { schemaVersion: 1, startup: { mode: 'last' } };
  Object.assign(settings, { remoteEnabled: false, keepRunning: false, startAtLogin: false, bootIntro: false });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

async function capturePass(page, label) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(output, `${label}-workbench.png`) });
  const conversation = page.locator('[data-testid="project-conversation-tree"] [role="treeitem"][aria-level="2"]').first();
  if (await conversation.count()) {
    await conversation.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(output, `${label}-conversation.png`) });
  }
}

async function launch() {
  const env = { ...process.env };
  Object.assign(env, {
    EZTERMINAL_USER_DATA_DIR: profile,
    EZTERMINAL_ALLOW_MULTIPLE_INSTANCES: '1',
    EZTERMINAL_DISABLE_UPDATE_CHECK: '1',
    EZTERMINAL_DISABLE_OPENCLAW_SUPERVISOR: '1',
    EZTERMINAL_REMOTE_PORT: '47999',
  });
  const app = await electron.launch({ args: [MAIN_ENTRY, '--lang=ko-KR'], env });
  await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setBounds({ x: 40, y: 40, width: 1600, height: 1000 });
  });
  return app;
}

ensureBuild();
mkdirSync(output, { recursive: true });
copyProfile();

// Pass 1: the user's own appearance (theme, effects, skin from Local Storage).
let app = await launch();
try { await capturePass(await app.firstWindow(), 'user'); } finally { await app.close(); }

// Pass 2: product default appearance — Dark theme, bubble skin, no effects.
const settingsFile = path.join(profile, 'settings.json');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
Object.assign(settings, { theme: 'dark', effectToggles: {} });
writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
app = await launch();
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => localStorage.setItem('ezterminal.chat.skin', 'bubble'));
  await page.reload();
  await capturePass(page, 'default');
} finally { await app.close(); }

process.stdout.write(`${JSON.stringify({ stage, output, files: readdirSync(output) })}\n`);
