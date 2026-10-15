import { z } from 'zod';
import { PlanningAssetBinarySchema } from '../../shared/planning-asset';
import {
  PlanningAssetSchema, PlanningComponentSchema, PlanningItemSchema, ScreenSceneSchema, validatePlanningDraft,
  type PlanningComponent, type PlanningDraft, type PlanningOperation, type PlanningSnapshot, type SceneElement, type ScreenScene,
} from '../../shared/planning';

export const SCENE_KINDS: readonly SceneElement['kind'][] = ['frame', 'text', 'input', 'button', 'list', 'table', 'tabs', 'dialog'];
export const STATE_KINDS: readonly ScreenScene['states'][number]['kind'][] = ['default', 'loading', 'empty', 'validation', 'disabled', 'error', 'success', 'offline'];
export const PROPERTY_KEYS: readonly (keyof SceneElement['properties'])[] = ['text', 'placeholder', 'disabled', 'required', 'variant', 'assetId', 'accessibleName'];
export const sceneIdentity = (prefix: string): string => `${prefix}-${crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
export function newScene(platform: ScreenScene['platform'] = 'windows'): ScreenScene {
  return { id: sceneIdentity('scene'), revision: 0, title: '', platform, width: platform === 'android' ? 390 : 1200, height: platform === 'android' ? 844 : 800,
    featureIds: [], elements: [], states: [{ id: 'default', title: 'Default', kind: 'default' }], transitions: [], status: 'draft' };
}
export function newElement(kind: SceneElement['kind'], parentId: string | null, order: number): SceneElement {
  return { id: sceneIdentity('element'), kind, parentId, order, stateIds: [], properties: { text: kind === 'frame' ? '' : kind, accessibleName: kind },
    layout: { direction: 'column', width: 'fill', height: 'hug', gap: 12, padding: kind === 'frame' || kind === 'dialog' ? 16 : 0, overflow: 'visible' } };
}
export function descendantIds(elements: readonly SceneElement[], id: string): Set<string> {
  const ids = new Set([id]); let previous: number;
  do { previous = ids.size; for (const element of elements) if (element.parentId && ids.has(element.parentId)) ids.add(element.id); } while (ids.size !== previous);
  return ids;
}
export function deleteSceneElement(scene: ScreenScene, id: string): ScreenScene {
  const removed = descendantIds(scene.elements, id);
  return { ...scene, elements: scene.elements.filter((element) => !removed.has(element.id)), transitions: scene.transitions.filter((transition) => !removed.has(transition.elementId)) };
}
export function moveElement(elements: readonly SceneElement[], id: string, direction: -1 | 1): SceneElement[] {
  const selected = elements.find((element) => element.id === id);
  if (!selected) return [...elements];
  const siblings = elements.filter((element) => element.parentId === selected.parentId).sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((element) => element.id === id); const destination = index + direction;
  if (destination < 0 || destination >= siblings.length) return [...elements];
  [siblings[index], siblings[destination]] = [siblings[destination]!, siblings[index]!];
  return elements.map((element) => element.parentId === selected.parentId ? { ...element, order: siblings.findIndex((candidate) => candidate.id === element.id) } : element);
}
export function instanceOwner(elements: readonly SceneElement[], id: string): SceneElement | undefined {
  let element = elements.find((candidate) => candidate.id === id); const visited = new Set<string>();
  while (element && !visited.has(element.id)) {
    if (element.component) return element;
    visited.add(element.id); element = elements.find((candidate) => candidate.id === element!.parentId);
  }
  return undefined;
}
export function instantiateComponent(component: PlanningComponent, parentId: string | null, order: number): SceneElement[] {
  const roots = component.elements.filter((element) => element.parentId === null);
  if (roots.length !== 1) throw new Error('A reusable component needs exactly one root element.');
  const prefix = sceneIdentity('instance'); const rootId = roots[0]!.id;
  const map = (id: string): string => id === rootId ? prefix : `${prefix}:${id}`;
  return component.elements.map((element) => ({ ...structuredClone(element), id: map(element.id), parentId: element.parentId ? map(element.parentId) : parentId,
    stateIds: [], ...(element.id === rootId ? { order, component: { componentId: component.id, version: component.revision, overrides: {} } } : {}) }));
}

export const ScenePackageSchema = z.object({
  version: z.literal(1), sceneId: z.string().min(1),
  scenes: z.array(ScreenSceneSchema).min(1).max(500), components: z.array(PlanningComponentSchema).max(500),
  assets: z.array(PlanningAssetSchema).max(2000), features: z.array(PlanningItemSchema).max(2000),
  binaries: z.array(PlanningAssetBinarySchema).max(2000).optional(),
}).strict();
export type ScenePackage = z.infer<typeof ScenePackageSchema>;
export function parseScenePackage(input: unknown): ScenePackage {
  const value = ScenePackageSchema.parse(input);
  if (new Set(value.binaries?.map((entry) => entry.assetId)).size !== (value.binaries?.length ?? 0)) throw new Error('A scene package contains duplicate asset binaries.');
  for (const binary of value.binaries ?? []) {
    const asset = value.assets.find((entry) => entry.id === binary.assetId);
    if (!asset || asset.hash !== binary.hash || asset.mimeType !== binary.mimeType) throw new Error('An asset binary does not match the scene metadata.');
  }
  if (!value.scenes.some((scene) => scene.id === value.sceneId)) throw new Error('The selected scene is missing from this file.');
  const candidate: PlanningDraft = { id: 'scene-import', items: value.features, scenes: value.scenes, components: value.components, assets: value.assets, links: [], profiles: [], tasks: [] };
  const issues = validatePlanningDraft(candidate);
  if (issues.length) throw new Error(issues.slice(0, 4).join('\n'));
  return value;
}
export function exportScenePackage(draft: PlanningDraft, sceneId: string): ScenePackage {
  const sceneIds = new Set([sceneId]); const componentIds = new Set<string>(); const assetIds = new Set<string>(); const featureIds = new Set<string>();
  let previous: number;
  do {
    previous = sceneIds.size;
    for (const scene of draft.scenes) if (sceneIds.has(scene.id)) for (const transition of scene.transitions) if (transition.toSceneId) sceneIds.add(transition.toSceneId);
  } while (previous !== sceneIds.size);
  const scenes = draft.scenes.filter((scene) => sceneIds.has(scene.id));
  const collectElements = (elements: readonly SceneElement[]): void => {
    for (const element of elements) {
      if (element.component) componentIds.add(element.component.componentId);
      if (element.properties.assetId) assetIds.add(element.properties.assetId);
      if (element.component?.overrides.assetId) assetIds.add(element.component.overrides.assetId);
    }
  };
  for (const scene of scenes) { collectElements(scene.elements); for (const id of scene.featureIds) featureIds.add(id); }
  do {
    previous = componentIds.size;
    for (const component of draft.components) if (componentIds.has(component.id)) collectElements(component.elements);
  } while (previous !== componentIds.size);
  return parseScenePackage({ version: 1, sceneId, scenes, components: draft.components.filter((component) => componentIds.has(component.id)),
    assets: draft.assets.filter((asset) => assetIds.has(asset.id)), features: draft.items.filter((item) => featureIds.has(item.id)) });
}
export function sceneImportOperations(value: ScenePackage, snapshot: PlanningSnapshot): PlanningOperation[] {
  const imported = parseScenePackage(value);
  const nextRevision = snapshot.revision + 1;
  const componentIds = new Set(imported.components.map((component) => component.id));
  const elements = (entries: SceneElement[]): SceneElement[] => entries.map((element) => element.component && componentIds.has(element.component.componentId)
    ? { ...element, component: { ...element.component, version: nextRevision } } : element);
  return [
    ...imported.features.map((item): PlanningOperation => ({ op: 'item.put', value: { ...item, revision: snapshot.draft.items.find((entry) => entry.id === item.id)?.revision ?? 0 } })),
    ...imported.assets.map((asset): PlanningOperation => ({ op: 'asset.put', value: { ...asset, revision: snapshot.draft.assets.find((entry) => entry.id === asset.id)?.revision ?? 0 } })),
    ...imported.components.map((component): PlanningOperation => ({ op: 'component.put', value: { ...component, elements: elements(component.elements), revision: snapshot.draft.components.find((entry) => entry.id === component.id)?.revision ?? 0 } })),
    ...imported.scenes.map((scene): PlanningOperation => ({ op: 'scene.put', value: { ...scene, elements: elements(scene.elements), revision: snapshot.draft.scenes.find((entry) => entry.id === scene.id)?.revision ?? 0 } })),
  ];
}
