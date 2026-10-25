import { runSubprojectId, type ExecutionRun } from '../shared/planning-execution';
import { flowRuns } from '../shared/workflow-run-view';

/** Each flow keeps the work folders of its newest runs (by 실행 #n); older finished ones may be cleaned up. */
export const RETENTION_KEEP_RUNS = 3;

export interface RetentionCandidate {
  readonly runId: string;
  readonly subprojectId: string;
  /** `older`: past the newest RETENTION_KEEP_RUNS; `launch-leftover`: a run a refused launch prepared and cancelled. */
  readonly why: 'older' | 'launch-leftover';
}

/**
 * The finished runs whose work folders a person may clean up, per flow: every finished run but the newest
 * RETENTION_KEEP_RUNS finished ones in 실행 #n order, and runs a refused launch prepared and cancelled (recorded by the host when it
 * cancelled them). A run counts as finished only when it is completed or cancelled with no attempt still running or
 * unsettled and nothing of it busy elsewhere (a review or integration in progress, `busy`); a prepared run that never
 * started is kept. Whether each folder may really go is decided per folder afterwards.
 */
export function retentionCandidates(runs: readonly ExecutionRun[], options: {
  readonly busy: (run: ExecutionRun) => boolean;
  readonly launchLeftovers: ReadonlySet<string>;
  readonly keep?: number;
}): RetentionCandidate[] {
  const keep = options.keep ?? RETENTION_KEEP_RUNS;
  const finished = (run: ExecutionRun) => (run.state === 'completed' || run.state === 'cancelled')
    && !run.attempts.some(attempt => attempt.state === 'running' || attempt.state === 'delivery-uncertain')
    && !options.busy(run);
  const subprojects = [...new Set(runs.map(run => runSubprojectId(run)).filter((id): id is string => !!id))].sort();
  const candidates: RetentionCandidate[] = [];
  for (const subprojectId of subprojects) {
    const own = flowRuns(runs, subprojectId);
    // The newest finished runs keep their folders; a run still going (or only prepared) takes no place among them.
    const ended = own.filter(run => (run.state === 'completed' || run.state === 'cancelled') && !(options.launchLeftovers.has(run.runId) && !run.startedAt));
    const newest = new Set(ended.slice(-keep).map(run => run.runId));
    for (const run of own) {
      if (!finished(run)) continue;
      if (options.launchLeftovers.has(run.runId) && run.state === 'cancelled' && !run.startedAt) candidates.push({ runId: run.runId, subprojectId, why: 'launch-leftover' });
      else if (!newest.has(run.runId)) candidates.push({ runId: run.runId, subprojectId, why: 'older' });
    }
  }
  return candidates;
}
