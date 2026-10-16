import { expect, it } from 'vitest';
import { PlanningSnapshotSchema, validatePlanningDraft } from '../shared/planning';
import { copyWorkflowPlanning } from './workflow-planning-copy';

it('materializes frozen input references as new editable entities without copying approval baselines', () => {
  const blank = { id: 'draft', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] };
  const old = { id: 'old-doc', revision: 5, title: 'Frozen requirements', kind: 'requirement', body: 'Frozen source bytes', status: 'ready', acceptance: [] };
  const source = PlanningSnapshotSchema.parse({ schemaVersion: 1, projectId: 'p', revision: 8, draft: { ...blank, profiles: [{ id: 'planner', revision: 8, title: 'Planner', role: 'planning', instructions: 'Plan', allowedTools: ['planning.read'], retryLimit: 2, contextRefs: [{ id: old.id, kind: 'item', revision: 5, baselineId: 'baseline' }] }] }, baselines: [{ id: 'baseline', title: 'Frozen', sourceRevision: 5, createdAt: '2026-10-13T00:00:00.000Z', createdBy: { kind: 'user', id: 'u' }, hash: 'a'.repeat(64), draft: { ...blank, items: [old] } }], history: [], profileProposals: [] });
  const copy = copyWorkflowPlanning(source, 'new-owner');
  expect(copy.baselines).toEqual([]); expect(copy.history).toEqual([]); expect(copy.draft.id).not.toBe(source.draft.id);
  expect(copy.draft.items[0]).toMatchObject({ body: 'Frozen source bytes', status: 'review-needed', revision: 0 });
  expect(copy.draft.items[0].id).not.toBe(old.id);
  expect(copy.draft.profiles[0].contextRefs[0]).toMatchObject({ id: copy.draft.items[0].id, revision: 0, baselineId: undefined });
  expect(validatePlanningDraft(copy.draft)).toEqual([]); expect(source.baselines[0].draft.items[0]).toEqual(old);
});
