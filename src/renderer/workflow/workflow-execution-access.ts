import type { PlanningRunRequest, PlanningRunResult } from '../../shared/planning-run';

/** The host's execution records of a flow, as the flow screen needs them beyond the workflow commands. */
export interface WorkflowExecutionAccess {
  getPlanningExecutionSnapshot(projectId: string, subprojectId?: string): Promise<PlanningRunResult>;
  executePlanningRun(command: PlanningRunRequest): Promise<PlanningRunResult>;
}

type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const RETRY_KEY = 'ezterminal-review-retry-v1';

function remembered(storage: RetryStorage | undefined, key: string, commandId: string): PlanningRunRequest | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const request = JSON.parse(raw) as PlanningRunRequest;
    return request && request.commandId === commandId && request.type === 'retry-review' ? request : null;
  } catch { return null; }
}

/**
 * 독립 검토 다시 요청: asks the host to run the independent review of an attempt again (a reviewer that
 * failed is never retried on its own). One command id per review generation. The host keeps the retry it
 * accepted under that id and its exact contents (revision included) and finishes it when the same request
 * comes again, even after the run moved on. So the request is remembered on this device until an answer
 * settles it and sent again unchanged; only an explicit revision-conflict (nothing was recorded) makes a
 * new one at the current revision. Any other conflict is shown as it is.
 */
export async function retryIndependentReview(access: WorkflowExecutionAccess, target: {
  readonly projectId: string;
  readonly subprojectId: string;
  readonly runId: string;
  readonly attemptId: string;
  /** How many reviews the attempt already had (its next one is retried). */
  readonly reviewGeneration: number;
}, storage: RetryStorage | undefined = globalThis.localStorage): Promise<PlanningRunResult> {
  const commandId = `retry-review:${target.attemptId}:${target.reviewGeneration + 1}`;
  const key = `${RETRY_KEY}:${target.projectId}:${commandId}`;
  const fresh = async (): Promise<PlanningRunRequest | PlanningRunResult> => {
    const current = await access.getPlanningExecutionSnapshot(target.projectId, target.subprojectId);
    if (!current.ok) return current;
    return {
      commandId,
      projectId: target.projectId,
      subprojectId: target.subprojectId,
      expectedRevision: current.snapshot.revision,
      type: 'retry-review',
      payload: { runId: target.runId, attemptId: target.attemptId },
    };
  };
  const send = async (request: PlanningRunRequest): Promise<PlanningRunResult> => {
    try { storage?.setItem(key, JSON.stringify(request)); } catch { /* Remembering is best effort. */ }
    return access.executePlanningRun(request);
  };
  let request = remembered(storage, key, commandId) ?? await fresh();
  if ('ok' in request) return request;
  let answer = await send(request);
  if (!answer.ok && answer.error === 'revision-conflict') {
    request = await fresh();
    if ('ok' in request) return request;
    answer = await send(request);
  }
  // An answer settles the request; without one (unavailable) it is sent again unchanged next time.
  if (answer.ok || answer.error !== 'unavailable') {
    try { storage?.removeItem(key); } catch { /* Best effort. */ }
  }
  return answer;
}
