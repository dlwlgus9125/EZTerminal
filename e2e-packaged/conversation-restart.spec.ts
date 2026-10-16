import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRegisteredE2eTempDir, expect, test } from '../e2e/test';
import { launchPackagedRenderer } from './packaged-renderer';

test('production restart retains an encrypted draft and labels an unlinked old terminal as ended', async () => {
  const profile = createRegisteredE2eTempDir('ezterm-conversation-restore-');
  const evidence = path.resolve('artifacts/conversation-ux/windows'); mkdirSync(evidence, { recursive: true });
  const panelId = 'previous-cli-terminal';
  writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ schemaVersion: 1, startup: { mode: 'last' }, bootIntro: false }));
  writeFileSync(path.join(profile, 'layout.json'), JSON.stringify({ schemaVersion: 1, savedAt: new Date().toISOString(), layout: {
    grid: { root: { type: 'branch', data: [{ type: 'leaf', data: { views: [panelId], activeView: panelId, id: 'restored-group' }, size: 720 }], size: 1280 }, width: 1280, height: 720, orientation: 'VERTICAL' },
    panels: { [panelId]: { id: panelId, title: 'Previous CLI', renderer: 'always', tabComponent: 'props.defaultTabComponent', contentComponent: 'terminal', params: {} } }, activeGroup: 'restored-group',
  } }));
  const environment = { EZTERMINAL_DISABLE_OPENCLAW_SUPERVISOR: '1' };
  let app = await launchPackagedRenderer('conversation-restart-', environment, profile);
  try {
    let page = app.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    const ended = page.getByTestId('restored-terminal-ended');
    await expect(ended).toContainText(/The previous terminal has ended|이전 터미널이 종료됐습니다/);
    await page.screenshot({ path: path.join(evidence, 'previous-terminal-ended.png') });
    await ended.getByRole('button', { name: /Open new terminal|새 터미널 열기/, exact: true }).click();
    await expect(page.getByTestId('pane')).toBeVisible();
    await page.getByTestId('rail-agents').click();
    await page.getByTestId('agent-new-run').click();
    await page.getByTestId('conversation-start').getByTestId('structured-agent-composer-input').fill('Draft retained across a Windows restart');
    await expect.poll(() => page.evaluate(async () => {
      const saved = await window.ezterminal.loadLayout();
      const layout = saved?.layout as { panels?: Record<string, { params?: { historyId?: string; projectId?: string } }> };
      const draft = Object.values(layout?.panels ?? {}).find(panel => panel.params?.historyId?.startsWith('structured-draft-'))?.params;
      if (!draft?.historyId) return { error: 'Draft layout not persisted', saved };
      const stored = await window.ezterminal.chatStateRead({ kind: 'draft', projectId: draft.projectId ?? 'drafts', sessionId: draft.historyId });
      return stored.ok ? stored.snapshot.state.draft.text : stored;
    }), { timeout: 20_000 }).toBe('Draft retained across a Windows restart');
    // Exercise the same close action as the user, then reopen the exact profile.
    const exited = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('App did not close')), 15_000);
      app.child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    await page.evaluate(() => window.ezterminalDesktop?.performWindowAction('close')).catch(() => undefined);
    await exited;
    await app.close();
    app = await launchPackagedRenderer('conversation-restart-', environment, profile);
    page = app.page; await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('conversation-start').getByTestId('structured-agent-composer-input')).toHaveValue('Draft retained across a Windows restart', { timeout: 15_000 });
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents).toHaveLength(0);
    await page.screenshot({ path: path.join(evidence, 'restored-draft.png') });
  } catch (error) {
    const details = await app.page.evaluate(async () => {
      const saved = await window.ezterminal.loadLayout();
      const layout = saved?.layout as { panels?: Record<string, { params?: { historyId?: string; projectId?: string } }> };
      const draft = Object.values(layout?.panels ?? {}).find(panel => panel.params?.historyId?.startsWith('structured-draft-'))?.params;
      return { saved, text: document.body.innerText, stored: draft?.historyId && await window.ezterminal.chatStateRead({ kind: 'draft', projectId: draft.projectId ?? 'drafts', sessionId: draft.historyId }) };
    }).catch(() => ({ error: 'Renderer unavailable after failure' }));
    writeFileSync(path.join(evidence, 'packaged-restart-failure.json'), JSON.stringify(details, null, 2));
    await app.page.screenshot({ path: path.join(evidence, 'packaged-restart-failure.png') }).catch(() => undefined);
    throw error;
  } finally { await app.close(); }
});
