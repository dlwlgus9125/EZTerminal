import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDaemonCommand } from '../src/shared/daemon-protocol';
import { createWorkflowGraph } from '../src/shared/workflow';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { launchApp } from './launch-app';

test('ordinary chat keeps its session and unsent draft when linked; a provider edits creation preview through the app tool', async () => {
  test.setTimeout(180_000);
  const profile = createRegisteredE2eTempDir('ezterm-workflow-chat-profile-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-workflow-chat-project-');
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const app = await launchApp(profile, { [pathKey]: `${path.resolve(__dirname, 'fixtures/fake-codex')}${path.delimiter}${process.env[pathKey] ?? ''}`, TMPDIR: profile });
  try {
    const page = await app.firstWindow(); await expect(page.getByTestId('cmd-input')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Workflow chat acceptance', primaryRoot: root, additionalRoots: [], pinned: false }), projectRoot);
    if (!saved.ok) throw new Error(saved.reason); const projectId = saved.project.projectId;
    const inspection = await page.evaluate(() => window.ezterminal.inspectDaemonProvider('codex'));
    if (!inspection.ok) throw new Error(inspection.message); const { probe, reviewDigest } = inspection.value;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
      const id = `enable-fixture-${attempt}`;
      const receipt = await page.evaluate(command => window.ezterminal.sendDaemonCommand(command), createDaemonCommand({ commandId: id, idempotencyKey: id, expectedRevision: state!.revision, issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'e2e-workflow' }, type: 'provider.enable', payload: { providerId: probe.providerId, displayName: probe.displayName, protocol: probe.protocol, executablePath: probe.executablePath, executableVersion: probe.executableVersion, argv: probe.argv, environmentVariableNames: probe.environmentVariableNames, capabilities: probe.capabilities, reviewDigest } }));
      if (receipt.ok) break; if (receipt.error.code !== 'revision-conflict' || attempt === 3) throw new Error(receipt.error.message);
    }
    const graph = createWorkflowGraph('research', 'stage-work'); graph.nodes[0].document = 'Saved stage reference';
    const read = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId); if (!read.ok) throw new Error(read.message);
    const created = await page.evaluate(command => window.ezterminal.executeWorkflowCommand(command), { commandId: 'create-stage-work', projectId, hostId: read.snapshot.hostId, expectedRevision: read.snapshot.registryRevision, type: 'subproject.create' as const, payload: { id: 'stage-work', title: 'Stage work', goal: '', presetId: 'research' as const, graph } });
    expect(created.ok).toBe(true);
    await page.getByTestId('rail-agents').click(); await page.getByTestId(`agent-project-open-${projectId}`).click();
    const workspace = page.getByTestId('workflow-workspace'); await expect(workspace).toBeVisible();
    await workspace.getByRole('button', { name: 'New conversation', exact: true }).click();
    await expect(page.getByTestId('conversation-start')).toBeVisible();
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents).toHaveLength(0);
    await page.getByTestId('conversation-start').getByTestId('structured-agent-composer-input').fill('Start the ordinary project conversation');
    await page.getByTestId('conversation-start').getByTestId('structured-agent-send').click();
    await expect(page.getByTestId('conversation-start')).toHaveCount(0, { timeout: 30_000 });
    const chat = page.locator('[data-testid=structured-agent-session]:visible'); await expect(chat).toBeVisible({ timeout: 30_000 });
    const sessionId = (await chat.getAttribute('data-session-id'))!;
    await chat.getByTestId('structured-agent-composer-input').fill('Keep this unsent draft');
    if (!await page.getByTestId(`agent-project-open-${projectId}`).isVisible()) await page.getByTestId('rail-agents').click();
    await page.getByTestId(`agent-project-open-${projectId}`).click(); await expect(workspace).toBeVisible();
    await workspace.locator('.workflow-conversation-row').getByRole('button', { name: 'Link to stage' }).click();
    await page.getByRole('dialog').getByLabel('Subproject', { exact: true }).selectOption('stage-work');
    await page.getByRole('dialog').getByLabel('Stage', { exact: true }).selectOption(graph.entryNodeId!);
    await page.getByRole('dialog').getByRole('button', { name: 'Link', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });
    await workspace.locator('.workflow-stage .workflow-items button').click(); await expect(chat).toBeVisible();
    await expect(chat).toHaveAttribute('data-session-id', sessionId); await expect(chat.getByTestId('structured-agent-composer-input')).toHaveValue('Keep this unsent draft');
    await expect(chat.getByText('Referenced saved stage document', { exact: false })).toBeVisible();
    await chat.getByRole('button', { name: 'Return to this stage' }).click();
    await mkdir('artifacts/r4-implementation-review/real-app', { recursive: true });
    await page.screenshot({ path: 'artifacts/r4-implementation-review/real-app/stage-chat-return.png' });
    await writeFile('artifacts/r4-implementation-review/real-app/stage-return-dom.json', JSON.stringify(await page.evaluate(() => ({ roots: document.querySelectorAll('[data-testid=workflow-workspace]').length, fields: [...document.querySelectorAll('textarea')].map(field => ({ label: field.parentElement?.textContent, inWorkspace: !!field.closest('[data-testid=workflow-workspace]'), value: field.value })) })), null, 2));
    await expect(page.getByRole('textbox', { name: 'Stage document', exact: true })).toHaveValue('Saved stage reference');
    const untouched = await page.evaluate(() => window.ezterminal.getDaemonSnapshot()); expect(untouched!.turns).toHaveLength(1);
    // Back on the board, "New flow" opens the project's items.
    await workspace.getByRole('button', { name: 'Back to the board' }).click();
    await page.getByRole('button', { name: 'New flow', exact: true }).click();
    await workspace.getByRole('button', { name: 'New subproject' }).click();
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Preview to cancel');
    await page.getByRole('button', { name: 'Design in conversation' }).click(); await page.getByRole('button', { name: 'Open setup conversation' }).click();
    await expect(page.getByTestId('structured-agent-create')).toBeEnabled(); await page.getByTestId('structured-agent-create').click();
    await expect(chat).toBeVisible({ timeout: 30_000 }); const previewSessionId = await chat.getAttribute('data-session-id');
    await chat.getByTestId('structured-agent-composer-input').fill('EZTERMINAL_E2E_PREVIEW');
    await expect(chat.getByTestId('structured-agent-send')).toBeEnabled({ timeout: 30_000 });
    await chat.getByTestId('structured-agent-send').click();
    await expect(chat).toContainText('AI preview updated through the authenticated app tool.', { timeout: 20_000 });
    if (!await page.getByTestId(`agent-project-open-${projectId}`).isVisible()) await page.getByTestId('rail-agents').click();
    await page.getByTestId(`agent-project-open-${projectId}`).click(); await workspace.getByRole('button', { name: 'Continue setup' }).click();
    await expect(page.getByRole('dialog').getByText('AI preview stage', { exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    const result = await page.evaluate(id => window.ezterminal.getWorkflowSnapshot(id), projectId);
    expect(result.ok && result.snapshot.subprojects.some(item => item.title === 'Preview to cancel')).toBe(false);
    const final = await page.evaluate(() => window.ezterminal.getDaemonSnapshot());
    expect(final!.sessions.some(session => session.id === previewSessionId)).toBe(true);
    expect(final!.turns.filter(turn => turn.sessionId === sessionId)).toHaveLength(1);
  } finally { await app.close(); }
});
