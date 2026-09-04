import { expect, test } from './test';

import { launchApp } from './launch-app';

test('New Agent opens a draft tab without creating a daemon Session', async () => {
  const app = await launchApp();
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();

    const before = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(before).not.toBeNull();

    await window.getByTestId('btn-toggle-agents').click();
    await window.getByTestId('agent-new-run').click();

    const draft = window.getByTestId('structured-agent-draft');
    await expect(draft).toBeVisible();
    await expect(draft.getByTestId('structured-agent-first-prompt')).toBeVisible();

    const after = await window.evaluate(async () => (
      globalThis.window.ezterminal.getDaemonSnapshot()
    ));
    expect(after).not.toBeNull();
    expect(after?.revision).toBe(before?.revision);
    expect(after?.sessions).toEqual(before?.sessions);
    expect(after?.turns).toEqual(before?.turns);
  } finally {
    await app.close();
  }
});
