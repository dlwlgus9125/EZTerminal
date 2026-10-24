// @vitest-environment jsdom

import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';

import { DockWindowCoordinator } from './dock-window-coordinator';
import { PanelPreviewSlot } from './shell/panel-preview';

function disposable() {
  return { dispose: vi.fn() };
}

function createHarness() {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const auxiliary = frame.contentWindow!;
  const mainGroup = {
    id: 'main-group',
    panels: [] as IDockviewPanel[],
    activePanel: undefined as IDockviewPanel | undefined,
    element: document.createElement('div'),
    api: { location: { type: 'grid' } },
  } as unknown as DockviewGroupPanel;
  const popoutGroup = {
    id: 'popout-group',
    panels: [] as IDockviewPanel[],
    activePanel: undefined as IDockviewPanel | undefined,
    element: auxiliary.document.createElement('div'),
    api: { location: { type: 'popout' } },
  } as unknown as DockviewGroupPanel;

  const makePanel = (
    id: string,
    group: DockviewGroupPanel,
    ownerWindow: Window,
  ): IDockviewPanel => ({
    id,
    group,
    api: {
      component: 'terminal',
      group,
      location: group.api.location,
      getWindow: () => ownerWindow,
      moveTo: vi.fn(),
      setActive: vi.fn(),
      close: vi.fn(),
    },
  } as unknown as IDockviewPanel);
  const mainPanel = makePanel('tab-main', mainGroup, window);
  const popoutPanel = makePanel('tab-popout', popoutGroup, auxiliary);
  (mainGroup.panels as IDockviewPanel[]).push(mainPanel);
  (popoutGroup.panels as IDockviewPanel[]).push(popoutPanel);
  Object.defineProperty(mainGroup, 'activePanel', { value: mainPanel, configurable: true });
  Object.defineProperty(popoutGroup, 'activePanel', { value: popoutPanel, configurable: true });

  const panels = [mainPanel, popoutPanel];
  const addPanel = vi.fn((options: { id: string; position?: { referencePanel?: IDockviewPanel } }) => {
    const reference = options.position?.referencePanel;
    const group = reference?.group ?? mainGroup;
    const ownerWindow = group === popoutGroup ? auxiliary : window;
    const panel = makePanel(options.id, group, ownerWindow);
    panels.push(panel);
    (group.panels as IDockviewPanel[]).push(panel);
    return panel;
  });
  const moved: Array<(event: { panel: IDockviewPanel }) => void> = [];
  const removed: Array<(panel: IDockviewPanel) => void> = [];
  const addPopoutGroup = vi.fn(async () => true);
  const api = {
    panels,
    groups: [mainGroup, popoutGroup],
    activePanel: popoutPanel,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel,
    addPopoutGroup,
    onDidActivePanelChange: vi.fn(() => disposable()),
    onDidMovePanel: vi.fn((listener: (event: { panel: IDockviewPanel }) => void) => { moved.push(listener); return disposable(); }),
    onDidRemovePanel: vi.fn((listener: (panel: IDockviewPanel) => void) => { removed.push(listener); return disposable(); }),
  } as unknown as DockviewApi;
  const move = (panel: IDockviewPanel): void => { for (const listener of moved) listener({ panel }); };
  const remove = (panel: IDockviewPanel): void => { for (const listener of removed) listener(panel); };

  return { api, addPanel, addPopoutGroup, auxiliary, mainPanel, popoutPanel, mainGroup, makePanel, panels, move, remove };
}

describe('DockWindowCoordinator placement', () => {
  it('adds global tabs to the main grid even while a popout is globally active', () => {
    const h = createHarness();
    const coordinator = new DockWindowCoordinator(h.api);

    coordinator.addPanel({ id: 'tab-new', component: 'terminal' }, { kind: 'main-tab' });

    expect(h.addPanel).toHaveBeenCalledWith(expect.objectContaining({
      position: { referencePanel: h.mainPanel, direction: 'within' },
    }));
    expect(coordinator.activePanelIdForDocument(h.auxiliary.document)).toBe('tab-popout');
  });

  it('splits inside an auxiliary nested grid through the move engine', () => {
    const h = createHarness();
    const coordinator = new DockWindowCoordinator(h.api);

    const panel = coordinator.addPanel(
      { id: 'tab-split', component: 'terminal' },
      { kind: 'split', referencePanelId: h.popoutPanel.id, direction: 'below' },
    );

    expect(h.addPanel).toHaveBeenCalledWith(expect.objectContaining({
      position: { referencePanel: h.popoutPanel, direction: 'within' },
    }));
    expect(panel.api.moveTo).toHaveBeenCalledWith({
      group: h.popoutPanel.group,
      position: 'bottom',
    });
  });

  it('replaces a tab in its own place, in whichever window it is', () => {
    const h = createHarness();
    const coordinator = new DockWindowCoordinator(h.api);
    (h.popoutPanel.group.panels as IDockviewPanel[]).unshift({ id: 'tab-before' } as IDockviewPanel);

    coordinator.addPanel({ id: 'tab-replacement', component: 'agent-session' }, { kind: 'replace', referencePanelId: h.popoutPanel.id });

    expect(h.addPanel).toHaveBeenCalledWith(expect.objectContaining({
      position: { referencePanel: h.popoutPanel, direction: 'within', index: 1 },
    }));
    expect(h.popoutPanel.api.close).toHaveBeenCalledOnce();
  });

  it('moves a tab to a new native window through the same placement owner', async () => {
    const h = createHarness();
    const coordinator = new DockWindowCoordinator(h.api);

    await expect(coordinator.movePanelToNewWindow(h.mainPanel.id)).resolves.toBe(true);

    expect(h.addPopoutGroup).toHaveBeenCalledWith(
      h.mainPanel,
      expect.objectContaining({ popoutUrl: expect.stringContaining('ez-popout=1') }),
    );
  });

  it('moves a detached tab back to the main grid anchor', () => {
    const h = createHarness();
    const coordinator = new DockWindowCoordinator(h.api);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);

    expect(coordinator.movePanelToMainWindow(h.popoutPanel.id)).toBe(true);

    expect(h.popoutPanel.api.moveTo).toHaveBeenCalledWith({
      group: h.mainPanel.group,
      position: 'center',
      skipSetActive: true,
    });
    focus.mockRestore();
  });
});

describe('DockWindowCoordinator preview place', () => {
  it('opens the first list open as a main tab and marks it as the preview', () => {
    const h = createHarness();
    const slot = new PanelPreviewSlot();
    const coordinator = new DockWindowCoordinator(h.api, slot);

    coordinator.addPanel({ id: 'agent-session-a', component: 'agent-session' }, { kind: 'preview' });

    expect(h.addPanel).toHaveBeenCalledWith(expect.objectContaining({
      position: { referencePanel: h.mainPanel, direction: 'within' },
    }));
    expect(slot.panelId).toBe('agent-session-a');
  });

  it('replaces the preview in its own place on the next list open', () => {
    const h = createHarness();
    const slot = new PanelPreviewSlot();
    const coordinator = new DockWindowCoordinator(h.api, slot);
    const first = coordinator.addPanel({ id: 'agent-session-a', component: 'agent-session' }, { kind: 'preview' });

    coordinator.addPanel({ id: 'agent-session-b', component: 'agent-session' }, { kind: 'preview' });

    expect(h.addPanel).toHaveBeenLastCalledWith(expect.objectContaining({
      id: 'agent-session-b',
      position: { referencePanel: first, direction: 'within', index: 1 },
    }));
    expect(first.api.close).toHaveBeenCalledOnce();
    expect(slot.panelId).toBe('agent-session-b');
  });

  it('keeps a preview the person kept, so the next list open adds a tab', () => {
    const h = createHarness();
    const slot = new PanelPreviewSlot();
    const coordinator = new DockWindowCoordinator(h.api, slot);
    const first = coordinator.addPanel({ id: 'agent-session-a', component: 'agent-session' }, { kind: 'preview' });

    slot.keep(first.id);
    coordinator.addPanel({ id: 'agent-session-b', component: 'agent-session' }, { kind: 'preview' });

    expect(first.api.close).not.toHaveBeenCalled();
    expect(slot.panelId).toBe('agent-session-b');
  });

  it('treats moving a tab as keeping it and forgets a closed preview', () => {
    const h = createHarness();
    const slot = new PanelPreviewSlot();
    const coordinator = new DockWindowCoordinator(h.api, slot);
    const first = coordinator.addPanel({ id: 'agent-session-a', component: 'agent-session' }, { kind: 'preview' });

    h.move(first);
    expect(slot.panelId).toBeNull();

    const second = coordinator.addPanel({ id: 'agent-session-b', component: 'agent-session' }, { kind: 'preview' });
    h.remove(second);
    expect(slot.panelId).toBeNull();
  });

  it('never replaces a preview that sits in another window', () => {
    const h = createHarness();
    const slot = new PanelPreviewSlot();
    const coordinator = new DockWindowCoordinator(h.api, slot);
    slot.mark(h.popoutPanel.id);

    coordinator.addPanel({ id: 'agent-session-b', component: 'agent-session' }, { kind: 'preview' });

    expect(h.popoutPanel.api.close).not.toHaveBeenCalled();
    expect(h.addPanel).toHaveBeenLastCalledWith(expect.objectContaining({
      position: { referencePanel: h.mainPanel, direction: 'within' },
    }));
    expect(slot.panelId).toBe('agent-session-b');
  });

  it('leaves a preview in another group alone and starts a new one where the person works', () => {
    const h = createHarness();
    const slot = new PanelPreviewSlot();
    const coordinator = new DockWindowCoordinator(h.api, slot);
    const otherGroup = { ...h.mainGroup, id: 'other-group', panels: [] as IDockviewPanel[] } as unknown as typeof h.mainGroup;
    const elsewhere = h.makePanel('agent-session-elsewhere', otherGroup, window);
    h.panels.push(elsewhere);
    slot.mark(elsewhere.id);

    coordinator.addPanel({ id: 'agent-session-b', component: 'agent-session' }, { kind: 'preview' });

    expect(elsewhere.api.close).not.toHaveBeenCalled();
    expect(slot.panelId).toBe('agent-session-b');
  });
});
