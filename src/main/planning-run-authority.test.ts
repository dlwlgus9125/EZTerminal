import { expect, it, vi } from 'vitest';
import type { ExecutionRun } from '../shared/planning-execution';
import { PlanningRunAuthority } from './planning-run-authority';
import { LocalMutationIngress } from './local-mutation-ingress';
import type { PlanningRunService } from './planning-run-service';

it('uses explicit host-owned execution scope for run, attempt and evidence reads', async () => {
  const runs = ['a', 'b'].map(owner => ({ runId: `run-${owner}`, preparation: { subprojectId: owner }, attempts: [{ attemptId: `attempt-${owner}` }], evidence: [{ logRefs: [`log-${owner}`], captureRefs: [] }] } as unknown as ExecutionRun));
  const results = { readResult: vi.fn(async () => null), readIntegration: vi.fn(async () => null), readLog: vi.fn(async () => 'evidence'), readDiff: vi.fn(async () => 'diff'), readDeviceCapture: vi.fn(async () => null) };
  const authority = new PlanningRunAuthority({ service: { read: () => ({ ok: true, snapshot: { version: 1, projectId: 'p', revision: 1, runs } }) } as unknown as PlanningRunService,
    results, ingress: new LocalMutationIngress('test'), ready: Promise.resolve(), available: () => true, ownsSubproject: async (_project, owner) => ['a', 'b'].includes(owner) });
  expect(await authority.read('p', 'a')).toMatchObject({ ok: true, snapshot: { runs: [{ runId: 'run-a' }] } });
  expect(await authority.read('p')).toMatchObject({ ok: true, snapshot: { runs: [] } });
  expect(await authority.read('p', 'unknown')).toMatchObject({ ok: false });
  expect(await authority.readResult({ kind: 'attempt', projectId: 'p', subprojectId: 'a', attemptId: 'attempt-b' })).toMatchObject({ ok: false });
  expect(results.readResult).not.toHaveBeenCalled();
  expect(await authority.readResult({ kind: 'attempt', projectId: 'p', subprojectId: 'b', attemptId: 'attempt-b' })).toMatchObject({ ok: true });
  expect(await authority.readResult({ kind: 'log', projectId: 'p', subprojectId: 'a', reference: 'log-b' })).toMatchObject({ ok: false });
  expect(results.readLog).not.toHaveBeenCalled();
  expect(await authority.readResult({ kind: 'log', projectId: 'p', subprojectId: 'a', reference: 'log-a' })).toMatchObject({ ok: true, text: 'evidence' });
});
