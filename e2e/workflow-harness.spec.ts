import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import type { WorkflowGraph } from '../src/shared/workflow';
import { launchApp } from './launch-app';
import { openProjectItems, startNewConversation } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { resizeWindow } from './workbench-navigation';

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchApp>>['firstWindow']>>;

/**
 * The workflow harness through the real app and the fake Codex (no real provider or account):
 * an effort changed while the AI works waits for the next request and shows as "now → next";
 * "next request only" goes back to the conversation's own effort after it. A workflow's answer
 * stage waits for the person, and the stage after it is asked with that answer.
 */
const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidence = path.resolve('artifacts/harness/e2e');
mkdirSync(evidence, { recursive: true });

function fakeCodexEnvironment(profile: string): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}`, TMPDIR: profile };
}

async function enableCodex(page: Page): Promise<void> {
  const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
  if (!inspection.ok) throw new Error(inspection.message);
  const { probe, reviewDigest } = inspection.value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const id = `e2e-harness-enable-${attempt}`;
    const receipt = await page.evaluate((command) => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({
      commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'e2e-harness' }, type: 'provider.enable',
      payload: {
        providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath,
        executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames,
        capabilities: probe.capabilities, reviewDigest,
      },
    }));
    if (receipt.ok) return;
    if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
  }
}

interface TurnLine { readonly threadId: string; readonly effort: string | null; readonly input: string }
function turns(profile: string): readonly TurnLine[] {
  const file = path.join(profile, 'ezterminal-e2e-codex-turns.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as TurnLine);
}

test('an effort changed while the AI works waits for the next request; "next request only" goes back after it', async () => {
  test.setTimeout(240_000);
  const profile = createRegisteredE2eTempDir('ezterm-harness-chat-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-harness-chat-project-');
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1440, height: 900 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate((root) => window.ezterminal.saveAgentProject({ name: 'Harness chat', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason);
    await enableCodex(page);
    // The app stores real paths; TEMP may be an 8.3 alias (as on CI).
    const key = (folder: string): string => folder.replace(/[\\/]+$/u, '').toLowerCase();
    const root = key(realpathSync.native(projectRoot));
    const projectWorkspace = async () => (await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.workspaces.find((workspace) => key(workspace.rootPath) === root);
    await expect.poll(async () => (await projectWorkspace())?.name ?? null, { timeout: 15_000 }).not.toBeNull();
    const workspaceName = (await projectWorkspace())!.name;

    const draft = await startNewConversation(page);
    const folders = draft.getByTestId('structured-agent-folders');
    await folders.click();
    await page.getByRole('menuitemradio').filter({ has: page.getByText(workspaceName, { exact: true }) }).click();
    const composer = draft.getByTestId('structured-agent-composer-input');
    await composer.fill('First request.');
    await composer.press('Enter');
    await expect(page.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
    const session = page.getByTestId('structured-agent-session').first();
    const sessionId = (await session.getAttribute('data-session-id'))!;
    const input = session.getByTestId('structured-agent-composer-input');
    const turnStates = () => page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.turns
      .filter((turn) => turn.sessionId === id).map((turn) => turn.state) ?? [], sessionId);
    await expect.poll(turnStates, { timeout: 30_000 }).toEqual(['completed']);

    // The second request answers slowly: change the effort while it works.
    const replyConfig = path.join(profile, 'ezterminal-e2e-codex-reply.json');
    writeFileSync(replyConfig, JSON.stringify({ chars: 80, chunks: 2, chunkDelayMs: 500, startDelayMs: 6_000 }));
    await input.fill('Second request, answered slowly.');
    await input.press('Enter');
    await expect.poll(async () => page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.agents
      .find((agent) => agent.sessionId === id)?.state, sessionId), { timeout: 30_000 }).toBe('working');
    await session.getByTestId('structured-agent-live-effort').click();
    await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
    // Not refused: kept for the next request and shown as now → next, with the scope choice.
    const pending = session.getByTestId('structured-agent-pending-settings');
    await expect(pending).toBeVisible({ timeout: 15_000 });
    await expect(pending).toContainText(/High/u);
    // The scope chips are labels around their radios: the person presses the label.
    await pending.locator('label').filter({ hasText: 'Next request only' }).click();
    await expect(pending.getByRole('radio', { name: 'Next request only' })).toBeChecked();
    await expect.poll(async () => page.evaluate(async (id) => (await window.ezterminal.getDaemonSnapshot())?.pendingAgentSettings?.[id]?.effortScope, sessionId), { timeout: 15_000 }).toBe('once');
    await page.screenshot({ path: path.join(evidence, 'queued-effort.png') });
    // The running turn was started without it.
    expect(turns(profile).at(-1)?.effort).not.toBe('high');
    await expect.poll(turnStates, { timeout: 60_000 }).toEqual(['completed', 'completed']);
    rmSync(replyConfig, { force: true });

    // The next request carries High once; the one after goes back to the conversation's own effort.
    await input.fill('Third request.');
    await input.press('Enter');
    await expect.poll(turnStates, { timeout: 30_000 }).toEqual(['completed', 'completed', 'completed']);
    await expect(pending).toHaveCount(0);
    await input.fill('Fourth request.');
    await input.press('Enter');
    await expect.poll(turnStates, { timeout: 30_000 }).toEqual(['completed', 'completed', 'completed', 'completed']);
    // The thread's own effort is the one Codex reported when it started it (the fixture says medium, like a config default).
    const efforts = turns(profile).filter((line) => line.threadId?.startsWith('fixture-thread-')).map((line) => line.effort);
    expect(efforts).toHaveLength(4);
    expect(efforts[2]).toBe('high');
    expect(efforts[3]).toBe('medium');
    await page.screenshot({ path: path.join(evidence, 'effort-back.png') });
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'queued-effort-error.png') });
    console.log((await page.locator('body').innerText()).slice(-6000));
    throw error;
  } finally {
    await app.close();
  }
});

const answerGraph: WorkflowGraph = {
  entryNodeId: 'ask',
  nodes: [
    { id: 'ask', title: 'My answer', operation: 'answer', role: 'planning', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', position: { x: 40, y: 40 }, inputs: [],
      answer: { prompt: 'Which file should the summary cover?' } },
    { id: 'build', title: 'Build', operation: 'agent', role: 'implementation', instructions: 'Summarise the file the person named.', document: '', acceptance: ['A short summary'], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', providerId: 'codex', model: 'gpt-5.6-fixture', position: { x: 384, y: 40 }, inputs: [] },
    { id: 'done', title: 'Done', operation: 'complete', role: 'integration', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', position: { x: 728, y: 40 }, inputs: [] },
  ],
  edges: [
    { id: 'ask-build', from: 'ask', to: 'build', outcome: 'next' },
    { id: 'build-done', from: 'build', to: 'done', outcome: 'next' },
  ],
};

test('an answer stage waits for the person, and the stage after it is asked with the answer', async () => {
  test.setTimeout(300_000);
  const profile = createRegisteredE2eTempDir('ezterm-harness-answer-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-harness-answer-project-');
  const app = await launchApp(profile, fakeCodexEnvironment(profile));
  const page = await app.firstWindow();
  try {
    await resizeWindow(page, { width: 1440, height: 900 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate((root) => window.ezterminal.saveAgentProject({ name: 'Harness answer', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason);
    const projectId = saved.project.projectId;
    await enableCodex(page);
    const read = await page.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId);
    if (!read.ok) throw new Error(read.message);
    const created = await page.evaluate((command) => window.ezterminal.executeWorkflowCommand(command), { commandId: 'create-answer-flow', projectId, hostId: read.snapshot.hostId, expectedRevision: read.snapshot.registryRevision,
      type: 'subproject.create' as const, payload: { id: 'answer-flow', title: 'Answer flow', goal: 'Ask, then build', presetId: 'custom' as const, graph: answerGraph } });
    if (!created.ok) throw new Error(created.message);
    const flow = created.snapshot.subprojects.find((entry) => entry.id === 'answer-flow')!;
    const reviewer = await page.evaluate((command) => window.ezterminal.executeWorkflowCommand(command), { commandId: 'answer-flow-reviewer', projectId, hostId: created.snapshot.hostId, expectedRevision: flow.revision,
      subprojectId: 'answer-flow', type: 'subproject.update' as const, payload: { runSettings: { reviewer: { providerId: 'codex', model: 'gpt-5.6-fixture' } } } });
    if (!reviewer.ok) throw new Error(reviewer.message);

    const workspace = await openProjectItems(page, projectId);
    await workspace.getByTestId('workflow-subproject-item').filter({ hasText: 'Answer flow' }).click();
    await expect(workspace.locator('[data-renderer="react-flow"]')).toBeVisible({ timeout: 30_000 });
    const bar = workspace.getByTestId('workflow-run-bar');
    await bar.getByTestId('workflow-run-again').click();
    await expect(bar.getByTestId('workflow-run-phase')).toContainText(/실행 #1|Run #1/u, { timeout: 30_000 });

    // The answer stage waits for the person; no model is asked meanwhile.
    const ask = workspace.locator('.react-flow__node[data-id="ask"] .workflow-node-card');
    await expect(ask).toHaveAttribute('data-run-state', 'awaiting-approval', { timeout: 30_000 });
    expect(turns(profile)).toEqual([]);
    await bar.getByRole('button', { name: /1 awaiting your answer|답변 대기 1/u }).click();
    const panel = workspace.locator('.workflow-flow__panel');
    await expect(panel).toContainText('Which file should the summary cover?');
    await panel.getByLabel(/^(Answer|답)$/u).fill('README.md, the install section');
    await page.screenshot({ path: path.join(evidence, 'answer-stage.png') });
    await panel.getByRole('button', { name: /^(Send answer|답 보내기)$/u }).click();
    await expect(ask).toHaveAttribute('data-run-state', 'completed', { timeout: 30_000 });

    // The next stage's request quotes the answer.
    await expect.poll(() => turns(profile).some((line) => line.input.includes('README.md, the install section')), { timeout: 60_000 }).toBe(true);
    const run = async () => {
      const result = await page.evaluate((id) => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs.find((entry) => entry.preparation.workflow?.subprojectId === 'answer-flow') ?? null : null;
    };
    expect((await run())?.workflowRuntime?.activations.find((activation) => activation.nodeId === 'ask')?.answer).toBe('README.md, the install section');
    await expect.poll(async () => (await run())?.state ?? null, { timeout: 120_000 }).toBe('completed');
    await page.screenshot({ path: path.join(evidence, 'answer-run-completed.png') });
  } catch (error) {
    await page.screenshot({ path: path.join(evidence, 'answer-stage-error.png') });
    console.log((await page.locator('body').innerText()).slice(-6000));
    throw error;
  } finally {
    await app.close();
  }
});
