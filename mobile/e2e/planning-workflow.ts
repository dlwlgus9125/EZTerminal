/**
 * Real Android WebView flow work against the real PC: a subproject made on the phone, its
 * encrypted graph draft, one flow run answered from the phone (I2), its 다시 실행 and 반복,
 * and the run's results opened in the phone's result dialog (I5: what the old planning panel
 * showed now lives on the flow screen). Initial connection uses the standard native one-tap
 * helper; flow controls use DOM clicks so native hit testing stays a separate gate. The
 * reviewed CLI fixture supplies provider metadata and answers the turns.
 * Run: node --experimental-strip-types mobile/e2e/planning-workflow.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { OwnedDesktopProfileRegistry } from '../../e2e/owned-desktop-profile.ts';
import {
  APK_PATH, APP_ID, MAIN_ENTRY, closeMobileE2eResources, connectAndAuth,
  evaluateWebView, launchDesktop, restartApp, runAdb, runAdbBinary, setTestIdTextValue, sleep,
  waitForTestId, waitForTestIdHidden,
  openProjectList,
} from './lib.ts';

const artifactDir = process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR
  ? path.resolve(process.env.EZTERMINAL_MOBILE_E2E_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, '../../artifacts/g8-android');

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

async function openProject(name: string): Promise<void> {
  // I4 layout A: the feed's ▾ opens the project list (every project chosen).
  await openProjectList();
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
}

async function captureWorkflowVisibility(): Promise<unknown> {
  return evaluateWebView(`(() => {
    const root = document.querySelector('[data-testid="workflow-workspace"]');
    const geometry = node => { const rect = node.getBoundingClientRect(); return {width:rect.width,height:rect.height,x:rect.x,y:rect.y}; };
    return {
      root: root && geometry(root), view: root && root.getAttribute('data-view'),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => ({label:node.getAttribute('aria-label'),geometry:geometry(node)})),
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
    scenario: 'Android flow subproject / encrypted graph draft / run from the phone / run results',
    inputMethod: 'Initial auth: native tap; flow controls: WebView DOM clicks and input events',
    realProviderCalls: 0,
    modelTurns: 'fixture turns only (one conversation and two flow runs)',
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
    await connectAndAuth(desktop.token);
    await openProject(name);
    // r4: real remote subproject commands, common chat identity, and the device's
    // encrypted graph cache. Provider discovery uses the reviewed CLI fixture. A 2.0
    // conversation starts with its first message, so the deterministic fixture answers
    // exactly one turn; no workflow execution run is started in this scenario.
    await recordWorkflowRuntimeErrors();
    await clickLabel('[data-testid="workflow-workspace"] button', ['New subproject', '새 소프로젝트']);
    await fillSelector('.workflow-create input', 'Android subproject');
    await clickLabel('[role="dialog"] button', ['Create subproject', '소프로젝트 만들기']);
    const readWorkflow = async () => { const result = await host.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!result.ok) throw new Error(result.message); return result.snapshot; };
    const createDeadline = Date.now() + 30_000;
    while (!(await readWorkflow()).subprojects.some(item => item.title === 'Android subproject')) { if (Date.now() > createDeadline) throw new Error('Android subproject creation was not acknowledged'); await sleep(150); }
    const subproject = (await readWorkflow()).subprojects.find(item => item.title === 'Android subproject')!;
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
    // Back to the project screen the conversation was opened from (I4: its back button returns there, no tab bar).
    await clickSelector('[data-testid="mobile-structured-agent-back"]');
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
    // The run bar wraps on a phone: its controls must not overlap in any WebView (API 29 has no flex gap).
    const runBar = await evaluateWebView<{ count: number; overlap: number } | null>(`(() => {
      const bar = document.querySelector('[data-testid="workflow-run-bar"]'); if (!bar) return null;
      const boxes = [...bar.children].map(node => node.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
      let overlap = 0;
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i], b = boxes[j];
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 0.5 && y > 0.5) overlap = Math.max(overlap, Math.min(x, y));
      }
      return { count: boxes.length, overlap };
    })()`);
    report.runBarLayout = runBar;
    assert.ok(runBar && runBar.count >= 3 && runBar.overlap <= 0.5, `The run bar's controls sit apart (${JSON.stringify(runBar)})`);
    await writeFile(path.join(artifactDir, 'r4-stage-chat-return.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    phases.push('r4 subproject create/save acknowledged; same session and unsent chat draft survive stage linking; unsaved stage document survives chat return');
    await host.evaluate(() => window.ezterminal.setRemoteEnabled(false)); await waitForTestId('mobile-reconnect-scrim');
    await fillSelector('.workflow-stage textarea', 'Android offline graph draft');
    await waitForCondition('encrypted offline graph receipt', `(async () => { const r = await window.ezterminal.workflowDraftRead(${JSON.stringify(projectId)}); const state = r.ok && r.snapshot.state; const draft = state && state.drafts[${JSON.stringify(subproject.id)}]; const node = draft && draft.graph.nodes.find(n => n.id === ${JSON.stringify(subproject.graph.entryNodeId)}); return !!node && node.document === 'Android offline graph draft'; })()`);
    await restartApp();
    await waitForTestId('connect-screen', 45_000); await recordWorkflowRuntimeErrors(); await clickSelector('[data-testid="connect-submit"]'); await waitForTestId('mobile-workspace', 30_000); await openProject(name);
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
    // I2: run a flow from the phone. The review AI is saved in the run bar, 실행 runs the saved flow, the
    // approval stage is approved from its stage column, the working stage's conversation opens from there,
    // and once the run finishes 다시 실행 runs it again with a new stage conversation.
    const runGraph = {
      entryNodeId: 'gate',
      nodes: [
        { id: 'gate', title: 'Go-ahead', operation: 'approval' as const, role: 'review' as const, instructions: 'Approve to start the build.', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan' as const, position: { x: 40, y: 40 }, inputs: [] },
        { id: 'build', title: 'Build', operation: 'agent' as const, role: 'implementation' as const, instructions: 'Summarise the project folder.', document: '', acceptance: ['A short summary'], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan' as const, providerId: 'codex', model: 'gpt-5.6-fixture', position: { x: 384, y: 40 }, inputs: [] },
        { id: 'done', title: 'Done', operation: 'complete' as const, role: 'integration' as const, instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan' as const, position: { x: 728, y: 40 }, inputs: [] },
        { id: 'stopped', title: 'Stopped', operation: 'complete' as const, role: 'integration' as const, instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan' as const, position: { x: 384, y: 224 }, inputs: [] },
      ],
      edges: [
        { id: 'gate-build', from: 'gate', to: 'build', outcome: 'approved' as const },
        { id: 'gate-stopped', from: 'gate', to: 'stopped', outcome: 'rejected' as const },
        { id: 'build-done', from: 'build', to: 'done', outcome: 'next' as const },
      ],
    };
    const beforeRunFlow = await readWorkflow();
    const createdRunFlow = await host.evaluate(command => window.ezterminal.executeWorkflowCommand(command), { commandId: 'android-run-flow', projectId, hostId: beforeRunFlow.hostId,
      expectedRevision: beforeRunFlow.registryRevision, type: 'subproject.create' as const, payload: { id: 'android-run', title: 'Android run', goal: '', presetId: 'custom' as const, graph: runGraph } });
    assert.equal(createdRunFlow.ok, true, 'The run flow was created on the PC');
    const flowRuns = async () => (await readWorkflow()).runs.filter(run => run.preparation.workflow?.subprojectId === 'android-run').sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const waitHost = async (label: string, check: () => Promise<boolean>, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!await check()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(250); }
    };
    const openListItem = async (selector: string, label: string) => {
      const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.querySelector('strong') && node.querySelector('strong').textContent === ${JSON.stringify(label)})`;
      await waitForCondition(`item ${label}`, `!!(${find})`, 30_000);
      await evaluateWebView(`(() => { ${find}.click(); return true; })()`);
    };
    const approveGate = async () => {
      await clickLabel('[data-testid="workflow-run-bar"] button', ['1 awaiting approval', '승인 대기 1']);
      await clickLabel('[data-testid="workflow-stage-approval"] button', ['Approve', '승인']);
    };
    await clickSelector('[data-testid="workflow-back"]');
    await openListItem('[data-testid="workflow-subproject-item"]', 'Android run');
    await waitForTestId('workflow-run-bar', 30_000);
    // I2-9: the phone reads the PC's model catalog (provider-models-read) and saves the review AI itself.
    const pickReviewer = async (labels: readonly string[], value: string) => {
      const select = `[...document.querySelectorAll('[data-testid="workflow-run-bar"] select')].find(node => ${JSON.stringify(labels)}.includes(node.getAttribute('aria-label') || ''))`;
      await waitForCondition(`the ${labels[0]} offers ${value}`, `!!${select} && !${select}.disabled && [...${select}.options].some(option => option.value === ${JSON.stringify(value)})`, 30_000);
      await evaluateWebView(`(() => { const select = ${select}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    };
    await pickReviewer(['Review AI provider', '검토 AI 제공자'], 'codex');
    await pickReviewer(['Reviewer model', '검토 모델'], 'gpt-5.6-fixture');
    await waitHost('the review AI chosen on the phone is saved on the PC', async () => (await readWorkflow()).subprojects.find(item => item.id === 'android-run')?.runSettings?.reviewer.model === 'gpt-5.6-fixture');
    report.phoneModelCatalog = await evaluateWebView<string>(`[...(([...document.querySelectorAll('[data-testid="workflow-run-bar"] select')].find(node => ['Reviewer model', '검토 모델'].includes(node.getAttribute('aria-label') || '')) || {}).options || [])].map(option => option.value).join(',')`);
    await clickSelector('[data-testid="workflow-run-again"]');
    await waitHost('run #1 waits for its approval', async () => (await flowRuns())[0]?.workflowRuntime?.activations.some(entry => entry.nodeId === 'gate' && entry.state === 'awaiting-approval') === true);
    await waitForCondition('run #1 on the phone', `/(Run|실행) #1/.test((document.querySelector('[data-testid="workflow-run-phase"]') || {}).textContent || '')`, 30_000);
    // The host counts the waiting stage (I2-5): the phone counts it (the terminal header's way back to the feed), and it clears once approved.
    await waitForCondition('the phone badges the waiting approval', `Number((document.querySelector('[data-testid="mobile-waiting-badge"]') || {}).textContent || 0) >= 1`, 30_000);
    await writeFile(path.join(artifactDir, 'i2-attention-badge.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    await approveGate();
    await waitForCondition('the badge clears after the approval', `!document.querySelector('[data-testid="mobile-waiting-badge"]')`, 30_000);
    await waitHost('run #1 sends its AI stage', async () => !!(await flowRuns())[0]?.attempts[0]?.sessionId);
    const firstSession = (await flowRuns())[0]!.attempts[0]!.sessionId;
    await openListItem('.workflow-outline button', 'Build');
    await clickSelector('[data-testid="workflow-stage-open"]');
    await waitForCondition('the stage conversation of run #1', `(document.querySelector('[data-testid="structured-agent-session"]') || { getAttribute: () => null }).getAttribute('data-session-id') === ${JSON.stringify(firstSession)}`, 30_000);
    await writeFile(path.join(artifactDir, 'i2-stage-conversation.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    await waitHost('run #1 completes', async () => (await flowRuns())[0]?.state === 'completed', 180_000);
    // Leaving the stage conversation returns to the project screen, which kept the flow that was open.
    await clickSelector('[data-testid="mobile-structured-agent-back"]');
    await waitForTestId('workflow-run-bar', 30_000);
    await waitForCondition('run #1 shown as done', `/(Run|실행) #1/.test((document.querySelector('[data-testid="workflow-run-phase"]') || {}).textContent || '')`, 30_000);
    // I5: the run's results open in the flow screen's own dialog (the planning panel is gone).
    await clickLabel('[data-testid="workflow-run-bar"] button', ['Results', '결과']);
    await waitForCondition('run results dialog', `[...document.querySelectorAll('[role="dialog"]')].some(node => node.getBoundingClientRect().width > 0 && /통합|Integration/.test(node.textContent || ''))`, 30_000);
    report.resultsDialog = await captureWorkflowVisibility();
    await writeFile(path.join(artifactDir, 'i5-run-results.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    await clickLabel('[role="dialog"] button', ['Close', '닫기']);
    await waitForCondition('run results dialog closed', `![...document.querySelectorAll('[role="dialog"]')].some(node => node.getBoundingClientRect().width > 0)`, 15_000);
    phases.push('I5 run results on the phone: 결과 opens the integration result dialog over the flow and closes back to it');
    await clickSelector('[data-testid="workflow-run-again"]');
    await waitHost('run #2 waits for its approval', async () => (await flowRuns())[1]?.workflowRuntime?.activations.some(entry => entry.nodeId === 'gate' && entry.state === 'awaiting-approval') === true);
    await approveGate();
    await waitHost('run #2 sends its AI stage', async () => !!(await flowRuns())[1]?.attempts[0]?.sessionId);
    assert.notEqual((await flowRuns())[1]!.attempts[0]!.sessionId, firstSession, 'Each run starts a new stage conversation');
    assert.equal((await flowRuns()).length, 2, 'One run per 실행 / 다시 실행');
    await writeFile(path.join(artifactDir, 'i2-run-again.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    // 반복 (I2-6): set on the phone, saved on the PC in the phone's zone, shown with its next run or why it waits.
    const chooseOption = async (testId: string, value: string) => {
      const select = `[...document.querySelectorAll(${JSON.stringify(`[data-testid="${testId}"]`)})].reverse().find(node => { const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })`;
      await waitForCondition(`the ${testId} select`, `!!${select} && !${select}.disabled`, 30_000);
      await evaluateWebView(`(() => { const select = ${select}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    };
    const savedRepeat = async () => (await readWorkflow()).subprojects.find(item => item.id === 'android-run')?.repeat;
    // What the run bar says when a save does not land (kept in the report).
    const repeatState = () => evaluateWebView<string>(`JSON.stringify({ bar: (document.querySelector('[data-testid="workflow-run-bar"]') || {}).innerText,
      cadence: (() => { const select = document.querySelector('[data-testid="workflow-repeat-cadence"]'); return select && { value: select.value, disabled: select.disabled, options: [...select.options].map(option => option.value + (option.disabled ? ':off' : '')) }; })(),
      alerts: [...document.querySelectorAll('[role="alert"], [role="status"]')].map(node => node.textContent).filter(Boolean).slice(0, 8) })`);
    // A choice the PC does not save fails with what the run bar and the selects said (zone included).
    const chooseAndConfirm = async (testId: string, value: string, label: string, saved: () => Promise<boolean>) => {
      await chooseOption(testId, value);
      try { await waitHost(label, saved, 30_000); } catch (error) {
        const probe = await evaluateWebView<string>(`(() => { const all = [...document.querySelectorAll(${JSON.stringify(`[data-testid="${testId}"]`)})];
          return JSON.stringify({ count: all.length, visible: all.map(node => node.getBoundingClientRect().width > 0), values: all.map(node => node.value), disabled: all.map(node => node.disabled), zone: Intl.DateTimeFormat().resolvedOptions().timeZone }); })()`).catch((cause: unknown) => String(cause));
        report.repeatFailure = { state: await repeatState().catch((cause: unknown) => String(cause)), probe };
        throw error;
      }
    };
    await chooseAndConfirm('workflow-repeat-cadence', 'daily', '반복 saved on the PC', async () => (await savedRepeat())?.enabled === true);
    await chooseAndConfirm('workflow-repeat-hour', '07', '반복 time saved on the PC', async () => (await savedRepeat())?.time === '07:00');
    await waitForCondition('반복 status on the phone', `/Next run|다음 실행|Repeats run only while|PC 앱이 로그인할 때/.test((document.querySelector('[data-testid="workflow-repeat-status"]') || {}).textContent || '')`, 30_000);
    const repeat = await savedRepeat();
    assert.equal(repeat?.cadence, 'daily', 'The phone saved a daily repeat');
    assert.ok(repeat?.timezone, 'The repeat names the zone it runs in');
    report.repeat = { saved: repeat, status: await evaluateWebView<string>(`(document.querySelector('[data-testid="workflow-repeat-status"]') || {}).textContent || ''`) };
    // The run bar is above the stage column the earlier steps left on screen: bring 반복 into view for the shot.
    await evaluateWebView(`(() => { document.querySelector('[data-testid="workflow-repeat"]').scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(500);
    await writeFile(path.join(artifactDir, 'i2-repeat.png'), runAdbBinary(['exec-out', 'screencap', '-p']));
    phases.push('I2 반복 from the phone: daily at 07:00 saved on the PC with its zone; the phone shows the next run or why it waits');
    await assertWorkflowHealthy('I2 flow run');
    phases.push('I2 flow run from the phone: review AI saved, 실행 → approve → working stage conversation → run #1 completed → 다시 실행 = run #2 with a new stage conversation');
    report.status = 'passed';
    console.log('[planning-e2e] PASS: phone flow run, 다시 실행, 반복 and run results');
  } catch (error) {
    errors.push(error);
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    try { report.failureVisibility = await captureWorkflowVisibility(); } catch { /* Original failure remains authoritative. */ }
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
  if (errors.length) throw new AggregateError(errors, 'Android flow scenario did not complete');
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
