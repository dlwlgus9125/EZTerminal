import { expect, test } from './test';

import type { DaemonSnapshot } from '../src/shared/daemon-protocol';
import { launchApp } from './launch-app';

function structuredAgentState(snapshot: DaemonSnapshot): {
  readonly sessions: typeof snapshot.sessions;
  readonly agents: typeof snapshot.agents;
  readonly turns: typeof snapshot.turns;
} {
  const sessions = snapshot.sessions.filter((session) => session.kind === 'agent');
  return {
    sessions,
    agents: snapshot.agents,
    turns: snapshot.turns,
  };
}

test('New Agent opens a draft tab without creating structured daemon work', async () => {
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
    // Legacy terminal registration and Project discovery may legitimately
    // advance the shared daemon revision while this read-only draft is open.
    // The draft contract is that no structured Provider work exists until Send.
    expect(structuredAgentState(after!)).toEqual(structuredAgentState(before!));
  } finally {
    await app.close();
  }
});
