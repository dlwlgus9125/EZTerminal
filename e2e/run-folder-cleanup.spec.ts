import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createDaemonCommand } from '../src/shared/daemon-protocol';
import type { WorkflowGraph } from '../src/shared/workflow';
import { launchApp } from './launch-app';
import { openProjectItems } from './project-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';

/**
 * 작업 폴더 정리 (I2-7), end to end through the real app: a flow in a Git project runs four times (each stage works in
 * its own worktree); the person cleans up from the flow screen's ⋯ menu, which offers only the oldest run's folders
 * (each flow keeps its newest three) and removes them. The run's stage conversation stays readable as history, its
 * stage says its folders were cleaned up, and its files still read from the run's kept result. The fake Codex answers
 * at once; no real provider or account is used.
 */
const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');
const evidence = path.resolve('artifacts/workflow-canvas/e2e-cleanup');
mkdirSync(evidence, { recursive: true });

const graph: WorkflowGraph = {
  entryNodeId: 'build',
  nodes: [
    { id: 'build', title: 'Build', operation: 'agent', role: 'implementation', instructions: 'Summarise the project folder.', document: '', acceptance: ['A short summary'], allowedPaths: [], retryLimit: 0, permissionPreset: 'plan', providerId: 'codex', model: 'gpt-5.6-fixture', position: { x: 40, y: 40 }, inputs: [] },
    { id: 'done', title: 'Done', operation: 'complete', role: 'integration', instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', position: { x: 384, y: 40 }, inputs: [] },
  ],
  edges: [{ id: 'build-done', from: 'build', to: 'done', outcome: 'next' }],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

test('작업 폴더 정리: the oldest run’s folders go, its conversation and result stay readable', async () => {
  test.setTimeout(480_000);
  const profile = createRegisteredE2eTempDir('ezterm-cleanup-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-cleanup-project-');
  git(projectRoot, 'init', '-b', 'main');
  git(projectRoot, 'config', 'user.email', 'tests@example.invalid');
  git(projectRoot, 'config', 'user.name', 'EZTerminal Tests');
  writeFileSync(path.join(projectRoot, 'README.md'), 'cleanup fixture\n');
  git(projectRoot, 'add', 'README.md');
  git(projectRoot, 'commit', '-m', 'initial');
  writeFileSync(path.join(profile, 'ezterminal-e2e-codex-reply.json'), JSON.stringify({ chars: 40, chunks: 1, chunkDelayMs: 0, startDelayMs: 0 }));
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(profile, { [pathKey]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[pathKey] ?? ''}`, TMPDIR: profile });
  try {
    const page = await app.firstWindow(); await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Cleanup acceptance', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason); const projectId = saved.project.projectId;
    const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    if (!inspection.ok) throw new Error(inspection.message); const { probe, reviewDigest } = inspection.value;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
      const id = `enable-cleanup-${attempt}`;
      const receipt = await page.evaluate(command => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({ commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'e2e-cleanup' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } }));
      if (receipt.ok) break; if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
    }
    const read = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!read.ok) throw new Error(read.message);
    const created = await page.evaluate(command => window.ezterminal.executeWorkflowCommand(command), { commandId: 'create-cleanup-flow', projectId, hostId: read.snapshot.hostId, expectedRevision: read.snapshot.registryRevision, type: 'subproject.create' as const, payload: { id: 'cleanup-flow', title: 'Cleanup flow', goal: 'Run four times', presetId: 'custom' as const, graph } });
    expect(created.ok).toBe(true);

    // Four finished runs of the flow, one after another (a flow runs once at a time).
    const runOf = async (runId: string) => {
      const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
      return result.ok ? result.snapshot.runs.find(entry => entry.runId === runId) ?? null : null;
    };
    for (let index = 1; index <= 4; index++) {
      const current = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!current.ok) throw new Error(current.message);
      const flow = current.snapshot.subprojects.find(item => item.id === 'cleanup-flow')!;
      const launched = await page.evaluate(command => window.ezterminal.executeWorkflowCommand(command), { commandId: `launch-cleanup-${index}`, projectId, hostId: current.snapshot.hostId, expectedRevision: flow.revision, subprojectId: 'cleanup-flow', type: 'run.launch' as const, payload: { runId: `cleanup-run-${index}`, reviewer: { providerId: 'codex', model: 'gpt-5.6-fixture' } } });
      expect(launched.ok).toBe(true);
      await expect.poll(async () => (await runOf(`cleanup-run-${index}`))?.state ?? null, { timeout: 120_000 }).toBe('completed');
    }
    const first = (await runOf('cleanup-run-1'))!;
    const daemon = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const folderOf = (workspaceId: string) => daemon!.workspaces.find(entry => entry.id === workspaceId)!.rootPath;
    const oldest = folderOf(first.attempts[0]!.workspaceId!);
    const newest = folderOf((await runOf('cleanup-run-4'))!.attempts[0]!.workspaceId!);
    expect(existsSync(oldest)).toBe(true);

    const workspace = await openProjectItems(page, projectId);
    await workspace.getByTestId('workflow-subproject-item').filter({ hasText: 'Cleanup flow' }).click();
    await expect(workspace.locator('.react-flow__node[data-id="build"]')).toBeVisible({ timeout: 30_000 });

    // ⋯ → 작업 폴더 정리…: only run #1 (past the newest three) is offered, and its folders hold nothing of the person's.
    await workspace.getByRole('button', { name: /소프로젝트 작업|Subproject actions/u }).click();
    await page.getByRole('menuitem', { name: /작업 폴더 정리|Clean up work folders/u }).click();
    const dialog = page.getByTestId('run-folder-cleanup');
    await expect(dialog.locator('li[data-state="removable"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText(/실행 #1|Run #1/u);
    await expect(dialog).not.toContainText(/실행 #2|Run #2/u);
    await expect(dialog.locator('li[data-state="kept"]')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, '01-cleanup-offered.png') });
    await page.getByTestId('run-folder-cleanup-confirm').click();
    await expect(dialog.getByRole('status')).toContainText(/정리했습니다|Cleaned up/u, { timeout: 120_000 });
    await page.screenshot({ path: path.join(evidence, '02-cleaned.png') });
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newest)).toBe(true);
    // The kept result still holds the run's files: the cleaned folder reads from it, never from the old path.
    const state = await page.evaluate(folder => window.ezterminal.runRetention!.folderState(folder), oldest);
    expect(state).toEqual({ ok: true, value: { state: 'cleaned', root: oldest, result: true } });
    const file = await page.evaluate(filePath => window.ezterminal.runRetention!.readFile(filePath), path.join(oldest, 'README.md'));
    expect(file).toMatchObject({ ok: true, value: { ok: true, kind: 'text', content: expect.stringContaining('cleanup fixture') } });
    await page.getByTestId('run-folder-cleanup-close').click();
    await expect(dialog).toHaveCount(0);

    // Run #1's stage says its folders were cleaned up, and its conversation opens as history.
    await workspace.getByTestId('workflow-run-bar').getByLabel(/실행 번호|Run number/u).selectOption('cleanup-run-1');
    await workspace.locator('.react-flow__node[data-id="build"] .workflow-node-card__title').click();
    const panel = workspace.locator('.workflow-flow__panel');
    await expect(panel.getByTestId('workflow-stage-cleaned')).toBeVisible({ timeout: 30_000 });
    await panel.getByTestId('workflow-stage-open').click();
    // It opens as history: the recorded reply reads, and nothing can be sent into the gone folder.
    const conversation = page.locator('[data-testid="structured-agent-session"]').filter({ hasText: /기록 · 여기서 이어 쓸 수 없음|History · cannot be continued here/u });
    await expect(conversation).toBeVisible({ timeout: 30_000 });
    await expect(conversation).toContainText('Streamed profile reply');
    await expect(conversation.getByRole('button', { name: /^(보내기|Send)$/u })).toBeDisabled();
    await page.screenshot({ path: path.join(evidence, '03-history.png') });
  } finally { await app.close(); }
});
