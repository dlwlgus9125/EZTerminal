import { describe, expect, it } from 'vitest';
import { validatePlanningDraft } from '../../shared/planning';
import { deleteSceneElement, descendantIds, exportScenePackage, instantiateComponent, moveElement, parseScenePackage, sceneImportOperations } from './scene-model';
import { sampleScene, sceneSnapshot } from './scene-fixtures';

describe('semantic scene editing and exchange', () => {
  it('round-trips stable IDs, states, transitions, component overrides and asset hashes', () => {
    const draft = structuredClone(sceneSnapshot.draft);
    draft.assets.push({ id: 'asset-1', revision: 2, title: 'Logo', relativePath: 'assets/logo.png', hash: 'a'.repeat(64), mimeType: 'image/png', byteLength: 128 });
    draft.scenes[0]!.elements[1]!.properties.assetId = 'asset-1';
    const exported = exportScenePackage(draft, sampleScene.id);
    expect(parseScenePackage(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
    expect(exported.scenes[0]!.elements.find((element) => element.id === 'send')?.component?.overrides.text).toBe('대화 시작');
    expect(exported.assets[0]?.hash).toBe('a'.repeat(64));
  });
  it('rejects scripts, unknown element types, missing references and parent cycles', () => {
    const valid = exportScenePackage(sceneSnapshot.draft, sampleScene.id);
    expect(() => parseScenePackage({ ...valid, script: 'alert(1)' })).toThrow();
    for (const patch of [{ kind: 'html' }, { parentId: 'title' }, { component: { componentId: 'missing', version: 1, overrides: {} } }]) {
      const broken = structuredClone(valid); Object.assign(broken.scenes[0]!.elements[1]!, patch);
      expect(() => parseScenePackage(broken)).toThrow();
    }
  });
  it('exports only the selected scene and its reachable references', () => {
    const draft = structuredClone(sceneSnapshot.draft);
    draft.scenes.push({ ...structuredClone(sampleScene), id: 'unrelated-scene', featureIds: [] });
    draft.items.push({ ...draft.items[0]!, id: 'private-unrelated-item', body: 'Unrelated private planning' });
    const exported = exportScenePackage(draft, sampleScene.id);
    expect(exported.scenes.map((scene) => scene.id)).toEqual([sampleScene.id]);
    expect(exported.features.map((item) => item.id)).not.toContain('private-unrelated-item');
    draft.scenes[0]!.transitions[0]!.toSceneId = 'unrelated-scene';
    expect(exportScenePackage(draft, sampleScene.id).scenes).toHaveLength(2);
  });
  it('deletes descendants and their transitions while preserving unrelated elements', () => {
    const withoutSend = deleteSceneElement(sampleScene, 'send');
    expect(withoutSend.elements.map((element) => element.id)).toEqual(['frame', 'title', 'input', 'success']);
    expect(withoutSend.transitions).toEqual([]);
    expect(deleteSceneElement(sampleScene, 'frame').elements).toEqual([]);
    expect(descendantIds(sampleScene.elements, 'title')).toEqual(new Set(['title']));
  });
  it('moves only sibling order and clones linked components under fresh stable IDs', () => {
    const moved = moveElement(sampleScene.elements, 'input', -1);
    expect(moved.find((element) => element.id === 'input')?.order).toBe(0);
    expect(moved.find((element) => element.id === 'title')?.order).toBe(1);
    expect(moved.find((element) => element.id === 'frame')).toEqual(sampleScene.elements[0]);
    const component = sceneSnapshot.draft.components[0]!;
    const clone = instantiateComponent(component, 'frame', 4);
    expect(clone[0]?.id).not.toBe(component.elements[0]?.id);
    expect(clone[0]?.component).toEqual({ componentId: component.id, version: component.revision, overrides: {} });
    expect(clone[0]?.parentId).toBe('frame');
  });
  it('validates cross-screen target states against the destination screen', () => {
    const draft = structuredClone(sceneSnapshot.draft);
    draft.scenes.push({ ...structuredClone(sampleScene), id: 'target', states: [{ id: 'target-default', title: 'Target', kind: 'default' }], elements: [], transitions: [] });
    draft.scenes[0]!.transitions[0] = { ...draft.scenes[0]!.transitions[0]!, toSceneId: 'target', toStateId: 'target-default' };
    expect(validatePlanningDraft(draft)).toEqual([]);
    draft.scenes[0]!.transitions[0]!.toStateId = 'success';
    expect(validatePlanningDraft(draft)).not.toEqual([]);
  });
  it('binds imported edits to current entity revisions and next component versions', () => {
    const operations = sceneImportOperations(exportScenePackage(sceneSnapshot.draft, sampleScene.id), sceneSnapshot);
    const scenePut = operations.find((operation) => operation.op === 'scene.put');
    expect(scenePut).toMatchObject({ op: 'scene.put', value: { revision: 2 } });
    if (scenePut?.op !== 'scene.put') throw new Error('Missing scene');
    expect(scenePut.value.elements.find((element) => element.id === 'send')?.component?.version).toBe(3);
  });
});
