import { describe, expect, it } from 'vitest';

import type { AgentActivity } from '../../../src/shared/agent';
import type { DaemonSnapshot } from '../../../src/shared/daemon-protocol';
import type { HostAttention } from '../../../src/shared/host-attention';
import { shellSnapshot, shellWorkflow } from '../../../src/renderer/shell/shell-fixtures';
import {
  askBarUsage,
  feedBadgeCount,
  feedConversations,
  feedFlows,
  feedProjects,
  feedWaiting,
  flowReadProjects,
  stageSessionIds,
} from './feed-model';

function terminal(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id: 'activity-1', sessionId: 'pty-1', provider: 'claude', providerLabel: 'Claude', cwd: 'C:/Working/Garnet',
    state: 'blocked', status: 'blocked', stateSeq: 3, live: true, interactiveReady: true, stateSource: 'hook',
    projectId: 'p-garnet', createdAt: Date.parse('2026-10-24T09:00:00.000Z'), updatedAt: Date.parse('2026-10-24T09:20:00.000Z'),
    approval: { approvalId: 'gate-1', toolName: 'Bash', command: 'rm -rf dist', risk: 'danger', pending: true, requestedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER },
    ...overrides,
  } as AgentActivity;
}

const attention: HostAttention = {
  version: 1, digest: 'd',
  items: [
    { id: 'approval-1', kind: 'approval', projectId: 'p-ez', title: 'Android 승인 알림이 두 번 뜨는 문제', since: '2026-10-24T09:28:00.000Z', sessionId: 's-notify', approvalId: 'a-command' },
    { id: 'question-1', kind: 'question', projectId: 'p-ez', title: '결과 탭 PDF 저장 버튼', since: '2026-10-24T09:24:00.000Z', sessionId: 's-pdf', approvalId: 'a-question' },
    { id: 'flow-1', kind: 'flow-approval', projectId: 'p-kestrel', title: '승인', since: '2026-10-24T09:25:00.000Z', subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4', activationId: 'act-1' },
    { id: 'agent-1', kind: 'terminal-agent', projectId: 'p-garnet', title: 'Claude', since: '2026-10-24T09:20:00.000Z', activityId: 'activity-1' },
  ],
};

function withAttention(snapshot: DaemonSnapshot = shellSnapshot()): DaemonSnapshot {
  return { ...snapshot, attention };
}

describe('feedWaiting', () => {
  it('lists what waits across every project, newest first, with the project named', () => {
    const items = feedWaiting(withAttention(), [terminal()]);
    // Conversation approvals carry their request time (the fixture's command 09:23, question 09:19).
    expect(items.map((item) => item.kind)).toEqual(['flow-approval', 'approval', 'terminal-agent', 'question']);
    expect(items[0]).toMatchObject({ projectName: 'Kestrel', flow: { subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4' } });
    expect(items[1]).toMatchObject({ projectId: 'p-ez', projectName: 'EZTerminal', detail: 'pnpm --dir mobile test -- notifications', providerId: 'claude', sessionId: 's-notify' });
    expect(items[2]).toMatchObject({ projectName: 'Garnet', activityId: 'activity-1', detail: 'rm -rf dist' });
  });

  it('lets a card decide only a command, a file change or a tool, and a terminal agent whose gate is still open', () => {
    const items = feedWaiting(withAttention(), [terminal()]);
    expect(items.find((item) => item.kind === 'approval')?.decide).toEqual({ target: 'conversation', approvalId: 'a-command' });
    expect(items.find((item) => item.kind === 'question')?.decide).toBeUndefined();
    expect(items.find((item) => item.kind === 'flow-approval')?.decide).toBeUndefined();
    expect(items.find((item) => item.kind === 'terminal-agent')?.decide).toEqual({ target: 'terminal', activityId: 'activity-1', approvalId: 'gate-1' });
    const expired = feedWaiting(withAttention(), [terminal({ approval: { ...terminal().approval!, pending: false } })]);
    expect(expired.find((item) => item.kind === 'terminal-agent')?.decide).toBeUndefined();
  });

  it('names a flow approval by its flow once that flow was read, with the stage below', () => {
    const workflows = new Map([['p-kestrel', { subprojects: [{ ...shellWorkflow().subprojects[0]!, id: 'login', title: '로그인 개선' }] }]]);
    const flow = feedWaiting(withAttention(), [], workflows).find((item) => item.kind === 'flow-approval');
    expect(flow).toMatchObject({ title: '로그인 개선', detail: '승인' });
    expect(feedWaiting(withAttention(), []).find((item) => item.kind === 'flow-approval')).toMatchObject({ title: '승인', detail: '' });
  });

  it('reads an older PC (no attention) as conversation approvals plus blocked terminal agents', () => {
    const items = feedWaiting(shellSnapshot(), [terminal(), terminal({ id: 'activity-2', state: 'working', status: 'working', approval: undefined })]);
    expect(items.map((item) => item.kind)).toEqual(['approval', 'terminal-agent', 'question']);
    expect(items[1]).toMatchObject({ activityId: 'activity-1', projectName: 'Garnet', decide: { target: 'terminal', activityId: 'activity-1', approvalId: 'gate-1' } });
  });

  it('counts the badge exactly as the host does when it sends attention', () => {
    expect(feedBadgeCount(withAttention(), [terminal()])).toBe(attention.items.length);
    // An older PC: still counts its conversation approvals.
    expect(feedBadgeCount(shellSnapshot(), [])).toBe(2);
    expect(feedBadgeCount(null, [])).toBe(0);
  });
});

describe('feedConversations', () => {
  it('lists one project newest first, leaving out what already waits, flow stages and non-app sessions', () => {
    const snapshot = shellSnapshot();
    const sessions = snapshot.sessions.map((session) => session.id === 's-merge' ? { ...session, source: 'legacy-import' as const } : session);
    const { items, total } = feedConversations({ ...snapshot, sessions }, 'p-ez', {
      waitingSessions: new Set(['s-notify', 's-pdf']), stageSessions: new Set(['s-font']),
    });
    expect(items.map((item) => item.sessionId)).toEqual([]);
    expect(total).toBe(0);
    const all = feedConversations(snapshot, 'p-ez');
    expect(all.items.map((item) => item.sessionId)).toEqual(['s-notify', 's-pdf', 's-font', 's-merge']);
    expect(all.items[0]).toMatchObject({ projectId: 'p-ez', projectName: 'EZTerminal' });
  });

  it('merges every project for 모든 프로젝트 and stops at the limit, counting the rest', () => {
    const { items, total } = feedConversations(shellSnapshot(), null, { limit: 3 });
    expect(total).toBe(6);
    expect(items.map((item) => item.sessionId)).toEqual(['s-notify', 's-pdf', 's-csv']);
    expect(items[2]).toMatchObject({ projectName: 'Kestrel', lamp: 'red' });
  });
});

describe('feedFlows and the reads behind them', () => {
  const projects = feedProjects(shellSnapshot());

  it('shows a project\'s flows, and only flows with a run going across every project', () => {
    const workflows = new Map([['p-ez', shellWorkflow('awaiting-approval')], ['p-kestrel', shellWorkflow('completed')]]);
    expect(feedFlows(workflows, 'p-kestrel', projects).map((flow) => flow.phase)).toEqual(['completed']);
    const all = feedFlows(workflows, null, projects);
    expect(all.map((flow) => [flow.projectName, flow.phase])).toEqual([['EZTerminal', 'awaiting-approval']]);
    expect(all[0]?.lamp).toBe('amber');
  });

  it('collects the stage conversations of every read flow', () => {
    const linked = { linkedAt: '2026-10-24T09:00:00.000Z', graphRevision: 1 };
    const workflow = { sessionLinks: [{ sessionId: 's-font', subprojectId: 'login', nodeId: 'n', scope: 'stage' as const, ...linked }, { sessionId: 's-merge', subprojectId: 'login', scope: 'flow-edit' as const, ...linked }] };
    expect([...stageSessionIds([workflow])]).toEqual(['s-font']);
  });

  it('reads the chosen project, or for every project the waiting ones first, at most six', () => {
    expect(flowReadProjects('p-garnet', projects, [], [])).toEqual(['p-garnet']);
    expect(flowReadProjects('gone', projects, [], [])).toEqual([]);
    const waiting = feedWaiting(withAttention(), []);
    const conversations = feedConversations(shellSnapshot(), null).items;
    expect(flowReadProjects(null, projects, waiting, conversations)).toEqual(['p-kestrel', 'p-ez', 'p-garnet']);
    expect(flowReadProjects(null, projects, waiting, conversations, 1)).toEqual(['p-kestrel']);
  });
});

describe('askBarUsage', () => {
  it('shows the plan limits of the newest conversation\'s provider, without a context figure', () => {
    const snapshot: DaemonSnapshot = { ...shellSnapshot(), providerUsage: {
      claude: { fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 21 }, contextPercent: 40 },
      codex: { weekly: { usedPercent: 41 } },
    } };
    const conversations = feedConversations(snapshot, null).items;
    expect(askBarUsage(snapshot, conversations)).toEqual({ providerId: 'claude', usage: snapshot.providerUsage!.claude });
    expect(askBarUsage({ ...snapshot, providerUsage: { codex: { weekly: { usedPercent: 41 } } } }, conversations)).toBeNull();
    expect(askBarUsage(null, [])).toBeNull();
  });
});
