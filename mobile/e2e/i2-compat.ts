/**
 * Remote protocol v17 compatibility on a real Android WebView (I2 checkpoint A):
 *  1. an installed older app (vc77, protocol v16) on this PC: a flow whose stage carries an effort and
 *     whose subproject keeps run settings opens, a conversation sends, and an edit that would drop the
 *     hidden fields is refused with "update the app";
 *  2. this app (vc78) installed over it without wiping data: the pairing and the older app's flow draft
 *     survive and the new flow screen shows;
 *  3. this app on an older PC (f958e5a, protocol v16): the flow opens, the run bar has no review AI
 *     settings and "Run" prepares from the dialog.
 * The reviewed fake Codex answers the only provider turns. No real provider or account is used.
 * Run: node --experimental-strip-types mobile/e2e/i2-compat.ts --old-apk=<vc77.apk> --old-pc=<worktree>
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APK_PATH, APP_ID, closeMobileE2eResources, closeWebViewDevtools, connectAndAuth, ensureRemoteBridgeTransport,
  evaluateWebView, launchDesktop, runAdb, runAdbBinary, setTestIdTextValue, sleep, waitForTestId,
  openProjectList,
  SHELL_ROOT_TEST_ID,
} from './lib.ts';

const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const OLD_APK = path.resolve(arg('old-apk') ?? 'release-assets/2.0.0-local-ed32a403-3c79cd7b/EZTerminal-Android-2.0.0-vc77.apk');
const OLD_PC = path.resolve(arg('old-pc') ?? '../ez-oldpc-f958e5a');
const artifactDir = process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR ? path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR) : path.resolve(import.meta.dirname, '../../artifacts/i2-compat');
const FAKE_CODEX = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const fakeCodexEnv = { [pathKey]: `${FAKE_CODEX}${path.delimiter}${process.env[pathKey] ?? ''}` };

async function waitForCondition(label: string, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await evaluateWebView<boolean>(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}
async function clickSelector(selector: string): Promise<void> {
  await waitForCondition(`enabled ${selector}`, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node instanceof HTMLElement && !node.disabled && node.getBoundingClientRect().width > 0; })()`);
  await evaluateWebView(`(() => { document.querySelector(${JSON.stringify(selector)}).click(); return true; })()`);
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
async function openProject(name: string): Promise<void> {
  // The older app (vc77) has the Projects tab; this app opens the list from the feed's ▾ (I4 layout A).
  const olderApp = await evaluateWebView<boolean>(`!!document.querySelector('[data-testid="shell-tab-home"]')`);
  if (olderApp) await clickSelector('[data-testid="shell-tab-home"]');
  else await openProjectList();
  await waitForTestId('mobile-projects-navigator');
  await openListItem('[data-testid="mobile-planning-project"]', name);
  await waitForTestId('workflow-workspace');
}
async function noWorkflowError(label: string): Promise<void> {
  const errors = await evaluateWebView<string[]>(`[...document.querySelectorAll('.workflow-error')].filter(node => node.getBoundingClientRect().width > 0).map(node => node.textContent)`);
  assert.deepEqual(errors, [], `${label}: no workflow error`);
}
async function shot(name: string): Promise<void> { await writeFile(path.join(artifactDir, name), runAdbBinary(['exec-out', 'screencap', '-p'])); }

type Host = Awaited<ReturnType<typeof launchDesktop>>;
async function enableFakeCodex(host: Host): Promise<void> {
  const inspected = await host.window.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspected.ok) throw new Error(inspected.message);
  assert.ok(path.resolve(inspected.value.probe.executablePath).startsWith(FAKE_CODEX), `expected the fake codex, found ${inspected.value.probe.executablePath}`);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const enabled = await host.window.evaluate(async ({ probe, reviewDigest, attempt }) => {
      const state = await window.ezterminal.getDaemonSnapshot(); if (!state) throw new Error('Daemon unavailable'); const commandId = `compat-provider-${attempt}`;
      return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId, idempotencyKey: commandId, expectedRevision: state.revision, issuedAt: new Date().toISOString(),
        principal: { kind: 'desktop', id: 'compat-e2e' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol,
          executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } } as never);
    }, { ...inspected.value, attempt });
    if (enabled.ok) return;
    if (enabled.error.code !== 'revision-conflict' || attempt === 3) throw new Error(enabled.error.message);
  }
}
async function project(host: Host, root: string, name: string, graph: unknown, runSettings?: unknown): Promise<string> {
  const saved = await host.window.evaluate((input) => window.ezterminal.saveAgentProject({ name: input.name, primaryRoot: input.root, additionalRoots: [], pinned: false }), { name, root });
  if (!saved.ok) throw new Error(saved.reason);
  const projectId = saved.project.projectId;
  const read = await host.window.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!read.ok) throw new Error(read.message);
  const created = await host.window.evaluate((command) => window.ezterminal.executeWorkflowCommand(command as never), { commandId: 'compat-create', projectId, hostId: read.snapshot.hostId,
    expectedRevision: read.snapshot.registryRevision, type: 'subproject.create', payload: { id: 'compat', title: 'Compat flow', goal: '', presetId: 'custom', graph } });
  assert.equal(created.ok, true, `the flow was created: ${JSON.stringify(created).slice(0, 300)}`);
  if (runSettings) {
    const updated = await host.window.evaluate((command) => window.ezterminal.executeWorkflowCommand(command as never), { commandId: 'compat-settings', projectId, hostId: read.snapshot.hostId,
      expectedRevision: 0, subprojectId: 'compat', type: 'subproject.update', payload: { runSettings } });
    assert.equal(updated.ok, true, 'the run settings were saved');
  }
  return projectId;
}
const stage = (extra: Record<string, unknown>) => ({ entryNodeId: 'build', edges: [{ id: 'build-done', from: 'build', to: 'done', outcome: 'next' }], nodes: [
  { id: 'build', title: 'Build', operation: 'agent', role: 'planning', instructions: 'Summarise the project folder.', document: 'Saved document', acceptance: ['A short summary'], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', providerId: 'codex', model: 'gpt-5.6-fixture', position: { x: 40, y: 40 }, inputs: [], ...extra },
  { id: 'done', title: 'Done', operation: 'complete', role: 'integration', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 384, y: 40 }, inputs: [] },
] });

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), oldApk: OLD_APK, newApk: APK_PATH, oldPc: OLD_PC, phases: [] };
  const phases = report.phases as string[];
  let desktop: Host | undefined;
  try {
    report.androidApi = runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim();
    // 1. Older app on this PC.
    desktop = await launchDesktop({ env: fakeCodexEnv });
    const projectId = await project(desktop, registry.createTempDir('ezterm-compat-new-pc-'), 'Compat on this PC', stage({ reasoningEffort: 'high' }), { reviewer: { providerId: 'codex', model: 'gpt-5.6-fixture' } });
    await enableFakeCodex(desktop);
    await connectAndAuth(desktop.token, { apkPath: OLD_APK, uninstallFirst: true });
    await openProject('Compat on this PC');
    await openListItem('[data-testid="workflow-subproject-item"]', 'Compat flow');
    await waitForCondition('the older app shows the flow', `document.body.innerText.includes('Build')`, 30_000);
    await noWorkflowError('older app flow');
    await openListItem('.workflow-outline button', 'Build');
    await clickLabel('[data-testid="workflow-workspace"] [role="tab"], [data-testid="workflow-workspace"] button', ['Stage documents and chats', '단계 문서·대화']);
    await fill('.workflow-stage textarea', 'Older app edit');
    await clickLabel('[data-testid="workflow-workspace"] button', ['Save draft', '초안 저장']);
    await waitForCondition('the older app is told to update', `document.body.innerText.includes('Update the Android app')`, 30_000);
    const after = await desktop.window.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!after.ok) throw new Error(after.message);
    const kept = after.snapshot.subprojects.find((item) => item.id === 'compat')!;
    assert.equal(kept.graph.nodes.find((node) => node.id === 'build')?.reasoningEffort, 'high', 'The hidden effort is kept');
    assert.equal(kept.graph.nodes.find((node) => node.id === 'build')?.document, 'Saved document', 'The refused edit did not reach the PC');
    assert.deepEqual(kept.runSettings, { reviewer: { providerId: 'codex', model: 'gpt-5.6-fixture' } });
    await shot('1-older-app-refused.png');
    // A conversation still sends from the older app.
    await clickSelector('[data-testid="workflow-workspace"] header button');
    await clickLabel('[data-testid="workflow-workspace"] button', ['New conversation', '새 일반 대화']);
    await waitForTestId('conversation-start', 30_000);
    await setTestIdTextValue('structured-agent-composer-input', 'Older app conversation');
    await clickSelector('[data-testid="structured-agent-send"]');
    await waitForTestId('structured-agent-session', 30_000);
    await waitForCondition('fixture reply', `document.body.innerText.indexOf('Structured Codex fixture ready') >= 0`, 45_000);
    phases.push('vc77 on this PC: an effort flow opens, a conversation sends, an edit that would drop the hidden fields is refused with "update the app" and the PC keeps effort and run settings');

    // 2. This app over it, data kept.
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    runAdb(['install', '-r', APK_PATH]);
    ensureRemoteBridgeTransport();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    // The saved connection survived the update: connect with it (as after a force-stop).
    await clickSelector('[data-testid="connect-submit"]');
    await waitForTestId(SHELL_ROOT_TEST_ID, 30_000);
    await openProject('Compat on this PC');
    // The device draft is read first (it restores the older app's last view); navigate after it settles.
    await waitForCondition('the device draft check settles', `!document.body.innerText.includes('Checking drafts saved on this device')`, 30_000);
    await sleep(500);
    const visible = (selector: string) => evaluateWebView<boolean>(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(node => node.getBoundingClientRect().width > 0)`);
    if (!await visible('[data-testid="workflow-run-bar"]')) await openListItem('[data-testid="workflow-subproject-item"]', 'Compat flow');
    await waitForCondition('the new flow screen', `[...document.querySelectorAll('[data-testid="workflow-run-bar"]')].some(node => node.getBoundingClientRect().width > 0)`, 30_000);
    if (!await visible('.workflow-stage textarea')) await openListItem('.workflow-outline button', 'Build');
    await waitForCondition('the older app’s draft survives the update', `[...document.querySelectorAll('.workflow-stage textarea')].some(node => node.getBoundingClientRect().width > 0 && node.value === 'Older app edit')`, 30_000);
    await waitForCondition('the saved review AI shows', `(document.querySelector('[data-testid="workflow-run-bar"] select[aria-label="Reviewer model"]') || {}).value === 'gpt-5.6-fixture'`, 30_000);
    await shot('2-updated-app.png');
    // Saving the older app's draft from here keeps what that app could not see (the stage's effort).
    await clickLabel('[data-testid="workflow-workspace"] button', ['Save draft', '초안 저장']);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const now = await desktop.window.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!now.ok) throw new Error(now.message);
      const build = now.snapshot.subprojects.find((item) => item.id === 'compat')!.graph.nodes.find((node) => node.id === 'build')!;
      if (build.document === 'Older app edit') { assert.equal(build.reasoningEffort, 'high', 'The stage keeps its effort'); break; }
      if (Date.now() > deadline) throw new Error('The rebased draft was not saved');
      await sleep(250);
    }
    phases.push('vc78 installed over vc77 without wiping data: pairing, the flow draft and the new flow screen (saved review AI) are there; saving that draft keeps the stage effort');
    await desktop.dispose(); desktop = undefined;

    // 3. This app on an older PC.
    desktop = await launchDesktop({ env: fakeCodexEnv, mainEntry: path.join(OLD_PC, '.vite', 'build', 'main.js'), cwd: OLD_PC });
    await project(desktop, registry.createTempDir('ezterm-compat-old-pc-'), 'Compat on an older PC', stage({}));
    await connectAndAuth(desktop.token);
    await openProject('Compat on an older PC');
    await openListItem('[data-testid="workflow-subproject-item"]', 'Compat flow');
    await waitForTestId('workflow-run-bar', 30_000);
    await noWorkflowError('older PC flow');
    assert.equal(await evaluateWebView<boolean>(`!!document.querySelector('[data-testid="workflow-run-bar"] select[aria-label="Review AI provider"]')`), false, 'No review AI settings on an older PC');
    await clickSelector('[data-testid="workflow-run-again"]');
    await waitForCondition('Run prepares from the dialog', `[...document.querySelectorAll('[role="dialog"] button')].some(node => node.textContent.trim() === 'Prepare this version')`, 30_000);
    await shot('3-older-pc-prepare.png');
    phases.push('vc78 on an older PC (protocol v16): the flow opens, no review AI settings, Run opens the prepare dialog');
    report.status = 'passed';
    console.log('[i2-compat] PASS');
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.stack ?? error.message : String(error);
    try { await shot('failure.png'); } catch { /* keep the original failure */ }
    throw error;
  } finally {
    try { runAdb(['shell', 'am', 'force-stop', APP_ID]); } catch { /* best effort */ }
    closeMobileE2eResources();
    try { await desktop?.dispose(); } catch { /* best effort */ }
    try { await registry.disposeAll(); } catch { /* best effort */ }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(artifactDir, 'i2-compat-report.json'), JSON.stringify(report, null, 2));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
