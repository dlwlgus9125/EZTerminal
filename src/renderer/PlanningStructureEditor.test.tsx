// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanningItem, PlanningSnapshot } from '../shared/planning';
import { PlanningStructureEditor, planningStructureRows } from './PlanningStructureEditor';
import { planningExecutionFixture } from './planning-execution-fixtures';

vi.mock('./i18n', () => ({ useAppTranslation: () => ({ i18n: { language: 'en' } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
function fixture(): PlanningSnapshot {
  const base = planningExecutionFixture().planning;
  return {...base, draft: {...base.draft, items: ['home', 'projects', 'settings'].map((id): PlanningItem => ({id, kind: 'information', title: id, body: '', revision: 1, acceptance: [], status: 'draft'})), links: [{id: 'parent-home', revision: 1, fromId: 'home', toId: 'projects', kind: 'contains', note: ''}]}};
}
describe('planning structure projections', () => {
  it('uses the same persisted hierarchy and stable IDs for ordered list and diagram', async () => {
    const snapshot = fixture();
    expect(planningStructureRows(snapshot)).toEqual([{id:'home',depth:0},{id:'projects',depth:1,parentId:'home'},{id:'settings',depth:0}]);
    await act(async () => root.render(<PlanningStructureEditor mode="information" snapshot={snapshot} disabled={false} onPatch={vi.fn()} onEditItem={vi.fn()} onOpenDesign={vi.fn()} />));
    const titles = () => [...container.querySelectorAll('.planning-workspace__structure-node strong')].map((entry) => entry.textContent);
    expect(titles()).toEqual(['home','projects','settings']);
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Step list')!.click());
    expect(titles()).toEqual(['home','projects','settings']);
  });
  it('reparents a page in one change bundle so it cannot transiently gain two parents', async () => {
    const onPatch = vi.fn();
    await act(async () => root.render(<PlanningStructureEditor mode="information" snapshot={fixture()} disabled={false} onPatch={onPatch} onEditItem={vi.fn()} onOpenDesign={vi.fn()} />));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.planning-workspace__structure-node')].find((button) => button.textContent?.includes('settings'))!.click());
    const select = container.querySelector('select')!;
    await act(async () => { select.value = 'projects'; select.dispatchEvent(new Event('change', {bubbles: true})); });
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Connect')!.click());
    expect(onPatch).toHaveBeenCalledWith([{op:'entity.delete',kind:'link',id:'parent-home'}, {op:'link.put',value: expect.objectContaining({kind:'contains',fromId:'settings',toId:'projects'})}], expect.any(String));
  });
  it('distinguishes an intentional end result from an action with a missing destination', async () => {
    const snapshot = fixture();
    snapshot.draft.items = [{...snapshot.draft.items[0], id:'action', title:'Submit request', kind:'flow', flowStep:{kind:'action'}},{...snapshot.draft.items[0], id:'end', title:'Request cancelled', kind:'flow', flowStep:{kind:'end'}}];
    snapshot.draft.links = [];
    await act(async () => root.render(<PlanningStructureEditor mode="flow" snapshot={snapshot} disabled={false} onPatch={vi.fn()} onEditItem={vi.fn()} onOpenDesign={vi.fn()} />));
    const warning = container.querySelector('[role="status"]');
    expect(warning?.textContent).toContain('Submit request');
    expect(warning?.textContent).not.toContain('Request cancelled');
  });
});
