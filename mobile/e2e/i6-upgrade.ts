/**
 * vc80 → vc81 on a real Android device (remote protocol 18: stage agents, checks, answer stages):
 *  1. the installed older app (vc80, ae81f74, protocol v17) on this PC: a flow with v18 fields (an agent and a check on a
 *     stage, an answer stage) opens without an error — the PC sends it the reduced view, the answer stage as an approval;
 *  2. this app (vc81) installed over it without wiping data: the saved pairing and the theme are kept, and the same flow
 *     opens with its answer stage;
 *  3. this app on an older PC (ae81f74, protocol v17): a flow opens without an error.
 * No provider turn is started.
 * Run: node --experimental-strip-types mobile/e2e/i6-upgrade.ts --old-apk=<vc80 apk> [--new-apk=<vc81 apk signed like it>] --old-pc=<ae81f74 worktree with a .vite build>
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
const OLD_APK = path.resolve(arg('old-apk') ?? 'artifacts/harness/i6/old-vc80-ae81f74.apk');
const OLD_PC = path.resolve(arg('old-pc') ?? '../ez-oldpc-ae81f74');
/** An update installs over the older app only with the same signing key: the release vc80 needs a release vc81. */
const NEW_APK = path.resolve(arg('new-apk') ?? APK_PATH);
const artifactDir = path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ?? 'artifacts/harness/i6/upgrade');

async function waitForCondition(label: string, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await evaluateWebView<boolean>(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}
async function openListItem(selector: string, label: string): Promise<void> {
  const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getBoundingClientRect().width > 0 && node.querySelector('strong') && node.querySelector('strong').textContent === ${JSON.stringify(label)})`;
  await waitForCondition(`item ${label}`, `!!(${find})`, 30_000);
  await evaluateWebView(`(() => { ${find}.click(); return true; })()`);
}
async function openProject(name: string): Promise<void> {
  await openProjectList();
  await waitForTestId('mobile-projects-navigator');
  await openListItem('[data-testid="mobile-planning-project"]', name);
  await waitForTestId('workflow-workspace');
}
async function openFlow(label: string): Promise<void> {
  await openListItem('[data-testid="workflow-subproject-item"]', 'Harness flow');
  await waitForCondition(`${label}: the flow's run bar`, `[...document.querySelectorAll('[data-testid="workflow-run-bar"]')].some(node => node.getBoundingClientRect().width > 0)`, 30_000);
  const errors = await evaluateWebView<string[]>(`[...document.querySelectorAll('.workflow-error')].filter(node => node.getBoundingClientRect().width > 0).map(node => node.textContent)`);
  assert.deepEqual(errors, [], `${label}: no workflow error`);
}
const pageText = () => evaluateWebView<string>('document.body.innerText');
async function shot(name: string): Promise<void> { await writeFile(path.join(artifactDir, name), runAdbBinary(['exec-out', 'screencap', '-p'])); }
const theme = () => evaluateWebView<{ attribute: string | null; saved: string | null; source: string | null }>(
  `({ attribute: document.documentElement.getAttribute('data-theme'), saved: localStorage.getItem('ezterminal-mobile-theme'), source: localStorage.getItem('ezterminal-mobile-theme-source') })`,
);

type Host = Awaited<ReturnType<typeof launchDesktop>>;
/** A flow on the PC; `v18` adds an agent and a check on the AI stage and an answer stage before it. */
async function project(host: Host, root: string, name: string, v18: boolean): Promise<void> {
  const saved = await host.window.evaluate((input) => window.ezterminal.saveAgentProject({ name: input.name, primaryRoot: input.root, additionalRoots: [], pinned: false }), { name, root });
  if (!saved.ok) throw new Error(saved.reason);
  const projectId = saved.project.projectId;
  const read = await host.window.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!read.ok) throw new Error(read.message);
  const base = { document: '', acceptance: [] as string[], allowedPaths: [] as string[], retryLimit: 2, permissionPreset: 'plan', inputs: [] as unknown[] };
  const nodes = [
    ...(v18 ? [{ ...base, id: 'ask', title: 'Your answer', operation: 'answer', role: 'planning', instructions: '', answer: { prompt: 'Which part first?' }, position: { x: 40, y: 40 } }] : []),
    { ...base, id: 'build', title: 'Build', operation: 'agent', role: 'planning', instructions: 'Summarise the project folder.', acceptance: ['A short summary'], retryLimit: 0, providerId: 'codex', position: { x: 384, y: 40 },
      ...(v18 ? { agent: { profileId: 'builder', name: 'Builder', providerId: 'codex', capturedAt: '2026-10-29T00:00:00.000Z' }, checks: [{ id: 'list', command: 'git status' }] } : {}) },
    { ...base, id: 'done', title: 'Done', operation: 'complete', role: 'integration', instructions: '', position: { x: 728, y: 40 } },
  ];
  const edges = [...(v18 ? [{ id: 'ask-build', from: 'ask', to: 'build', outcome: 'next' }] : []), { id: 'build-done', from: 'build', to: 'done', outcome: 'next' }];
  const created = await host.window.evaluate((command) => window.ezterminal.executeWorkflowCommand(command as never), { commandId: `i6-create-${v18 ? 'v18' : 'v17'}`, projectId, hostId: read.snapshot.hostId,
    expectedRevision: read.snapshot.registryRevision, type: 'subproject.create', payload: { id: 'harness', title: 'Harness flow', goal: '', presetId: 'custom', graph: { entryNodeId: v18 ? 'ask' : 'build', nodes, edges } } });
  assert.equal(created.ok, true, `the flow was created: ${JSON.stringify(created).slice(0, 300)}`);
}

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), oldApk: OLD_APK, newApk: NEW_APK, oldPc: OLD_PC, checks: [] };
  const checks = report.checks as string[];
  let desktop: Host | undefined;
  try {
    report.androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
    // 1. vc80 on this PC: the reduced view parses.
    desktop = await launchDesktop();
    await project(desktop, registry.createTempDir('ezterm-i6-upgrade-'), 'Harness on this PC', true);
    await connectAndAuth(desktop.token, { apkPath: OLD_APK, uninstallFirst: true });
    await waitForTestId(SHELL_ROOT_TEST_ID, 30_000);
    const before = await theme();
    await openProject('Harness on this PC');
    await openFlow('vc80');
    assert.ok((await pageText()).includes('Your answer'), 'vc80 lists the answer stage (as an approval)');
    await shot('1-vc80-reduced-flow.png');
    checks.push('vc80 on this PC: a flow with stage agents, a check and an answer stage opens (reduced view)');
    await tapTestId('workflow-back');

    // 2. vc81 over vc80, data kept.
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['install', '-r', NEW_APK]);
    ensureRemoteBridgeTransport();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    const go = await waitForAnyTestId(['connect-saved-go', 'connect-submit'], 15_000);
    await tapTestId(go);
    await waitForTestId(SHELL_ROOT_TEST_ID, 45_000);
    assert.deepEqual(await theme(), before, 'the theme is kept');
    checks.push(`vc81 over vc80: the saved pairing connects, the theme is kept (${before.attribute})`);
    await openProject('Harness on this PC');
    await openFlow('vc81');
    const text = await pageText();
    assert.ok(text.includes('Your answer'), 'vc81 lists the answer stage');
    await shot('2-vc81-flow.png');
    checks.push('vc81: the same flow opens with its answer stage');
    await desktop.dispose(); desktop = undefined;

    // 3. vc81 on an older PC (protocol v17).
    desktop = await launchDesktop({ mainEntry: path.join(OLD_PC, '.vite', 'build', 'main.js'), cwd: OLD_PC });
    await project(desktop, registry.createTempDir('ezterm-i6-upgrade-old-pc-'), 'Harness on an older PC', false);
    await connectAndAuth(desktop.token);
    await openProject('Harness on an older PC');
    await openFlow('vc81 on an older PC');
    await shot('3-vc81-older-pc.png');
    checks.push('vc81 on an older PC (protocol v17): the flow opens without an error');
    report.status = 'passed';
    console.log(`[i6-upgrade] PASS ${checks.length} checks`);
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    try { await shot('failure.png'); } catch { /* keep the original failure */ }
    try { report.text = await pageText(); } catch { /* WebView unavailable */ }
    throw error;
  } finally {
    try { runAdb(['shell', 'am', 'force-stop', APP_ID]); } catch { /* best effort */ }
    closeMobileE2eResources();
    try { await desktop?.dispose(); } catch { /* best effort */ }
    try { await registry.disposeAll(); } catch { /* best effort */ }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifactDir, 'i6-upgrade.json'), JSON.stringify(report, null, 2));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
