/**
 * vc79 → vc80 on a real Android device (I5: the old planning screen and the PC's planning editing are gone):
 *  1. the installed older app (vc79, 0bc0640) on this PC: a flow opens; an edit on its old planning screen is refused
 *     with "update the app" (no "check save result" loop) and the connection stays (the flow opens again);
 *  2. this app (vc80) installed over it without wiping data: the saved pairing and the theme are kept, the old
 *     planning entry is gone and the flow opens;
 *  3. this app on an older PC (f958e5a, protocol v16): the flow opens without an error.
 * No provider turn is started.
 * Run: node --experimental-strip-types mobile/e2e/i5-upgrade.ts --old-apk=<vc79 debug apk> --old-pc=<worktree>
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APK_PATH, APP_ID, SHELL_ROOT_TEST_ID, closeMobileE2eResources, closeWebViewDevtools, connectAndAuth,
  ensureRemoteBridgeTransport, evaluateWebView, launchDesktop, openProjectList, runAdb, runAdbBinary, sleep, tapTestId,
  waitForAnyTestId, waitForTestId,
} from './lib.ts';

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const OLD_APK = path.resolve(arg('old-apk') ?? 'artifacts/ux2/i5/old-vc79-0bc0640-debug.apk');
const OLD_PC = path.resolve(arg('old-pc') ?? '../ez-oldpc-f958e5a');
const artifactDir = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/ux2/i5/upgrade');
const UPDATE_MESSAGE = 'Update the app on this device';
const UNKNOWN_SAVE = ['The save result is unknown', '저장 결과를 확인하지 못했습니다'];

async function waitForCondition(label: string, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await evaluateWebView<boolean>(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}
async function clickLabel(selector: string, labels: readonly string[]): Promise<void> {
  const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => ${JSON.stringify(labels)}.includes(node.textContent.trim()) && !node.disabled && node.getBoundingClientRect().width > 0)`;
  await waitForCondition(`control ${labels.join('/')}`, `!!(${find})`);
  await evaluateWebView(`(() => { ${find}.click(); return true; })()`);
}
async function fill(selector: string, value: string): Promise<void> {
  await waitForCondition(`editable ${selector}`, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return !!node && !node.disabled && !node.readOnly; })()`);
  await evaluateWebView(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)}); node.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
}
async function openListItem(selector: string, label: string): Promise<void> {
  const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getBoundingClientRect().width > 0 && node.querySelector('strong') && node.querySelector('strong').textContent === ${JSON.stringify(label)})`;
  await waitForCondition(`item ${label}`, `!!(${find})`, 30_000);
  await evaluateWebView(`(() => { ${find}.click(); return true; })()`);
}
const visible = (selector: string) => evaluateWebView<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(node => node.getBoundingClientRect().width > 0)`);
async function openProject(name: string): Promise<void> {
  await openProjectList();
  await waitForTestId('mobile-projects-navigator');
  await openListItem('[data-testid="mobile-planning-project"]', name);
  await waitForTestId('workflow-workspace');
}
async function openFlow(label: string): Promise<void> {
  await openListItem('[data-testid="workflow-subproject-item"]', 'Compat flow');
  await waitForCondition(`${label}: the flow's run bar`, `[...document.querySelectorAll('[data-testid="workflow-run-bar"]')].some(node => node.getBoundingClientRect().width > 0)`, 30_000);
  const errors = await evaluateWebView<string[]>(`[...document.querySelectorAll('.workflow-error')].filter(node => node.getBoundingClientRect().width > 0).map(node => node.textContent)`);
  assert.deepEqual(errors, [], `${label}: no workflow error`);
}
async function shot(name: string): Promise<void> { await writeFile(path.join(artifactDir, name), runAdbBinary(['exec-out', 'screencap', '-p'])); }
const theme = () => evaluateWebView<{ attribute: string | null; saved: string | null; source: string | null }>(
  `({ attribute: document.documentElement.getAttribute('data-theme'), saved: localStorage.getItem('ezterminal-mobile-theme'), source: localStorage.getItem('ezterminal-mobile-theme-source') })`,
);

type Host = Awaited<ReturnType<typeof launchDesktop>>;
async function project(host: Host, root: string, name: string): Promise<void> {
  const saved = await host.window.evaluate((input) => window.ezterminal.saveAgentProject({ name: input.name, primaryRoot: input.root, additionalRoots: [], pinned: false }), { name, root });
  if (!saved.ok) throw new Error(saved.reason);
  const projectId = saved.project.projectId;
  const read = await host.window.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!read.ok) throw new Error(read.message);
  const graph = { entryNodeId: 'build', edges: [{ id: 'build-done', from: 'build', to: 'done', outcome: 'next' }], nodes: [
    { id: 'build', title: 'Build', operation: 'agent', role: 'planning', instructions: 'Summarise the project folder.', document: 'Saved document', acceptance: ['A short summary'], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', providerId: 'codex', position: { x: 40, y: 40 }, inputs: [] },
    { id: 'done', title: 'Done', operation: 'complete', role: 'integration', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 384, y: 40 }, inputs: [] },
  ] };
  const created = await host.window.evaluate((command) => window.ezterminal.executeWorkflowCommand(command as never), { commandId: 'upgrade-create', projectId, hostId: read.snapshot.hostId,
    expectedRevision: read.snapshot.registryRevision, type: 'subproject.create', payload: { id: 'compat', title: 'Compat flow', goal: '', presetId: 'custom', graph } });
  assert.equal(created.ok, true, `the flow was created: ${JSON.stringify(created).slice(0, 300)}`);
}

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), oldApk: OLD_APK, newApk: APK_PATH, oldPc: OLD_PC, checks: [] };
  const checks = report.checks as string[];
  let desktop: Host | undefined;
  try {
    report.androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
    // 1. vc79 on this PC.
    desktop = await launchDesktop();
    await project(desktop, registry.createTempDir('ezterm-i5-upgrade-'), 'Upgrade on this PC');
    await connectAndAuth(desktop.token, { apkPath: OLD_APK, uninstallFirst: true });
    await waitForTestId(SHELL_ROOT_TEST_ID, 30_000);
    const before = await theme();
    await openProject('Upgrade on this PC');
    await openFlow('vc79');
    checks.push('vc79 on this PC: the flow opens');
    await tapTestId('workflow-back');
    await clickLabel('[data-testid="workflow-workspace"] button', ['Quick tasks and existing work', '빠른 작업·기존 자료']);
    await waitForTestId('planning-workspace', 30_000);
    await clickLabel('[data-testid="planning-workspace"] button', ['Write a requirement', '요구사항 작성']);
    await fill('.planning-workspace__editor input[maxlength="300"]', 'Old app requirement');
    await fill('.planning-workspace__editor textarea[maxlength="200000"]', 'Written on the old planning screen');
    await evaluateWebView(`(() => { document.querySelector('.planning-workspace__editor button[type="submit"]').click(); return true; })()`);
    await waitForCondition('the old app is told to update', `document.body.innerText.includes(${JSON.stringify(UPDATE_MESSAGE)})`, 30_000);
    await sleep(500);
    const alert = await evaluateWebView<string>(`[...document.querySelectorAll('[data-testid="planning-workspace"] [role="alert"]')].map(node => node.textContent).join('\\n')`);
    assert.ok(!UNKNOWN_SAVE.some((text) => alert.includes(text)), `the refusal is final, not an unknown save: ${alert}`);
    await shot('1-vc79-planning-refused.png');
    checks.push('vc79 old planning edit: refused with "update the app", no unknown-save retry');
    // The connection stays: the flow opens again.
    assert.equal(await visible('[data-testid="mobile-reconnect-scrim"]'), false, 'no reconnect after the refusal');
    await clickLabel('[data-testid="workflow-workspace"] .workflow-switch button', ['Subprojects and conversations', '소프로젝트·대화']);
    await openFlow('vc79 after the refusal');
    checks.push('vc79 stays connected after the refusal: the flow opens again');

    // 2. vc80 over vc79, data kept.
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['install', '-r', APK_PATH]);
    ensureRemoteBridgeTransport();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    const go = await waitForAnyTestId(['connect-saved-go', 'connect-submit'], 15_000);
    await tapTestId(go);
    await waitForTestId(SHELL_ROOT_TEST_ID, 45_000);
    assert.deepEqual(await theme(), before, 'the theme is kept');
    checks.push(`vc80 over vc79: the saved pairing connects, the theme is kept (${before.attribute})`);
    await openProject('Upgrade on this PC');
    await sleep(500);
    assert.equal(await evaluateWebView<boolean>(`[...document.querySelectorAll('[data-testid="workflow-workspace"] button')].some(node => ['Quick tasks and existing work', '빠른 작업·기존 자료'].includes(node.textContent.trim()))`), false, 'no old planning entry');
    await openFlow('vc80');
    await shot('2-vc80-flow.png');
    checks.push('vc80: no old planning entry, the flow opens');
    await desktop.dispose(); desktop = undefined;

    // 3. vc80 on an older PC.
    desktop = await launchDesktop({ mainEntry: path.join(OLD_PC, '.vite', 'build', 'main.js'), cwd: OLD_PC });
    await project(desktop, registry.createTempDir('ezterm-i5-upgrade-old-pc-'), 'Upgrade on an older PC');
    await connectAndAuth(desktop.token);
    await openProject('Upgrade on an older PC');
    await openFlow('vc80 on an older PC');
    await shot('3-vc80-older-pc.png');
    checks.push('vc80 on an older PC (protocol v16): the flow opens without an error');
    report.status = 'passed';
    console.log(`[i5-upgrade] PASS ${checks.length} checks`);
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    try { await shot('failure.png'); } catch { /* keep the original failure */ }
    try { report.text = await evaluateWebView<string>('document.body.innerText'); } catch { /* WebView unavailable */ }
    throw error;
  } finally {
    try { runAdb(['shell', 'am', 'force-stop', APP_ID]); } catch { /* best effort */ }
    closeMobileE2eResources();
    try { await desktop?.dispose(); } catch { /* best effort */ }
    try { await registry.disposeAll(); } catch { /* best effort */ }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifactDir, 'i5-upgrade.json'), JSON.stringify(report, null, 2));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
