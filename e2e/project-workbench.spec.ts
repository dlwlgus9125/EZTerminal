import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { daemonWorkspaceId } from '../src/main/daemon-project-sync';
import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';
import { createRegisteredE2eTempDir, expect, test, type Locator, type Page } from './test';

const SEARCH_TARGET_LINE = 160;
const SEARCH_TARGET = 'SEARCH_REVEAL_TARGET';

function projectSource(answer: number): string {
  const lines = Array.from(
    { length: 220 },
    (_, index) => `export const contextLine${String(index + 1)} = ${String(index + 1)};`,
  );
  lines[SEARCH_TARGET_LINE - 1] = `export const ${SEARCH_TARGET} = ${String(answer)};`;
  return `${lines.join('\n')}\n`;
}

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
  writeFileSync(path.join(projectRoot, 'src', 'app.ts'), projectSource(1), 'utf8');
  writeFileSync(
    path.join(projectRoot, 'review-link.js'),
    "process.stdout.write('\\r\\n\\r\\nsrc/app.ts (+1 -1)\\r\\n'); setInterval(() => undefined, 1_000);\n",
    'utf8',
  );
  writeFileSync(
    path.join(projectRoot, 'source-link.js'),
    `process.stdout.write('\\r\\n\\r\\nsrc/app.ts:${String(SEARCH_TARGET_LINE)}:1\\r\\nsrc/app.ts (+1 -1)\\r\\n'); setInterval(() => undefined, 1_000);\n`,
    'utf8',
  );
  git(projectRoot, 'init', '-b', 'main');
  git(projectRoot, 'config', 'user.email', 'test@example.invalid');
  git(projectRoot, 'config', 'user.name', 'Test');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-m', 'base');
  writeFileSync(path.join(projectRoot, 'src', 'app.ts'), projectSource(2), 'utf8');
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

async function paneAtCwd(panes: Locator, cwd: string): Promise<Locator> {
  let index = -1;
  await expect.poll(async () => {
    index = await panes.evaluateAll((elements, expectedCwd) => elements.findIndex((element) =>
      element.querySelector('[data-testid="prompt-cwd"]')?.getAttribute('title') === expectedCwd), cwd);
    return index;
  }, { timeout: 10_000, message: `A terminal pane should open at ${cwd}` }).toBeGreaterThanOrEqual(0);
  return panes.nth(index);
}

async function openRegisteredProject(window: Page, projectId: string): Promise<void> {
  await window.getByTestId('btn-toggle-agents').click();
  const panel = window.getByTestId('project-workspace-panel');
  const projectButton = window.getByTestId(`agent-project-open-${projectId}`);
  await expect.poll(async () => await panel.isVisible() || await projectButton.isVisible(), {
    timeout: 15_000,
    message: 'Agent sidebar should restore the active project or show its project entry',
  }).toBe(true);
  if (!await panel.isVisible()) await projectButton.click();
  await expect(window.getByTestId('project-workspace-panel')).toBeVisible();
  await expect(window.locator('.project-path-tree')).toBeVisible({ timeout: 15_000 });
}

async function openTreeFile(window: Page, name = 'app.ts'): Promise<void> {
  const sourceDirectory = window.locator('.project-path-tree [role="treeitem"]')
    .filter({ hasText: 'src' });
  await expect(sourceDirectory).toBeVisible({ timeout: 15_000 });
  if (await sourceDirectory.getAttribute('aria-expanded') !== 'true') await sourceDirectory.click();
  const file = window.locator('.project-path-tree [role="treeitem"]')
    .filter({ hasText: name });
  await expect(file).toBeVisible({ timeout: 15_000 });
  await file.click();
}

async function selectionRange(input: Locator): Promise<readonly [number | null, number | null]> {
  return input.evaluate((element) => {
    const field = element as HTMLInputElement;
    return [field.selectionStart, field.selectionEnd] as const;
  });
}

async function flushLayout(window: Page): Promise<void> {
  await window.evaluate(() => {
    const seam = globalThis as unknown as { __ezLayoutFlush?: () => Promise<void> };
    if (!seam.__ezLayoutFlush) throw new Error('__ezLayoutFlush seam missing');
    return seam.__ezLayoutFlush();
  });
}

test('project root terminal preserves fixed-root identity across rename and restart', async () => {
  const { projectRoot, userDataDir } = createProjectFixture();
  const explorerProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = realpathSync.native(projectRoot);
  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const publicProjectId = await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items[0]?.projectId);
  expect(publicProjectId).toBeTruthy();

  await openRegisteredProject(window, publicProjectId!);
  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('', { timeout: 10_000 });
  await pathInput.fill(projectRoot);
  await pathInput.press('Enter');
  // File Explorer preserves the resolved spelling entered by the user, which
  // can be a DOS 8.3 alias on Windows. Project terminal identity below is the
  // separate canonical-path contract.
  await expect(pathInput).toHaveAttribute('title', explorerProjectRoot, { timeout: 10_000 });

  const openTerminal = async (): Promise<void> => {
    await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
    await window.getByTestId('ctx-open-terminal').click();
  };

  await openTerminal();
  await openTerminal();

  const projectTabs = window.locator('.project-session-tab');
  await expect(projectTabs).toHaveCount(2);
  await expect(projectTabs.nth(0).locator('.project-session-tab__label'))
    .toHaveText('Workbench fixture');
  await expect(projectTabs.nth(1).locator('.project-session-tab__label'))
    .toHaveText('Workbench fixture 2');
  await expect(projectTabs.locator('.project-session-tab__badge')).toHaveText([
    'Terminal',
    'Terminal',
  ]);

  await projectTabs.nth(0).click();
  const activeProjectPane = window.locator('[data-testid="pane"]:visible');
  // Session binding is asynchronous: the pane can become visible before its
  // fixed-root terminal identity lands under load.
  await expect(activeProjectPane).toHaveAttribute('data-session-id', /.+/);
  const firstSessionId = await activeProjectPane.getAttribute('data-session-id');
  if (!firstSessionId) throw new Error('expected the active project pane to have a data-session-id');
  await projectTabs.nth(0).dblclick();
  const rename = window.getByTestId('workspace-tab-rename');
  await rename.fill('Pinned project');
  await rename.press('Enter');
  await expect(projectTabs.nth(0).locator('.project-session-tab__label'))
    .toHaveText('Pinned project');
  await expect(activeProjectPane).toHaveAttribute('data-session-id', firstSessionId!);

  await openTerminal();
  await expect(projectTabs).toHaveCount(3);
  await expect(projectTabs.locator('.project-session-tab__label')).toHaveText([
    'Pinned project',
    'Workbench fixture',
    'Workbench fixture 2',
  ]);
  await expect(projectTabs.locator('.project-session-tab__badge')).toHaveText([
    'Terminal',
    'Terminal',
    'Terminal',
  ]);

  const panes = window.getByTestId('pane');
  await expect.poll(async () => panes.evaluateAll((elements, expectedCwd) => elements.filter(
    (element) => element.querySelector('[data-testid="prompt-cwd"]')?.getAttribute('title') === expectedCwd,
  ).length, canonicalProjectRoot), {
    timeout: 15_000,
    message: 'Every project terminal session should resolve to the project root in main',
  }).toBe(3);

  const beforeRestart = await panes.evaluateAll((elements, expectedCwd) => elements
    .filter((element) => element.querySelector('[data-testid="prompt-cwd"]')
      ?.getAttribute('title') === expectedCwd)
    .map((element) => element.getAttribute('data-session-id')), canonicalProjectRoot);
  expect(beforeRestart).toHaveLength(3);
  expect(beforeRestart.every(Boolean)).toBe(true);
  await flushLayout(window);
  await app.close();

  const restoredApp = await launchApp(userDataDir);
  const restored = await restoredApp.firstWindow();
  await restored.setViewportSize({ width: 1440, height: 900 });
  const restoredTabs = restored.locator('.project-session-tab');
  await expect(restoredTabs).toHaveCount(3, { timeout: 15_000 });
  await expect(restoredTabs.locator('.project-session-tab__label')).toHaveText([
    'Pinned project',
    'Workbench fixture',
    'Workbench fixture 2',
  ]);
  await expect(restoredTabs.locator('.project-session-tab__badge')).toHaveText([
    'Terminal',
    'Terminal',
    'Terminal',
  ]);

  const restoredPanes = restored.getByTestId('pane');
  await expect.poll(async () => restoredPanes.evaluateAll((elements, expectedCwd) => elements.filter(
    (element) => element.querySelector('[data-testid="prompt-cwd"]')?.getAttribute('title') === expectedCwd,
  ).length, canonicalProjectRoot), {
    timeout: 15_000,
    message: 'Restored project terminals should resolve their safe metadata to the project root',
  }).toBe(3);
  const afterRestart = await restoredPanes.evaluateAll((elements, expectedCwd) => elements
    .filter((element) => element.querySelector('[data-testid="prompt-cwd"]')
      ?.getAttribute('title') === expectedCwd)
    .map((element) => element.getAttribute('data-session-id')), canonicalProjectRoot);
  expect(afterRestart).toHaveLength(3);
  expect(afterRestart.every(Boolean)).toBe(true);
  for (const restoredSessionId of afterRestart) {
    expect(beforeRestart).not.toContain(restoredSessionId);
  }
  await restoredApp.close();
});

test('newly approved worktree terminal keeps its project daemon identity', async () => {
  const { projectRoot, userDataDir } = createProjectFixture();
  const externalParent = createRegisteredE2eTempDir('ezterm-project-workbench-external-');
  const externalRoot = path.join(externalParent, 'review');
  git(projectRoot, 'worktree', 'add', '-b', 'e2e-external-review', externalRoot, 'HEAD');
  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const publicProjectId = await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items[0]?.projectId);
  expect(publicProjectId).toBeTruthy();

  // Seed daemon project identity while the external worktree is still denied.
  // Approval is then invoked directly so no later descriptor refresh can hide
  // whether terminal resolution itself preserves daemon identity ordering.
  await openRegisteredProject(window, publicProjectId!);
  const externalWorkspace = await window.evaluate(async ({ projectId, expectedPath }) => {
    const described = await globalThis.window.ezterminalDesktop!.describeProjectWorkspace(projectId);
    if (!described.ok) return null;
    return described.project.workspaces?.find((workspace) => workspace.displayPath === expectedPath) ?? null;
  }, { projectId: publicProjectId!, expectedPath: realpathSync.native(externalRoot) });
  expect(externalWorkspace).toMatchObject({
    kind: 'external',
    access: 'authorization-required',
  });
  if (!externalWorkspace) throw new Error('expected the external worktree descriptor');

  const approved = await window.evaluate(async ({ projectId, rootId, workspaceId }) => (
    globalThis.window.ezterminalDesktop!.approveProjectWorkspace({
      projectId,
      rootId,
      workspaceId,
    })
  ), {
    projectId: publicProjectId!,
    rootId: externalWorkspace.rootId,
    workspaceId: externalWorkspace.workspaceId,
  });
  expect(approved).toMatchObject({ ok: true });

  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await pathInput.fill(externalRoot);
  await pathInput.press('Enter');
  await expect(pathInput).toHaveAttribute('title', path.resolve(externalRoot), {
    timeout: 10_000,
  });
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();

  const projectTab = window.locator('.project-session-tab');
  await expect(projectTab).toHaveCount(1);
  const projectPane = window.locator('[data-testid="pane"]:visible');
  await expect(projectPane).toHaveAttribute('data-session-id', /.+/);
  const sessionId = await projectPane.getAttribute('data-session-id');
  if (!sessionId) throw new Error('expected the external worktree pane to have a session id');

  const expectedWorkspaceId = daemonWorkspaceId(
    publicProjectId,
    externalWorkspace.rootId,
    externalWorkspace.workspaceId,
  );
  await expect.poll(async () => window.evaluate(async (id) => {
    const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
    const session = snapshot?.sessions.find((candidate) => candidate.id === id);
    return session ? {
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      state: session.state,
      source: session.source,
    } : null;
  }, sessionId), {
    timeout: 10_000,
    message: 'The terminal should inherit the synchronized external-worktree daemon identity',
  }).toEqual({
    projectId: publicProjectId,
    workspaceId: expectedWorkspaceId,
    state: 'running',
    source: 'legacy-pty',
  });

  const revoked = await window.evaluate(async ({ projectId, rootId, workspaceId }) => (
    globalThis.window.ezterminalDesktop!.revokeProjectWorkspace({
      projectId,
      rootId,
      workspaceId,
    })
  ), {
    projectId: publicProjectId,
    rootId: externalWorkspace.rootId,
    workspaceId: externalWorkspace.workspaceId,
  });
  expect(revoked).toBe(true);
  await expect.poll(async () => window.evaluate(async (workspaceId) => {
    const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
    return snapshot?.workspaces.find((workspace) => workspace.id === workspaceId)?.archivedAt ?? null;
  }, expectedWorkspaceId), {
    timeout: 10_000,
    message: 'Revoking external access should archive its daemon launch capability',
  }).toEqual(expect.any(String));

  const reapproved = await window.evaluate(async ({ projectId, rootId, workspaceId }) => (
    globalThis.window.ezterminalDesktop!.approveProjectWorkspace({
      projectId,
      rootId,
      workspaceId,
    })
  ), {
    projectId: publicProjectId,
    rootId: externalWorkspace.rootId,
    workspaceId: externalWorkspace.workspaceId,
  });
  expect(reapproved).toMatchObject({ ok: true });
  await window.evaluate(async (projectId) => {
    await globalThis.window.ezterminalDesktop!.describeProjectWorkspace(projectId);
  }, publicProjectId);
  await expect.poll(async () => window.evaluate(async (workspaceId) => {
    const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
    const workspace = snapshot?.workspaces.find((candidate) => candidate.id === workspaceId);
    return workspace ? { active: workspace.archivedAt === undefined, projectId: workspace.projectId } : null;
  }, expectedWorkspaceId), {
    timeout: 10_000,
    message: 'Reapproving external access should reactivate the same daemon Workspace',
  }).toEqual({ active: true, projectId: publicProjectId });

  const blockedWhileTerminalIsActive = await window.evaluate(async (projectId) => (
    globalThis.window.ezterminal.removeAgentProject(projectId)
  ), publicProjectId);
  expect(blockedWhileTerminalIsActive).toBe(false);
  await expect.poll(async () => window.evaluate(async ({ projectId, workspaceId }) => {
    const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
    const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
    const workspace = snapshot?.workspaces.find((candidate) => candidate.id === workspaceId);
    return {
      projectActive: project !== undefined && project.archivedAt === undefined,
      workspaceActive: workspace !== undefined && workspace.archivedAt === undefined,
    };
  }, { projectId: publicProjectId, workspaceId: expectedWorkspaceId }), {
    message: 'Removing a Project with an active terminal must fail without partially revoking authority',
  }).toEqual({ projectActive: true, workspaceActive: true });

  await projectTab.hover();
  await projectTab.locator('.project-session-tab__close').click();
  await expect(projectTab).toHaveCount(0);
  await expect.poll(async () => window.evaluate(async (id) => {
    const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
    return snapshot?.sessions.find((candidate) => candidate.id === id)?.state ?? null;
  }, sessionId), {
    timeout: 10_000,
    message: 'Closing the Project terminal should finish its daemon Session before Project removal',
  }).toBe('completed');

  const removed = await window.evaluate(async (projectId) => (
    globalThis.window.ezterminal.removeAgentProject(projectId)
  ), publicProjectId);
  expect(removed).toBe(true);
  await expect.poll(async () => window.evaluate(async ({ projectId, sessionId }) => {
    const snapshot = await globalThis.window.ezterminal.getDaemonSnapshot();
    const project = snapshot?.projects.find((candidate) => candidate.id === projectId);
    const workspaces = snapshot?.workspaces.filter((workspace) => workspace.projectId === projectId) ?? [];
    const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
    return {
      projectArchived: typeof project?.archivedAt === 'string',
      hasWorkspaces: workspaces.length > 0,
      activeWorkspaceCount: workspaces.filter((workspace) => workspace.archivedAt === undefined).length,
      sessionArchived: session?.state === 'archived',
    };
  }, { projectId: publicProjectId, sessionId }), {
    timeout: 10_000,
    message: 'Removing an Agent Project should revoke every daemon launch capability',
  }).toEqual({
    projectArchived: true,
    hasWorkspaces: true,
    activeWorkspaceCount: 0,
    sessionArchived: true,
  });

  await app.close();
});

test('Agent Project opens changed files in one VS Code-style read-only editor', async () => {
  const { userDataDir } = createProjectFixture();

  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  const errors: string[] = [];
  window.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  window.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await window.setViewportSize({ width: 1440, height: 900 });

  const publicProjectId = await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items[0]?.projectId);
  expect(publicProjectId).toBeTruthy();
  const descriptor = await window.evaluate(async (projectId) =>
    globalThis.window.ezterminalDesktop?.describeProjectWorkspace(projectId!), publicProjectId);
  expect(descriptor).toMatchObject({ ok: true });

  await window.getByTestId('btn-toggle-files').click();
  await expect(window.locator('.explorer-workbench__modes')).toHaveCount(0);
  await expect(window.getByTestId('file-list')).toBeVisible();
  await window.getByTestId('btn-toggle-files').click();

  await openRegisteredProject(window, publicProjectId!);
  await expect(window.locator('#project-workspace-select')).toHaveCount(0);
  await expect(window.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0);
  await expect(window.getByRole('tab', { name: 'Changes', exact: true })).toHaveCount(0);
  await expect(window.getByRole('tab', { name: 'Working tree', exact: true })).toHaveCount(0);
  await expect(window.getByRole('tab', { name: 'Sessions', exact: true })).toHaveCount(0);
  const sourceDirectory = window.locator('.project-path-tree [role="treeitem"]')
    .filter({ hasText: 'src' });
  await expect(sourceDirectory.locator('[data-icon="folder"]')).toBeVisible();
  await sourceDirectory.click();
  await expect(sourceDirectory.locator('[data-icon="folder-open"]')).toBeVisible();
  const file = window.locator('.project-path-tree [role="treeitem"]').filter({ hasText: 'app.ts' });
  await expect(file).toBeVisible({ timeout: 15_000 });
  await expect(file.locator('[data-icon="code"][data-category="code"]')).toBeVisible();
  await expect(file.locator('.project-file-change')).toHaveText('M', { timeout: 20_000 });
  await file.click();
  const editorPanel = window.getByTestId('project-editor-panel');
  await expect(editorPanel).toHaveAttribute('data-path', 'src/app.ts');
  await expect(editorPanel).toHaveAttribute('data-comparison', 'current');
  await expect(editorPanel.locator('.monaco-diff-editor')).toBeVisible({
    timeout: 20_000,
  });
  expect(errors, 'the first tree click should not raise a renderer error').toEqual([]);
  await expect(editorPanel).toContainText('read only');
  await expect(window.getByText('Ask about code', { exact: true })).toHaveCount(0);
  await expect(window.getByText('Add lines', { exact: true })).toHaveCount(0);
  await expect(window.getByText('Add with snippet', { exact: true })).toHaveCount(0);
  await expect(editorPanel.getByText('Keep Open', { exact: true })).toHaveCount(0);
  await expect(editorPanel.getByTestId('open-current-project-file')).toHaveCount(0);
  await editorPanel.evaluate((element) => element.setAttribute('data-e2e-instance', 'canonical-editor'));
  await file.click();
  expect(errors, 'reopening the same tree file should not raise a renderer error').toEqual([]);
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);
  await expect(editorPanel).toHaveAttribute('data-e2e-instance', 'canonical-editor');
  await expect(editorPanel).toContainText('src/app.ts', { timeout: 20_000 });
  const reviewGeometry = await editorPanel.evaluate((element) => {
    const group = element.closest<HTMLElement>('.dv-groupview')?.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>('.project-editor__body')?.getBoundingClientRect();
    const bodyElement = element.querySelector<HTMLElement>('.project-editor__body');
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
  await expect(window.locator('.dock-host')).toHaveAttribute('data-project-layout', 'wide');
  const layoutGeometry = await window.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>('.dv-groupview')];
    const editor = groups.find((group) => group.textContent?.includes('app.ts'))?.getBoundingClientRect();
    const terminal = groups.find((group) => group.textContent?.includes('Terminal 1'))?.getBoundingClientRect();
    return editor && terminal ? {
      editorTop: editor.top,
      editorHeight: editor.height,
      terminalTop: terminal.top,
      terminalHeight: terminal.height,
    } : null;
  });
  expect(layoutGeometry, 'wide project layout should expose editor and terminal groups').not.toBeNull();
  expect(layoutGeometry!.editorTop).toBeLessThan(layoutGeometry!.terminalTop);
  const editorShare = layoutGeometry!.editorHeight
    / (layoutGeometry!.editorHeight + layoutGeometry!.terminalHeight);
  expect(editorShare).toBeGreaterThan(0.58);
  expect(editorShare).toBeLessThan(0.78);

  await window.locator('.project-view-tools select').selectOption('content');
  await window.locator('.project-search-control input').fill(SEARCH_TARGET);
  const result = window.locator('.project-search-results [role="option"]')
    .filter({ hasText: `src/app.ts:${String(SEARCH_TARGET_LINE)}` });
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result.locator('[data-icon="code"]')).toBeVisible();
  await result.click();
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);
  await expect(editorPanel).toHaveAttribute('data-e2e-instance', 'canonical-editor');
  await expect(editorPanel).toHaveAttribute('data-path', 'src/app.ts');
  await expect(editorPanel.locator('.view-line').filter({ hasText: SEARCH_TARGET }).first())
    .toBeVisible({ timeout: 20_000 });
  await expect(editorPanel.locator('.monaco-diff-editor')).toBeVisible({
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
  await expect(pathInput).toHaveAttribute('title', projectRoot, { timeout: 10_000 });
  await expect(window.getByTestId('file-entry').filter({ hasText: 'out' })).toBeVisible();
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(2);
  const projectPane = await paneAtCwd(panes, projectRoot);
  await window.getByTestId('btn-toggle-files').click();

  await projectPane.getByTestId('cmd-input').fill('!node review-link.js');
  await projectPane.getByTestId('btn-run').click();
  const ptyBlock = projectPane.getByTestId('pty-block');
  await expect(ptyBlock).toBeVisible();
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 })
    .toContain('out/manual-test-project/src/app.ts (+1 -1)');
  await clickXtermText(ptyBlock, 'out/manual-test-project/src/app.ts (+1 -1)');

  const diff = window.getByTestId('project-editor-panel');
  await expect(diff).toBeVisible({ timeout: 20_000 });
  await expect(diff).toHaveAttribute('data-path', 'out/manual-test-project/src/app.ts');
  await expect(diff).toHaveAttribute('data-comparison', 'current');
  const verticalFill = await diff.evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const group = element.closest<HTMLElement>('.dv-groupview')?.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>('.project-editor__body')?.getBoundingClientRect();
    const editor = element.querySelector<HTMLElement>('.project-editor__monaco')?.getBoundingClientRect();
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
  await expect(diff.locator('.project-editor__breadcrumb')).toContainText('src/app.ts');
  await expect(diff.locator('.project-editor__repository')).toHaveText('manual-test-project');
  const editor = diff.locator('.monaco-diff-editor');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(editor).toContainText('first context');
  await expect(editor).toContainText('last context');
  await expect(diff.getByTestId('open-current-project-file')).toHaveCount(0);
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);
  await expect(window.getByTestId('file-viewer-overlay')).toHaveCount(0);

  await app.close();
});

test('narrow project workspace reuses one editor and preserves live PTY state through layout round trips', async () => {
  const { projectRoot, userDataDir } = createProjectFixture();
  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });

  const publicProjectId = await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100)).items[0]?.projectId);
  expect(publicProjectId).toBeTruthy();

  await window.getByTestId('btn-toggle-files').click();
  const pathInput = window.getByTestId('file-path-input');
  await expect(pathInput).not.toHaveValue('', { timeout: 10_000 });
  await pathInput.fill(projectRoot);
  await pathInput.press('Enter');
  await expect(pathInput).toHaveValue(projectRoot);
  await expect(window.getByTestId('file-entry').filter({ hasText: 'src' })).toBeVisible();
  await window.getByTestId('file-list').click({ button: 'right', position: { x: 10, y: 350 } });
  await window.getByTestId('ctx-open-terminal').click();

  const panes = window.getByTestId('pane');
  await expect(panes).toHaveCount(2);
  const projectPane = await paneAtCwd(panes, projectRoot);
  const projectSessionId = await projectPane.getAttribute('data-session-id');
  expect(projectSessionId).toBeTruthy();
  const draftSessionId = await panes.evaluateAll((elements, excludedSessionId) => (
    elements.map((element) => element.getAttribute('data-session-id'))
      .find((sessionId) => sessionId && sessionId !== excludedSessionId) ?? null
  ), projectSessionId);
  expect(draftSessionId).toBeTruthy();
  await window.getByTestId('btn-toggle-files').click();

  await projectPane.getByTestId('cmd-input').fill('!node source-link.js');
  await projectPane.getByTestId('btn-run').click();
  const ptyBlock = projectPane.getByTestId('pty-block');
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 })
    .toContain(`src/app.ts:${String(SEARCH_TARGET_LINE)}:1`);
  await expect.poll(() => readXtermBuffer(ptyBlock), { timeout: 15_000 })
    .toContain('src/app.ts (+1 -1)');
  await expect(projectPane.getByTestId('block-status').last()).toHaveAttribute('data-status', 'running');

  await window.getByRole('tab', { name: 'Terminal 1', exact: true }).click();
  const draftInput = window.locator(
    `[data-testid="pane"][data-session-id="${draftSessionId!}"] [data-testid="cmd-input"]`,
  );
  await projectPane.evaluate((element) => element.setAttribute('data-e2e-instance', 'live-project-pty'));
  await draftInput.evaluate((element) => element.closest('[data-testid="pane"]')
    ?.setAttribute('data-e2e-instance', 'draft-terminal'));
  await draftInput.fill('preserve this draft');
  await draftInput.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.focus();
    input.setSelectionRange(3, 11);
  });
  await expect(draftInput).toBeFocused();
  expect(await selectionRange(draftInput)).toEqual([3, 11]);

  await window.setViewportSize({ width: 800, height: 600 });
  await openRegisteredProject(window, publicProjectId!);
  await expect(window.getByTestId('project-workspace-panel')).toBeVisible();
  await openTreeFile(window);
  await expect(window.getByTestId('project-workspace-panel')).toHaveCount(0);
  await expect(window.locator('.dock-host')).toHaveAttribute('data-project-layout', 'narrow');

  const code = window.getByTestId('project-editor-panel');
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(code).toHaveAttribute('data-path', 'src/app.ts');
  await expect(code).toHaveAttribute('data-comparison', 'current');
  await expect(code.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => code.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await code.evaluate((element) => element.setAttribute('data-e2e-instance', 'canonical-editor'));
  const editorTab = window.getByRole('tab', { name: 'app.ts', exact: true });
  const terminalTab = window.getByRole('tab', { name: 'Terminal 1', exact: true });
  await expect(editorTab).toBeVisible();
  await expect(terminalTab).toBeVisible();

  await window.getByRole('tab', { name: 'Terminal 2', exact: true }).click();
  const liveProjectPane = window.locator(
    `[data-testid="pane"][data-session-id="${projectSessionId!}"]`,
  );
  await expect(liveProjectPane).toBeVisible();
  const livePty = liveProjectPane.getByTestId('pty-block');
  await clickXtermText(livePty, `src/app.ts:${String(SEARCH_TARGET_LINE)}:1`, ['Control']);
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);
  await expect(code).toHaveAttribute('data-e2e-instance', 'canonical-editor');
  await expect(code.locator('.view-line').filter({ hasText: SEARCH_TARGET }).first())
    .toBeVisible({ timeout: 20_000 });

  await window.getByRole('tab', { name: 'Terminal 2', exact: true }).click();
  await clickXtermText(livePty, 'src/app.ts (+1 -1)');
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);
  await expect(code).toHaveAttribute('data-e2e-instance', 'canonical-editor');
  await expect(window.getByTestId('file-viewer-overlay')).toHaveCount(0);

  await openRegisteredProject(window, publicProjectId!);
  await expect(window.locator('.project-path-tree [role="treeitem"]')
    .filter({ hasText: 'app.ts' })).toBeVisible();
  await window.locator('.project-view-tools select').selectOption('content');
  await window.locator('.project-search-control input').fill(SEARCH_TARGET);
  const searchResult = window.locator('.project-search-results [role="option"]')
    .filter({ hasText: `src/app.ts:${String(SEARCH_TARGET_LINE)}` });
  await expect(searchResult).toBeVisible({ timeout: 15_000 });
  await searchResult.click();
  await expect(window.getByTestId('project-workspace-panel')).toHaveCount(0);
  await expect(window.getByTestId('project-editor-panel')).toHaveCount(1);
  await expect(code).toHaveAttribute('data-e2e-instance', 'canonical-editor');
  await expect(code.locator('.view-line').filter({ hasText: SEARCH_TARGET }).first())
    .toBeVisible({ timeout: 20_000 });

  await expect(liveProjectPane).toHaveAttribute('data-session-id', projectSessionId!);
  await expect(liveProjectPane).toHaveAttribute('data-e2e-instance', 'live-project-pty');
  await expect(draftInput.locator('xpath=ancestor::*[@data-testid="pane"]'))
    .toHaveAttribute('data-e2e-instance', 'draft-terminal');
  await expect(liveProjectPane.getByTestId('block-status').last()).toHaveAttribute('data-status', 'running');
  await expect.poll(() => readXtermBuffer(livePty)).toContain('src/app.ts (+1 -1)');
  await expect(draftInput).toHaveValue('preserve this draft');
  expect(await selectionRange(draftInput)).toEqual([3, 11]);

  await terminalTab.click();
  await draftInput.focus();
  await draftInput.evaluate((element) => (element as HTMLInputElement).setSelectionRange(3, 11));
  await expect(draftInput).toBeFocused();
  await window.setViewportSize({ width: 1440, height: 900 });
  await expect(window.locator('.dock-host')).toHaveAttribute('data-project-layout', 'wide');
  await expect(draftInput).toBeFocused();
  await expect(draftInput).toHaveValue('preserve this draft');
  expect(await selectionRange(draftInput)).toEqual([3, 11]);
  await window.setViewportSize({ width: 800, height: 600 });
  await expect(window.locator('.dock-host')).toHaveAttribute('data-project-layout', 'narrow');
  await expect(draftInput).toBeFocused();
  await expect(liveProjectPane).toHaveAttribute('data-session-id', projectSessionId!);
  await expect(liveProjectPane).toHaveAttribute('data-e2e-instance', 'live-project-pty');
  await expect.poll(() => readXtermBuffer(livePty)).toContain('src/app.ts (+1 -1)');

  await app.close();
});
