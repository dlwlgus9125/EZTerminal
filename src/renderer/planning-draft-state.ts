import { PlanningDraftResultSchema, PlanningWorkspaceDraftSchema, type PlanningDraftStorage } from '../shared/planning-draft';
export { PlanningWorkspaceDraftSchema, type PlanningWorkspaceDraft, type PlanningDraftStorage, type PlanningEntityDrafts } from '../shared/planning-draft';

/** Desktop renderer recovery only; this never advances the PC's authority revision. */
export function desktopPlanningDraftStorage(projectId: string, subprojectId?: string): PlanningDraftStorage {
  let revision: number | undefined;
  let blocked = false;
  return {
    async loadDraft() {
      const result = PlanningDraftResultSchema.parse(await window.ezterminal.planningDraftRead(projectId, subprojectId));
      if (!result.ok) throw new Error(result.message);
      if (result.snapshot.projectId !== projectId) throw new Error('Stored planning draft identity mismatch.');
      if (result.snapshot.subprojectId !== subprojectId) throw new Error('Stored planning draft subproject mismatch.');
      revision = result.snapshot.revision;
      blocked = false;
      return result.snapshot.state;
    },
    async saveDraft(state) {
      if (revision === undefined || blocked) throw new Error('Read stored planning recovery before saving. Your local draft has been preserved.');
      const value = PlanningWorkspaceDraftSchema.parse(state);
      if (value.projectId !== projectId) throw new Error('Planning draft project mismatch.');
      if (value.subprojectId !== subprojectId) throw new Error('Planning draft subproject mismatch.');
      try {
        const result = PlanningDraftResultSchema.parse(await window.ezterminal.planningDraftWrite(projectId, { expectedRevision: revision, state: value }, subprojectId));
        if (!result.ok) throw new Error(result.message);
        if (result.snapshot.projectId !== projectId) throw new Error('Stored planning draft identity mismatch.');
        revision = result.snapshot.revision;
      } catch (error) { blocked = true; throw error; }
    },
  };
}
