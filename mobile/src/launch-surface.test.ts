// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { lastSurfaceOf, launchSurface } from './launch-surface';
import { readWorkspaceRestore, writeWorkspaceRestore, type MobileWorkspaceRestore } from './workspace-restore';

/** The check the 2.0 build before the feed (versionCode 78, 5f85ba1) runs on the same key, copied as it was. */
function vc78Accepts(raw: string | null): boolean {
  const saved = JSON.parse(raw ?? 'null');
  const validId = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 256;
  return Boolean(saved && Array.isArray(saved.terminalSessionIds) && saved.terminalSessionIds.length <= 128
    && saved.terminalSessionIds.every(validId)
    && (saved.activeTerminalSessionId === null || validId(saved.activeTerminalSessionId))
    && (saved.activeAgentSessionId === null || validId(saved.activeAgentSessionId))
    && ['terminal', 'agents'].includes(saved.destination));
}

const base: MobileWorkspaceRestore = { terminalSessionIds: ['one'], activeTerminalSessionId: 'one', activeAgentSessionId: 'chat', destination: 'terminal' };

beforeEach(() => localStorage.clear());

describe('launch surface', () => {
  it('opens on the feed whenever something waits', () => {
    for (const last of ['feed', 'terminal', 'chat'] as const) {
      expect(launchSurface({ waiting: 1, last, terminalRestored: true, conversationExists: true })).toBe('feed');
    }
  });

  it('otherwise returns to the terminal or conversation left, when it is still there', () => {
    expect(launchSurface({ waiting: 0, last: 'terminal', terminalRestored: true, conversationExists: false })).toBe('terminal');
    expect(launchSurface({ waiting: 0, last: 'terminal', terminalRestored: false, conversationExists: true })).toBe('feed');
    expect(launchSurface({ waiting: 0, last: 'chat', terminalRestored: true, conversationExists: true })).toBe('agents');
    expect(launchSurface({ waiting: 0, last: 'chat', terminalRestored: true, conversationExists: false })).toBe('feed');
    expect(launchSurface({ waiting: 0, last: 'feed', terminalRestored: true, conversationExists: true })).toBe('feed');
  });

  it('reads a record from before the feed by its work destination', () => {
    expect(lastSurfaceOf({ destination: 'terminal' })).toBe('terminal');
    expect(lastSurfaceOf({ destination: 'agents' })).toBe('chat');
    expect(lastSurfaceOf({ destination: 'agents', lastSurface: 'feed' })).toBe('feed');
  });
});

describe('restore record with the last surface', () => {
  it('stays readable by the build before the feed, and that build\'s record stays readable here', () => {
    writeWorkspaceRestore('host', { ...base, lastSurface: 'feed' });
    expect(vc78Accepts(localStorage.getItem('ezterminal-workspace-v1:host'))).toBe(true);
    expect(readWorkspaceRestore('host')).toEqual({ ...base, lastSurface: 'feed' });
    localStorage.setItem('ezterminal-workspace-v1:host', JSON.stringify(base));
    expect(readWorkspaceRestore('host')).toEqual(base);
  });

  it('drops a surface it does not know without losing the terminals', () => {
    localStorage.setItem('ezterminal-workspace-v1:host', JSON.stringify({ ...base, lastSurface: 'board' }));
    expect(readWorkspaceRestore('host')).toEqual(base);
  });
});
