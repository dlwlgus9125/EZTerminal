// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningEntityDrafts } from '../../shared/planning-draft';
import type { ScreenScene } from '../../shared/planning';
import { AppI18nProvider } from '../i18n';
import { SceneDesigner, type SceneDesignerProps } from './SceneDesigner';
import { sceneSnapshot } from './scene-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
function fixture(overrides: Partial<SceneDesignerProps> = {}) {
  const changed = vi.fn(); const onPatch = vi.fn();
  function Controlled(): JSX.Element {
    const [scenes, setScenes] = useState<PlanningEntityDrafts['scenes']>({});
    const [components, setComponents] = useState<PlanningEntityDrafts['components']>({});
    return <SceneDesigner snapshot={sceneSnapshot} sceneDrafts={scenes} componentDrafts={components}
      onSceneDraftChange={(value) => { changed(value); setScenes((current) => ({ ...current, [value.id]: { value, dirty: true } })); }}
      onComponentDraftChange={(value) => setComponents((current) => ({ ...current, [value.id]: { value, dirty: true } }))} onPatch={onPatch} {...overrides} />;
  }
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><Controlled /></AppI18nProvider>));
  return { changed, onPatch };
}
function control(label: string): HTMLInputElement | HTMLSelectElement {
  const field = [...container.querySelectorAll('label')].find((entry) => entry.textContent === label);
  return document.getElementById(field?.htmlFor ?? '') as HTMLInputElement | HTMLSelectElement;
}
function setValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
function click(text: string): void { act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!.click()); }
function selectTree(text: string): void { act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find((button) => button.textContent?.includes(text))!.click()); }

describe('SceneDesigner controlled editing', () => {
  it('edits only the selected element and sends a typed patch only on Save', () => {
    const { changed, onPatch } = fixture(); selectTree('제목');
    setValue(container.querySelector<HTMLTextAreaElement>('[aria-label="Element text"]')!, 'New heading');
    const draft = changed.mock.lastCall![0] as ScreenScene;
    expect(draft.elements.find((element) => element.id === 'title')?.properties.text).toBe('New heading');
    expect(draft.elements.filter((element) => element.id !== 'title')).toEqual(sceneSnapshot.draft.scenes[0]!.elements.filter((element) => element.id !== 'title'));
    expect(onPatch).not.toHaveBeenCalled(); click('Save');
    expect(onPatch).toHaveBeenCalledWith([{ op: 'scene.put', value: draft }], expect.any(String));
  });
  it('supports keyboard tree selection and explicit sibling ordering', () => {
    const { changed } = fixture();
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    act(() => { items[1]!.focus(); items[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement).toBe(items[2]);
    expect(items[2]?.getAttribute('aria-selected')).toBe('true');
    click('Move up');
    expect((changed.mock.lastCall![0] as ScreenScene).elements.find((element) => element.id === 'input')?.order).toBe(0);
  });
  it('preserves linked component overrides and blocks structural edits until explicit detach', () => {
    const { changed } = fixture(); selectTree('대화 시작');
    expect(control('Parent element').disabled).toBe(true);
    expect(control('Variant').disabled).toBe(true);
    setValue(container.querySelector<HTMLTextAreaElement>('[aria-label="Element text"]')!, 'Local exception');
    expect((changed.mock.lastCall![0] as ScreenScene).elements.find((element) => element.id === 'send')?.component?.overrides.text).toBe('Local exception');
    click('Detach from source');
    expect(control('Parent element').disabled).toBe(false);
    expect((changed.mock.lastCall![0] as ScreenScene).elements.find((element) => element.id === 'send')?.component).toBeUndefined();
  });
  it('keeps frozen baseline read-only and preserves the current editable draft', () => {
    const snapshot = structuredClone(sceneSnapshot);
    snapshot.baselines.push({ id: 'baseline', title: 'Reviewed', sourceRevision: 2, createdAt: '2026-10-13T08:00:00.000Z', createdBy: { kind: 'user', id: 'desktop' }, hash: 'a'.repeat(64), draft: structuredClone(snapshot.draft) });
    const { changed, onPatch } = fixture({ snapshot });
    setValue(control('Screen name'), 'Unsaved current draft');
    setValue(control('Design version'), 'baseline');
    expect(control('Screen name').value).toBe('대화 시작');
    expect(control('Screen name').disabled).toBe(true);
    click('Save'); expect(onPatch).not.toHaveBeenCalled();
    setValue(control('Design version'), 'draft');
    expect(control('Screen name').value).toBe('Unsaved current draft');
    expect(changed).toHaveBeenCalledOnce();
  });
  it('allows offline draft editing while save is disabled', () => {
    const { changed, onPatch } = fixture({ disabled: true });
    expect(control('Screen name').disabled).toBe(false);
    setValue(control('Screen name'), 'Offline edit'); click('Save');
    expect(changed).toHaveBeenCalledOnce(); expect(onPatch).not.toHaveBeenCalled();
  });
  it('runs local prototype transitions without saving or executing a command', () => {
    const { changed, onPatch } = fixture(); click('Try prototype');
    const button = container.querySelector<HTMLButtonElement>('[data-scene-element="send"] button')!;
    act(() => button.click());
    expect(control('Preview state').value).toBe('success');
    expect(container.querySelector('[data-scene-element="send"]')).toBeNull();
    expect(container.querySelector('[data-scene-element="success"]')?.textContent).toContain('요청을 확인했습니다');
    expect(changed).not.toHaveBeenCalled(); expect(onPatch).not.toHaveBeenCalled();
  });
  it('keeps the mobile flow to one active panel and opens properties from the tree', () => {
    fixture({ mobile: true });
    expect([...container.querySelectorAll('[role="tabpanel"]')].filter((panel) => !panel.hasAttribute('hidden'))).toHaveLength(1);
    click('Structure'); selectTree('제목');
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Properties');
    expect(control('Accessible name').value).toBe('제목');
  });
  it('rejects an imported file containing executable fields before any write', async () => {
    const { onPatch } = fixture();
    const file = new File(['{"version":1,"script":"alert(1)"}'], 'unsafe.ezscene.json', { type: 'application/json' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });
  it('exports editable scene data through the native download callback and reports storage failure', async () => {
    const onExportScene = vi.fn<NonNullable<SceneDesignerProps['onExportScene']>>().mockRejectedValue(new Error('Download storage unavailable'));
    const { onPatch } = fixture({ onExportScene });
    await act(async () => click('Export'));
    expect(onExportScene).toHaveBeenCalledWith('scene-chat.ezscene.json', expect.any(String));
    const content = JSON.parse(vi.mocked(onExportScene).mock.calls[0]![1] as string);
    expect(content.sceneId).toBe('scene-chat');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Download storage unavailable');
    expect(onPatch).not.toHaveBeenCalled();
  });
});
