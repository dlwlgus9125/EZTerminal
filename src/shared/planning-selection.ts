import type { PlanningDraft, PlanningReference } from './planning';

/** Dependency/reference closure of an explicit task selection; unrelated drafts stay editable. */
export function selectPlanningTasks(draft: PlanningDraft, taskIds: readonly string[]): PlanningDraft {
  const selected = new Set<string>();
  const all = [...draft.items, ...draft.tasks, ...draft.profiles, ...draft.scenes, ...draft.components, ...draft.assets];
  const visitReference = (reference: PlanningReference): void => { if (!reference.baselineId && reference.kind !== 'file') visit(reference.id); };
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const value = all.find(entry => entry.id === id); if (!value) throw new Error(`The selected scope references missing entity ${id}.`);
    selected.add(id);
    if ('dependencyIds' in value) { for (const next of [...value.dependencyIds, ...value.featureIds, ...value.screenIds]) visit(next); if (value.profileId) visit(value.profileId); [...value.inputRefs, ...value.interfaceRefs].forEach(visitReference); }
    if ('contextRefs' in value) { if (value.parentProfileId) visit(value.parentProfileId); value.contextRefs.forEach(visitReference); }
    if ('elements' in value) for (const element of value.elements) { if (element.component) visit(element.component.componentId); if (element.properties.assetId) visit(element.properties.assetId); if (element.component?.overrides.assetId) visit(element.component.overrides.assetId); }
    if ('transitions' in value) { value.featureIds.forEach(visit); for (const transition of value.transitions) if (transition.toSceneId) visit(transition.toSceneId); }
    // Outgoing semantic dependencies are part of the chosen scope; unrelated incoming references are not.
    for (const link of draft.links) if (link.fromId === id && link.kind !== 'contains') visit(link.toId);
    for (const link of draft.links) if (link.toId === id && link.kind === 'contains') visit(link.fromId);
  };
  for (const id of taskIds) { if (!draft.tasks.some(task => task.id === id)) throw new Error(`Selected task ${id} is unavailable.`); visit(id); }
  return structuredClone({ ...draft, items: draft.items.filter(value => selected.has(value.id)), tasks: draft.tasks.filter(value => selected.has(value.id)),
    profiles: draft.profiles.filter(value => selected.has(value.id)), scenes: draft.scenes.filter(value => selected.has(value.id)), components: draft.components.filter(value => selected.has(value.id)), assets: draft.assets.filter(value => selected.has(value.id)),
    links: draft.links.filter(link => selected.has(link.fromId) && selected.has(link.toId)) });
}
