// @vitest-environment jsdom

import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';

import { DockWindowCoordinator } from './dock-window-coordinator';

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
  const addPopoutGroup = vi.fn(async () => true);
  const api = {
    panels,
    groups: [mainGroup, popoutGroup],
    activePanel: popoutPanel,
    getPanel: (id: string) => panels.find((panel) => panel.id === id),
    addPanel,
    addPopoutGroup,
    onDidActivePanelChange: vi.fn(() => disposable()),
    onDidMovePanel: vi.fn(() => disposable()),
    onDidRemovePanel: vi.fn(() => disposable()),
  } as unknown as DockviewApi;

  return { api, addPanel, addPopoutGroup, auxiliary, mainPanel, popoutPanel };
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
