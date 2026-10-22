import type { ExecutionRun, ExecutionTask } from '../../shared/planning-execution';
import { workflowOutcomePorts, type WorkflowActivation, type WorkflowEdge, type WorkflowGraph } from '../../shared/workflow-graph';
import type { WorkflowCopy } from './workflow-copy';

/** What a stage looks like in one run. Derived only from what the runtime already recorded. */
export type WorkflowNodeRunStatus =
  | 'pending' | 'not-reached' | 'waiting' | 'queued' | 'working' | 'reviewing' | 'reconciling' | 'paused'
  | 'needs-attention' | 'awaiting-approval' | 'completed' | 'rejected' | 'retry-exhausted' | 'cancelled';

export interface WorkflowNodeRunView {
  readonly status: WorkflowNodeRunStatus;
  readonly outcome?: WorkflowActivation['outcome'];
  /** Zero-based round of the latest activation; loops raise it. */
  readonly iteration: number;
  readonly activationId?: string;
  readonly attemptId?: string;
  readonly arrivals?: { readonly arrived: number; readonly expected: number };
}
export interface WorkflowEdgeRunView { readonly taken: number; readonly retryLimit?: number }
export interface WorkflowRunOverlay {
  readonly nodes: Readonly<Record<string, WorkflowNodeRunView>>;
  readonly edges: Readonly<Record<string, WorkflowEdgeRunView>>;
  readonly awaitingApproval: readonly { readonly nodeId: string; readonly activationId: string }[];
  /** A completed or cancelled run: stages without an activation were never reached. */
  readonly ended: boolean;
}

function activeTaskStatus(task: ExecutionTask | undefined, runPaused: boolean): WorkflowNodeRunStatus {
  switch (task?.state) {
    case 'waiting': case 'ready': return runPaused ? 'paused' : 'queued';
    case 'awaiting-review': return 'reviewing';
    case 'reconciling': case 'completed': return 'reconciling';
    case 'paused': return 'paused';
    case 'failed': case 'stale': return 'needs-attention';
    case 'cancelled': return 'cancelled';
    default: return 'working';
  }
}

/**
 * Projects a run onto its frozen graph. Precedence: a cancelled run stops every unfinished
 * stage; an active AI stage is refined by its task; otherwise the latest activation decides.
 * `completed` keeps its outcome because routed failures and rejections also complete.
 */
export function projectRunOverlay(run: ExecutionRun): WorkflowRunOverlay | null {
  const graph = run.preparation.workflow?.graph;
  if (!graph) return null;
  const runtime = run.workflowRuntime;
  const cancelled = run.state === 'cancelled';
  const ended = cancelled || run.state === 'completed';
  const nodes: Record<string, WorkflowNodeRunView> = {};
  const awaitingApproval: { nodeId: string; activationId: string }[] = [];
  for (const node of graph.nodes) {
    const latest = (runtime?.activations ?? []).filter(entry => entry.nodeId === node.id).reduce<WorkflowActivation | undefined>((best, entry) => !best || entry.iteration > best.iteration ? entry : best, undefined);
    if (!latest) { nodes[node.id] = { status: ended ? 'not-reached' : 'pending', iteration: 0 }; continue; }
    const finished = latest.state === 'completed' || latest.state === 'rejected' || latest.state === 'retry-exhausted';
    let status: WorkflowNodeRunStatus;
    if (finished) status = latest.state as WorkflowNodeRunStatus;
    else if (cancelled) status = 'cancelled';
    else if (latest.state === 'awaiting-approval') status = 'awaiting-approval';
    else if (latest.state === 'waiting') status = 'waiting';
    else status = node.operation === 'agent' ? activeTaskStatus(run.tasks.find(task => task.taskId === node.id), run.state === 'paused') : 'working';
    if (status === 'awaiting-approval') awaitingApproval.push({ nodeId: node.id, activationId: latest.id });
    const expected = node.operation === 'join' ? graph.edges.filter(edge => edge.to === node.id && !edge.retryLimit).length : 0;
    nodes[node.id] = {
      status, iteration: latest.iteration, activationId: latest.id,
      ...(latest.outcome ? { outcome: latest.outcome } : {}),
      ...(latest.attemptId ? { attemptId: latest.attemptId } : {}),
      ...(node.operation === 'join' ? { arrivals: { arrived: latest.incomingEdgeIds.filter(edgeId => graph.edges.some(edge => edge.id === edgeId && !edge.retryLimit)).length, expected } } : {}),
    };
  }
  const edges: Record<string, WorkflowEdgeRunView> = {};
  for (const edge of graph.edges) edges[edge.id] = { taken: runtime?.edgeCounts[edge.id] ?? 0, ...(edge.retryLimit ? { retryLimit: edge.retryLimit } : {}) };
  return { nodes, edges, awaitingApproval, ended };
}

/**
 * Outcome names live on the source port, so a connection only carries what the port cannot say:
 * its retry bound while editing, the rounds used while running, or repeat traversals.
 */
export function workflowEdgeBadge(edge: WorkflowEdge, run: WorkflowEdgeRunView | undefined, text: WorkflowCopy): string | null {
  if (edge.retryLimit) return run ? text(`재시도 ${run.taken}/${edge.retryLimit}`, `Retry ${run.taken}/${edge.retryLimit}`) : text(`재시도 최대 ${edge.retryLimit}회`, `Retry up to ${edge.retryLimit}×`);
  return run && run.taken > 1 ? `×${run.taken}` : null;
}

export interface WorkflowPoint { readonly x: number; readonly y: number }
export interface WorkflowEdgePath { readonly d: string; readonly labelX: number; readonly labelY: number; readonly backward: boolean }
/** Clearance below the lower port for a connection that returns to an earlier stage. */
export const WORKFLOW_BACKWARD_DROP = 96;

function cubic(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}
/**
 * One path shape for both renderers. Forward connections curve between the ports; a connection
 * whose target sits left of its source loops underneath, where its label has room.
 */
export function workflowEdgePath(source: WorkflowPoint, target: WorkflowPoint): WorkflowEdgePath {
  const backward = target.x < source.x + 24;
  if (!backward) {
    const bend = Math.max(40, (target.x - source.x) / 2);
    const c1 = { x: source.x + bend, y: source.y }; const c2 = { x: target.x - bend, y: target.y };
    return { d: `M ${source.x} ${source.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${target.x} ${target.y}`, labelX: cubic(source.x, c1.x, c2.x, target.x, 0.5), labelY: cubic(source.y, c1.y, c2.y, target.y, 0.5), backward };
  }
  const low = Math.max(source.y, target.y) + WORKFLOW_BACKWARD_DROP;
  const out = 48;
  const midX = (source.x + out + target.x - out) / 2;
  const d = `M ${source.x} ${source.y} C ${source.x + out} ${source.y}, ${source.x + out} ${low}, ${source.x} ${low} L ${target.x} ${low} C ${target.x - out} ${low}, ${target.x - out} ${target.y}, ${target.x} ${target.y}`;
  return { d, labelX: midX, labelY: low, backward };
}

export interface WorkflowNodeSize { readonly width: number; readonly height: number }
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

function reaches(graph: WorkflowGraph, from: string, to: string): boolean {
  const seen = new Set<string>(); const pending = [from];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === to) return true;
    if (seen.has(current)) continue; seen.add(current);
    for (const edge of graph.edges) if (edge.from === current && !edge.retryLimit) pending.push(edge.to);
  }
  return false;
}
/** Blocks only what can never be valid; anything else is drawn and left to the validator. */
export function canConnectWorkflow(graph: WorkflowGraph, from: string, outcome: WorkflowEdge['outcome'], to: string): boolean {
  const source = graph.nodes.find(node => node.id === from);
  if (!source || !graph.nodes.some(node => node.id === to)) return false;
  if (!workflowOutcomePorts(source.operation).includes(outcome)) return false;
  if (from === to && outcome !== 'failed' && outcome !== 'rejected') return false;
  return !graph.edges.some(edge => edge.from === from && edge.to === to && edge.outcome === outcome);
}
/** A failure or rejection that returns upstream becomes a bounded retry (default 2 rounds). */
export function connectWorkflowEdge(graph: WorkflowGraph, from: string, outcome: WorkflowEdge['outcome'], to: string, id: string): WorkflowGraph {
  const loops = (outcome === 'failed' || outcome === 'rejected') && (from === to || reaches(graph, to, from));
  const edge: WorkflowEdge = { id, from, to, outcome, ...(loops ? { retryLimit: 2 } : {}) };
  return { ...graph, edges: [...graph.edges, edge] };
}
