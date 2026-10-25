import { describe, expect, it } from 'vitest';

import type { ExecutionRun } from '../shared/planning-execution';
import { retentionCandidates } from './run-retention';

/** A flow run of `subprojectId`, prepared at minute `minute`. */
function run(runId: string, subprojectId: string, minute: number, state: ExecutionRun['state'], extra: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    runId, state, createdAt: new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString(), startedAt: state === 'prepared' ? undefined : new Date(Date.UTC(2026, 9, 26, 0, minute, 1)).toISOString(),
    attempts: [], preparation: { workflow: { subprojectId } }, ...extra,
  } as unknown as ExecutionRun;
}
const none = { busy: () => false, launchLeftovers: new Set<string>() };

describe('retentionCandidates', () => {
  it('offers every finished run of a flow but its newest three, in 실행 #n order', () => {
    const runs = [run('r1', 'a', 1, 'completed'), run('r2', 'a', 2, 'cancelled'), run('r3', 'a', 3, 'completed'), run('r4', 'a', 4, 'completed'), run('r5', 'a', 5, 'completed')];
    expect(retentionCandidates(runs, none)).toEqual([{ runId: 'r1', subprojectId: 'a', why: 'older' }, { runId: 'r2', subprojectId: 'a', why: 'older' }]);
    // Only finished runs fill the newest three: one still going takes no place (Codex I2-7c P2-8).
    expect(retentionCandidates([...runs, run('r6', 'a', 6, 'running')], none).map(entry => entry.runId)).toEqual(['r1', 'r2']);
    const prepared = [run('done', 'a', 1, 'completed'), run('p2', 'a', 2, 'prepared'), run('p3', 'a', 3, 'prepared'), run('p4', 'a', 4, 'prepared')];
    expect(retentionCandidates(prepared, none)).toEqual([]);
  });

  it('counts each flow on its own and orders by preparation, not by when a run last changed', () => {
    const runs = [run('b1', 'b', 1, 'completed', { updatedAt: '2026-10-27T00:00:00.000Z' } as Partial<ExecutionRun>), run('a1', 'a', 2, 'completed'),
      run('b2', 'b', 3, 'completed'), run('b3', 'b', 4, 'completed'), run('b4', 'b', 5, 'completed')];
    expect(retentionCandidates(runs, none)).toEqual([{ runId: 'b1', subprojectId: 'b', why: 'older' }]);
  });

  it('never offers a run that is not finished: going, prepared only, an attempt unsettled, or busy elsewhere', () => {
    const unsettled = { attempts: [{ attemptId: 'x', state: 'delivery-uncertain' }] } as unknown as Partial<ExecutionRun>;
    const runs = [run('r1', 'a', 1, 'paused'), run('r2', 'a', 2, 'prepared'), run('r3', 'a', 3, 'cancelled', unsettled), run('r4', 'a', 4, 'completed'),
      run('r5', 'a', 5, 'completed'), run('r6', 'a', 6, 'completed'), run('r7', 'a', 7, 'completed')];
    expect(retentionCandidates(runs, { ...none, busy: entry => entry.runId === 'r4' })).toEqual([]);
    expect(retentionCandidates(runs, none).map(entry => entry.runId)).toEqual(['r4']);
  });

  it('offers a run a refused launch prepared and cancelled even among the newest, and only that kind', () => {
    const runs = [run('r1', 'a', 1, 'completed'), run('left', 'a', 2, 'cancelled', { startedAt: undefined }), run('r3', 'a', 3, 'completed')];
    expect(retentionCandidates(runs, { ...none, launchLeftovers: new Set(['left']) })).toEqual([{ runId: 'left', subprojectId: 'a', why: 'launch-leftover' }]);
    // A run that started is not a leftover whatever the record says (it is kept as one of the newest).
    const started = [run('r1', 'a', 1, 'completed'), run('left', 'a', 2, 'cancelled'), run('r3', 'a', 3, 'completed')];
    expect(retentionCandidates(started, { ...none, launchLeftovers: new Set(['left']) })).toEqual([]);
  });

  it('leaves runs that belong to no flow alone', () => {
    const legacy = { ...run('old', 'a', 1, 'completed'), preparation: {} } as unknown as ExecutionRun;
    expect(retentionCandidates([legacy], { ...none, keep: 0 })).toEqual([]);
  });
});
