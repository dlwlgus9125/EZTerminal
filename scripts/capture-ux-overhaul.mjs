/*
 * Real-app captures for the UX overhaul, run against a COPY of the user's
 * profile. The real profile is only read: SQLite is snapshotted with
 * `VACUUM INTO`, and settings that would touch the OS (login item, remote
 * bridge, keep-running) are switched off in the copy.
 *
 * The copy is also made inert (scripts/capture-profile-isolation.mjs): its
 * providers point at a missing executable, schedules are off, queued commands
 * are settled, and startup work that acts on real repositories is not copied.
 * While the app runs, any provider process under it aborts the capture, and
 * afterwards HEAD/refs/worktrees of every real repository must be unchanged.
 *
 *   node scripts/capture-ux-overhaul.mjs <stage> [--build] [--measure]
 *
 * Output: artifacts/ux-overhaul/<stage>/*.png + isolation.json
 * (+ <pass>-chrome.json and <pass>-measure-<w>x<h>.png with --measure)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';
import {
  PROFILE_COPY_SKIP,
  inertPath,
  listProcesses,
  providerDescendants,
  repositoryFingerprint,
  repositoryRoots,
  sanitizeCopiedDatabase,
} from './capture-profile-isolation.mjs';
import { measureChromeBands } from './chrome-bands.mjs';

const { _electron: electron } = playwright;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_ENTRY = path.join(ROOT, '.vite', 'build', 'main.js');
const stage = process.argv[2];
if (!stage || !/^[\w.-]+$/u.test(stage)) throw new Error('Usage: capture-ux-overhaul.mjs <stage> [--build]');
const output = path.join(ROOT, 'artifacts', 'ux-overhaul', stage);
const profile = path.join(ROOT, 'artifacts', 'ux-overhaul', `profile-${stage}`);
const source = process.env.EZTERMINAL_CAPTURE_SOURCE_PROFILE ?? path.join(process.env.APPDATA ?? '', 'EZTerminal');
const isolation = { providerPaths: [], roots: [], before: {}, violations: [], observationErrors: 0, observations: 0, sanitized: undefined };
/** --measure also records the chrome bands around the open conversation (ux2 baseline). */
const MEASURE = process.argv.includes('--measure');

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
    if (PROFILE_COPY_SKIP.has(entry)) continue;
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
  const copy = path.join(profile, 'orchestration.sqlite3');
  if (existsSync(database)) {
    snapshotDatabase(database, copy);
    isolation.sanitized = sanitizeCopiedDatabase(copy, path.join(profile, 'capture-disabled-providers'));
    isolation.providerPaths = isolation.sanitized.originalProviderPaths;
    isolation.roots = repositoryRoots(copy).filter((root) => existsSync(root));
    for (const root of isolation.roots) isolation.before[root] = repositoryFingerprint(root);
  }
  const settingsFile = path.join(profile, 'settings.json');
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : { schemaVersion: 1, startup: { mode: 'last' } };
  Object.assign(settings, { remoteEnabled: false, keepRunning: false, startAtLogin: false, bootIntro: false });
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

async function capturePass(app, page, label) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(output, `${label}-workbench.png`) });
  if (MEASURE) await measurePass(app, page, label);
  // The first conversation on the board, or in the work list (the project tree is gone, P-1).
  const conversation = page.locator('[data-testid="shell-conversation-card"], [data-testid="shell-live-row"]').first();
  if (await conversation.count()) {
    await conversation.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(output, `${label}-conversation.png`) });
  }
}

/** --measure: chrome bands around the open conversation at three window sizes. */
async function measurePass(app, page, label) {
  const results = [];
  for (const [width, height] of [[1600, 1000], [1280, 800], [1024, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, ...size });
    }, { width, height });
    await page.waitForTimeout(1200);
    const bands = await page.evaluate(measureChromeBands);
    await page.screenshot({ path: path.join(output, `${label}-measure-${width}x${height}.png`) });
    results.push({ bounds: { width, height }, bands });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1600, height: 1000 }));
  writeFileSync(path.join(output, `${label}-chrome.json`), JSON.stringify(results, null, 2));
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
  // CLI-history readers start `codex`/`claude` by name: keep them off PATH in the copy.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') env[key] = inertPath(env[key], existsSync);
  const app = await electron.launch({ args: [MAIN_ENTRY, '--lang=ko-KR'], env });
  watchProviders(app);
  await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.setBounds({ x: 40, y: 40, width: 1600, height: 1000 });
  });
  return app;
}

/** Aborts the capture as soon as a provider process appears under the app. */
function watchProviders(app) {
  const pid = app.process().pid;
  const check = () => {
    let found = [];
    // A check that could not look is not evidence that nothing ran: it fails the capture.
    try { found = providerDescendants(listProcesses(), pid, isolation.providerPaths); } catch { isolation.observationErrors += 1; return; }
    isolation.observations += 1;
    if (found.length === 0) return;
    isolation.violations.push(...found);
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  };
  const timer = setInterval(check, 2000);
  app.on('close', () => { clearInterval(timer); });
  app.process().once('exit', () => clearInterval(timer));
}

async function closeChecked(app) {
  await app.close().catch(() => undefined);
  if (isolation.violations.length > 0) {
    throw new Error(`Capture copy started provider processes: ${JSON.stringify(isolation.violations, null, 2)}`);
  }
  if (isolation.observationErrors > 0 || isolation.observations === 0) {
    throw new Error(`The process watch could not observe the app (${isolation.observationErrors} failed, ${isolation.observations} succeeded).`);
  }
}

function assertRepositoriesUnchanged() {
  const changed = isolation.roots.filter((root) => repositoryFingerprint(root) !== isolation.before[root]);
  writeFileSync(path.join(output, 'isolation.json'), JSON.stringify({ ...isolation, before: undefined, changed }, null, 2));
  if (changed.length > 0) throw new Error(`HEAD, refs or worktrees changed during the capture: ${changed.join(', ')}`);
}

ensureBuild();
mkdirSync(output, { recursive: true });
copyProfile();

// Pass 1: the user's own appearance (theme, effects, skin from Local Storage).
let app = await launch();
try { await capturePass(app, await app.firstWindow(), 'user'); } finally { await closeChecked(app); }

// Pass 2: product default appearance — Dark theme, bubble skin, no effects, 100% UI scale.
const settingsFile = path.join(profile, 'settings.json');
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
Object.assign(settings, { theme: 'dark', effectToggles: {}, uiScale: 100 });
writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
app = await launch();
try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => localStorage.setItem('ezterminal.chat.skin', 'bubble'));
  await page.reload();
  await capturePass(app, page, 'default');
} finally { await closeChecked(app); }

assertRepositoriesUnchanged();
process.stdout.write(`${JSON.stringify({ stage, output, files: readdirSync(output) })}\n`);
