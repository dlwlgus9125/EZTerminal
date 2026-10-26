import { resizeWindow } from './workbench-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { launchApp } from './launch-app';
import { openAllProjects, openProjectItems } from './project-navigation';

for (const width of [1400, 1024]) test(`an opened project leads back to its board, and every project stays one click away at ${width}px`, async () => {
  const profile = createRegisteredE2eTempDir('ezterm-experience-profile-');
  const root = createRegisteredE2eTempDir('ezterm-experience-project-');
  const app = await launchApp(profile);
  try {
    const page = await app.firstWindow();
    await resizeWindow(page, { width, height: 900 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const result = await page.evaluate(primaryRoot => window.ezterminal.saveAgentProject({ name: 'Project navigation', primaryRoot, additionalRoots: [], pinned: false }), root);
    if (!result.ok) throw new Error(result.reason);
    const workspace = await openProjectItems(page, result.project.projectId);
    // The flow tab's top-level back goes to the project's board, not to a project sidebar.
    await workspace.getByTestId('workflow-back').click();
    await expect(page.getByTestId('shell-board').getByRole('heading', { level: 1 })).toHaveText('Project navigation');
    await expect(page.getByTestId('workbench-sidebar')).toHaveCount(0);
    // 모든 프로젝트 still lists it from the top bar.
    const projects = await openAllProjects(page);
    await expect(projects.getByTestId(`all-projects-open-${result.project.projectId}`)).toBeVisible();
  } finally { await app.close(); }
});
