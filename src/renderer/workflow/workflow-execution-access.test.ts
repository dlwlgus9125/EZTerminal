import { describe, expect, it, vi } from 'vitest';

import type { PlanningRunRequest, PlanningRunResult } from '../../shared/planning-run';
import { retryIndependentReview, type WorkflowExecutionAccess } from './workflow-execution-access';

function snapshotAt(revision: number): PlanningRunResult {
  return { ok: true, snapshot: { version: 1, projectId: 'P', revision, runs: [] } } as unknown as PlanningRunResult;
}
function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
}

const TARGET = { projectId: 'P', subprojectId: 'S', runId: 'R', attemptId: 'A', reviewGeneration: 2 } as const;

describe('retryIndependentReview', () => {
  it('sends retry-review in the flow scope at the current revision, with one command id per review generation', async () => {
    const sent: PlanningRunRequest[] = [];
    const storage = memory();
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(7)),
      executePlanningRun: vi.fn(async (command) => { sent.push(command); return snapshotAt(8); }),
    };
    await expect(retryIndependentReview(access, TARGET, storage)).resolves.toMatchObject({ ok: true });
    expect(access.getPlanningExecutionSnapshot).toHaveBeenCalledWith('P', 'S');
    expect(sent).toEqual([{ commandId: 'retry-review:A:3', projectId: 'P', subprojectId: 'S', expectedRevision: 7, type: 'retry-review', payload: { runId: 'R', attemptId: 'A' } }]);
    expect(storage.values.size).toBe(0);
  });

  it('reads the revision again once after a revision-conflict and resends the same command', async () => {
    const revisions = [7, 9];
    const sent: PlanningRunRequest[] = [];
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(revisions.shift()!)),
      executePlanningRun: vi.fn(async (command) => {
        sent.push(command);
        return sent.length === 1 ? { ok: false as const, error: 'revision-conflict', message: 'changed' } : snapshotAt(10);
      }),
    };
    await expect(retryIndependentReview(access, TARGET, memory())).resolves.toMatchObject({ ok: true });
    expect(sent.map((command) => [command.commandId, command.expectedRevision])).toEqual([['retry-review:A:3', 7], ['retry-review:A:3', 9]]);
  });

  it('after a lost answer sends the exact same request again, though the run moved on (the host finishes it)', async () => {
    const storage = memory();
    const sent: PlanningRunRequest[] = [];
    const revisions = [7, 12];
    const answers: PlanningRunResult[] = [{ ok: false, error: 'unavailable', message: 'No execution receipt.' }, snapshotAt(13)];
    const access: WorkflowExecutionAccess = {
      getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(revisions.shift()!)),
      executePlanningRun: vi.fn(async (command) => { sent.push(command); return answers.shift()!; }),
    };
    await expect(retryIndependentReview(access, TARGET, storage)).resolves.toMatchObject({ ok: false, error: 'unavailable' });
    expect(storage.values.size).toBe(1);
    await expect(retryIndependentReview(access, TARGET, storage)).resolves.toMatchObject({ ok: true });
    expect(sent.map((command) => command.expectedRevision)).toEqual([7, 7]);
    expect(access.getPlanningExecutionSnapshot).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);
  });

  it('shows a command-conflict and any other refusal as it is, without resending', async () => {
    for (const refusal of [
      { ok: false as const, error: 'command-conflict', message: 'This command ID already belongs to a different execution action.' },
      { ok: false as const, error: 'stale-review', message: 'Only a failed independent review can be retried.' },
    ]) {
      const storage = memory();
      const access: WorkflowExecutionAccess = {
        getPlanningExecutionSnapshot: vi.fn(async () => snapshotAt(7)),
        executePlanningRun: vi.fn(async () => refusal),
      };
      await expect(retryIndependentReview(access, TARGET, storage)).resolves.toEqual(refusal);
      expect(access.executePlanningRun).toHaveBeenCalledTimes(1);
      expect(storage.values.size).toBe(0);
    }
  });
});
