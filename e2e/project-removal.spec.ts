import { AgentHistoryService } from '../src/main/agent-history-service';
import { AgentProjectStore } from '../src/main/agent-project-store';
import { DaemonStore } from '../src/main/daemon-store';
import { launchApp } from './launch-app';
import { createRegisteredE2eTempDir, expect, test } from './test';

test('project removal succeeds with a terminal record from a previous app process', async () => {
  const userDataDir = createRegisteredE2eTempDir('ezterm-project-removal-data-');
  const projectRoot = createRegisteredE2eTempDir('ezterm-project-removal-root-');
  const projects = new AgentProjectStore(userDataDir);
  await projects.init();
  const history = new AgentHistoryService(projects, []);
  const saved = await history.saveProject({
    name: 'Pinball', primaryRoot: projectRoot, additionalRoots: [], pinned: false,
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error('Project fixture could not be saved');
  const projectId = saved.project.projectId;
  const workspaceId = `${projectId}.${projectId}.${projectId}`;
  const store = new DaemonStore(userDataDir);
  await store.init();
  await store.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: { id: projectId, name: 'Pinball', rootPath: projectRoot, source: 'native' } },
    { kind: 'workspace.upsert', value: { id: workspaceId, projectId, name: 'Pinball', rootPath: projectRoot, kind: 'local' } },
    { kind: 'session.upsert', value: {
      id: 'previous-terminal', projectId, workspaceId, kind: 'terminal',
      title: 'Terminal · Pinball', state: 'running', source: 'legacy-pty',
    } },
  ] });
  await store.close();

  const app = await launchApp(userDataDir);
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  expect(await window.evaluate(async () =>
    (await globalThis.window.ezterminal.listSessions()).some((session) => session.sessionId === 'previous-terminal'),
  )).toBe(false);
  const removed = await window.evaluate(async (id) => globalThis.window.ezterminal.removeAgentProject(id), projectId);
  expect(removed, 'A terminal absent from the current process must not block Project removal').toBe(true);
  await app.close();
});
