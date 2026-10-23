import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import type { WorkflowGraph } from '../src/shared/workflow';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

/**
 * The subproject flow as one canvas, end to end through the real app: the desktop React Flow
 * chunk loads, a run is prepared and started from the canvas header, the approval stage shows
 * its state on the canvas, it is approved from the stage panel, the AI stage starts working and
 * its task conversation opens from the same panel. The fake Codex answers slowly so the stage
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

test('one canvas: prepare, start, approve on the canvas and open the working stage conversation', async () => {
  test.setTimeout(240_000);
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

    await workspace.getByRole('button', { name: /^(실행 준비|Prepare run)$/u }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/검토 모델|Reviewer model/u).selectOption('gpt-5.6-fixture');
    await dialog.getByRole('button', { name: /이 버전 준비|Prepare this version/u }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await workspace.getByRole('button', { name: /^(실행 시작|Start execution)$/u }).click();

    // The approval stage waits on the same canvas, and the header offers the jump to it.
    const gate = workspace.locator('.react-flow__node[data-id="gate"] .workflow-node-card');
    await expect(gate).toHaveAttribute('data-run-state', 'awaiting-approval', { timeout: 30_000 });
    await page.screenshot({ path: path.join(evidence, '02-awaiting-approval.png') });
    await workspace.getByRole('button', { name: /승인 대기 1|1 awaiting approval/u }).click();
    await expect(workspace.getByRole('tab', { name: /실행 상태|Run status/u, selected: true })).toBeVisible();
    await workspace.locator('.workflow-flow__panel').getByRole('button', { name: /^(허용|Approve)$/u }).click();
    await expect(gate).toHaveAttribute('data-run-state', 'completed', { timeout: 30_000 });

    // The AI stage starts; its card and panel follow the run, and its conversation opens from there.
    const build = workspace.locator('.react-flow__node[data-id="build"]');
    await expect(build.locator('.workflow-node-card')).toHaveAttribute('data-run-state', /^(queued|working)$/u, { timeout: 60_000 });
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs[0]?.attempts[0]?.sessionId ?? null : null;
    }, { timeout: 60_000 }).not.toBeNull();
    const after = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
    if (!after.ok) throw new Error(after.message);
    const sessionId = after.snapshot.runs[0].attempts[0].sessionId;
    await build.locator('.workflow-node-card__title').click();
    await workspace.getByRole('tab', { name: /실행 상태|Run status/u }).click();
    const open = workspace.locator('.workflow-flow__panel').getByRole('button', { name: /작업 대화 열기|Open task conversation/u });
    await expect(open).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(evidence, '03-stage-working.png') });
    await open.click();
    await expect(page.locator(`[data-testid="structured-agent-session"][data-session-id="${sessionId}"]`)).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(evidence, '04-task-conversation.png') });

    // The (sensitive-marked) reply is captured as the stage's result and the reviewer's decision is read.
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs[0]?.attempts[0]?.state ?? null : null;
    }, { timeout: 90_000 }).toBe('succeeded');
    const attemptId = after.snapshot.runs[0].attempts[0].attemptId;
    // The reviewer's judgment, read from its own (sensitive-marked) reply, is the recorded decision.
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      const review = result.ok ? result.snapshot.runs[0]?.reviews.find(entry => entry.attemptId === attemptId) : undefined;
      return review ? `${review.decision}: ${review.detail}` : null;
    }, { timeout: 90_000 }).toBe('approve: Fixture review: the frozen result answers the task.');
    const record = await page.evaluate(query => window.ezterminal.readPlanningResult(query), { kind: 'attempt' as const, projectId, subprojectId: 'canvas-flow', attemptId });
    if (!record.ok || record.kind !== 'attempt' || !record.result) throw new Error('No captured result');
    expect(record.result.transcript?.filter(item => item.kind === 'assistant-message')).toHaveLength(1);
    // Accepted, the stage completes on the canvas and the run finishes (back on the canvas tab).
    await page.locator('.dv-tab').filter({ hasText: 'Canvas acceptance' }).first().click();
    await expect(build.locator('.workflow-node-card')).toHaveAttribute('data-run-state', 'completed', { timeout: 60_000 });
    await expect.poll(async () => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs[0]?.state ?? null : null;
    }, { timeout: 60_000 }).toBe('completed');
    await page.screenshot({ path: path.join(evidence, '05-run-completed.png') });
  } finally { await app.close(); }
});
