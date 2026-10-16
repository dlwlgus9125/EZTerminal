/**
 * Real Android WebView planning + encrypted draft recovery against the real PC.
 * Initial connection uses the standard native one-tap helper. Planning controls
 * deliberately use DOM clicks/controlled input so native hit testing is a
 * separate gate, not silently claimed by this scenario. The reviewed CLI fixture
 * supplies provider metadata and initializes sessions; no model turn is submitted.
 * Run: node --experimental-strip-types mobile/e2e/planning-workflow.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APK_PATH, APP_ID, MAIN_ENTRY, closeMobileE2eResources, closeWebViewDevtools, connectAndAuth,
  evaluateWebView, launchDesktop, runAdb, runAdbBinary, setTestIdTextValue, sleep,
  waitForTestId, waitForTestIdHidden,
} from './lib.ts';

const artifactDir = process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR
  ? path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, '../../artifacts/g8-android');
const editor = '.planning-workspace__editor';
const titleSelector = `${editor} input[maxlength="300"]`;
const bodySelector = `${editor} textarea[maxlength="200000"]`;
const saveSelector = `${editor} button[type="submit"]`;
const title = 'Android planning persistence';
const firstBody = 'Saved through the Android planning editor.';
const recoveredBody = 'Offline edit retained through Android force-stop; send only explicitly.';

async function waitForCondition(label: string, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await evaluateWebView<boolean>(expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(150);
  }
}

async function assertWorkflowHealthy(label: string): Promise<void> {
  const errors = await evaluateWebView<string[]>(`[...document.querySelectorAll('.workflow-error, .workflow-toolbar [role="alert"]')].filter(node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0).map(node => node.textContent.trim())`);
  assert.deepEqual(errors, [], `${label}: no unexpected workflow error or graph conflict`);
  assert.deepEqual(await evaluateWebView('window.__workflowAcceptanceErrors || []'), [], `${label}: no uncaught JavaScript or rejected API promise`);
}

async function recordWorkflowRuntimeErrors(): Promise<void> {
  await evaluateWebView(`(() => { if (window.__workflowAcceptanceErrors) return true; window.__workflowAcceptanceErrors = []; window.addEventListener('error', event => window.__workflowAcceptanceErrors.push(event.message)); window.addEventListener('unhandledrejection', event => window.__workflowAcceptanceErrors.push(String(event.reason))); return true; })()`);
}

async function clickSelector(selector: string): Promise<void> {
  await waitForCondition(`enabled ${selector}`, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return node instanceof HTMLElement && !node.disabled && node.getBoundingClientRect().width > 0;
  })()`);
  await evaluateWebView(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement) || node.disabled) throw new Error('Control unavailable');
    node.click(); return true;
  })()`);
}

async function clickLabel(selector: string, labels: readonly string[]): Promise<void> {
  const expression = `(() => {
    const labels = ${JSON.stringify(labels)};
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(node => labels.includes(node.textContent.trim()) && !node.disabled && node.getBoundingClientRect().width > 0);
    return node;
  })()`;
  await waitForCondition(`control ${labels.join('/')}`, `!!${expression}`);
  await evaluateWebView(`(() => { const node = ${expression};
    if (!(node instanceof HTMLElement) || node.disabled) throw new Error('Control unavailable');
    node.click(); return true;
  })()`);
}

async function fillSelector(selector: string, value: string): Promise<void> {
  await waitForCondition(`editable ${selector}`, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return !!node && !node.disabled && !node.readOnly;
  })()`);
  await evaluateWebView(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    setter.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  await waitForCondition('controlled input value', `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return !!node && node.value === ${JSON.stringify(value)}; })()`);
}

async function openProject(name: string, advanced = true): Promise<void> {
  await clickSelector('[data-testid="shell-tab-home"]');
  await waitForTestId('mobile-projects-navigator');
  await waitForCondition('registered project row', `(() => {
    return [...document.querySelectorAll('[data-testid="mobile-planning-project"]')]
      .some(node => node.querySelector('strong') && node.querySelector('strong').textContent === ${JSON.stringify(name)});
  })()`);
  await evaluateWebView(`(() => {
    const node = [...document.querySelectorAll('[data-testid="mobile-planning-project"]')]
      .find(node => node.querySelector('strong') && node.querySelector('strong').textContent === ${JSON.stringify(name)});
    node.click(); return true;
  })()`);
  await waitForTestId('workflow-workspace');
  if (!advanced) return;
  await clickLabel('[data-testid="workflow-workspace"] button', ['Quick tasks and existing work', '빠른 작업·기존 자료']);
  await waitForTestId('planning-workspace');
  await waitForCondition('project document state loaded', `!!document.querySelector('[data-testid="planning-workspace"] .planning-workspace__intro')`);
}

async function openPlanningDocument(): Promise<void> {
  await clickLabel('[data-testid="planning-workspace"] [role="tab"]', ['Planning', '기획']);
  await waitForCondition('visible restored planning editor', `(() => {
    const node = document.querySelector(${JSON.stringify(bodySelector)});
    return !!node && node.getBoundingClientRect().width > 0 && !node.disabled;
  })()`);
}

async function waitForDeviceDraftIdle(): Promise<void> {
  await waitForCondition('secure draft write completion', `(() => {
    const root = document.querySelector('[data-testid="planning-workspace"]');
    if (!root) return false;
    const text = root.textContent;
    if (text.includes('Device draft storage is unavailable') || text.includes('기기 초안 저장소를 사용할 수 없습니다'))
      throw new Error('Secure planning draft persistence failed');
    return !text.includes('Saving draft on this device') && !text.includes('기기에 초안 저장 중');
  })()`);
  // Observe the settled UI after React has processed the controlled edit.
  await sleep(400);
}

async function capturePlanningVisibility(): Promise<unknown> {
  return evaluateWebView(`(() => {
    const root = document.querySelector('[data-testid="planning-workspace"]');
    const save = document.querySelector(${JSON.stringify(saveSelector)});
    const geometry = node => { const rect = node.getBoundingClientRect(); return {width:rect.width,height:rect.height,x:rect.x,y:rect.y}; };
    return {
      root: root && geometry(root), save: save && {disabled:save.disabled, geometry:geometry(save)},
      tabs: root && [...root.querySelectorAll('[role="tab"]')].map(node => ({text:node.textContent,selected:node.getAttribute('aria-selected')})),
      panels: root && [...root.querySelectorAll('[role="tabpanel"]')].map(node => ({id:node.id,hidden:node.hidden,geometry:geometry(node)})),
      ancestors: save && (() => { const list = []; let node = save; while (node) {
        list.push({tag:node.tagName,className:typeof node.className === 'string' ? node.className : '',display:getComputedStyle(node).display,hidden:node.hidden});
        node = node.parentElement;
      } return list; })(),
      offline: !!document.querySelector('[data-testid="mobile-reconnect-scrim"]')
    };
  })()`);
}

async function main(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const registry = new OwnedDesktopProfileRegistry();
  const projectRoot = registry.createTempDir('ezterm-mobile-planning-project-');
  const name = 'Android planning E2E';
  const report: Record<string, unknown> = {
    scenario: 'Android planning manual save / offline encrypted draft / force-stop recovery',
    inputMethod: 'Initial auth: native tap; planning and restart auth: WebView DOM clicks and input events',
    realProviderCalls: 0,
    modelTurns: 0,
    providerFixture: 'Reviewed fake Codex initialization only',
    startedAt: new Date().toISOString(),
    phases: [],
  };
  const phases = report.phases as string[];
  const errors: unknown[] = [];
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    report.runtime = {
      serial: process.env.ANDROID_SERIAL ?? 'auto-selected',
      androidApi: runAdb(['shell', 'getprop', 'ro.build.version.sdk']).trim(),
      apkSha256: createHash('sha256').update(await readFile(APK_PATH)).digest('hex'),
      desktopMainSha256: createHash('sha256').update(await readFile(MAIN_ENTRY)).digest('hex'),
      sourceFingerprint: process.env.EZTERMINAL_E2E_SOURCE_FINGERPRINT ?? null,
    };
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    const fakeCodex = path.resolve(import.meta.dirname, '../../e2e/fixtures/fake-codex');
    desktop = await launchDesktop({ env: { [pathKey]: `${fakeCodex}${path.delimiter}${process.env[pathKey] ?? ''}` } });
    const host = desktop.window;
    const saved = await host.evaluate(root => window.ezterminal.saveAgentProject({
      name: 'Android planning E2E', primaryRoot: root, additionalRoots: [], pinned: false,
    }), projectRoot);
    if (!saved.ok) throw new Error(`Project registration failed: ${saved.reason}`);
    const projectId = saved.project.projectId;
    const before = await host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const readHost = async () => {
      const result = await host.evaluate(id => window.ezterminal.getPlanningSnapshot(id), projectId);
      if (!result.ok) throw new Error(`Host planning read failed: ${result.message}`);
      return result.snapshot;
    };
    assert.equal((await readHost()).revision, 0);
    await connectAndAuth(desktop.token);
    await openProject(name);
    await clickLabel('[data-testid="planning-workspace"] button', ['Write a requirement', '요구사항 작성']);
    await fillSelector(titleSelector, title);
    await fillSelector(bodySelector, firstBody);
    await clickSelector(saveSelector);
    const firstDeadline = Date.now() + 20_000;
    while ((await readHost()).revision !== 1) {
      if (Date.now() > firstDeadline) throw new Error('Android manual save did not reach the host');
      await sleep(150);
    }
    const initial = await readHost();
    assert.equal(initial.draft.items.length, 1);
    assert.equal(initial.draft.items[0].title, title);
    assert.equal(initial.draft.items[0].body, firstBody);
    phases.push('Android project entry, manual creation and explicit save reached host revision 1');
    console.log('[planning-e2e] PASS: Android manual save -> PC revision 1');
    await waitForDeviceDraftIdle();

    await host.evaluate(() => window.ezterminal.setRemoteEnabled(false));
    await waitForTestId('mobile-reconnect-scrim', 15_000);
    await fillSelector(bodySelector, recoveredBody);
    await waitForCondition('offline save disabled', `(() => { const node = document.querySelector(${JSON.stringify(saveSelector)}); return !!node && node.disabled === true; })()`);
    await waitForDeviceDraftIdle();
    assert.equal((await readHost()).revision, 1);
    assert.equal((await readHost()).draft.items[0].body, firstBody);
    await writeFile(path.join(artifactDir, 'planning-offline.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    phases.push('Offline editing retained locally; save disabled and host unchanged');

    runAdb(['shell', 'am', 'force-stop', APP_ID]);
    closeWebViewDevtools();
    runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000);
    await clickSelector('[data-testid="connect-submit"]');
    // This is an intentionally offline reconnect: the encrypted project cache
    // must restore browsing before the remote bridge returns.
    await waitForTestId('mobile-workspace', 30_000);
    await openProject(name);
    await openPlanningDocument();
    await waitForCondition('force-stop restored offline draft', `(() => { const node = document.querySelector(${JSON.stringify(bodySelector)}); return !!node && node.value === ${JSON.stringify(recoveredBody)}; })()`);
    assert.equal((await readHost()).revision, 1);
    phases.push('Android force-stop restored encrypted offline document body with PC still disconnected');
    console.log('[planning-e2e] PASS: force-stop restored offline draft');
    report.beforeReconnect = await capturePlanningVisibility();

    await host.evaluate(() => window.ezterminal.setRemoteEnabled(true));
    await waitForTestIdHidden('mobile-reconnect-scrim', 30_000);
    report.afterReconnect = await capturePlanningVisibility();
    await waitForCondition('visible planning editor remains open after reconnect', `(() => {
      const node = document.querySelector(${JSON.stringify(bodySelector)});
      return !!node && node.getBoundingClientRect().width > 0;
    })()`);
    await waitForCondition('explicit save enabled after reconnect', `(() => { const node = document.querySelector(${JSON.stringify(saveSelector)}); return !!node && node.disabled === false; })()`);
    const noAutoSendUntil = Date.now() + 2_000;
    do {
      const state = await readHost();
      assert.equal(state.revision, 1, 'Reconnection must not automatically send a draft');
      assert.equal(state.draft.items[0].body, firstBody);
      await sleep(150);
    } while (Date.now() < noAutoSendUntil);
    assert.equal(await evaluateWebView(`document.querySelector(${JSON.stringify(bodySelector)}).value`), recoveredBody);
    phases.push('Reconnect preserved unsent input and host revision 1 for a 2-second observation window');
    report.beforeFinalSave = await capturePlanningVisibility();
    await clickSelector(saveSelector);
    const finalDeadline = Date.now() + 20_000;
    while ((await readHost()).revision !== 2) {
      if (Date.now() > finalDeadline) throw new Error('Explicit recovered-draft save did not reach the host');
      await sleep(150);
    }
    const final = await readHost();
    assert.equal(final.draft.items.length, 1);
    assert.equal(final.draft.items[0].id, initial.draft.items[0].id);
    assert.equal(final.draft.items[0].body, recoveredBody);
    assert.equal(final.history.length, 2);
    const after = await host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    assert.deepEqual(after?.turns, before?.turns, 'Planning editing must not start a provider turn');
    const execution = await host.evaluate(id => window.ezterminal.getPlanningExecutionSnapshot(id), projectId);
    assert.equal(execution.ok, true);
    if (execution.ok) assert.deepEqual(execution.snapshot.runs, []);
    phases.push('Explicit recovered-draft save reached revision 2 exactly once; no provider turns or runs');
    await writeFile(path.join(artifactDir, 'planning-recovered.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    report.finalHostRevision = final.revision;
    // r4: real remote subproject commands, common chat identity, and the device's
    // encrypted graph cache. Provider discovery uses the reviewed CLI fixture. A 2.0
    // conversation starts with its first message, so the deterministic fixture answers
    // exactly one turn; no workflow execution run is started in this scenario.
    await recordWorkflowRuntimeErrors();
    // Planning replaces the project's item list (Phase 4); subprojects live in the other view.
    await clickLabel('[data-testid="workflow-workspace"] .workflow-switch button', ['Subprojects and conversations', '소프로젝트·대화']);
    await clickLabel('[data-testid="workflow-workspace"] button', ['New subproject', '새 소프로젝트']);
    await fillSelector('.workflow-create input', 'Android subproject');
    await clickLabel('[role="dialog"] button', ['Create subproject', '소프로젝트 만들기']);
    const readWorkflow = async () => { const result = await host.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!result.ok) throw new Error(result.message); return result.snapshot; };
    const createDeadline = Date.now() + 30_000;
    while (!(await readWorkflow()).subprojects.some(item => item.title === 'Android subproject')) { if (Date.now() > createDeadline) throw new Error('Android subproject creation was not acknowledged'); await sleep(150); }
    const subproject = (await readWorkflow()).subprojects.find(item => item.title === 'Android subproject')!;
    await clickLabel('[data-testid="workflow-workspace"] button', ['Stage documents and chats', '단계 문서·대화']);
    await fillSelector('.workflow-stage textarea', 'Android saved stage document');
    await clickLabel('[data-testid="workflow-workspace"] button', ['Save draft', '초안 저장']);
    const documentDeadline = Date.now() + 30_000;
    while ((await readWorkflow()).subprojects.find(item => item.id === subproject.id)?.graph.nodes.find(node => node.id === subproject.graph.entryNodeId)?.document !== 'Android saved stage document') { if (Date.now() > documentDeadline) throw new Error('Android stage document save was not acknowledged'); await sleep(150); }
    await fillSelector('.workflow-stage textarea', 'Android unsaved stage draft');
    await waitForCondition('encrypted graph draft receipt', `(async () => { const r = await window.ezterminal.workflowDraftRead(${JSON.stringify(projectId)}); const state = r.ok && r.snapshot.state; const draft = state && state.drafts[${JSON.stringify(subproject.id)}]; const node = draft && draft.graph.nodes.find(n => n.id === ${JSON.stringify(subproject.graph.entryNodeId)}); return !!node && node.document === 'Android unsaved stage draft'; })()`);
    const inspected = await host.evaluate(() => window.ezterminal.inspectDaemonProvider('codex')); if (!inspected.ok) throw new Error(inspected.message);
    // Never enable a real provider: the first message below must reach the fixture only.
    assert.ok(path.resolve(inspected.value.probe.executablePath).startsWith(fakeCodex), `expected the fake codex, found ${inspected.value.probe.executablePath}`);
    for (let attempt = 0; attempt < 4; attempt++) {
      const enabled = await host.evaluate(async ({ probe, reviewDigest, attempt }) => {
        const state = await window.ezterminal.getDaemonSnapshot(); if (!state) throw new Error('Daemon unavailable'); const commandId = `android-workflow-provider-${attempt}`;
        return window.ezterminal.sendDaemonCommand({ protocolVersion: state.protocolVersion, commandId, idempotencyKey: commandId, expectedRevision: state.revision, issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'android-workflow-fixture' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } });
      }, { ...inspected.value, attempt });
      if (enabled.ok) break; if (enabled.error.code !== 'revision-conflict' || attempt === 3) throw new Error(enabled.error.message);
    }
    await clickSelector('[data-testid="workflow-workspace"] header button');
    await clickLabel('[data-testid="workflow-workspace"] button', ['New conversation', '새 일반 대화']);
    await waitForTestId('conversation-start', 30_000);
    await setTestIdTextValue('structured-agent-composer-input', 'Android stage conversation');
    await clickSelector('[data-testid="structured-agent-send"]');
    await waitForTestId('structured-agent-session', 30_000);
    await waitForCondition('fixture reply to the first message', `document.body.innerText.indexOf('Structured Codex fixture ready') >= 0`, 45_000);
    const afterFirstSend = await host.evaluate(() => window.ezterminal.getDaemonSnapshot());
    assert.equal(afterFirstSend?.turns.length, (before?.turns.length ?? 0) + 1, 'The first message starts exactly one fixture turn');
    const sessionId = await evaluateWebView<string>('document.querySelector("[data-testid=structured-agent-session]").getAttribute("data-session-id")');
    // The accepted first message clears the composer once its draft store is ready; type the
    // unsent draft only after that, as the conversation journey does.
    await waitForCondition('live composer recovery ready', `!!document.querySelector('.mobile-v2-draft-status[data-state="saved"]')`);
    await waitForCondition('accepted draft cleared', `(document.querySelector('[data-testid="structured-agent-composer-input"]') || {}).value === ''`);
    // More than one composer can be mounted here; type into the visible one, as lib does.
    await setTestIdTextValue('structured-agent-composer-input', 'Android unsent chat draft');
    await sleep(1000);
    await clickSelector('[data-testid="shell-tab-home"]');
    await clickLabel('.workflow-conversation-row button', ['Link to stage', '단계에 연결']);
    await evaluateWebView(`(() => { const selects = document.querySelectorAll('[role="dialog"] select'); selects[0].value = ${JSON.stringify(subproject.id)}; selects[0].dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await evaluateWebView(`(() => { const selects = document.querySelectorAll('[role="dialog"] select'); selects[1].value = ${JSON.stringify(subproject.graph.entryNodeId)}; selects[1].dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await clickLabel('[role="dialog"] button', ['Link', '연결']);
    await waitForCondition('stage chat link acknowledged', `!document.querySelector('[role="dialog"]')`, 30_000);
    await clickSelector('.workflow-stage .workflow-items button'); await waitForTestId('structured-agent-session');
    assert.equal(await evaluateWebView('document.querySelector("[data-testid=structured-agent-session]").getAttribute("data-session-id")'), sessionId);
    // Reopening restores the device draft asynchronously ("Loading device draft…").
    await waitForCondition('unsent chat draft restored in the reopened conversation', `(() => { const visible = Array.prototype.slice.call(document.querySelectorAll('[data-testid="structured-agent-composer-input"]')).reverse().filter(node => node.getBoundingClientRect().width > 0)[0]; return !!visible && visible.value === 'Android unsent chat draft'; })()`, 30_000);
    await clickLabel('.workflow-conversation-context button', ['Return to this stage', '이 단계로 돌아가기']);
    await waitForCondition('unsaved stage preserved through chat return', `(document.querySelector('.workflow-stage textarea') || {}).value === 'Android unsaved stage draft'`);
    await assertWorkflowHealthy('Stage chat return');
    const spacing = await evaluateWebView<{ token: string; actualGap: number; fallback: string | null }>(`(() => { const buttons = document.querySelectorAll('.workflow-tabs > button'); const a = buttons[0].getBoundingClientRect(), b = buttons[1].getBoundingClientRect(); return { token: getComputedStyle(document.documentElement).getPropertyValue('--ui-space-2'), actualGap: Math.abs(a.top - b.top) < 1 ? b.left - a.right : b.top - a.bottom, fallback: document.documentElement.getAttribute('data-ui-flex-gap') }; })()`);
    report.workflowSpacing = spacing;
    assert.ok(spacing.actualGap >= 4, 'Stage navigation buttons must have a visible gap in the actual WebView');
    await writeFile(path.join(artifactDir, 'r4-stage-chat-return.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    phases.push('r4 subproject create/save acknowledged; same session and unsent chat draft survive stage linking; unsaved stage document survives chat return');
    await host.evaluate(() => window.ezterminal.setRemoteEnabled(false)); await waitForTestId('mobile-reconnect-scrim');
    await fillSelector('.workflow-stage textarea', 'Android offline graph draft');
    await waitForCondition('encrypted offline graph receipt', `(async () => { const r = await window.ezterminal.workflowDraftRead(${JSON.stringify(projectId)}); const state = r.ok && r.snapshot.state; const draft = state && state.drafts[${JSON.stringify(subproject.id)}]; const node = draft && draft.graph.nodes.find(n => n.id === ${JSON.stringify(subproject.graph.entryNodeId)}); return !!node && node.document === 'Android offline graph draft'; })()`);
    runAdb(['shell', 'am', 'force-stop', APP_ID]); closeWebViewDevtools(); runAdb(['shell', 'am', 'start', '-n', `${APP_ID}/.MainActivity`]);
    await waitForTestId('connect-screen', 45_000); await recordWorkflowRuntimeErrors(); await clickSelector('[data-testid="connect-submit"]'); await waitForTestId('mobile-workspace', 30_000); await openProject(name, false);
    await waitForCondition('offline graph cache and draft restored after force-stop', `(document.querySelector('.workflow-stage textarea') || {}).value === 'Android offline graph draft'`);
    await assertWorkflowHealthy('Offline graph recovery');
    assert.equal(await evaluateWebView(`document.querySelectorAll('.workflow-workspace > .workflow-notice').length`), 1, 'Offline recovery has one clear status message');
    const beforeR4Reconnect = (await readWorkflow()).subprojects.find(item => item.id === subproject.id)!;
    assert.equal(beforeR4Reconnect.graph.nodes.find(node => node.id === subproject.graph.entryNodeId)?.document, 'Android saved stage document');
    await writeFile(path.join(artifactDir, 'r4-offline-graph-restored.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    await host.evaluate(() => window.ezterminal.setRemoteEnabled(true)); await waitForTestIdHidden('mobile-reconnect-scrim', 30_000);
    await waitForCondition('same draft retained after authoritative reconnect', `(document.querySelector('.workflow-stage textarea') || {}).value === 'Android offline graph draft'`);
    await assertWorkflowHealthy('Authoritative reconnect');
    const r4ObservationUntil = Date.now() + 2_000;
    do {
      const observed = await readWorkflow();
      const observedSubproject = observed.subprojects.find(item => item.id === subproject.id)!;
      assert.equal(observedSubproject.revision, beforeR4Reconnect.revision, 'Reconnect must not save the recovered graph draft');
      assert.equal(observedSubproject.graph.nodes.find(node => node.id === subproject.graph.entryNodeId)?.document, 'Android saved stage document');
      assert.equal(observed.runs.length, 0, 'Reconnect must not start a workflow run');
      await sleep(150);
    } while (Date.now() < r4ObservationUntil);
    assert.deepEqual((await host.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.turns.length, afterFirstSend?.turns.length, 'Reconnect must not start a provider turn');
    phases.push('r4 encrypted graph snapshot/draft restore offline after force-stop; reconnect keeps local draft and host revision/document/runs unchanged for 2 seconds without new provider turns');
    report.status = 'passed';
    console.log('[planning-e2e] PASS: explicit recovered draft -> PC revision 2; no automatic send/provider turns');
  } catch (error) {
    errors.push(error);
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    try { report.failureVisibility = await capturePlanningVisibility(); } catch { /* Original failure remains authoritative. */ }
    try { await writeFile(path.join(artifactDir, 'failure.png'), runAdbBinary(['exec-out', 'screencap', '-p'])); } catch { /* Preserve the original failure. */ }
  } finally {
    try { runAdb(['shell', 'am', 'force-stop', APP_ID]); } catch (error) { errors.push(error); }
    closeMobileE2eResources();
    try { await desktop?.dispose(); } catch (error) { errors.push(error); }
    try { await registry.disposeAll(); } catch (error) { errors.push(error); }
    report.finishedAt = new Date().toISOString();
    report.cleanupErrors = errors.slice(report.status === 'failed' ? 1 : 0).map(error => String(error));
    await writeFile(path.join(artifactDir, 'planning-workflow-report.json'), JSON.stringify(report, null, 2));
  }
  if (errors.length) throw new AggregateError(errors, 'Android planning workflow did not complete');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
