import { describe, expect, it } from 'vitest';

import { WorkflowGraphSchema, validateWorkflowGraph, type WorkflowGraph } from './workflow-graph';
import { builtinWorkflowTemplates, instantiateWorkflowTemplate, workflowTemplateGraph } from './workflow-templates';

const english = (_ko: string, en: string) => en;
const agent = { profileId: 'agent-build', name: '구현 담당', providerId: 'codex', model: 'gpt-6-astra', capturedAt: '2026-10-29T00:00:00.000Z' };

describe('built-in workflow templates', () => {
  it('are 개발 절차 and 정기 점검, structurally sound, and need only agents placed before they run', () => {
    const [dev, check] = builtinWorkflowTemplates();
    expect([dev.title, check.title]).toEqual(['개발 절차', '정기 점검']);
    for (const template of [dev, check]) {
      expect(WorkflowGraphSchema.parse(template.graph)).toEqual(template.graph);
      expect(validateWorkflowGraph(template.graph)).toEqual([]);
      // Before agents are placed, only the provider is missing: instructions, acceptance and scopes are filled in.
      expect(new Set(validateWorkflowGraph(template.graph, true).map(issue => issue.code))).toEqual(new Set(['missing-provider']));
      for (const node of template.graph.nodes.filter(entry => entry.operation === 'agent')) {
        expect(node.instructions.trim()).not.toBe('');
        expect(node.acceptance.length).toBeGreaterThan(0);
      }
    }
  });

  it('build 개발 절차 as approved: answer after 요구 정리, fresh cross review, approval back to 계획, implementation checked by pnpm test', () => {
    const { graph } = builtinWorkflowTemplates()[0];
    const byTitle = Object.fromEntries(graph.nodes.map(node => [node.title, node]));
    expect(graph.nodes.map(node => [node.title, node.operation])).toEqual([
      ['요구 정리', 'agent'], ['내 답변', 'answer'], ['계획', 'agent'], ['시안', 'agent'], ['교차 검토', 'agent'], ['시안 승인', 'approval'], ['구현', 'agent'], ['완료', 'complete'],
    ]);
    expect(byTitle['내 답변'].answer).toEqual({ prompt: '정리한 요구에서 빠진 것이나 바로잡을 것을 알려 주세요', showResultOf: byTitle['요구 정리'].id });
    expect(byTitle['교차 검토']).toMatchObject({ role: 'review', permissionPreset: 'plan', session: 'fresh' });
    expect(byTitle['구현']).toMatchObject({ permissionPreset: 'standard', allowedPaths: ['src/**', 'test/**'], checks: [{ id: 'test', command: 'pnpm test' }] });
    expect(graph.edges.find(edge => edge.from === byTitle['시안 승인'].id && edge.outcome === 'rejected')).toMatchObject({ to: byTitle['계획'].id, retryLimit: 2 });
    // Laid out left to right from the start, never on top of each other.
    expect(new Set(graph.nodes.map(node => `${node.position.x},${node.position.y}`)).size).toBe(graph.nodes.length);
  });

  it('build 정기 점검 with review off on the checked stage', () => {
    const { graph } = builtinWorkflowTemplates()[1];
    expect(graph.nodes.map(node => node.title)).toEqual(['의존성·테스트 확인', '바뀐 점 요약', '결과 확인', '완료']);
    expect(graph.nodes[0]).toMatchObject({ role: 'review', permissionPreset: 'plan', review: { mode: 'off' }, checks: [{ id: 'audit', command: 'pnpm audit' }, { id: 'test', command: 'pnpm test' }] });
  });

  it('follow the UI language in titles and prompts', () => {
    const [dev, check] = builtinWorkflowTemplates(english);
    expect([dev.title, check.title]).toEqual(['Development process', 'Routine check']);
    expect(dev.graph.nodes.map(node => node.title)).toContain('Cross review');
    expect(dev.graph.nodes.find(node => node.operation === 'answer')?.answer?.prompt).toBe('Tell me what the requirements miss or get wrong');
  });
});

describe('instantiateWorkflowTemplate', () => {
  it('gives every stage and connection the new workflow prefix and keeps every reference', () => {
    const { graph } = builtinWorkflowTemplates()[0];
    const created = instantiateWorkflowTemplate(graph, 'subproject-1');
    expect(created.entryNodeId).toBe('subproject-1:req');
    expect(created.nodes.every(node => node.id.startsWith('subproject-1:'))).toBe(true);
    expect(created.edges.every(edge => edge.id.startsWith('subproject-1:') && edge.from.startsWith('subproject-1:') && edge.to.startsWith('subproject-1:'))).toBe(true);
    expect(created.nodes.find(node => node.operation === 'answer')?.answer?.showResultOf).toBe('subproject-1:req');
    expect(validateWorkflowGraph(created)).toEqual([]);
  });

  it('keeps ids apart when two stages end the same way and rewrites conditions and inputs', () => {
    const graph: WorkflowGraph = WorkflowGraphSchema.parse({
      entryNodeId: 'a:work',
      nodes: [
        { id: 'a:work', title: 'Work', operation: 'agent' },
        { id: 'b:work', title: 'Work again', operation: 'agent', inputs: [{ nodeId: 'a:work', kind: 'result' }] },
        { id: 'gate', title: 'Gate', operation: 'condition', condition: { sourceNodeId: 'b:work', field: 'outcome', equals: 'passed' } },
      ],
      edges: [{ id: 'e', from: 'a:work', to: 'b:work' }, { id: 'x:e', from: 'b:work', to: 'gate' }],
    });
    const created = instantiateWorkflowTemplate(graph, 'p');
    expect(created.nodes.map(node => node.id)).toEqual(['p:work', 'p:work-2', 'p:gate']);
    expect(created.nodes[1].inputs).toEqual([{ nodeId: 'p:work', kind: 'result' }]);
    expect(created.nodes[2].condition?.sourceNodeId).toBe('p:work-2');
    expect(created.edges.map(edge => [edge.id, edge.from, edge.to])).toEqual([['p:e', 'p:work', 'p:work-2'], ['p:e-2', 'p:work-2', 'p:gate']]);
  });
});

describe('workflowTemplateGraph', () => {
  const placed = (): WorkflowGraph => {
    const { graph } = builtinWorkflowTemplates()[0];
    return { ...graph, nodes: graph.nodes.map(node => node.operation === 'agent'
      ? { ...node, agent, providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', document: 'project notes', ...(node.role === 'review' ? { review: { mode: 'agent' as const, agent } } : {}) }
      : node) };
  };

  it('without the agents keeps each stage’s AI, model, effort and permission, and drops a stage reviewer agent', () => {
    const saved = workflowTemplateGraph(placed(), false);
    for (const node of saved.nodes) expect(node).not.toHaveProperty('agent');
    expect(saved.nodes.find(node => node.title === '구현')).toMatchObject({ providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', permissionPreset: 'standard', checks: [{ command: 'pnpm test' }] });
    expect(saved.nodes.find(node => node.title === '교차 검토')).not.toHaveProperty('review');
    expect(saved.nodes.every(node => node.document === '')).toBe(true);
    expect(WorkflowGraphSchema.parse(saved)).toEqual(saved);
  });

  it('with the agents keeps them and keeps instructions, acceptance and answer prompts', () => {
    const source = placed();
    const saved = workflowTemplateGraph(source, true);
    expect(saved.nodes.filter(node => node.agent).length).toBe(5);
    expect(saved.nodes.find(node => node.title === '교차 검토')?.review).toEqual({ mode: 'agent', agent });
    expect(saved.nodes.map(node => [node.instructions, node.acceptance, node.answer])).toEqual(source.nodes.map(node => [node.instructions, node.acceptance, node.answer]));
    expect(saved.edges).toEqual(source.edges);
  });
});
