import { z } from 'zod';

import { WORKFLOW_LAYOUT_CARD, WorkflowGraphSchema, WorkflowNodeSchema, layoutWorkflowGraph, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from './workflow-graph';

/**
 * Workflow templates: the stages, instructions, acceptance, checks and answer prompts a new workflow starts
 * from — never runs or conversations. Two built-ins live in code (never stored); people save their own on
 * this PC (`userData/workflow-templates.json`, app-wide, every project). Creating from a template sends
 * `subproject.create` with `presetId: 'custom'` and the template graph, so the protocol is unchanged.
 */
export const WorkflowTemplateInputSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(2_000),
  graph: WorkflowGraphSchema,
}).strict();
export type WorkflowTemplateInput = z.infer<typeof WorkflowTemplateInputSchema>;

export const WorkflowTemplateSchema = WorkflowTemplateInputSchema.extend({ createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;

export const WorkflowTemplateFileSchema = z.object({ version: z.literal(1), templates: z.array(WorkflowTemplateSchema).max(200) }).strict();
export type WorkflowTemplateFile = z.infer<typeof WorkflowTemplateFileSchema>;

export type WorkflowTemplateResult =
  | { readonly ok: true; readonly templates: readonly WorkflowTemplate[] }
  | { readonly ok: false; readonly error: string };

/** Desktop only: the renderer's view of the templates saved on this PC (the built-ins are not in it). */
export interface WorkflowTemplateAccess {
  list(): Promise<readonly WorkflowTemplate[]>;
  /** Adds a template, or replaces the one with the same id (keeping when it was first saved). */
  save(template: WorkflowTemplateInput): Promise<WorkflowTemplateResult>;
  remove(id: string): Promise<WorkflowTemplateResult>;
}

const BUILTIN_PREFIX = 'builtin-';
/** Built-in ids are code: a saved template never takes one. */
export function isBuiltinWorkflowTemplateId(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

type Text = (ko: string, en: string) => string;
const korean: Text = ko => ko;

function builtinGraph(prefix: string, nodes: readonly WorkflowNode[], edges: ReadonlyArray<readonly [string, string, WorkflowEdge['outcome'], number?]>): WorkflowGraph {
  const id = (key: string) => `${prefix}:${key}`;
  const graph: WorkflowGraph = {
    entryNodeId: nodes[0].id, nodes: [...nodes],
    edges: edges.map(([from, to, outcome, retryLimit]) => ({ id: id(`${from}-${to}`), from: id(from), to: id(to), outcome, ...(retryLimit ? { retryLimit } : {}) })),
  };
  return layoutWorkflowGraph(graph, WORKFLOW_LAYOUT_CARD);
}

function stage(prefix: string, key: string, fields: Record<string, unknown>): WorkflowNode {
  return WorkflowNodeSchema.parse({ id: `${prefix}:${key}`, ...fields });
}

/** 개발 절차: requirements → my answer → plan → mockup → cross review → approval → implementation (+ pnpm test) → done. */
function developmentGraph(text: Text): WorkflowGraph {
  const p = `${BUILTIN_PREFIX}dev`;
  return builtinGraph(p, [
    stage(p, 'req', { title: text('요구 정리', 'Requirements'), operation: 'agent', role: 'planning', permissionPreset: 'plan',
      instructions: '워크플로 목표와 프로젝트를 읽고 요구를 정리합니다. 만들 것, 하지 않을 것, 지켜야 할 제약, 끝났다고 볼 기준을 나눠 쓰고, 정하지 못한 점은 가정과 함께 질문으로 남깁니다. 파일은 고치지 않습니다.',
      acceptance: ['만들 것·하지 않을 것·제약·완료 기준이 나뉘어 적혀 있다', '정하지 못한 점마다 가정과 질문이 있다'] }),
    stage(p, 'answer', { title: text('내 답변', 'My answer'), operation: 'answer', role: 'planning',
      instructions: '요구 정리를 읽고 빠진 것이나 바로잡을 것을 답합니다. 답은 다음 단계들이 읽습니다.',
      answer: { prompt: text('정리한 요구에서 빠진 것이나 바로잡을 것을 알려 주세요', 'Tell me what the requirements miss or get wrong'), showResultOf: `${p}:req` } }),
    stage(p, 'plan', { title: text('계획', 'Plan'), operation: 'agent', role: 'planning', permissionPreset: 'plan',
      instructions: '정리한 요구와 내 답변을 반영해 구현 계획을 씁니다. 바꿀 파일과 이유, 작업 순서, 단계마다 확인할 방법(테스트·명령)을 적고, 위험한 부분과 대안을 함께 밝힙니다. 시안 승인에서 되돌아오면 남긴 의견을 먼저 반영합니다. 파일은 고치지 않습니다.',
      acceptance: ['바꿀 파일과 이유가 적혀 있다', '작업 순서와 단계마다 확인할 방법이 있다', '내 답변(되돌아온 경우 승인 의견)이 계획에 반영되어 있다'] }),
    stage(p, 'design', { title: text('시안', 'Mockup'), operation: 'agent', role: 'design', permissionPreset: 'plan',
      instructions: '계획에서 바뀌는 화면이나 동작을 시안으로 보여 줍니다. 화면은 배치·문구·상태(빈 화면, 오류, 불러오는 중)를 글이나 간단한 그림으로, 화면이 없는 변경은 바뀐 뒤의 사용 예로 씁니다. 프로젝트의 디자인 규칙을 따르고 파일은 고치지 않습니다.',
      acceptance: ['계획에서 바뀌는 화면·동작마다 시안이 있다', '빈 화면·오류 같은 상태가 빠지지 않았다'] }),
    stage(p, 'review', { title: text('교차 검토', 'Cross review'), operation: 'agent', role: 'review', permissionPreset: 'plan', session: 'fresh',
      instructions: '계획과 시안을 새 눈으로 검토합니다. 요구와 어긋나는 곳, 빠진 경우, 위험한 변경을 근거(파일·줄 또는 요구 항목)와 함께 찾고, 고칠 것과 괜찮은 것을 나눠 씁니다. 파일은 고치지 않습니다.',
      acceptance: ['찾은 문제마다 근거가 있다', '요구 항목마다 계획·시안이 다루는지 확인했다'] }),
    stage(p, 'approval', { title: text('시안 승인', 'Mockup approval'), operation: 'approval', role: 'review',
      instructions: '검토를 거친 계획과 시안으로 구현해도 되는지 정합니다. 되돌리면 남긴 의견과 함께 계획부터 다시 합니다.' }),
    stage(p, 'implement', { title: text('구현', 'Implementation'), operation: 'agent', role: 'implementation', permissionPreset: 'standard', allowedPaths: ['src/**', 'test/**'],
      checks: [{ id: 'test', command: 'pnpm test' }],
      instructions: '승인된 계획과 시안대로 구현합니다. 바꿀 수 있는 경로 안에서만 고치고, 바꾼 동작을 확인하는 테스트를 더하거나 고칩니다. 계획과 다르게 해야 했다면 이유를 남깁니다.',
      acceptance: ['승인된 계획의 작업이 모두 반영되어 있다', '바꾼 동작을 확인하는 테스트가 있다', '계획과 달라진 점이 있으면 이유가 적혀 있다'] }),
    stage(p, 'done', { title: text('완료', 'Complete'), operation: 'complete', role: 'integration' }),
  ], [
    ['req', 'answer', 'next'], ['answer', 'plan', 'next'], ['plan', 'design', 'next'], ['design', 'review', 'next'], ['review', 'approval', 'next'],
    ['approval', 'implement', 'approved'], ['approval', 'plan', 'rejected', 2], ['implement', 'done', 'next'],
  ]);
}

/** 정기 점검: commands check dependencies and tests, an AI summarizes, a person looks. */
function routineCheckGraph(text: Text): WorkflowGraph {
  const p = `${BUILTIN_PREFIX}check`;
  return builtinGraph(p, [
    stage(p, 'run', { title: text('의존성·테스트 확인', 'Dependencies and tests'), operation: 'agent', role: 'review', permissionPreset: 'plan', review: { mode: 'off' },
      checks: [{ id: 'audit', command: 'pnpm audit' }, { id: 'test', command: 'pnpm test' }],
      instructions: '확인 명령(pnpm audit, pnpm test)은 이 PC가 실행하고 종료 코드로 판정합니다. 이 단계에서는 package.json과 잠금 파일, 최근 변경을 읽고 의존성 경고나 깨질 만한 테스트가 있으면 근거와 함께 정리합니다. 파일은 고치지 않습니다.',
      acceptance: ['의존성과 테스트 상태가 근거(파일·패키지 이름)와 함께 정리되어 있다', '파일을 고치지 않았다'] }),
    stage(p, 'summary', { title: text('바뀐 점 요약', 'Summary of changes'), operation: 'agent', role: 'planning', permissionPreset: 'plan',
      instructions: '확인 단계의 결과에서 눈여겨볼 점만 다섯 줄 안으로 요약합니다. 실패하거나 새로 경고가 난 항목, 그 원인으로 보이는 변경, 바로 할 일을 나눠 씁니다. 파일은 고치지 않습니다.',
      acceptance: ['다섯 줄 안으로 요약했다', '실패나 경고가 있으면 항목마다 할 일을, 없으면 없다고 적었다'] }),
    stage(p, 'look', { title: text('결과 확인', 'Review findings'), operation: 'approval', role: 'review', instructions: '요약을 보고 할 일을 정합니다.' }),
    stage(p, 'done', { title: text('완료', 'Complete'), operation: 'complete', role: 'integration' }),
  ], [['run', 'summary', 'next'], ['summary', 'look', 'next'], ['look', 'done', 'approved']]);
}

/** The two built-in templates, listed before the saved ones. Titles follow the UI language; instructions are Korean. */
export function builtinWorkflowTemplates(text: Text = korean): readonly WorkflowTemplateInput[] {
  return [
    { id: `${BUILTIN_PREFIX}dev`, title: text('개발 절차', 'Development process'), graph: developmentGraph(text),
      description: text('요구를 정리해 내 답을 받고, 계획·시안을 교차 검토한 뒤 승인되면 구현하고 테스트로 확인합니다.', 'Clarify the requirements with your answer, cross-review the plan and mockup, then implement once approved and check with the tests.') },
    { id: `${BUILTIN_PREFIX}check`, title: text('정기 점검', 'Routine check'), graph: routineCheckGraph(text),
      description: text('의존성 점검과 테스트를 명령으로 확인하고, AI가 눈여겨볼 점을 요약하면 사람이 결과를 확인합니다.', 'Commands check dependencies and tests, an AI summarizes what to look at, and a person reviews the result.') },
  ];
}

/**
 * A template's graph for a new workflow: every stage and connection id takes the workflow's prefix (as the
 * presets' `createWorkflowGraph(preset, prefix)` does), keeping the part after the last ':' and every reference.
 */
export function instantiateWorkflowTemplate(graph: WorkflowGraph, prefix: string): WorkflowGraph {
  const rekey = (ids: readonly string[]): Map<string, string> => {
    const map = new Map<string, string>(); const used = new Set<string>();
    for (const old of ids) {
      const base = old.slice(old.lastIndexOf(':') + 1).slice(0, 100) || 'stage';
      let key = base;
      for (let n = 2; used.has(key); n += 1) key = `${base}-${n}`;
      used.add(key); map.set(old, `${prefix}:${key}`);
    }
    return map;
  };
  const nodeIds = rekey(graph.nodes.map(node => node.id));
  const edgeIds = rekey(graph.edges.map(edge => edge.id));
  const node = (id: string) => nodeIds.get(id) ?? id;
  return {
    entryNodeId: graph.entryNodeId ? node(graph.entryNodeId) : null,
    nodes: graph.nodes.map(entry => ({
      ...entry, id: node(entry.id), inputs: entry.inputs.map(input => ({ ...input, nodeId: node(input.nodeId) })),
      ...(entry.condition ? { condition: { ...entry.condition, sourceNodeId: node(entry.condition.sourceNodeId) } } : {}),
      ...(entry.answer ? { answer: { ...entry.answer, ...(entry.answer.showResultOf ? { showResultOf: node(entry.answer.showResultOf) } : {}) } } : {}),
    })),
    edges: graph.edges.map(edge => ({ ...edge, id: edgeIds.get(edge.id) ?? edge.id, from: node(edge.from), to: node(edge.to) })),
  };
}

/**
 * What 템플릿으로 저장 keeps of a workflow: stages, instructions, acceptance, checks and answer prompts; not the
 * stage documents. Without `keepAgents` the placed agents go (a stage's own reviewer agent too, back to the run's
 * reviewer); each stage keeps its provider, model, effort and permission.
 */
export function workflowTemplateGraph(graph: WorkflowGraph, keepAgents: boolean): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(({ agent, review, ...node }) => ({
      ...node, document: '',
      ...(keepAgents && agent ? { agent } : {}),
      ...(review && (keepAgents || review.mode !== 'agent') ? { review } : {}),
    })),
  };
}
