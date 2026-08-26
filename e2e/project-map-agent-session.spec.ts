import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { readXtermAllBuffer } from './xterm-buffer';

const FAKE_CODEX_DIR = path.resolve(__dirname, 'fixtures', 'fake-codex');

function seedProject(userDataDir: string, projectRoot: string): void {
  writeFileSync(
    path.join(userDataDir, 'agent-projects.json'),
    JSON.stringify({
      version: 3,
      projects: [{
        projectId: 'project-map-agent-session-fixture',
        name: 'Project Map fixture',
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

function pathEnvironment(): Record<string, string> {
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === 'path')
    ?? 'PATH';
  return { [key]: `${FAKE_CODEX_DIR}${path.delimiter}${process.env[key] ?? ''}` };
}

test('Project Map create opens a fresh Agent tab and binds the job to that session', async () => {
  const projectRoot = createRegisteredE2eTempDir('ezterm-e2e-project-map-root-');
  const userDataDir = createRegisteredE2eTempDir('ezterm-e2e-project-map-data-');
  seedProject(userDataDir, projectRoot);

  const app = await launchApp(userDataDir, {
    ...pathEnvironment(),
    EZTERMINAL_E2E_PROJECT_MAP_AGENT: '1',
  });
  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

  const project = await window.evaluate(async () => {
    const listed = await globalThis.window.ezterminal.listAgentProjects(false, undefined, 100);
    const projectId = listed.items[0]?.projectId;
    if (!projectId) return null;
    const described = await globalThis.window.ezterminalDesktop?.describeProjectWorkspace(projectId);
    if (!described?.ok) return null;
    const workspace = described.project.workspaces?.[0];
    return workspace ? {
      projectId,
      rootId: workspace.rootId,
      workspaceId: workspace.workspaceId,
    } : null;
  });
  expect(project).not.toBeNull();

  await window.getByTestId('btn-toggle-agents').click();
  await window.getByTestId(`agent-project-open-${project!.projectId}`).click();
  await expect(window.getByTestId('project-workspace-panel')).toBeVisible();
  await window.getByTestId('project-workspace-open-map').click();
  await expect(window.getByTestId('project-map-create')).toBeVisible({ timeout: 15_000 });
  await window.getByTestId('project-map-create').click();
  await expect(window.getByTestId('project-map-create-participant')).toContainText('Codex');
  await expect(window.getByTestId('project-map-send-creation')).toBeEnabled();
  await window.getByTestId('project-map-send-creation').click();

  const pane = window.locator('[data-testid="pane"]:visible');
  const terminal = pane.getByTestId('pty-block');
  await expect(terminal).toBeVisible({ timeout: 15_000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();

  await expect.poll(async () => window.evaluate(async ({ target, session }) => {
    const [activities, opened] = await Promise.all([
      globalThis.window.ezterminal.getAgentActivitySnapshot(),
      globalThis.window.ezterminalDesktop!.openProjectMap({
        projectId: target.projectId,
        ownerRootId: target.rootId,
        ownerWorkspaceId: target.workspaceId,
      }),
    ]);
    const activity = activities.items.find((item) => item.sessionId === session && item.provider === 'codex');
    return {
      activityId: activity?.id,
      activitySessionId: activity?.sessionId,
      jobActivityId: opened.snapshot.activeJob?.activityId,
      dispatch: opened.snapshot.activeJob?.dispatch,
      agentLabel: opened.snapshot.activeJob?.agentLabel,
      jobId: opened.snapshot.activeJob?.id,
    };
  }, { target: project!, session: sessionId! }), {
    timeout: 20_000,
    message: 'The Project Map job should bind only to the newly opened Agent terminal activity',
  }).toMatchObject({
    activitySessionId: sessionId,
    dispatch: 'dedicated-session',
    agentLabel: 'Codex',
  });

  const ids = await window.evaluate(async ({ target, session }) => {
    const [activities, opened] = await Promise.all([
      globalThis.window.ezterminal.getAgentActivitySnapshot(),
      globalThis.window.ezterminalDesktop!.openProjectMap({
        projectId: target.projectId,
        ownerRootId: target.rootId,
        ownerWorkspaceId: target.workspaceId,
      }),
    ]);
    return {
      activityId: activities.items.find((item) => item.sessionId === session && item.provider === 'codex')?.id,
      jobActivityId: opened.snapshot.activeJob?.activityId,
      jobId: opened.snapshot.activeJob?.id,
    };
  }, { target: project!, session: sessionId! });
  expect(ids.jobActivityId).toBe(ids.activityId);
  expect(ids.jobId).toBeTruthy();
  await expect.poll(() => readXtermAllBuffer(terminal), { timeout: 15_000 })
    .toContain(`EZTerminal Project Map job: ${ids.jobId!}`);

  await app.close();
});
