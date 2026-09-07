// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { readWorkspaceRestore, writeWorkspaceRestore } from './workspace-restore';

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
const saved = { terminalSessionIds: ['one', 'two'], activeTerminalSessionId: 'one', activeAgentSessionId: 'agent', destination: 'agents' as const };

it('restores only the authenticated host view and preserves the active terminal and Agent', () => {
  writeWorkspaceRestore('host-a', saved);
  expect(readWorkspaceRestore('host-a')).toEqual(saved);
  expect(readWorkspaceRestore('host-b')).toBeNull();
});

it('ignores corrupt view records and unavailable storage', () => {
  localStorage.setItem('ezterminal-workspace-v1:host', '{broken');
  expect(readWorkspaceRestore('host')).toBeNull();
  localStorage.setItem('ezterminal-workspace-v1:host', JSON.stringify({ ...saved, terminalSessionIds: [4] }));
  expect(readWorkspaceRestore('host')).toBeNull();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  expect(() => writeWorkspaceRestore('host', saved)).not.toThrow();
});
