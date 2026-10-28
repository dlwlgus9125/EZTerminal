import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { manageProject, openAllProjects } from '../e2e/project-navigation';
import { createRegisteredE2eTempDir, expect, test } from '../e2e/test';
import { launchPackagedRenderer } from './packaged-renderer';
import { encodeClaudeProjectDirName } from '../src/main/claude-history-adapter';

test('packaged project history navigation stays usable while scrolling a populated list', async () => {
  const fixtureRoot = createRegisteredE2eTempDir('ezterm-history-scroll-');
  const session = await launchPackagedRenderer('ezterminal-history-scroll-profile-');
  const { page } = session;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await expect(page.getByTestId('shell-all-projects')).toBeVisible();
    for (let index = 0; index < 24; index += 1) {
      const root = path.join(fixtureRoot, String(index));
      mkdirSync(root);
      const saved = await page.evaluate(input => window.ezterminal.saveAgentProject(input), {
        name: `History scroll fixture ${index}`, primaryRoot: root, additionalRoots: [], pinned: false,
      });
      expect(saved.ok).toBe(true);
    }
    // 모든 프로젝트 lists them all and scrolls.
    const list = await openAllProjects(page);
    await expect(list.locator('.ez-project-list__row').filter({ hasText: 'History scroll fixture' })).toHaveCount(24);
    await list.locator('.ez-project-list__rows').hover();
    for (let index = 0; index < 6; index += 1) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(80);
    }
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    await expect(list).toBeVisible();
    expect(errors.filter(error => /feature-loader|TypeError|Maximum update/.test(error))).toEqual([]);
  } finally {
    console.log(JSON.stringify({ rendererErrors: errors }));
    await session.close();
  }
});

test('packaged previous CLI conversations open and scroll without losing project navigation', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(75_000);
  // Real path: Claude names its history folder after the cwd it saw, and the app looks it up by
  // the saved project's real path, so an 8.3 alias of TEMP (as on CI) must not reach the fixture.
  const fixtureRoot = realpathSync.native(createRegisteredE2eTempDir('ezterm-history-open-'));
  const projectRoot = path.join(fixtureRoot, 'project');
  const claudeHome = path.join(fixtureRoot, '.claude');
  const codexHome = path.join(fixtureRoot, 'codex');
  const historyRoot = path.join(claudeHome, 'projects', encodeClaudeProjectDirName(projectRoot));
  for (const directory of [projectRoot, historyRoot, codexHome]) mkdirSync(directory, { recursive: true });
  const history: object[] = [];
  for (let conversation = 0; conversation < 24; conversation += 1) {
    const sessionId = randomUUID();
    const title = `Prior CLI conversation ${String(conversation).padStart(2, '0')}`;
    const records = Array.from({ length: 50 }, (_, index) => {
      const role = index % 2 === 0 ? 'user' : 'assistant';
      return { uuid: `${sessionId}-${index}`, parentUuid: index ? `${sessionId}-${index - 1}` : null,
        sessionId, cwd: projectRoot, isSidechain: false, type: role, timestamp: new Date(Date.now() + index).toISOString(),
        ...(role === 'user' ? { origin: { kind: 'human' }, promptSource: 'typed' } : {}),
        message: { role, content: role === 'user' ? `${title} question ${index}` : [{ type: 'text', text: `Prior response ${index}\n${'A saved message to read and scroll. '.repeat(35)}` }] } };
    });
    writeFileSync(path.join(historyRoot, `${sessionId}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n');
    history.push({ display: title, timestamp: Date.now() + conversation, project: projectRoot, sessionId });
  }
  writeFileSync(path.join(claudeHome, 'history.jsonl'), history.map(record => JSON.stringify(record)).join('\n') + '\n');
  const session = await launchPackagedRenderer('ezterminal-history-open-profile-', { USERPROFILE: fixtureRoot, HOME: fixtureRoot, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome });
  const { page } = session;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  try {
    await expect(page.getByTestId('shell-all-projects')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Prior conversations', primaryRoot: root, additionalRoots: [], pinned: true }), projectRoot);
    expect(saved.ok).toBe(true);
    // 모든 프로젝트 → the project's ⋯ → CLI history: its 24 CLI records in the history dialog.
    await manageProject(page, 'Prior conversations', /CLI history|CLI 기록/u);
    const history = page.getByTestId('conversation-history-dialog');
    const rows = history.locator('.conversation-history__row');
    await expect(rows).toHaveCount(24, { timeout: 15_000 });
    // Opening an older row also scrolls it into view without requiring a wheel.
    await rows.last().click({ timeout: 10_000 });
    const conversation = page.getByTestId('conversation-start');
    await expect(conversation).toBeVisible();
    await expect(page.getByTestId('conversation-history-dialog')).toHaveCount(0);
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    const transcript = conversation.getByTestId('structured-agent-transcript');
    await expect(transcript).toContainText('Prior response');
    await transcript.hover();
    await page.mouse.wheel(0, 750);
    await page.mouse.wheel(0, -450);
    // Older messages are offered; reaching the top loads them, and the offer goes once nothing older is left. (Scrolling
    // the off-screen button into view to click it raced that load: CI's 1024×720 window lost the button every time.)
    const earlier = conversation.getByRole('button', { name: /Load earlier messages|이전 메시지 불러오기/ });
    await expect(earlier).toHaveCount(1);
    await expect(async () => {
      await page.mouse.wheel(0, -4000);
      await expect(transcript.getByText(/^Prior response 1\s/)).toHaveCount(1, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await expect(earlier).toHaveCount(0);
    await expect(conversation.getByTestId('structured-agent-composer-input')).toBeVisible();
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents).toHaveLength(0);
    const evidence = path.resolve('artifacts/conversation-ux/windows'); mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'previous-conversation.png') });
    await testInfo.attach('previous-conversation', { path: path.join(evidence, 'previous-conversation.png'), contentType: 'image/png' });
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    // The project stays one click away in 모든 프로젝트.
    const list = await openAllProjects(page);
    await expect(list.getByTestId(`all-projects-open-${saved.ok ? saved.project.projectId : ''}`)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    expect(errors.filter(error => /feature-loader|TypeError|Maximum update/.test(error))).toEqual([]);
  } finally {
    console.log(JSON.stringify({ rendererErrors: errors }));
    await session.close();
  }
});
