import { describe, expect, it, vi } from 'vitest';

import type { PlanningRunRequest, PlanningRunResult } from '../../shared/planning-run';
import { retryIndependentReview, type WorkflowExecutionAccess } from './workflow-execution-access';

function snapshotAt(revision: number): PlanningRunResult {
  return { ok: true, snapshot: { version: 1, projectId: 'P', revision, runs: [] } } as unknown as PlanningRunResult;
}

const TARGET = { projectId: 'P', subprojectId: 'S', runId: 'R', attemptId: 'A', reviewGeneration: 2 } as const;

describe('retryIndependentReview', () => {
  it('sends retry-review in the flow scope at the current revision, with one command id per review generation', async () => {
    const sent: PlanningRunRequest[] = [];
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(7)),
      executePlanningRun: vi.fn(async (command) => { sent.push(command); return snapshotAt(8); }),
    };
    await expect(retryIndependentReview(access, TARGET)).resolves.toMatchObject({ ok: true });
    expect(access.getPlanningExecutionSnapshot).toHaveBeenCalledWith('P', 'S');
    expect(sent).toEqual([{ commandId: 'retry-review:A:3', projectId: 'P', subprojectId: 'S', expectedRevision: 7, type: 'retry-review', payload: { runId: 'R', attemptId: 'A' } }]);
  });

  it('reads the revision again once after a conflict and resends the same command', async () => {
    const revisions = [7, 9];
    const sent: PlanningRunRequest[] = [];
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(revisions.shift()!)),
      executePlanningRun: vi.fn(async (command) => {
        sent.push(command);
        return sent.length === 1 ? { ok: false as const, error: 'revision-conflict', message: 'changed' } : snapshotAt(10);
      }),
    };
    await expect(retryIndependentReview(access, TARGET)).resolves.toMatchObject({ ok: true });
    expect(sent.map((command) => [command.commandId, command.expectedRevision])).toEqual([['retry-review:A:3', 7], ['retry-review:A:3', 9]]);
  });

  it('treats this round’s id already taken (an earlier answer was lost) as the retry already recorded', async () => {
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(11)),
      executePlanningRun: vi.fn(async () => ({ ok: false as const, error: 'command-conflict', message: 'This command ID belongs to a different request.' })),
    };
    await expect(retryIndependentReview(access, TARGET)).resolves.toEqual(snapshotAt(11));
    expect(access.executePlanningRun).toHaveBeenCalledTimes(1);
  });

  it('returns the host refusal as it is and does not resend other errors', async () => {
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(7)),
      executePlanningRun: vi.fn(async () => ({ ok: false as const, error: 'stale-review', message: 'Only a failed independent review can be retried.' })),
    };
    await expect(retryIndependentReview(access, TARGET)).resolves.toEqual({ ok: false, error: 'stale-review', message: 'Only a failed independent review can be retried.' });
    expect(access.executePlanningRun).toHaveBeenCalledTimes(1);
  });
});
