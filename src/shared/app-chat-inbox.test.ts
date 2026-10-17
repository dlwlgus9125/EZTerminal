import { describe, expect, it } from 'vitest';

import { appChatInbox } from './app-chat-inbox';
import { DAEMON_PROTOCOL_VERSION, type DaemonSnapshot } from './daemon-protocol';

const stamp = { revision: 1, createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:00.000Z' };
const session = (id: string, title: string) => ({ ...stamp, id, projectId: 'project', workspaceId: 'main', kind: 'agent' as const, title, state: 'idle' as const, source: 'structured' as const });
const agent = (sessionId: string, providerId = 'claude') => ({ ...stamp, sessionId, providerId, permissionPreset: 'standard' as const, state: 'idle' as const, queuedTurnCount: 0, orchestrationEnabled: false });
const turn = (id: string, sessionId: string, state: 'completed' | 'failed' | 'interrupted', finishedAt: string) => ({
  ...stamp, id, sessionId, commandId: `command-${id}`, state, startedAt: '2026-10-17T00:00:00.000Z', finishedAt,
});

function snapshot(): DaemonSnapshot {
  return {
    protocolVersion: DAEMON_PROTOCOL_VERSION, revision: 1, eventSequence: 1, generatedAt: stamp.updatedAt,
    runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: false, browserEnabled: false },
    projects: [], workspaces: [], transcriptHeads: [], providers: [], schedules: [], heartbeats: [],
    sessions: [session('lead', 'README 삭제 맡기기'), session('review', '로그인 변경 검토'), session('child', 'Delete README'), session('planning-0123456789abcdef0123456789abcdef', 'Stage agent'), session('quiet', 'Old chat')],
    agents: [agent('lead'), agent('review', 'codex'), agent('child'), agent('planning-0123456789abcdef0123456789abcdef'), agent('quiet')],
    agentRelations: [{ ...stamp, id: 'relation', treeId: 'lead', parentSessionId: 'lead', childSessionId: 'child', owner: 'provider-native', depth: 1 }],
    turns: [
      turn('t-review', 'review', 'completed', '2026-10-17T03:40:00.000Z'),
      turn('t-child', 'child', 'completed', '2026-10-17T03:41:00.000Z'),
      turn('t-planning', 'planning-0123456789abcdef0123456789abcdef', 'completed', '2026-10-17T03:42:00.000Z'),
      turn('t-quiet', 'quiet', 'completed', '2026-10-16T09:00:00.000Z'),
      turn('t-lead', 'lead', 'interrupted', '2026-10-17T03:43:00.000Z'),
    ],
    approvals: [{
      ...stamp, id: 'approval-1', sessionId: 'lead', providerRequestId: 'request-1', risk: 'danger', title: 'Run command',
      detail: 'Delete README: Remove-Item README.md', state: 'pending', createdAt: '2026-10-17T04:01:00.000Z',
      request: { v: 1, kind: 'command', command: 'Remove-Item README.md', subagent: { sessionId: 'child', title: 'Delete README' } },
    }],
  };
}

const seen = { epoch: '2026-10-17T00:00:00.000Z', sessions: {} };

describe('appChatInbox', () => {
  it('lists pending approvals first, naming the subagent that asked', () => {
    const [first] = appChatInbox(snapshot(), seen);
    expect(first).toMatchObject({ kind: 'approval', sessionId: 'lead', conversationTitle: 'README 삭제 맡기기', subagentTitle: 'Delete README', detail: 'Remove-Item README.md' });
  });

  it('lists conversations that finished while unseen, never a subagent, a planning run or an interrupted turn', () => {
    const entries = appChatInbox(snapshot(), seen);
    expect(entries.map((entry) => [entry.kind, entry.sessionId])).toEqual([
      ['approval', 'lead'],
      ['finished', 'review'],
    ]);
  });

  it('drops a conversation once it is open or was seen after it finished', () => {
    expect(appChatInbox(snapshot(), seen, new Set(['review'])).some((entry) => entry.sessionId === 'review')).toBe(false);
    expect(appChatInbox(snapshot(), { ...seen, sessions: { review: '2026-10-17T03:45:00.000Z' } }).some((entry) => entry.sessionId === 'review')).toBe(false);
  });

  it('marks a failed turn as failed', () => {
    const failing = snapshot();
    const entries = appChatInbox({ ...failing, turns: [{ ...turn('t-review', 'review', 'failed', '2026-10-17T03:40:00.000Z'), errorCode: 'provider-session-failed' }] }, seen);
    expect(entries.find((entry) => entry.sessionId === 'review')).toMatchObject({ kind: 'failed', errorCode: 'provider-session-failed' });
  });
});
