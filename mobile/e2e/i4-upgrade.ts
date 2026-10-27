/**
 * vc78 → vc79 on a real Android device (I4): the 2.0 build before the feed (5f85ba1, versionCode 78) is installed,
 * connected and left on a terminal tab; this build is installed over it without wiping data. The install from before
 * keeps its look (Dark, the theme it never saved, now written as the default), reopens the terminal it left (nothing
 * waits), and a fresh install (`pm clear`) starts in Matrix.
 * Run: node --experimental-strip-types mobile/e2e/i4-upgrade.ts --old-apk=<vc78 debug apk>
 * (a debug build of 5f85ba1: release APKs are not debuggable, the harness drives the WebView over DevTools).
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  APK_PATH, APP_ID, LEGACY_SHELL_ROOT_TEST_ID, SHELL_ROOT_TEST_ID, closeMobileE2eResources, closeWebViewDevtools,
  connectAndAuth, ensureRemoteBridgeTransport, evaluateWebView, launchDesktop, runAdb, runAdbBinary, sleep, tapTestId,
  waitForAnyTestId, waitForTestId, waitForTestIdAttribute,
} from './lib.ts';

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const OLD_APK = path.resolve(arg('old-apk') ?? 'artifacts/ux2/i4/old-vc78-5f85ba1-debug.apk');
const artifacts = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/ux2/i4/upgrade');

async function capture(name: string): Promise<void> { await writeFile(path.join(artifacts, `${name}.png`), runAdbBinary(['exec-out', 'screencap', '-p'])); }
const theme = () => evaluateWebView<{ attribute: string | null; saved: string | null; source: string | null }>(
  `({ attribute: document.documentElement.getAttribute('data-theme'), saved: localStorage.getItem('ezterminal-mobile-theme'), source: localStorage.getItem('ezterminal-mobile-theme-source') })`,
);

async function main(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  const checks: string[] = [];
  const desktop = await launchDesktop();
  try {
    // 1. The build before the feed: connected, a terminal tab open, Dark shown without a theme saved.
    await connectAndAuth(desktop.token, { apkPath: OLD_APK, uninstallFirst: true });
    await waitForTestId(LEGACY_SHELL_ROOT_TEST_ID, 30_000);
    await tapTestId('tab-add-btn');
    await waitForTestId('mobile-session-view', 30_000);
    await sleep(1500);
    const before = await theme();
    assert.equal(before.attribute, 'dark', 'vc78 shows Dark');
    assert.equal(before.saved, null, 'vc78 never saved a theme');
    await capture('01-vc78-terminal');
    checks.push('vc78 connected with a terminal tab, Dark shown, no theme saved');

    // 2. This build over it, data kept.
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['install', '-r', APK_PATH]);
    ensureRemoteBridgeTransport();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    const go = await waitForAnyTestId(['connect-saved-go', 'connect-submit'], 15_000);
    await tapTestId(go);
    await waitForTestId(SHELL_ROOT_TEST_ID, 45_000);
    const after = await theme();
    assert.deepEqual(after, { attribute: 'dark', saved: 'dark', source: 'default' }, 'the install from before keeps Dark, written as the default');
    checks.push('vc79 over vc78 keeps Dark and writes it as the default');
    // Nothing waits and the terminal it left is there: the app opens on it.
    await waitForTestIdAttribute(SHELL_ROOT_TEST_ID, 'data-terminal-active', 'true', 20_000);
    await waitForTestId('mobile-session-view', 20_000);
    await capture('02-vc79-terminal-restored');
    checks.push('vc79 reopens the terminal tab vc78 left');

    // 3. A fresh install starts in Matrix.
    await connectAndAuth(desktop.token);
    const fresh = await theme();
    assert.deepEqual(fresh, { attribute: 'matrix', saved: 'matrix', source: 'default' }, 'a fresh install starts in Matrix');
    await waitForTestId('mobile-feed', 30_000);
    await capture('03-fresh-matrix-feed');
    checks.push('a fresh install starts in Matrix on the feed');

    await writeFile(path.join(artifacts, 'i4-upgrade.json'), JSON.stringify({ ok: true, oldApk: OLD_APK, androidApi: runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim(), checks }, null, 2));
    console.log(`[i4-upgrade] PASS ${checks.length} checks`);
  } catch (error) {
    await capture('failure').catch(() => undefined);
    const text = await evaluateWebView<string>('document.body.innerText').catch(() => 'WebView unavailable');
    await writeFile(path.join(artifacts, 'failure.txt'), `${String(error)}\n${checks.join('\n')}\n---\n${text}`);
    throw error;
  } finally {
    await desktop.dispose();
    closeMobileE2eResources();
  }
}
await main();
