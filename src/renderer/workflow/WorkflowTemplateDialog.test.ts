import { describe, expect, it } from 'vitest';

import { builtinWorkflowTemplates } from '../../shared/workflow-templates';
import { workflowTemplateChoice } from './WorkflowTemplateDialog';

const korean = (ko: string) => ko;
const english = (_ko: string, en: string) => en;

describe('workflowTemplateChoice', () => {
  it('shows 개발 절차 in path order with the people’s stages and its check, and what it needs', () => {
    const choice = workflowTemplateChoice(builtinWorkflowTemplates()[0], 'builtin', korean);
    expect(choice).toMatchObject({ id: 'builtin-dev', title: '개발 절차', origin: 'builtin' });
    expect(choice.steps).toEqual([
      { label: '요구 정리' }, { label: '내 답변', kind: 'person' }, { label: '계획' }, { label: '시안' }, { label: '교차 검토' },
      { label: '시안 승인', kind: 'person' }, { label: '구현' }, { label: 'pnpm test', kind: 'check' },
    ]);
    expect(choice.needs).toBe('에이전트를 놓을 단계 5개 · 확인 명령 1개');
  });

  it('shows 정기 점검 with both checks after the stage that runs them', () => {
    const choice = workflowTemplateChoice(builtinWorkflowTemplates()[1], 'builtin', korean);
    expect(choice.steps).toEqual([
      { label: '의존성·테스트 확인' }, { label: 'pnpm audit', kind: 'check' }, { label: 'pnpm test', kind: 'check' }, { label: '바뀐 점 요약' }, { label: '결과 확인', kind: 'person' },
    ]);
    expect(choice.needs).toBe('에이전트를 놓을 단계 2개 · 확인 명령 2개');
  });

  it('names the agents a saved template keeps', () => {
    const template = builtinWorkflowTemplates(english)[1];
    const agent = (name: string) => ({ profileId: name, name, providerId: 'claude', capturedAt: '2026-10-29T00:00:00.000Z' });
    const graph = { ...template.graph, nodes: template.graph.nodes.map((node, index) => index === 0 ? { ...node, agent: agent('Quick') } : node) };
    expect(workflowTemplateChoice({ ...template, id: 'template-mine', graph }, 'user', english)).toMatchObject({
      origin: 'user', needs: '1 agent (Quick) · 1 stage to place an agent on · 2 checks',
    });
  });
});
