import { describe, expect, it } from 'vitest';

import { shellSnapshot, shellWorkflow } from './shell-fixtures';
import { hostWaitingItems, otherProjects, projectConversations, projectFlows, waitingItems } from './shell-model';

describe('projectConversations', () => {
  it('lists a project\'s conversations newest first with provider subagents nested under their parent', () => {
    const items = projectConversations(shellSnapshot(), 'p-ez');
    expect(items.map((item) => item.sessionId)).toEqual(['s-notify', 's-pdf', 's-font', 's-merge']);
    const parent = items[0]!;
    expect(parent.children.map((child) => child.sessionId)).toEqual(['s-dedupe', 's-trace']);
    expect(parent.children.map((child) => child.state)).toEqual(['working', 'done']);
  });

  it('reads waiting states from pending approvals: a question asks, anything else wants approval', () => {
    const items = projectConversations(shellSnapshot(), 'p-ez');
    expect(items.find((item) => item.sessionId === 's-notify')).toMatchObject({ state: 'approval', lamp: 'amber' });
    expect(items.find((item) => item.sessionId === 's-pdf')).toMatchObject({ state: 'question', lamp: 'amber' });
    expect(items.find((item) => item.sessionId === 's-font')).toMatchObject({ state: 'done', lamp: 'ok' });
  });

  it('marks an errored conversation red and leaves planning runs and excluded sessions out', () => {
    const snapshot = shellSnapshot();
    expect(projectConversations(snapshot, 'p-kestrel')[0]).toMatchObject({ state: 'failed', lamp: 'red' });
    expect(projectConversations(snapshot, 'p-ez', { exclude: new Set(['s-pdf']) }).map((item) => item.sessionId)).not.toContain('s-pdf');
  });

  it('returns nothing before the host answers', () => {
    expect(projectConversations(null, 'p-ez')).toEqual([]);
  });
});

describe('waitingItems', () => {
  it('names what waits in one line: the command or the question', () => {
    const items = waitingItems(shellSnapshot(), 'p-ez');
    expect(items).toEqual([
      expect.objectContaining({ approvalId: 'a-command', kind: 'command', detail: 'pnpm --dir mobile test -- notifications', title: 'Android 승인 알림이 두 번 뜨는 문제' }),
      expect.objectContaining({ approvalId: 'a-question', kind: 'question', detail: 'PDF를 새 창으로 열까요, 바로 저장할까요?' }),
    ]);
    expect(waitingItems(shellSnapshot(), 'p-garnet')).toEqual([]);
    expect(waitingItems(shellSnapshot({ waiting: false }))).toEqual([]);
  });
});

describe('hostWaitingItems', () => {
  const attention = {
    version: 1 as const, digest: 'd',
    items: [
      { id: 'flow-1', kind: 'flow-approval' as const, projectId: 'p-ez', title: '승인', since: '2026-10-25T09:00:00.000Z', subprojectId: 'login', nodeId: 'login:approval', runId: 'run-4', activationId: 'act-1' },
      { id: 'agent-1', kind: 'terminal-agent' as const, projectId: 'p-garnet', title: 'claude', since: '2026-10-25T08:00:00.000Z', activityId: 'activity-1' },
      { id: 'approval-x', kind: 'approval' as const, projectId: 'p-ez', title: 'ignored: conversations come from the approvals', since: '2026-10-25T07:00:00.000Z' },
    ],
  };

  it('is the conversation approvals alone for an older host', () => {
    expect(hostWaitingItems(shellSnapshot(), 'p-ez')).toEqual(waitingItems(shellSnapshot(), 'p-ez'));
  });

  it('adds the flow approvals and blocked terminal agents the host counts, by project, newest first', () => {
    const snapshot = { ...shellSnapshot(), attention };
    const ez = hostWaitingItems(snapshot, 'p-ez');
    expect(ez.map((item) => item.kind)).toEqual(['flow-approval', ...waitingItems(snapshot, 'p-ez').map((item) => item.kind)]);
    expect(ez[0]).toMatchObject({ approvalId: 'flow-1', sessionId: '', projectId: 'p-ez', title: '승인', flow: { subprojectId: 'login', nodeId: 'login:approval' } });
    expect(hostWaitingItems(snapshot, 'p-garnet').map((item) => item.kind)).toEqual(['terminal-agent']);
    expect(hostWaitingItems(snapshot)).toHaveLength(waitingItems(snapshot).length + 2);
  });
});

describe('projectFlows', () => {
  it('shows the latest run of each live subproject as lamps, numbered by its runs', () => {
    const [flow] = projectFlows(shellWorkflow('awaiting-approval'));
    expect(flow).toMatchObject({ subprojectId: 'login', title: '로그인 개선', runNumber: 4, phase: 'awaiting-approval', lamp: 'amber' });
    expect(flow!.stages.find((stage) => stage.state === 'wait')?.id).toBe('login:approval');
    expect(flow!.stages.filter((stage) => stage.state === 'done').length).toBeGreaterThan(0);
  });

  it('reads completed and running runs', () => {
    expect(projectFlows(shellWorkflow('completed'))[0]).toMatchObject({ phase: 'completed', lamp: 'ok' });
    expect(projectFlows(shellWorkflow('retry-running'))[0]).toMatchObject({ phase: 'running', lamp: 'on' });
  });

  it('shows the run still going over a newer one only prepared, without condition chips, with this run’s stage conversations', () => {
    const workflow = shellWorkflow('retry-running');
    const going = workflow.runs.at(-1)!;
    const prepared = { ...going, runId: 'run-login-5', createdAt: '2030-01-01T00:00:00.000Z', state: 'prepared' as const, startedAt: undefined, attempts: [], reviews: [] };
    const [flow] = projectFlows({ ...workflow, runs: [...workflow.runs, prepared] });
    expect(flow).toMatchObject({ runNumber: 4, phase: 'running', canRunAgain: false });
    const graph = going.preparation.workflow!.graph;
    expect(flow!.stages.map((stage) => stage.id)).toEqual(graph.nodes.filter((node) => node.operation !== 'condition').map((node) => node.id));
    const attempt = going.attempts.at(-1)!;
    expect(flow!.stages.find((stage) => stage.id === attempt.taskId)?.sessionId).toBe(attempt.sessionId);
    // 다시 실행 needs a finished flow and a saved review AI.
    const done = shellWorkflow('completed');
    expect(projectFlows(done)[0]!.canRunAgain).toBe(false);
    const saved = { ...done, subprojects: done.subprojects.map((subproject) => ({ ...subproject, runSettings: { reviewer: { providerId: 'codex', model: 'gpt-6-astra' } } })) };
    expect(projectFlows(saved)[0]!.canRunAgain).toBe(true);
  });
});

describe('otherProjects', () => {
  it('lists the other projects that need a look, busiest first', () => {
    expect(otherProjects(shellSnapshot(), 'p-ez')).toEqual([
      { projectId: 'p-kestrel', name: 'Kestrel', waiting: 0, failed: 1, working: 0 },
    ]);
  });
});
