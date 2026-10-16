import type { DockviewApi, IDockviewPanel } from 'dockview-react';

export type WorkbenchLayoutPreset = 'two-by-one' | 'one-plus-two' | 'single' | 'rows';

function moveInto(panel: IDockviewPanel, reference: IDockviewPanel): void {
  if (panel.api.group.id === reference.api.group.id) return;
  panel.api.moveTo({ group: reference.api.group, position: 'center', skipSetActive: true });
}

/**
 * Rearrange the existing Dockview panel nodes only. `renderer: "always"`
 * panels keep their mounted PTY/WebContents state while groups are moved.
 */
export function applyWorkbenchLayoutPreset(
  api: DockviewApi,
  preset: WorkbenchLayoutPreset,
  panelIds?: readonly string[],
): boolean {
  const panels = api.panels.filter(panel => panel.api.location?.type !== 'popout' && (!panelIds || panelIds.includes(panel.id)));
  const active = panels.find(panel => panel.id === api.activePanel?.id) ?? panels[0];
  if (!active) return false;

  if (preset === 'single') {
    if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
    for (const panel of panels) {
      if (panel.id !== active.id) moveInto(panel, active);
    }
    active.api.setActive();
    return true;
  }

  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const rest = panels.filter((panel) => panel.id !== active.id);
  if (rest.length === 0) {
    active.api.setActive();
    return true;
  }

  // First collapse existing non-active groups into the active group. This
  // makes the resulting geometry deterministic without removing a panel.
  for (const panel of rest) moveInto(panel, active);

  const rightTop = rest[0];
  rightTop.api.moveTo({ group: active.api.group, position: preset === 'rows' ? 'bottom' : 'right', skipSetActive: true });

  if (preset === 'one-plus-two' && rest.length > 1) {
    const rightBottom = rest[1];
    rightBottom.api.moveTo({ group: rightTop.api.group, position: 'bottom', skipSetActive: true });
    for (const panel of rest.slice(2)) moveInto(panel, rightBottom);
  } else {
    for (const panel of rest.slice(1)) moveInto(panel, rightTop);
  }

  active.api.setActive();
  return true;
}
