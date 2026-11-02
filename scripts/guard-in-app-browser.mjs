#!/usr/bin/env node
/**
 * The in-app browser shows pages the AI may be told to obey. What keeps such a page from the app,
 * the person's other sign-ins and the system browser is a handful of settings that one edit could
 * drop. Unit and OS tests exercise them; this pins them in source. It reads source; it runs nothing.
 *
 *   1. The one page view is sandboxed, isolated, without node, webview, preload or dialogs, on its own partition.
 *   2. That partition is the browser's alone, and the browser never uses the app's default session.
 *   3. Nothing in the browser hands a URL to the system browser; a new window is always denied.
 *   4. Every view gets the navigation guards, and the partition refuses permissions, devices and downloads.
 *
 * Run: node scripts/guard-in-app-browser.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
// Sources are CRLF; the patterns below are written for LF.
const read = (relative) => readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/gu, '\n');
const isSource = (name) => /\.(ts|tsx)$/u.test(name) && !/\.(test|os\.test|harness|stories)\.tsx?$/u.test(name);

const PARTITION = 'persist:ezterminal-browser';
const browserModules = [
  ...readdirSync(path.join(root, 'src/main'))
    .filter((name) => name.startsWith('browser-') && isSource(name))
    .map((name) => `src/main/${name}`),
  'src/renderer/BrowserPanel.tsx',
  'src/shared/browser.ts',
];
const manager = read('src/main/browser-view-manager.ts');

// ── 1. the page view's settings ──────────────────────────────────────────────
const prefs = manager.match(/new WebContentsView\(\{\s*webPreferences:\s*\{([\s\S]*?)\}/u)?.[1];
if (prefs === undefined) {
  failures.push('src/main/browser-view-manager.ts no longer creates its view as new WebContentsView({ webPreferences: { ... } }).');
} else {
  for (const [setting, reason] of [
    [/\bsandbox:\s*true\b/u, 'sandbox: true (the page runs in a sandboxed renderer)'],
    [/\bcontextIsolation:\s*true\b/u, 'contextIsolation: true (page scripts stay out of any app context)'],
    [/\bnodeIntegration:\s*false\b/u, 'nodeIntegration: false (no node in the page)'],
    [/\bwebviewTag:\s*false\b/u, 'webviewTag: false (the page cannot embed its own unguarded view)'],
    [/\bpartition:\s*BROWSER_PARTITION\b/u, 'partition: BROWSER_PARTITION (its own cookies and storage)'],
    [/\bdisableDialogs:\s*true\b/u, 'disableDialogs: true (alert, confirm and prompt cannot hold the app)'],
  ]) {
    if (!setting.test(prefs)) failures.push(`The browser view's webPreferences must keep ${reason}.`);
  }
  if (/\bpreload\b/u.test(prefs)) failures.push('The browser view has a preload. A page must have no channel into the app.');
}
let views = 0;
for (const file of browserModules) {
  const source = read(file);
  views += (source.match(/\bnew WebContentsView\(/gu) ?? []).length;
  if (/\bnew (?:BrowserWindow|BrowserView)\(|<webview\b/u.test(source)) {
    failures.push(`${file} opens a page outside the one guarded WebContentsView.`);
  }
}
if (views !== 1) failures.push(`Browser modules create ${views} WebContentsViews; the one in ensureView() is the only guarded one.`);

// ── 2. the partition is the browser's alone ──────────────────────────────────
if (!read('src/shared/browser.ts').includes(`export const BROWSER_PARTITION = '${PARTITION}';`)) {
  failures.push(`src/shared/browser.ts must export BROWSER_PARTITION = '${PARTITION}'.`);
}
const sourceFiles = (directory) => readdirSync(path.join(root, directory), { recursive: true })
  .map((name) => String(name).replaceAll('\\', '/'))
  .filter((name) => isSource(path.basename(name)))
  .map((name) => `${directory}/${name}`);
for (const file of ['src/main', 'src/renderer', 'src/shared'].flatMap(sourceFiles)) {
  if (file !== 'src/shared/browser.ts' && read(file).includes(PARTITION)) {
    failures.push(`${file} names the browser partition. Use BROWSER_PARTITION, and only for the browser.`);
  }
}
for (const file of browserModules) {
  const source = read(file);
  if (/\bdefaultSession\b/u.test(source)) failures.push(`${file} uses the app's default session; the browser has its own partition.`);
  for (const call of source.matchAll(/\bfromPartition\(([^)]*)\)/gu)) {
    if (call[1].trim() !== 'BROWSER_PARTITION') failures.push(`${file} opens partition ${call[1]}; the browser uses BROWSER_PARTITION only.`);
  }
}

// ── 3. nothing reaches the system browser ────────────────────────────────────
for (const file of browserModules) {
  // Calls and imports only: comments here say "never reaches `shell.openExternal`".
  const source = read(file);
  if (/\bopenExternal\s*\(/u.test(source) || /import\s*\{[^}]*\bshell\b[^}]*\}\s*from\s*'electron'/u.test(source)) {
    failures.push(`${file} hands a URL to the system browser. A page must never reach openExternal.`);
  }
}
const openHandler = manager.match(/setWindowOpenHandler\(([\s\S]*?)\n\s{4}\}\);/u)?.[1];
if (openHandler === undefined) {
  failures.push('src/main/browser-view-manager.ts no longer sets a window open handler on the view.');
} else if (!/return \{ action: 'deny' \}/u.test(openHandler) || /'allow'/u.test(openHandler)) {
  failures.push('The window open handler must always return { action: \'deny\' }; a target opens in the same view or not at all.');
}

// ── 4. every view is guarded, and so is the partition ────────────────────────
const ensureView = manager.match(/private ensureView\(pane: Pane\)[\s\S]*?\n {2}\}\n/u)?.[0] ?? '';
const order = ['installBrowserPartitionGuards(', 'new WebContentsView(', 'this.guard(pane, contents)'].map((needle) => ensureView.indexOf(needle));
if (order.includes(-1) || order[0] > order[1] || order[1] > order[2]) {
  failures.push('ensureView() must install the partition guards before it creates the view and guard the view right after.');
}
for (const event of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
  if (!manager.includes(`contents.on('${event}',`)) failures.push(`The browser view no longer checks ${event}.`);
}
const network = read('src/main/browser-network-guard.ts');
const partitionGuards = network.match(/export function installBrowserPartitionGuards\([\s\S]*?\n\}\n/u)?.[0] ?? '';
for (const [needle, reason] of [
  [/setPermissionRequestHandler\(\([^)]*\)\s*=>\s*callback\(false\)\)/u, 'refuse every permission request'],
  [/setPermissionCheckHandler\(\(\)\s*=>\s*false\)/u, 'answer every permission check with false'],
  [/setDevicePermissionHandler\(\(\)\s*=>\s*false\)/u, 'refuse device access'],
  [/on\('will-download',[\s\S]{0,120}?event\.preventDefault\(\)/u, 'cancel every download'],
  [/webRequest\.onBeforeRequest\(\{ urls: \['<all_urls>'\] \}/u, 'check every request before it leaves'],
]) {
  if (!needle.test(partitionGuards)) failures.push(`installBrowserPartitionGuards() no longer does this: ${reason}.`);
}

if (failures.length > 0) {
  process.stderr.write(`${failures.map((line) => `- ${line}`).join('\n')}\n`);
  process.exit(1);
}

process.stdout.write('In-app browser guard: one sandboxed view on its own partition, no preload or dialogs, no openExternal, guards installed.\n');
