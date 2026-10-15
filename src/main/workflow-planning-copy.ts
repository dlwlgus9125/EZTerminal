import { createHash } from 'node:crypto';
import type { PlanningDraft, PlanningReference, PlanningSnapshot } from '../shared/planning';

/** Make editable copies of current documents and any explicitly frozen input references. */
export function copyWorkflowPlanning(source: PlanningSnapshot, ownerId: string): PlanningSnapshot {
  const identity = (key: string) => `copy-${createHash('sha256').update(`${ownerId}\0${key}`).digest('hex').slice(0, 32)}`;
  const draft: PlanningDraft = { id: identity('draft'), items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] };
  const collections = { item: 'items', scene: 'scenes', component: 'components', profile: 'profiles', task: 'tasks', asset: 'assets' } as const;
  const mapped = new Map<string, string>();
  const reference = (ref: PlanningReference): PlanningReference => ref.kind === 'file' ? { ...ref, baselineId: undefined }
    : { ...ref, id: visit(ref.kind, ref.id, ref.baselineId), revision: 0, baselineId: undefined };
  const visit = (kind: keyof typeof collections, id: string, baselineId?: string): string => {
    const key = `${baselineId ?? 'draft'}:${kind}:${id}`; const existing = mapped.get(key); if (existing) return existing;
    const scope = baselineId ? source.baselines.find(baseline => baseline.id === baselineId)?.draft : source.draft;
    const collection = collections[kind]; const original = scope?.[collection].find(value => value.id === id);
    if (!original) throw new Error(`The copy references missing ${kind} ${id}.`);
    const nextId = identity(key); mapped.set(key, nextId);
    const value = structuredClone(original); value.id = nextId; value.revision = 0;
    if ('status' in value) value.status = 'review-needed';
    if ('dependencyIds' in value) {
      value.dependencyIds = value.dependencyIds.map(next => visit('task', next, baselineId));
      value.featureIds = value.featureIds.map(next => visit('item', next, baselineId));
      value.screenIds = value.screenIds.map(next => visit('scene', next, baselineId));
      if (value.profileId) value.profileId = visit('profile', value.profileId, baselineId);
      value.inputRefs = value.inputRefs.map(ref => reference({ ...ref, baselineId: ref.baselineId ?? baselineId }));
      value.interfaceRefs = value.interfaceRefs.map(ref => reference({ ...ref, baselineId: ref.baselineId ?? baselineId }));
    }
    if ('contextRefs' in value) {
      if (value.parentProfileId) value.parentProfileId = visit('profile', value.parentProfileId, baselineId);
      value.contextRefs = value.contextRefs.map(ref => reference({ ...ref, baselineId: ref.baselineId ?? baselineId }));
    }
    if ('elements' in value) for (const element of value.elements) {
      if (element.properties.assetId) element.properties.assetId = visit('asset', element.properties.assetId, baselineId);
      if (element.component) {
        element.component.componentId = visit('component', element.component.componentId, baselineId); element.component.version = 0;
        if (element.component.overrides.assetId) element.component.overrides.assetId = visit('asset', element.component.overrides.assetId, baselineId);
      }
    }
    if ('transitions' in value) {
      value.featureIds = value.featureIds.map(next => visit('item', next, baselineId));
      for (const transition of value.transitions) if (transition.toSceneId) transition.toSceneId = visit('scene', transition.toSceneId, baselineId);
    }
    // kind fixes the collection at runtime; its discriminated union is preserved unchanged.
    (draft[collection] as typeof value[]).push(value);
    return nextId;
  };
  for (const [kind, collection] of Object.entries(collections)) for (const value of source.draft[collection]) visit(kind as keyof typeof collections, value.id);
  for (const link of source.draft.links) {
    const from = Object.keys(collections).map(kind => mapped.get(`draft:${kind}:${link.fromId}`)).find(Boolean);
    const to = Object.keys(collections).map(kind => mapped.get(`draft:${kind}:${link.toId}`)).find(Boolean);
    if (from && to) draft.links.push({ ...link, id: identity(`link:${link.id}`), revision: 0, fromId: from, toId: to });
  }
  return { schemaVersion: 1, projectId: source.projectId, revision: 0, draft, baselines: [], history: [], profileProposals: [] };
}
