import { createRegisteredE2eTempDir, expect, test } from './test';
import { launchApp } from './launch-app';
import { openProjectItems } from './project-navigation';
import { mkdir } from 'node:fs/promises';

test('subproject creation and stage edits persist through real IPC and restart without a model turn', async () => {
  test.setTimeout(120_000);
  const profile = createRegisteredE2eTempDir('ezterm-workflow-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-workflow-project-');
  let app = await launchApp(profile);
  try {
    await mkdir('artifacts/r4-implementation-review/real-app', { recursive: true });
    let page = await app.firstWindow();
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Workflow acceptance', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason);
    const projectId = saved.project.projectId;
    const before = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const items = await openProjectItems(page, projectId);
    await page.screenshot({ path: 'artifacts/r4-implementation-review/real-app/project-home.png' });
    await items.getByRole('button', { name: /새 워크플로|New workflow/u, exact: true }).click();
    await page.getByRole('dialog').getByLabel(/이름|Name/u, { exact: true }).fill('Cancelled setup');
    await page.getByRole('dialog').getByRole('button', { name: /취소|Cancel/u, exact: true }).click();
    expect(await page.evaluate(async id => { const result = await window.ezterminal.getWorkflowSnapshot(id); return result.ok && result.snapshot.subprojects.some(item => item.title === 'Cancelled setup'); }, projectId)).toBe(false);
    await items.getByRole('button', { name: /새 워크플로|New workflow/u, exact: true }).click();
    await page.getByRole('dialog').getByLabel(/이름|Name/u, { exact: true }).fill('Login workflow');
    await page.getByRole('dialog').getByLabel(/목표|Goal/u, { exact: true }).fill('Keep the stage document and identifiers.');
    await page.screenshot({ path: 'artifacts/r4-implementation-review/real-app/subproject-create.png' });
    await page.getByRole('dialog').getByRole('button', { name: /워크플로 만들기|Create workflow/u, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Login workflow', exact: true })).toBeVisible({ timeout: 30_000 });
    const created = await page.evaluate(async id => { const result = await window.ezterminal.getWorkflowSnapshot(id); if (!result.ok) throw new Error(result.message); return result.snapshot.subprojects.find(item => item.title === 'Login workflow')!; }, projectId);
    expect(created).toBeTruthy();
    await page.getByRole('textbox', { name: /^(단계 문서|Stage document)$/u }).fill('This document belongs to the selected node.');
    await page.screenshot({ path: 'artifacts/r4-implementation-review/real-app/stage-document.png' });
    await page.getByRole('button', { name: /초안 저장|Save draft/u, exact: true }).click();
    // Save and discard show only while the draft has unsaved changes.
    await expect(page.getByRole('button', { name: /초안 저장|Save draft/u, exact: true })).toBeHidden();
    await expect.poll(() => page.evaluate(async ({ projectId, subprojectId, nodeId }) => { const result = await window.ezterminal.getWorkflowSnapshot(projectId); return result.ok ? result.snapshot.subprojects.find(item => item.id === subprojectId)?.graph.nodes.find(node => node.id === nodeId)?.document : result.message; }, { projectId, subprojectId: created.id, nodeId: created.graph.entryNodeId }), { timeout: 30_000 }).toBe('This document belongs to the selected node.');
    const after = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    expect(after?.turns).toEqual(before?.turns);
    const stored = await page.evaluate(async id => { const result = await window.ezterminal.getWorkflowSnapshot(id); if (!result.ok) throw new Error(result.message); return result.snapshot; }, projectId);
    expect(stored.runs).toHaveLength(0);
    expect(stored.subprojects.find(item => item.id === created.id)?.graph.nodes.find(node => node.id === created.graph.entryNodeId)?.document).toBe('This document belongs to the selected node.');
    await app.close(); app = await launchApp(profile); page = await app.firstWindow();
    await expect(page.getByTestId('workflow-workspace')).toBeVisible();
    const restoredItem = page.getByTestId('workflow-subproject-item').filter({ hasText: 'Login workflow' });
    // After a restart the list can render before the saved selection is restored and replaces it,
    // so a one-off visibility check could click a row that is about to unmount. Settle on the header.
    const selectedTitle = page.getByTestId('workflow-workspace').locator('.workflow-header h2');
    await expect(async () => {
      if ((await selectedTitle.textContent()) !== 'Login workflow') await restoredItem.click({ timeout: 1_000 });
      await expect(selectedTitle).toHaveText('Login workflow', { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.getByRole('textbox', { name: /^(단계 문서|Stage document)$/u })).toHaveValue('This document belongs to the selected node.');
    const restarted = await page.evaluate(async id => window.ezterminal.getWorkflowSnapshot(id), projectId);
    expect(restarted).toMatchObject({ ok: true, snapshot: { runs: [], subprojects: expect.arrayContaining([expect.objectContaining({ id: created.id, revision: created.revision + 1 })]) } });
  } finally { await app.close(); }
});
