import type { DockviewApi, IDockviewPanel } from 'dockview-react';

/** Resolve a stable anchor that is physically hosted by the main Dockview grid. */
export function findMainGridPanel(
  api: DockviewApi,
  preferred?: IDockviewPanel | null,
): IDockviewPanel | undefined {
  if (
    preferred
    && api.getPanel(preferred.id) === preferred
    && preferred.api.location.type === 'grid'
  ) {
    return preferred;
  }
  if (api.activePanel?.api.location.type === 'grid') return api.activePanel;
  return api.panels.find((panel) => panel.api.location.type === 'grid');
}

/**
 * Recover a main-owned panel from a floating/popout location. An empty main
 * workspace gets a real grid group first, so recovery also works when every
 * detachable pane currently lives in an auxiliary window.
 */
export function movePanelToMainGrid(
  api: DockviewApi,
  panel: IDockviewPanel,
  preferred?: IDockviewPanel | null,
): void {
  if (panel.api.location.type === 'grid') return;
  const reference = findMainGridPanel(api, preferred);
  const group = reference?.api.group ?? api.addGroup({ direction: 'right' });
  panel.api.moveTo({ group, position: 'center', skipSetActive: true });
}
