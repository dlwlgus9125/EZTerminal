import { describe, expect, it, vi } from 'vitest';
import type { DockviewApi, IDockviewPanel } from 'dockview-react';

import { findMainGridPanel, movePanelToMainGrid } from './main-window-panel-routing';

function panel(id: string, location: 'grid' | 'popout') {
  return {
    id,
    api: {
      location: { type: location },
      group: { id: `${id}-group` },
      moveTo: vi.fn(),
    },
  } as unknown as IDockviewPanel;
}

describe('main window panel routing', () => {
  it('ignores active popouts and resolves the remembered main-grid panel', () => {
    const main = panel('main', 'grid');
    const popout = panel('popout', 'popout');
    const api = {
      activePanel: popout,
      panels: [popout, main],
      getPanel: (id: string) => [popout, main].find((candidate) => candidate.id === id),
    } as unknown as DockviewApi;

    expect(findMainGridPanel(api, main)).toBe(main);
  });

  it('creates a main grid group before recovering a non-grid panel when no anchor remains', () => {
    const popout = panel('popout', 'popout');
    const group = { id: 'new-main-group' };
    const addGroup = vi.fn(() => group);
    const api = {
      activePanel: popout,
      panels: [popout],
      getPanel: () => popout,
      addGroup,
    } as unknown as DockviewApi;

    movePanelToMainGrid(api, popout);

    expect(addGroup).toHaveBeenCalledWith({ direction: 'right' });
    expect(popout.api.moveTo).toHaveBeenCalledWith({
      group,
      position: 'center',
      skipSetActive: true,
    });
  });
});
