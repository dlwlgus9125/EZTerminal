import { createRegisteredE2eTempDir, expect, test } from './test';
import { launchApp } from './launch-app';
import { openProjectItems } from './project-navigation';
import type { PlanningCommand } from '../src/shared/planning';

test('planning and binary scenes survive host restart without starting execution', async () => {
  test.setTimeout(120_000);
  const profile = createRegisteredE2eTempDir('ezterm-v2-planning-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-v2-planning-project-');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z+1kAAAAASUVORK5CYII=';
  let projectId = '';
  let app = await launchApp(profile);
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'V2 planning test', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(`Project registration failed: ${saved.reason}`);
    projectId = saved.project.projectId;
    const before = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    const staged = await page.evaluate(request => window.ezterminal.executePlanningAsset(request), {
      type: 'stage' as const, projectId, assetId: 'logo', title: 'Preview logo', mimeType: 'image/png' as const, dataBase64: png,
    });
    if (!staged.ok) throw new Error(staged.message);
    const command: PlanningCommand = { type: 'planning.patch', commandId: 'initial-design', projectId, expectedRevision: 0,
      actor: { kind: 'user', id: 'renderer-cannot-choose-principal' }, payload: { summary: 'Connect the requirement and screen', operations: [
        { op: 'item.put', value: { id: 'requirement', revision: 0, kind: 'requirement', title: 'Keep real terminals', body: 'Chat skins and terminal sessions coexist.', status: 'ready', acceptance: ['The terminal remains usable.'] } },
        { op: 'asset.put', value: staged.asset },
        { op: 'scene.put', value: { id: 'screen', revision: 0, title: 'Planning screen', platform: 'windows', width: 800, height: 600, featureIds: [],
          elements: [{ id: 'preview', kind: 'frame', parentId: null, order: 0, stateIds: [], properties: { assetId: 'logo', accessibleName: 'Logo preview' }, layout: { direction: 'column', width: 'fill', height: 'hug', gap: 12, padding: 16, overflow: 'visible' } }],
          states: [{ id: 'default', title: 'Default', kind: 'default' }], transitions: [], status: 'ready' } },
      ] } };
    const applied = await page.evaluate(value => window.ezterminal.executePlanningCommand(value), command);
    expect(applied.ok).toBe(true);
    expect(await page.evaluate(value => window.ezterminal.executePlanningCommand(value), command)).toMatchObject({ ok: true, duplicate: true });
    expect(await page.evaluate(value => window.ezterminal.executePlanningCommand(value), { type: 'planning.freeze', commandId: 'freeze-design', projectId, expectedRevision: 1,
      actor: { kind: 'user', id: 'renderer' }, payload: { baselineId: 'approved-design', title: 'Approved screen' } } satisfies PlanningCommand)).toMatchObject({ ok: true });
    expect(await page.evaluate(id => window.ezterminal.executeProjectArchive({ type: 'inventory', projectId: id }), projectId)).toMatchObject({ ok: true, kind: 'inventory' });
    expect(await page.evaluate(id => window.ezterminal.planningAiRequest({ type: 'read', projectId: id }), projectId)).toMatchObject({ ok: true, jobs: [] });
    expect(await page.evaluate(id => window.ezterminal.getPlanningExecutionSnapshot(id), projectId)).toMatchObject({ ok: true, snapshot: { runs: [] } });
    const after = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    expect(after?.turns).toEqual(before?.turns);
    await openProjectItems(page, projectId);
    await expect(page.getByTestId('workflow-workspace').getByRole('heading', { name: 'V2 planning test' })).toBeVisible();
    await page.getByRole('button', { name: /빠른 작업·기존 자료|Quick tasks and existing work/u }).click();
    await expect(page.getByTestId('planning-workspace')).toBeVisible();
    await app.close();
    app = await launchApp(profile);
    const reopened = await app.firstWindow();
    await expect(reopened.getByTestId('workflow-workspace')).toBeVisible();
    const planning = await reopened.evaluate(id => window.ezterminal.getPlanningSnapshot(id), projectId);
    expect(planning).toMatchObject({ ok: true, snapshot: { revision: 2, baselines: [{ id: 'approved-design' }], history: expect.arrayContaining([expect.objectContaining({ actor: { kind: 'user', id: 'desktop-user' } })]) } });
    expect(await reopened.evaluate(id => window.ezterminal.executePlanningAsset({ type: 'read', projectId: id, assetId: 'logo', baselineId: 'approved-design' }), projectId)).toMatchObject({ ok: true, dataBase64: png });
    expect(await reopened.evaluate(id => window.ezterminal.getPlanningExecutionSnapshot(id), projectId)).toMatchObject({ ok: true, snapshot: { runs: [] } });
  } finally { await app.close(); }
});
