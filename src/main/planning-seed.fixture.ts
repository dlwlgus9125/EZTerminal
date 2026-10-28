import {
  PLANNING_SCHEMA_VERSION,
  type PlanningBaseline,
  type PlanningDraft,
  type PlanningSnapshot,
} from '../shared/planning';
import { planningDraftHash, type PlanningService } from './planning-service';

/**
 * Test fixture: planning data as the planning screen (removed in I5) left it, written through the restore path
 * the host still has. New entities come out at revision 1 as after their first save, and every baseline is a
 * person's freeze of that draft (or of its own draft) with a matching hash.
 */
export type SeedDraft = { readonly [K in keyof PlanningDraft]?: PlanningDraft[K] extends (infer E)[] ? readonly E[] : PlanningDraft[K] };
export interface SeedBaseline {
  readonly id: string;
  readonly title: string;
  readonly purpose?: PlanningBaseline['purpose'];
  readonly draft?: SeedDraft;
  /** A person's freeze by default; `workflow-runtime` for one a flow run captured. */
  readonly createdBy?: PlanningBaseline['createdBy'];
}

const SEEDED_AT = '2026-10-01T00:00:00.000Z';

function fullDraft(draft: SeedDraft, settle: boolean): PlanningDraft {
  const settled = <T extends { readonly revision: number }>(entries: readonly T[] | undefined): T[] =>
    (entries ?? []).map((entry) => (settle && entry.revision === 0 ? { ...entry, revision: 1 } : { ...entry }));
  return {
    ...draft,
    id: draft.id ?? 'draft-1',
    items: settled(draft.items), links: settled(draft.links), scenes: settled(draft.scenes),
    components: settled(draft.components), profiles: settled(draft.profiles), tasks: settled(draft.tasks), assets: settled(draft.assets),
  };
}

export async function seedPlanning(
  planning: Pick<PlanningService, 'importSnapshot'>,
  projectId: string,
  draft: SeedDraft,
  options: {
    readonly baselines?: readonly SeedBaseline[];
    readonly subprojectId?: string;
    /** Keep entity revisions as given (a flow run captures drafts unchanged). */
    readonly keepRevisions?: boolean;
  } = {},
): Promise<PlanningSnapshot> {
  const settle = !options.keepRevisions;
  const baselines: PlanningBaseline[] = (options.baselines ?? []).map((baseline) => {
    const frozen = fullDraft(baseline.draft ?? draft, settle);
    return {
      id: baseline.id, title: baseline.title, ...(baseline.purpose ? { purpose: baseline.purpose } : {}),
      sourceRevision: 1, createdAt: SEEDED_AT, createdBy: baseline.createdBy ?? { kind: 'user', id: 'test' }, hash: planningDraftHash(frozen), draft: frozen,
    };
  });
  const snapshot: PlanningSnapshot = {
    schemaVersion: PLANNING_SCHEMA_VERSION, projectId, revision: 1 + baselines.length,
    draft: fullDraft(draft, settle), baselines, history: [], profileProposals: [],
  };
  const result = await planning.importSnapshot(projectId, snapshot, options.subprojectId);
  if (!result.ok) throw new Error(`Planning seed failed: ${result.message} ${(result.issues ?? []).join('; ')}`);
  return result.snapshot;
}
