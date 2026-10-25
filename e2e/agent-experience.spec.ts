import { resizeWindow } from './workbench-navigation';
import { createRegisteredE2eTempDir, expect, test } from './test';
import { launchApp } from './launch-app';

for (const width of [1400, 1024]) test(`opening a project keeps the project list available at ${width}px`, async () => {
  const profile = createRegisteredE2eTempDir('ezterm-experience-profile-');
  const root = createRegisteredE2eTempDir('ezterm-experience-project-');
  const app = await launchApp(profile);
  try {
    const page = await app.firstWindow();
    await resizeWindow(page, { width, height: 900 });
    await expect(page.getByTestId('cmd-input')).toBeVisible();
    const result = await page.evaluate(primaryRoot => window.ezterminal.saveAgentProject({ name: 'Project navigation', primaryRoot, additionalRoots: [], pinned: false }), root);
    if (!result.ok) throw new Error(result.reason);
    await page.getByTestId('rail-agents').click();
    await page.getByTestId(`agent-project-open-${result.project.projectId}`).click();
    await expect(page.getByTestId('workflow-workspace')).toBeVisible();
    await expect(page.getByTestId('workbench-sidebar')).toBeVisible();
    await expect(page.getByTestId(`agent-project-open-${result.project.projectId}`)).toBeVisible();
  } finally { await app.close(); }
});
