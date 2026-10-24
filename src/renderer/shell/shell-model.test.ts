import { describe, expect, it } from 'vitest';

import { shellSnapshot, shellWorkflow } from './shell-fixtures';
import { otherProjects, projectConversations, projectFlows, waitingItems } from './shell-model';

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
});

describe('otherProjects', () => {
  it('lists the other projects that need a look, busiest first', () => {
    expect(otherProjects(shellSnapshot(), 'p-ez')).toEqual([
      { projectId: 'p-kestrel', name: 'Kestrel', waiting: 0, failed: 1, working: 0 },
    ]);
  });
});
