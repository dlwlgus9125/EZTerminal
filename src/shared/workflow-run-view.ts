import { runSubprojectId, runUnfinished, stageStructureChanged, type ExecutionRun } from './planning-execution';
import type { WorkflowGraph } from './workflow-graph';

/**
 * What the flow screens (desktop, phone and the board) read from a flow's runs. One definition each,
 * so the run a board card shows is the run the flow screen opens, with the same number.
 */

/** A flow's runs in the order they were prepared. */
export function flowRuns<T extends ExecutionRun>(runs: readonly T[], subprojectId: string): T[] {
  return runs.filter((run) => runSubprojectId(run) === subprojectId && run.preparation.workflow)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId));
}

/** The run a flow shows: the one still going, else the most recent. */
export function currentFlowRun<T extends ExecutionRun>(runs: readonly T[], subprojectId: string): T | undefined {
  const own = flowRuns(runs, subprojectId);
  return own.filter(runUnfinished).at(-1) ?? own.at(-1);
}

/** 실행 #n: every run of the flow is numbered in the order it was prepared, and keeps its number. */
export function flowRunNumber(runs: readonly ExecutionRun[], run: ExecutionRun): number {
  const own = flowRuns(runs, runSubprojectId(run) ?? '');
  const index = own.findIndex((entry) => entry.runId === run.runId);
  return index < 0 ? own.length + 1 : index + 1;
}

/** One stage's conversations in one run: its latest attempt (working or done) and that attempt's latest review. */
export interface StageConversation {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly working: boolean;
  readonly reviewSessionId?: string;
}

export function runStageConversation(run: ExecutionRun | undefined, nodeId: string): StageConversation | undefined {
  const attempt = run?.attempts.filter((entry) => entry.taskId === nodeId).sort((left, right) => left.number - right.number).at(-1);
  if (!run || !attempt) return undefined;
  const review = run.reviews.filter((entry) => entry.attemptId === attempt.attemptId).at(-1);
  return { sessionId: attempt.sessionId, attemptId: attempt.attemptId, working: attempt.state === 'running' || attempt.state === 'delivery-uncertain',
    ...(review ? { reviewSessionId: review.reviewerSessionId } : {}) };
}

/**
 * The same flow as far as a run is concerned: the same stages, kinds, connections and starting stage.
 * A stage's own settings may differ (they apply to stages not sent yet, or from the next run).
 */
export function sameWorkflowStructure(left: WorkflowGraph, right: WorkflowGraph): boolean {
  if (left.entryNodeId !== right.entryNodeId || left.nodes.length !== right.nodes.length || left.edges.length !== right.edges.length) return false;
  const edge = (entry: WorkflowGraph['edges'][number]) => JSON.stringify([entry.id, entry.from, entry.to, entry.outcome, entry.retryLimit ?? null]);
  const edges = new Set(left.edges.map(edge));
  if (!right.edges.every((entry) => edges.has(edge(entry)))) return false;
  return left.nodes.every((node) => {
    const other = right.nodes.find((entry) => entry.id === node.id);
    return Boolean(other) && !stageStructureChanged(node, other!);
  });
}
