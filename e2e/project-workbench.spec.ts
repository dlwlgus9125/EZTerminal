import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';
import { createRegisteredE2eTempDir, expect, test, type Locator } from './test';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

function seedProject(userDataDir: string, projectRoot: string): void {
  writeFileSync(
    path.join(userDataDir, 'agent-projects.json'),
    JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'project-workbench-fixture',
        name: 'Workbench fixture',
        primaryRoot: projectRoot,
        additionalRoots: [],
        pinned: true,
        origin: 'terminal',
        lastActiveAt: 1_785_181_625_234,
        createdAt: 1_785_181_600_000,
        updatedAt: 1_785_181_625_234,
      }],
    }),
    'utf8',
  );
}

function createProjectFixture(): { projectRoot: string; userDataDir: string } {
  const projectRoot = createRegisteredE2eTempDir('ezterm-project-workbench-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-project-workbench-data-');
  mkdirSync(path.join(projectRoot, 'src'));
  writeFileSync(path.join(projectRoot, 'src', 'app.ts'), 'export const answer = 1;\n', 'utf8');
  writeFileSync(
    path.join(projectRoot, 'review-link.js'),
    "process.stdout.write('\\r\\n\\r\\nsrc/app.ts (+1 -1)\\r\\n'); setInterval(() => undefined, 1_000);\n",
    'utf8',
  );
  writeFileSync(
    path.join(projectRoot, 'source-link.js'),
    "process.stdout.write('\\r\\n\\r\\nsrc/app.ts:1:1\\r\\n'); setInterval(() => undefined, 1_000);\n",
    'utf8',
  );
  git(projectRoot, 'init', '-b', 'main');
  git(projectRoot, 'config', 'user.email', 'test@example.invalid');
  git(projectRoot, 'config', 'user.name', 'Test');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-m', 'base');
  writeFileSync(path.join(projectRoot, 'src', 'app.ts'), 'export const answer = 2;\n', 'utf8');
  seedProject(userDataDir, projectRoot);
  return { projectRoot, userDataDir };
}

function createNestedProjectFixture(): { projectRoot: string; userDataDir: string } {
  const projectRoot = createRegisteredE2eTempDir('ezterm-project-workbench-outer-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-project-workbench-nested-data-');
  const nestedRoot = path.join(projectRoot, 'out', 'manual-test-project');
  mkdirSync(path.join(nestedRoot, 'src'), { recursive: true });
  writeFileSync(
    path.join(nestedRoot, 'src', 'app.ts'),
    '// first context\n\nexport const answer = 1;\n\n// last context\n',
    'utf8',
  );
  writeFileSync(
    path.join(projectRoot, 'review-link.js'),
    "process.stdout.write('\\r\\n\\r\\nout/manual-test-project/src/app.ts (+1 -1)\\r\\n'); setInterval(() => undefined, 1_000);\n",
    'utf8',
  );
  git(nestedRoot, 'init', '-b', 'main');
  git(nestedRoot, 'config', 'user.email', 'test@example.invalid');
  git(nestedRoot, 'config', 'user.name', 'Test');
  git(nestedRoot, 'add', '.');
  git(nestedRoot, 'commit', '-m', 'base');
  writeFileSync(
    path.join(nestedRoot, 'src', 'app.ts'),
    '// first context\n\nexport const answer = 2;\n\n// last context\n',
    'utf8',
  );
  seedProject(userDataDir, projectRoot);
  return { projectRoot, userDataDir };
}

async function clickXtermText(
  ptyBlock: Locator,
  needle: string,
  modifiers: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> = [],
): Promise<void> {
  const point = await ptyBlock.evaluate((element, text) => {
    const terminal = (element as HTMLElement & {
      __ezTerm?: {
        readonly cols: number;
        readonly rows: number;
        readonly buffer: {
          readonly active: {
            readonly viewportY: number;
            getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
          };
        };
      };
    }).__ezTerm;
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    if (!terminal || !screen) return null;
    for (let row = 0; row < terminal.rows; row += 1) {
      const value = terminal.buffer.active
        .getLine(terminal.buffer.active.viewportY + row)
        ?.translateToString(true) ?? '';
      const column = value.indexOf(text);
      if (column < 0) continue;
      const screenBox = screen.getBoundingClientRect();
      const hostBox = element.getBoundingClientRect();
      return {
        x: screenBox.left - hostBox.left + ((column + text.length / 2) * screenBox.width) / terminal.cols,
        y: screenBox.top - hostBox.top + ((row + 0.5) * screenBox.height) / terminal.rows,
      };
    }
    return null;
  }, needle);
  expect(point, `xterm should expose ${needle} in its current viewport`).not.toBeNull();
  await ptyBlock.hover({ position: point! });
  await ptyBlock.page().waitForTimeout(150);
  await ptyBlock.click({ position: point!, modifiers });
}

test('registered project opens read-only Monaco file and diff panels with a working worker', async () => {
  const { userDataDir } = createProjectFixture();

  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  const errors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  window.on('pageerror', (error) => errors.push(error.message));
  await window.setViewportSize({ width: 1440, height: 900 });

  const publicProjectId = await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items[0]?.projectId);
  expect(publicProjectId).toBeTruthy();
  const descriptor = await window.evaluate(async (projectId) =>
    globalThis.window.ezterminalDesktop?.describeProjectWorkspace(projectId!), publicProjectId);
  expect(descriptor).toMatchObject({ ok: true });

  await window.getByTestId('btn-toggle-files').click();
  await window.getByRole('tab', { name: 'Project', exact: true }).click();
  await expect(window.getByTestId('project-explorer-panel')).toBeVisible();
  await expect(window.getByLabel('Project', { exact: true })).toHaveValue(publicProjectId!);
  const sourceDirectory = window.locator('.project-tree__row').filter({ hasText: 'src' });
  await expect(sourceDirectory).toBeVisible({ timeout: 15_000 });
  await sourceDirectory.click();
  const file = window.locator('.project-tree__row').filter({ hasText: 'app.ts' });
  await expect(file).toBeVisible({ timeout: 15_000 });
  await file.click();
  await expect(window.getByTestId('code-file-panel').locator('.monaco-editor')).toBeVisible({
    timeout: 20_000,
  });
  await expect(window.getByTestId('code-file-panel')).toContainText('read only');

  await window.locator('[aria-label^="Review changes in "]').click();
  await expect(window.getByTestId('code-diff-panel')).toContainText('src/app.ts', { timeout: 20_000 });
  const reviewGeometry = await window.getByTestId('code-diff-panel').evaluate((element) => {
    const group = element.closest<HTMLElement>('.dv-groupview')?.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>('.diff-panel__body')?.getBoundingClientRect();
    const bodyElement = element.querySelector<HTMLElement>('.diff-panel__body');
    return {
      groupHeight: group?.height ?? 0,
      panelHeight: element.getBoundingClientRect().height,
      bodyHeight: body?.height ?? 0,
      bodyRatio: group?.height ? (body?.height ?? 0) / group.height : 0,
      panelRows: getComputedStyle(element).gridTemplateRows,
      bodyGridRow: bodyElement ? getComputedStyle(bodyElement).gridRow : '',
      children: [...element.children].map((child) => ({
        className: (child as HTMLElement).className,
        height: child.getBoundingClientRect().height,
      })),
    };
  });
  expect(reviewGeometry.bodyRatio, `A normal project review should fill the available vertical space: ${JSON.stringify(reviewGeometry)}`)
    .toBeGreaterThan(0.75);
  await expect(window.getByTestId('code-diff-panel').locator('.monaco-diff-editor')).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(
    () => window.workers().some((worker) => /editor\.worker/iu.test(worker.url())),
    { timeout: 20_000, message: 'Monaco editor worker should start from the renderer bundle' },
  ).toBe(true);

  await app.close();
  expect(errors, `unexpected project workbench errors:\n${errors.join('\n')}`).toEqual([]);
});

test('PTY nested-repository change summary opens the exact VS Code-style diff with one click', async () => {
  const { projectRoot, userDataDir } = createNestedProjectFixture();
  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });

  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('');
  await pathInput.fill(projectRoot);
  await pathInput.press('Enter');
  await expect(window.getByTestId('file-entry').filter({ hasText: 'src' })).toBeVisible();
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(2);
  const projectPane = panes.nth(1);
  await expect(projectPane.getByTestId('prompt-cwd')).toHaveAttribute('title', projectRoot, {
    timeout: 10_000,
  });
  await window.getByTestId('btn-toggle-files').click();

  await projectPane.getByTestId('cmd-input').fill('!node review-link.js');
  await projectPane.getByTestId('btn-run').click();
  const ptyBlock = projectPane.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 })
    .toContain('out/manual-test-project/src/app.ts (+1 -1)');
  await clickXtermText(ptyBlock, 'out/manual-test-project/src/app.ts (+1 -1)');

  const diff = window.getByTestId('code-diff-panel');
  await expect(diff).toBeVisible({ timeout: 20_000 });
  const verticalFill = await diff.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const group = element.closest<HTMLElement>('.dv-groupview')?.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>('.diff-panel__body')?.getBoundingClientRect();
    const editor = element.querySelector<HTMLElement>('.diff-panel__editor')?.getBoundingClientRect();
    return {
      panelHeight: panel.height,
      groupHeight: group?.height ?? 0,
      bodyHeight: body?.height ?? 0,
      editorHeight: editor?.height ?? 0,
      panelRatio: group?.height ? panel.height / group.height : 0,
      bodyRatio: group?.height ? (body?.height ?? 0) / group.height : 0,
    };
  });
  expect(verticalFill.groupHeight, 'Diff panel should belong to a visible Dockview group').toBeGreaterThan(0);
  expect(verticalFill.panelRatio, `Diff panel should fill its group height: ${JSON.stringify(verticalFill)}`)
    .toBeGreaterThan(0.8);
  expect(verticalFill.bodyRatio, `Diff review should fill the available vertical space: ${JSON.stringify(verticalFill)}`)
    .toBeGreaterThan(0.75);
  await expect(diff.locator('button[role="option"][aria-selected="true"]'))
    .toContainText('src/app.ts');
  await expect(diff).toContainText('Repository: manual-test-project');
  const editor = diff.locator('.monaco-diff-editor');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(editor).toContainText('first context');
  await expect(editor).toContainText('last context');
  await expect(diff.getByTestId('open-current-project-file')).toHaveCount(0);
  await expect(window.getByTestId('code-file-panel')).toHaveCount(0);
  await expect(window.getByTestId('file-viewer-overlay')).toHaveCount(0);

  await app.close();
});

test('PTY project source link joins the Code panel instead of opening duplicate preview UI', async () => {
  const { projectRoot, userDataDir } = createProjectFixture();
  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });

  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await pathInput.fill(projectRoot);
  await pathInput.press('Enter');
  await expect(window.getByTestId('file-entry').filter({ hasText: 'src' })).toBeVisible();
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(2);
  const projectPane = panes.nth(1);
  await expect(projectPane.getByTestId('prompt-cwd')).toHaveAttribute('title', projectRoot, {
    timeout: 10_000,
  });
  await window.getByTestId('btn-toggle-files').click();

  await projectPane.getByTestId('cmd-input').fill('!node source-link.js');
  await projectPane.getByTestId('btn-run').click();
  const ptyBlock = projectPane.getByTestId('pty-block');
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 })
    .toContain('src/app.ts:1:1');
  await clickXtermText(ptyBlock, 'src/app.ts:1:1', ['Control']);

  const code = window.getByTestId('code-file-panel');
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(code).toContainText('src/app.ts');
  await expect(code.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId('code-diff-panel')).toHaveCount(0);
  await expect(window.getByTestId('file-viewer-overlay')).toHaveCount(0);

  await app.close();
});
