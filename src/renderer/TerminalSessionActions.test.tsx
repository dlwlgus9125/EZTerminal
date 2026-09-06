// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppI18nProvider } from './i18n';
import { TerminalSessionActions } from './TerminalSessionActions';
import { withLiveTerminalSessions } from './use-live-terminal-sessions';
import { sessionStartSnapshot } from './session-start.fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
async function click(id: string) {
  await act(async () => { document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); await Promise.resolve(); });
}
function render() {
  const access = {
    listRuns: vi.fn(async () => [{ sessionId: 'terminal', runId: 'build', commandText: 'build', executionKind: 'local' as const }]),
    terminateSessionGuarded: vi.fn(async () => ({ ok: true as const })),
  };
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><TerminalSessionActions sessionId="terminal" title="Build terminal" access={access} /></AppI18nProvider>));
  return access;
}
it('ends only after explicit confirmation and a fresh run-set check', async () => {
  const access = render(); await click('session-end');
  expect(access.terminateSessionGuarded).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="session-end-dialog"]')?.textContent).toContain('Active runs: 1');
  await click('session-end-confirm');
  expect(access.listRuns).toHaveBeenCalledTimes(2);
  expect(access.terminateSessionGuarded).toHaveBeenCalledExactlyOnceWith('terminal', ['build']);
});
it('requires another confirmation when work changed after review', async () => {
  const access = render(); await click('session-end');
  access.listRuns.mockResolvedValue([{ sessionId: 'terminal', runId: 'deploy', commandText: 'deploy', executionKind: 'local' }]);
  await click('session-end-confirm');
  expect(access.terminateSessionGuarded).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="session-end-dialog"] [role="alert"]')).not.toBeNull();
  await click('session-end-confirm');
  expect(access.terminateSessionGuarded).toHaveBeenCalledExactlyOnceWith('terminal', ['deploy']);
});
it('does not offer an unverified termination when observation fails', async () => {
  const access = render(); access.listRuns.mockRejectedValue(new Error('disconnected')); await click('session-end');
  expect(access.terminateSessionGuarded).not.toHaveBeenCalled();
  expect(document.querySelector('[data-testid="session-end-confirm"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
it('treats a missing persisted PTY as ended without changing the host snapshot', () => {
  const snapshot = { ...sessionStartSnapshot, sessions: [{ ...sessionStartSnapshot.workspaces[0], id: 'old-pty', workspaceId: 'main', kind: 'terminal' as const, title: 'Old terminal', state: 'running' as const, source: 'legacy-pty' as const }] };
  expect(withLiveTerminalSessions(snapshot, new Set())?.sessions[0].state).toBe('completed');
  expect(snapshot.sessions[0].state).toBe('running');
  expect(withLiveTerminalSessions(snapshot, null)).toBe(snapshot);
});
