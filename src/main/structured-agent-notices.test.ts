import { describe, expect, it } from 'vitest';

import type { DaemonApproval, DaemonSnapshot, DaemonTurn } from '../shared/daemon-protocol';
import { StructuredAgentNoticeTracker } from './structured-agent-notices';

const NOW = '2026-10-15T09:30:00.000Z';

function snapshot(turns: Partial<DaemonTurn>[], approvals: Partial<DaemonApproval>[] = []): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: NOW,
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [], workspaces: [],
    sessions: [{ id: 's1', projectId: 'p', workspaceId: 'w', kind: 'agent', title: 'Fix login', state: 'running', source: 'structured', revision: 1, createdAt: NOW, updatedAt: NOW }],
    agents: [{ sessionId: 's1', providerId: 'claude', permissionPreset: 'standard', state: 'working', queuedTurnCount: 0, orchestrationEnabled: true, revision: 1, createdAt: NOW, updatedAt: NOW }],
    agentRelations: [],
    turns: turns.map((turn, index) => ({ id: `t${index + 1}`, sessionId: 's1', commandId: `c${index + 1}`, state: 'working', revision: 1, createdAt: NOW, updatedAt: NOW, ...turn }) as DaemonTurn),
    transcriptHeads: [],
    approvals: approvals.map((approval, index) => ({ id: `a${index + 1}`, sessionId: 's1', providerRequestId: `r${index + 1}`, risk: 'danger', title: 'Run command', state: 'pending', revision: 1, createdAt: NOW, updatedAt: NOW, ...approval }) as DaemonApproval),
    providers: [{ id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW }],
    schedules: [], heartbeats: [],
  };
}

describe('StructuredAgentNoticeTracker', () => {
  it('stays quiet about what was already true when it starts', () => {
    const tracker = new StructuredAgentNoticeTracker();
    expect(tracker.observe(snapshot([{ state: 'completed' }], [{}]))).toEqual([]);
    expect(tracker.observe(snapshot([{ state: 'completed' }], [{}]))).toEqual([]);
  });

  it('notifies a new pending approval once', () => {
    const tracker = new StructuredAgentNoticeTracker();
    tracker.observe(snapshot([{ state: 'working' }]));
    expect(tracker.observe(snapshot([{ state: 'blocked' }], [{ title: 'Run command' }]))).toEqual([
      { setting: 'blocked', sessionId: 's1', title: 'Claude needs your approval', body: 'Fix login · Run command' },
    ]);
    expect(tracker.observe(snapshot([{ state: 'blocked' }], [{ title: 'Run command' }]))).toEqual([]);
  });

  it('notifies a finished or failed turn, not an interrupted one', () => {
    const tracker = new StructuredAgentNoticeTracker();
    tracker.observe(snapshot([{ state: 'working' }, { state: 'working' }, { state: 'working' }]));
    const notices = tracker.observe(snapshot([{ state: 'completed' }, { state: 'failed' }, { state: 'interrupted' }]));
    expect(notices.map((notice) => [notice.setting, notice.title])).toEqual([
      ['waiting', 'Claude finished'],
      ['error', 'Claude stopped with an error'],
    ]);
    expect(tracker.observe(snapshot([{ state: 'completed' }, { state: 'failed' }, { state: 'interrupted' }]))).toEqual([]);
  });
});
