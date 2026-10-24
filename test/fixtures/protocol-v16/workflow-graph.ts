// FROZEN COPY of src/shared/workflow-graph.ts at ed32a40 (remote protocol v16). Do not edit:
// tests use it to prove what an already-installed v16 reader accepts.
import { z } from 'zod';

export const WorkflowIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const id = WorkflowIdSchema;
export const WorkflowNodeSchema = z.object({
  id, title: z.string().trim().min(1).max(300),
  operation: z.enum(['agent', 'condition', 'parallel', 'join', 'approval', 'complete']),
  role: z.enum(['planning', 'design', 'implementation', 'review', 'integration']).default('implementation'),
  instructions: z.string().max(65_536).default(''), document: z.string().max(200_000).default(''),
  providerId: id.optional(), model: z.string().max(256).optional(),
  permissionPreset: z.enum(['plan', 'standard', 'full-access']).default('plan'),
  acceptance: z.array(z.string().min(1).max(4_000)).max(200).default([]),
  allowedPaths: z.array(z.string().min(1).max(1_024)).max(200).default([]),
  retryLimit: z.number().int().min(0).max(20).default(2),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict().default({ x: 0, y: 0 }),
  condition: z.object({ sourceNodeId: id, field: z.literal('outcome'), equals: z.enum(['passed', 'failed']) }).strict().optional(),
  joinPolicy: z.enum(['all', 'any']).optional(),
  inputs: z.array(z.object({ nodeId: id, kind: z.enum(['document', 'result']) }).strict()).max(100).default([]),
}).strict();
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;
export const WorkflowEdgeSchema = z.object({
  id, from: id, to: id, outcome: z.enum(['next', 'passed', 'failed', 'approved', 'rejected']).default('next'),
  retryLimit: z.number().int().min(1).max(20).optional(),
}).strict();
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;
export const WorkflowGraphSchema = z.object({
  entryNodeId: id.nullable(), nodes: z.array(WorkflowNodeSchema).max(128), edges: z.array(WorkflowEdgeSchema).max(512),
}).strict();
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
export interface WorkflowIssue { readonly code: string; readonly message: string; readonly nodeId?: string; readonly edgeId?: string }

/** The outcomes a stage of this kind can route along; a completion stage routes nowhere. */
export function workflowOutcomePorts(operation: WorkflowNode['operation']): readonly WorkflowEdge['outcome'][] {
  switch (operation) {
    case 'agent': return ['next', 'passed', 'failed'];
    case 'condition': return ['passed', 'failed'];
    case 'approval': return ['approved', 'rejected'];
    case 'complete': return [];
    default: return ['next'];
  }
}

/** Invalid drafts remain editable. Only execution preparation requires a runnable graph. */
export function validateWorkflowGraph(graph: WorkflowGraph, execution = false): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const add = (code: string, message: string, nodeId?: string, edgeId?: string) => issues.push({ code, message, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) });
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) add('duplicate-node', 'A stage ID is repeated.', node.id);
    seen.add(node.id);
    if (node.operation === 'condition' && (!node.condition || nodes.get(node.condition.sourceNodeId)?.operation !== 'agent')) add('condition-source', 'Select an AI stage whose verified result controls this condition.', node.id);
    if (node.operation === 'join' && !node.joinPolicy) add('join-policy', 'Choose how incoming branches join.', node.id);
    for (const input of node.inputs) if (!nodes.has(input.nodeId) || input.nodeId === node.id) add('missing-input', 'A referenced input stage is missing or refers to itself.', node.id);
    if (execution && node.operation === 'agent') {
      if (!node.instructions.trim() || !node.acceptance.length) add('incomplete-task', 'An AI stage needs instructions and completion criteria.', node.id);
      if (!node.providerId || !node.model) add('missing-provider', 'Choose an available provider and model for this stage.', node.id);
      if (node.permissionPreset === 'full-access') add('permission', 'Managed workflow execution requires bounded worktree permissions.', node.id);
      if (node.permissionPreset !== 'plan' && !node.allowedPaths.length) add('missing-scope', 'A writing stage needs explicit allowed paths.', node.id);
    }
  }
  seen.clear();
  for (const edge of graph.edges) {
    if (seen.has(edge.id)) add('duplicate-edge', 'A connection ID is repeated.', undefined, edge.id);
    seen.add(edge.id);
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) add('missing-node', 'A connection points to a missing stage.', undefined, edge.id);
    const source = nodes.get(edge.from);
    // A missing source reports 'missing-node' and a completion source 'complete-output'; neither adds a port error.
    const ports: readonly string[] = source && source.operation !== 'complete' ? workflowOutcomePorts(source.operation) : ['next'];
    if (!ports.includes(edge.outcome)) add('invalid-port', 'This outcome port is unavailable on the source stage.', edge.from, edge.id);
    if (edge.retryLimit && !['failed', 'rejected'].includes(edge.outcome)) add('retry-port', 'A bounded retry must follow an explicit failure or rejection.', edge.from, edge.id);
  }
  if (!graph.entryNodeId || !nodes.has(graph.entryNodeId)) add('missing-entry', 'Choose an existing starting stage.');
  const reach = (start: string, reverse = false, omitRetries = false) => {
    const reached = new Set<string>(); const pending = [start];
    while (pending.length) { const current = pending.pop()!; if (reached.has(current)) continue; reached.add(current);
      for (const edge of graph.edges) if ((!omitRetries || !edge.retryLimit) && (reverse ? edge.to : edge.from) === current) pending.push(reverse ? edge.from : edge.to);
    } return reached;
  };
  const reachable = graph.entryNodeId ? reach(graph.entryNodeId) : new Set<string>();
  const terminating = new Set(graph.nodes.filter(node => node.operation === 'complete').flatMap(node => [...reach(node.id, true)]));
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) add('unreachable', 'This stage cannot be reached from the start.', node.id);
    if (!terminating.has(node.id)) add('no-completion', 'This stage has no path to completion.', node.id);
    const outgoing = graph.edges.filter(edge => edge.from === node.id);
    const incoming = graph.edges.filter(edge => edge.to === node.id && !edge.retryLimit);
    if (node.operation === 'complete' && outgoing.length) add('complete-output', 'A completion stage cannot have outgoing connections.', node.id);
    if (node.operation === 'condition' && !['passed', 'failed'].every(port => outgoing.filter(edge => edge.outcome === port).length === 1)) add('condition-ports', 'A condition needs exactly one passed and one failed connection.', node.id);
    if (node.operation === 'approval' && outgoing.filter(edge => edge.outcome === 'approved').length !== 1) add('approval-port', 'An approval needs one approved connection.', node.id);
    if (node.operation === 'parallel' && outgoing.length < 2) add('parallel-branches', 'A parallel start needs at least two branches.', node.id);
    if (!['parallel', 'condition', 'approval'].includes(node.operation) && new Set(outgoing.map(edge => edge.outcome)).size !== outgoing.length) add('ambiguous-output', 'Use a parallel start to fan out to multiple stages.', node.id);
    if (new Set(incoming.map(edge => edge.from)).size > 1 && node.operation !== 'join') add('ambiguous-join', 'Multiple incoming branches require an explicit join stage.', node.id);
    if (node.condition && !reach(node.id, true, true).has(node.condition.sourceNodeId)) add('condition-order', 'The condition source must be an upstream stage.', node.id);
    for (const input of node.inputs.filter(entry => entry.kind === 'result')) if (!reach(node.id, true, true).has(input.nodeId) || nodes.get(input.nodeId)?.operation !== 'agent') add('result-order', 'A result input must reference an upstream AI stage.', node.id);
  }
  for (const edge of graph.edges.filter(entry => entry.retryLimit)) {
    const downstream = reach(edge.to, false, true); const upstream = reach(edge.from, true, true);
    const cycleNodes = graph.nodes.filter(node => downstream.has(node.id) && upstream.has(node.id));
    if (!downstream.has(edge.from)) add('retry-target', 'A retry must return to a stage before its failure decision.', edge.from, edge.id);
    for (const node of cycleNodes) {
      if (node.condition && !cycleNodes.some(source => source.id === node.condition!.sourceNodeId)) add('retry-condition', 'The retry must rerun the source of every condition in its loop.', node.id, edge.id);
      if (node.operation === 'join') {
        const branches = graph.edges.filter(input => input.to === node.id && !input.retryLimit);
        if (branches.some(input => !cycleNodes.some(source => source.id === input.from))) add('retry-join', 'Retry from the parallel start so every join input belongs to the same iteration.', node.id, edge.id);
      }
    }
  }
  // Every cycle must cross a bounded, explicit failure edge.
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) { add('unbounded-cycle', 'The flow contains an unbounded cycle.', nodeId); return; }
    if (visited.has(nodeId)) return; visiting.add(nodeId);
    for (const edge of graph.edges.filter(entry => entry.from === nodeId && !entry.retryLimit)) visit(edge.to);
    visiting.delete(nodeId); visited.add(nodeId);
  };
  graph.nodes.forEach(node => visit(node.id));
  return issues;
}

/** One stage card in scale-free graph units (renderers multiply by the UI scale). */
export const WORKFLOW_LAYOUT_CARD = { width: 248, height: 136 } as const;
interface WorkflowNodeSize { readonly width: number; readonly height: number }
const LAYOUT_GAP = { x: 96, y: 48 } as const;
const LAYOUT_ORIGIN = 40;
/**
 * Layered layout from the entry: a stage sits one column after its furthest predecessor
 * (retry edges excluded, so loops do not stretch the flow). Unreachable stages get a last
 * column. Only positions change; coordinates never imply execution order.
 */
export function layoutWorkflowGraph(graph: WorkflowGraph, size: WorkflowNodeSize): WorkflowGraph {
  const forward = graph.edges.filter(edge => !edge.retryLimit && edge.from !== edge.to);
  const column = new Map<string, number>();
  if (graph.entryNodeId && graph.nodes.some(node => node.id === graph.entryNodeId)) {
    column.set(graph.entryNodeId, 0);
    // Longest path on the acyclic forward edges; the bound stops any unbounded cycle a draft may hold.
    for (let round = 0, changed = true; changed && round < graph.nodes.length; round += 1) {
      changed = false;
      for (const edge of forward) {
        const from = column.get(edge.from);
        if (from === undefined) continue;
        if ((column.get(edge.to) ?? -1) < from + 1) { column.set(edge.to, from + 1); changed = true; }
      }
    }
  }
  const lastColumn = column.size ? Math.max(...column.values()) + 1 : 0;
  const rows = new Map<number, number>();
  const nodes = graph.nodes.map(node => {
    const x = column.get(node.id) ?? lastColumn;
    const y = rows.get(x) ?? 0; rows.set(x, y + 1);
    return { ...node, position: { x: LAYOUT_ORIGIN + x * (size.width + LAYOUT_GAP.x), y: LAYOUT_ORIGIN + y * (size.height + LAYOUT_GAP.y) } };
  });
  return { ...graph, nodes };
}


export const WORKFLOW_PRESETS = [
  { id: 'feature', title: '기능 개발' }, { id: 'fix', title: '문제 수정' },
  { id: 'research', title: '조사' }, { id: 'parallel', title: '병렬 구현' }, { id: 'custom', title: '직접 구성' },
] as const;
export type WorkflowPresetId = typeof WORKFLOW_PRESETS[number]['id'];
export function createWorkflowGraph(preset: WorkflowPresetId, prefix: string): WorkflowGraph {
  const node = (key: string, title: string, operation: WorkflowNode['operation'], role: WorkflowNode['role'], index: number) => WorkflowNodeSchema.parse({
    id: `${prefix}:${key}`, title, operation, role, instructions: '', position: { x: 80 + index * 240, y: 80 },
    ...(operation === 'join' ? { joinPolicy: 'all' } : {}),
  });
  if (preset === 'custom') return { entryNodeId: null, nodes: [], edges: [] };
  const specs: Array<readonly [string, string, WorkflowNode['operation'], WorkflowNode['role']]> = preset === 'research'
    ? [['research', '조사', 'agent', 'planning'], ['approval', '결과 확인', 'approval', 'review'], ['done', '완료', 'complete', 'integration']]
    : preset === 'parallel'
      ? [['plan', '기획', 'agent', 'planning'], ['fork', '병렬 시작', 'parallel', 'implementation'], ['ui', '화면 구현', 'agent', 'implementation'], ['api', 'API 구현', 'agent', 'implementation'], ['join', '결과 합류', 'join', 'review'], ['approval', '승인', 'approval', 'review'], ['done', '완료', 'complete', 'integration']]
      : [['plan', preset === 'fix' ? '문제 분석' : '기획', 'agent', 'planning'], ...(preset === 'feature' ? [['design', '디자인', 'agent', 'design'] as const] : []), ['implement', '구현', 'agent', 'implementation'], ['review', '검토', 'agent', 'review'], ['condition', '검토 결과', 'condition', 'review'], ['approval', '승인', 'approval', 'review'], ['done', '완료', 'complete', 'integration']];
  const nodes = specs.map((spec, index) => node(...spec, index));
  const condition = nodes.find(entry => entry.operation === 'condition');
  if (condition) condition.condition = { sourceNodeId: `${prefix}:review`, field: 'outcome', equals: 'passed' };
  const edges: WorkflowEdge[] = [];
  const connect = (from: string, to: string) => edges.push({ id: `${prefix}:edge:${edges.length + 1}`, from: `${prefix}:${from}`, to: `${prefix}:${to}`, outcome: nodes.find(entry => entry.id === `${prefix}:${from}`)?.operation === 'approval' ? 'approved' : 'next' });
  if (preset === 'parallel') [['plan', 'fork'], ['fork', 'ui'], ['fork', 'api'], ['ui', 'join'], ['api', 'join'], ['join', 'approval'], ['approval', 'done']].forEach(([from, to]) => connect(from, to));
  else specs.slice(1).forEach((spec, index) => connect(specs[index][0], spec[0]));
  if (condition) {
    edges.find(edge => edge.from === condition.id)!.outcome = 'passed';
    edges.push({ id: `${prefix}:retry`, from: condition.id, to: `${prefix}:implement`, outcome: 'failed', retryLimit: 2 });
  }
  // Presets start tidy at the canvas card size, so a new subproject never opens with overlapping stages.
  return layoutWorkflowGraph({ entryNodeId: nodes[0].id, nodes, edges }, WORKFLOW_LAYOUT_CARD);
}

export const WorkflowFrozenSchema = z.object({
  subprojectId: id, revision: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), graph: WorkflowGraphSchema,
}).strict();
export type WorkflowFrozen = z.infer<typeof WorkflowFrozenSchema>;
export const WorkflowActivationSchema = z.object({
  id, nodeId: id, iteration: z.number().int().nonnegative(), state: z.enum(['waiting', 'active', 'awaiting-approval', 'completed', 'rejected', 'retry-exhausted']),
  incomingEdgeIds: z.array(id), outcome: z.enum(['passed', 'failed', 'approved', 'rejected', 'next']).optional(),
  inputResults: z.record(id, z.object({ attemptId: id, outcome: z.enum(['passed', 'failed']) }).strict()).default({}),
  attemptId: id.optional(), resolvedBy: id.optional(), resolvedAt: z.string().optional(),
}).strict();
export type WorkflowActivation = z.infer<typeof WorkflowActivationSchema>;
export const WorkflowRuntimeSchema = z.object({
  activations: z.array(WorkflowActivationSchema), edgeCounts: z.record(id, z.number().int().nonnegative()), completed: z.boolean(),
}).strict();
export type WorkflowRuntime = z.infer<typeof WorkflowRuntimeSchema>;
