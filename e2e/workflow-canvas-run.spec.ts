import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import type { WorkflowGraph } from '../src/shared/workflow';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

/**
 * The subproject flow as one canvas, end to end through the real app: the desktop React Flow
 * chunk loads, the review AI is saved in the run bar and one button runs the saved flow, the
 * approval stage shows its state on the canvas and is approved from the stage panel, the AI stage
 * starts working and its conversation opens from the same panel; once the run finishes, 다시 실행
 * runs it again as run #2 with a new stage conversation. The fake Codex answers slowly so the stage
 * stays observable while it works; no real provider or account is used. Its reply goes through the
 * real Codex adapter, which marks replies sensitive like every real provider, and the stage's result
 * is captured and independently reviewed from that reply.
 */
const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidence = path.resolve('artifacts/workflow-canvas/e2e');
mkdirSync(evidence, { recursive: true });

const graph: WorkflowGraph = {
  entryNodeId: 'gate',
  nodes: [
    { id: 'gate', title: 'Go-ahead', operation: 'approval', role: 'review', instructions: 'Approve to start the build.', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 40, y: 40 }, inputs: [] },
    { id: 'build', title: 'Build', operation: 'agent', role: 'implementation', instructions: 'Summarise the project folder.', document: '', acceptance: ['A short summary'], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', providerId: 'codex', model: 'gpt-5.6-fixture', position: { x: 384, y: 40 }, inputs: [] },
    { id: 'done', title: 'Done', operation: 'complete', role: 'integration', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 728, y: 40 }, inputs: [] },
    { id: 'stopped', title: 'Stopped', operation: 'complete', role: 'integration', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 384, y: 224 }, inputs: [] },
  ],
  edges: [
    { id: 'gate-build', from: 'gate', to: 'build', outcome: 'approved' },
    { id: 'gate-stopped', from: 'gate', to: 'stopped', outcome: 'rejected' },
    { id: 'build-done', from: 'build', to: 'done', outcome: 'next' },
  ],
};

test('one canvas: run the saved flow, approve, open the working stage conversation, run it again', async () => {
  test.setTimeout(300_000);
  const profile = createRegisteredE2eTempDir('ezterm-canvas-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-canvas-project-');
  // The fake Codex reads its reply timing from TMPDIR: hold every turn long enough to watch it.
  writeFileSync(path.join(profile, 'ezterminal-e2e-codex-reply.json'), JSON.stringify({ chars: 40, chunks: 1, chunkDelayMs: 0, startDelayMs: 45_000 }));
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(profile, { [pathKey]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[pathKey] ?? ''}`, TMPDIR: profile });
  try {
    const page = await app.firstWindow(); await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Canvas acceptance', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason); const projectId = saved.project.projectId;
    const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    if (!inspection.ok) throw new Error(inspection.message); const { probe, reviewDigest } = inspection.value;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
      const id = `enable-canvas-${attempt}`;
      const receipt = await page.evaluate(command => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({ commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'e2e-canvas' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } }));
      if (receipt.ok) break; if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
    }
    const read = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!read.ok) throw new Error(read.message);
    const created = await page.evaluate(command => window.ezterminal.executeWorkflowCommand(command), { commandId: 'create-canvas-flow', projectId, hostId: read.snapshot.hostId, expectedRevision: read.snapshot.registryRevision, type: 'subproject.create' as const, payload: { id: 'canvas-flow', title: 'Canvas flow', goal: 'Run from the canvas', presetId: 'custom' as const, graph } });
    expect(created.ok).toBe(true);

    await page.getByTestId('rail-agents').click(); await page.getByTestId(`agent-project-open-${projectId}`).click();
    const workspace = page.getByTestId('workflow-workspace'); await expect(workspace).toBeVisible();
    await workspace.getByTestId('workflow-subproject-item').filter({ hasText: 'Canvas flow' }).click();
    // The desktop canvas is the lazily loaded React Flow chunk, not the static fallback.
    await expect(workspace.locator('[data-renderer="react-flow"]')).toBeVisible({ timeout: 30_000 });
    await expect(workspace.locator('.react-flow__node[data-id="gate"]')).toBeVisible();
    await page.screenshot({ path: path.join(evidence, '01-flow.png') });

    // The run bar keeps the review AI on the subproject: chosen once, used by every run.
    const bar = workspace.getByTestId('workflow-run-bar');
    await bar.getByLabel(/검토 AI 제공자|Review AI provider/u).selectOption('codex');
    await bar.getByLabel(/검토 모델|Reviewer model/u).selectOption('gpt-5.6-fixture');
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.subprojects.find(item => item.id === 'canvas-flow')?.runSettings?.reviewer.model ?? null : null;
    }, { timeout: 30_000 }).toBe('gpt-5.6-fixture');
    // One button prepares and starts the saved flow.
    await bar.getByTestId('workflow-run-again').click();
    await expect(bar.getByTestId('workflow-run-phase')).toContainText(/실행 #1|Run #1/u, { timeout: 30_000 });

    // The approval stage waits on the same canvas, and the run bar offers the jump to it.
    const gate = workspace.locator('.react-flow__node[data-id="gate"] .workflow-node-card');
    await expect(gate).toHaveAttribute('data-run-state', 'awaiting-approval', { timeout: 30_000 });
    // While the run goes on, 다시 실행 waits and says why.
    await expect(bar.getByTestId('workflow-run-again')).toBeDisabled();
    await page.screenshot({ path: path.join(evidence, '02-awaiting-approval.png') });
    await bar.getByRole('button', { name: /승인 대기 1|1 awaiting approval/u }).click();
    const panel = workspace.locator('.workflow-flow__panel');
    await expect(panel.getByTestId('workflow-stage-approval')).toBeVisible();
    await panel.getByTestId('workflow-stage-approval').getByRole('button', { name: /^(승인|Approve)$/u }).click();
    await expect(gate).toHaveAttribute('data-run-state', 'completed', { timeout: 30_000 });

    // The AI stage starts; its panel opens the conversation it works in.
    const build = workspace.locator('.react-flow__node[data-id="build"]');
    await expect(build.locator('.workflow-node-card')).toHaveAttribute('data-run-state', /^(queued|working)$/u, { timeout: 60_000 });
    const attemptSession = async (run: number) => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs.filter(entry => entry.preparation.workflow?.subprojectId === 'canvas-flow')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[run]?.attempts[0]?.sessionId ?? null : null;
    };
    await expect.poll(() => attemptSession(0), { timeout: 60_000 }).not.toBeNull();
    const sessionId = (await attemptSession(0))!;
    await build.locator('.workflow-node-card__title').click();
    const open = panel.getByTestId('workflow-stage-open');
    await expect(open).toHaveText(/작업 중인 대화 열기|Open the working conversation/u, { timeout: 30_000 });
    await page.screenshot({ path: path.join(evidence, '03-stage-working.png') });
    await open.click();
    await expect(page.locator(`[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(evidence, '04-task-conversation.png') });

    // The (sensitive-marked) reply is captured as the stage's result and the reviewer's decision is read.
    const firstRun = async () => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs.find(entry => entry.attempts[0]?.sessionId === sessionId) ?? null : null;
    };
    await expect.poll(async () => (await firstRun())?.attempts[0]?.state ?? null, { timeout: 90_000 }).toBe('succeeded');
    const attemptId = (await firstRun())!.attempts[0]!.attemptId;
    await expect.poll(async () => {
      const review = (await firstRun())?.reviews.find(entry => entry.attemptId === attemptId);
      return review ? `${review.decision}: ${review.detail}` : null;
    }, { timeout: 90_000 }).toBe('approve: Fixture review: the frozen result answers the task.');
    const record = await page.evaluate(query => window.ezterminal.readPlanningResult(query), { kind: 'attempt' as const, projectId, subprojectId: 'canvas-flow', attemptId });
    if (!record.ok || record.kind !== 'attempt' || !record.result) throw new Error('No captured result');
    expect(record.result.transcript?.filter(item => item.kind === 'assistant-message')).toHaveLength(1);
    // Accepted, the stage completes on the canvas and the run finishes (back on the canvas tab).
    await page.locator('.dv-tab').filter({ hasText: 'Canvas acceptance' }).first().click();
    await expect(build.locator('.workflow-node-card')).toHaveAttribute('data-run-state', 'completed', { timeout: 60_000 });
    await expect.poll(async () => (await firstRun())?.state ?? null, { timeout: 60_000 }).toBe('completed');
    await page.screenshot({ path: path.join(evidence, '05-run-completed.png') });

    // 다시 실행: the saved flow and settings again, as run #2 with new stage conversations.
    await expect(bar.getByTestId('workflow-run-again')).toBeEnabled({ timeout: 30_000 });
    await bar.getByTestId('workflow-run-again').click();
    await expect(bar.getByTestId('workflow-run-phase')).toContainText(/실행 #2|Run #2/u, { timeout: 30_000 });
    await expect(gate).toHaveAttribute('data-run-state', 'awaiting-approval', { timeout: 30_000 });
    await bar.getByRole('button', { name: /승인 대기 1|1 awaiting approval/u }).click();
    await panel.getByTestId('workflow-stage-approval').getByRole('button', { name: /^(승인|Approve)$/u }).click();
    await expect.poll(() => attemptSession(1), { timeout: 60_000 }).not.toBeNull();
    const secondSession = (await attemptSession(1))!;
    expect(secondSession).not.toBe(sessionId);
    // The stage column now opens run #2's conversation.
    await build.locator('.workflow-node-card__title').click();
    await expect(open).toHaveText(/작업 중인 대화 열기|Open the working conversation/u, { timeout: 30_000 });
    await page.screenshot({ path: path.join(evidence, '06-run-again.png') });
    await open.click();
    await expect(page.locator(`[data-testid="structured-agent-session"][data-session-id="${secondSession}"]`)).toBeVisible({ timeout: 30_000 });
  } finally { await app.close(); }
});
