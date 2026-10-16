import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
    await expect(page.getByTestId('rail-agents')).toBeVisible();
    for (let index = 0; index < 24; index += 1) {
      const root = path.join(fixtureRoot, String(index));
      mkdirSync(root);
      const saved = await page.evaluate(input => window.ezterminal.saveAgentProject(input), {
        name: `History scroll fixture ${index}`, primaryRoot: root, additionalRoots: [], pinned: false,
      });
      expect(saved.ok).toBe(true);
    }
    await page.getByTestId('rail-agents').click();
    const tree = page.getByTestId('project-conversation-tree');
    await expect(tree).toBeVisible();
    await expect(tree.locator('[data-kind="project"]').filter({ hasText: 'History scroll fixture' })).toHaveCount(24);
    await tree.hover();
    for (let index = 0; index < 6; index += 1) {
      await page.mouse.wheel(0, 250);
      await page.waitForTimeout(80);
    }
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    await expect(tree).toBeVisible();
    expect(errors.filter(error => /feature-loader|TypeError|Maximum update/.test(error))).toEqual([]);
  } finally {
    console.log(JSON.stringify({ rendererErrors: errors }));
    await session.close();
  }
});

test('packaged previous CLI conversations open and scroll without losing project navigation', async ({ browserName }, testInfo) => {
  void browserName;
  test.setTimeout(75_000);
  const fixtureRoot = createRegisteredE2eTempDir('ezterm-history-open-');
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
    await expect(page.getByTestId('rail-agents')).toBeVisible();
    const saved = await page.evaluate(root => window.ezterminal.saveAgentProject({ name: 'Prior conversations', primaryRoot: root, additionalRoots: [], pinned: true }), projectRoot);
    expect(saved.ok).toBe(true);
    await page.getByTestId('rail-agents').click();
    const tree = page.getByTestId('project-conversation-tree');
    const project = tree.locator('[data-kind="project"]').filter({ hasText: 'Prior conversations' });
    await expect(project).toBeVisible();
    if (await project.getAttribute('aria-expanded') !== 'true') {
      await project.getByRole('button', { name: /^(Expand|펼치기): Prior conversations$/ }).click();
    }
    await expect(tree.locator('[data-kind="conversation"]')).toHaveCount(24, { timeout: 15_000 });
    // Opening an older row also scrolls it into view without requiring a wheel.
    await tree.locator('[data-kind="conversation"]').last().click({ timeout: 10_000 });
    const conversation = page.getByTestId('conversation-start');
    await expect(conversation).toBeVisible();
    await expect(page.getByTestId('conversation-history-dialog')).toHaveCount(0);
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    const transcript = conversation.getByTestId('structured-agent-transcript');
    await expect(transcript).toContainText('Prior response');
    await transcript.hover();
    await page.mouse.wheel(0, 750);
    await page.mouse.wheel(0, -450);
    await conversation.getByRole('button', { name: /Load earlier messages|이전 메시지 불러오기/ }).click();
    await expect(transcript.getByText(/^Prior response 1\s/)).toHaveCount(1);
    await expect(conversation.getByTestId('structured-agent-composer-input')).toBeVisible();
    expect((await page.evaluate(() => window.ezterminal.getDaemonSnapshot()))?.agents).toHaveLength(0);
    const evidence = path.resolve('artifacts/conversation-ux/windows'); mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'previous-conversation.png') });
    await testInfo.attach('previous-conversation', { path: path.join(evidence, 'previous-conversation.png'), contentType: 'image/png' });
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    await expect(tree).toBeVisible();
    await tree.hover();
    await page.mouse.wheel(0, -600);
    await page.mouse.wheel(0, 600);
    await expect(page.locator('.feature-load-error'), JSON.stringify(errors)).toHaveCount(0);
    expect(errors.filter(error => /feature-loader|TypeError|Maximum update/.test(error))).toEqual([]);
  } finally {
    console.log(JSON.stringify({ rendererErrors: errors }));
    await session.close();
  }
});
