import { describe, expect, it } from 'vitest';

import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import { shellSnapshot } from '../shell/shell-fixtures';
import { resolveTerminalProjectId, resolveTerminalTarget, terminalTargetCandidates } from './terminal-target';

const record = { revision: 1, createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z' };

/** The shell fixture with real Windows folders, a terminal and a per-folder stand-in project. */
function snapshot(): DaemonSnapshot {
  const base = shellSnapshot();
  return {
    ...base,
    projects: [
      ...base.projects.map((project) => (project.id === 'p-ez' ? { ...project, rootPath: 'C:\\Working\\EZTerminal' } : project)),
      { id: 'legacy-project-abc', name: 'dlwlg', rootPath: 'C:\\Users\\dlwlg', source: 'legacy-import', ...record },
      { id: 'p-old', name: 'Old', rootPath: 'C:\\Old', source: 'native', archivedAt: '2026-10-01T00:00:00.000Z', ...record },
    ],
    workspaces: [
      ...base.workspaces,
      { id: 'p-ez-wt', projectId: 'p-ez', name: 'wt', kind: 'worktree', rootPath: 'D:\\wt\\ez-feature', ...record },
    ],
    sessions: [
      ...base.sessions,
      { id: 'term-ez', projectId: 'p-ez', workspaceId: 'p-ez-main', kind: 'terminal', title: 'PowerShell', state: 'running', source: 'legacy-pty', ...record },
      { id: 'term-home', projectId: 'legacy-project-abc', workspaceId: 'w', kind: 'terminal', title: 'PowerShell', state: 'running', source: 'legacy-pty', ...record },
    ],
  };
}

describe('resolveTerminalProjectId', () => {
  it('uses the tab\'s project first', () => {
    expect(resolveTerminalProjectId({ tabProjectId: 'p-garnet', paneSessionId: 'term-ez' }, snapshot())).toBe('p-garnet');
  });

  it('uses the project the terminal session was registered under', () => {
    expect(resolveTerminalProjectId({ paneSessionId: 'term-ez', cwd: 'C:\\Elsewhere' }, snapshot())).toBe('p-ez');
  });

  it('does not treat a per-folder stand-in project as a project, but looks at the current folder', () => {
    expect(resolveTerminalProjectId({ paneSessionId: 'term-home', cwd: 'C:\\Users\\dlwlg' }, snapshot())).toBeUndefined();
    expect(resolveTerminalProjectId({ paneSessionId: 'term-home', cwd: 'c:/working/ezterminal/src/renderer/' }, snapshot())).toBe('p-ez');
    expect(resolveTerminalProjectId({ paneSessionId: 'term-home', cwd: 'D:\\wt\\ez-feature\\docs' }, snapshot())).toBe('p-ez');
  });

  it('needs a folder boundary and ignores archived or unknown projects', () => {
    expect(resolveTerminalProjectId({ cwd: 'C:\\Working\\EZTerminal-old' }, snapshot())).toBeUndefined();
    expect(resolveTerminalProjectId({ cwd: 'C:\\Old\\x' }, snapshot())).toBeUndefined();
    expect(resolveTerminalProjectId({ tabProjectId: 'p-gone', cwd: null }, snapshot())).toBeUndefined();
    expect(resolveTerminalProjectId({ tabProjectId: 'p-ez' }, null)).toBeUndefined();
  });
});

describe('terminalTargetCandidates', () => {
  it('lists live top-level conversations, last looked at first, then most recently active', () => {
    const views = { 's-font': '2026-10-24T09:10:00.000Z', 's-merge': '2026-10-24T09:20:00.000Z' };
    expect(terminalTargetCandidates(snapshot(), views, 'p-ez').map((item) => item.sessionId))
      .toEqual(['s-merge', 's-font', 's-notify', 's-pdf']);
  });

  it('leaves out subagents, terminals, archived and flow-stage sessions', () => {
    const base = snapshot();
    const withExtras: DaemonSnapshot = {
      ...base,
      sessions: [
        ...base.sessions,
        { id: 'planning-x', projectId: 'p-ez', workspaceId: 'p-ez-main', kind: 'agent', title: 'stage', state: 'idle', source: 'structured', ...record },
        { id: 's-arch', projectId: 'p-ez', workspaceId: 'p-ez-main', kind: 'agent', title: 'old', state: 'idle', source: 'structured', archivedAt: record.updatedAt, ...record },
      ],
      agents: [
        ...base.agents,
        { sessionId: 'planning-x', providerId: 'codex', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: false, state: 'done', ...record },
        { sessionId: 's-arch', providerId: 'codex', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: false, state: 'done', ...record },
      ],
    };
    const ids = terminalTargetCandidates(withExtras, {}).map((item) => item.sessionId);
    expect(ids).not.toContain('s-trace');
    expect(ids).not.toContain('term-ez');
    expect(ids).not.toContain('planning-x');
    expect(ids).not.toContain('s-arch');
  });
});

describe('resolveTerminalTarget', () => {
  const views = { 's-font': '2026-10-24T09:10:00.000Z', 's-garnet': '2026-10-24T09:25:00.000Z' };

  it('keeps the conversation the person picked while it is live', () => {
    expect(resolveTerminalTarget({ snapshot: snapshot(), views, projectId: 'p-ez', pickedSessionId: 's-pdf' }))
      .toEqual({ kind: 'conversation', sessionId: 's-pdf', title: '결과 탭 PDF 저장 버튼', providerId: 'codex' });
  });

  it('otherwise sends to the last conversation looked at in the terminal\'s project', () => {
    expect(resolveTerminalTarget({ snapshot: snapshot(), views, projectId: 'p-ez', pickedSessionId: 's-gone' }))
      .toMatchObject({ kind: 'conversation', sessionId: 's-font' });
  });

  it('uses the last conversation looked at anywhere for a terminal without a project', () => {
    expect(resolveTerminalTarget({ snapshot: snapshot(), views })).toMatchObject({ kind: 'conversation', sessionId: 's-garnet' });
  });

  it('starts a new conversation in the project when none there was looked at', () => {
    expect(resolveTerminalTarget({ snapshot: snapshot(), views, projectId: 'p-kestrel' })).toEqual({ kind: 'new', projectId: 'p-kestrel' });
    expect(resolveTerminalTarget({ snapshot: snapshot(), views: {} })).toEqual({ kind: 'new' });
    expect(resolveTerminalTarget({ snapshot: null, views })).toEqual({ kind: 'new' });
  });
});
