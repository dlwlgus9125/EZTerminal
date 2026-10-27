import type { PlanningRunRequest, PlanningRunResult } from '../../shared/planning-run';

/** The host's execution records of a flow, as the flow screen needs them beyond the workflow commands. */
export interface WorkflowExecutionAccess {
  getPlanningExecutionSnapshot(projectId: string, subprojectId?: string): Promise<PlanningRunResult>;
  executePlanningRun(command: PlanningRunRequest): Promise<PlanningRunResult>;
}

/**
 * 독립 검토 다시 요청: asks the host to run the independent review of an attempt again (a reviewer that
 * failed is never retried on its own). One command id per review generation, so a resend after a lost
 * answer is the same request. A revision that moved meanwhile is read again once and sent with the same id.
 */
export async function retryIndependentReview(access: WorkflowExecutionAccess, target: {
  readonly projectId: string;
  readonly subprojectId: string;
  readonly runId: string;
  readonly attemptId: string;
  /** How many reviews the attempt already had (its next one is retried). */
  readonly reviewGeneration: number;
}): Promise<PlanningRunResult> {
  const commandId = `retry-review:${target.attemptId}:${target.reviewGeneration + 1}`;
  const send = async (): Promise<PlanningRunResult> => {
    const current = await access.getPlanningExecutionSnapshot(target.projectId, target.subprojectId);
    if (!current.ok) return current;
    return access.executePlanningRun({
      commandId,
      projectId: target.projectId,
      subprojectId: target.subprojectId,
      expectedRevision: current.snapshot.revision,
      type: 'retry-review',
      payload: { runId: target.runId, attemptId: target.attemptId },
    });
  };
  const first = await send();
  return !first.ok && first.error === 'revision-conflict' ? send() : first;
}
