import type { DockviewApi, IDockviewPanel } from 'dockview-react';

interface ReviewLayoutGroupSnapshot {
  readonly id: string;
  readonly panelIds: readonly string[];
  readonly activePanelId?: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ProjectReviewLayoutSnapshot {
  readonly panelIds: ReadonlySet<string>;
  readonly activePanelId?: string;
  readonly maximizedGroupId?: string;
  readonly focusedElement?: HTMLElement;
  readonly groups: readonly ReviewLayoutGroupSnapshot[];
}

export type ProjectReviewLayoutMode = 'wide' | 'narrow';

function gridPanels(api: DockviewApi): readonly IDockviewPanel[] {
  return api.panels.filter((panel) => panel.api.location.type === 'grid');
}

function moveInto(panel: IDockviewPanel, reference: IDockviewPanel): void {
  if (panel.api.group.id === reference.api.group.id) return;
  panel.api.moveTo({ group: reference.api.group, position: 'center', skipSetActive: true });
}

interface LayoutInteractionState {
  readonly activePanel?: IDockviewPanel;
  readonly focusedElement?: HTMLElement;
  readonly groupActivePanels: readonly {
    readonly groupId: string;
    readonly panel: IDockviewPanel;
  }[];
  readonly maximizedGroup?: {
    readonly groupId: string;
    readonly representative?: IDockviewPanel;
  };
}

function currentFocusedElement(): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const element = document.activeElement;
  return element && typeof (element as HTMLElement).focus === 'function'
    ? element as HTMLElement
    : undefined;
}

function restoreFocus(element: HTMLElement | undefined): void {
  if (!element || element.isConnected === false) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function captureInteractionState(api: DockviewApi): LayoutInteractionState {
  const gridGroups = api.groups.filter((group) => group.activePanel?.api.location.type === 'grid');
  const maximizedGroup = gridGroups.find((group) => group.api.isMaximized());
  const focusedElement = currentFocusedElement();
  const maximizedRepresentative = maximizedGroup?.activePanel ?? maximizedGroup?.panels[0];
  return {
    ...(api.activePanel ? { activePanel: api.activePanel } : {}),
    ...(focusedElement ? { focusedElement } : {}),
    groupActivePanels: gridGroups.flatMap((group) => (
      group.activePanel ? [{ groupId: group.id, panel: group.activePanel }] : []
    )),
    ...(maximizedGroup ? {
      maximizedGroup: {
        groupId: maximizedGroup.id,
        ...(maximizedRepresentative ? { representative: maximizedRepresentative } : {}),
      },
    } : {}),
  };
}

function restoreMaximizedGroup(api: DockviewApi, state: LayoutInteractionState): void {
  const maximized = state.maximizedGroup;
  if (!maximized) return;
  const exactGroup = api.groups.find((group) => (
    group.id === maximized.groupId && group.panels.length > 0
  ));
  const fallback = maximized.representative?.api.location.type === 'grid'
    ? maximized.representative
    : undefined;
  const representative = exactGroup?.activePanel ?? exactGroup?.panels[0] ?? fallback;
  if (representative) api.maximizeGroup(representative);
}

function restoreInteractionState(api: DockviewApi, state: LayoutInteractionState): void {
  restoreMaximizedGroup(api, state);
  for (const saved of state.groupActivePanels) {
    const group = api.groups.find((candidate) => candidate.id === saved.groupId);
    if (
      group
      && saved.panel.api.location.type === 'grid'
      && saved.panel.api.group.id === group.id
      && group.activePanel?.id !== saved.panel.id
    ) {
      saved.panel.api.setActive();
    }
  }
  if (
    state.activePanel?.api.location.type === 'grid'
    && api.activePanel?.id !== state.activePanel.id
  ) {
    state.activePanel.api.setActive();
  }
  restoreFocus(state.focusedElement);
}

/** Captures topology and interaction state; PTY contents and renderer instances
 * never leave their existing Dockview panel nodes. */
export function captureProjectReviewLayout(api: DockviewApi): ProjectReviewLayoutSnapshot {
  const groups = api.groups
    .filter((group) => group.activePanel?.api.location.type === 'grid')
    .map((group) => {
      const rect = group.element.getBoundingClientRect();
      return {
        id: group.id,
        panelIds: group.panels.map((panel) => panel.id),
        ...(group.activePanel ? { activePanelId: group.activePanel.id } : {}),
        x: rect.left,
        y: rect.top,
        width: group.width,
        height: group.height,
      };
    });
  const maximizedGroup = api.groups.find((group) => group.api.isMaximized());
  const focusedElement = currentFocusedElement();
  return {
    panelIds: new Set(groups.flatMap((group) => group.panelIds)),
    ...(api.activePanel ? { activePanelId: api.activePanel.id } : {}),
    ...(maximizedGroup ? { maximizedGroupId: maximizedGroup.id } : {}),
    ...(focusedElement ? { focusedElement } : {}),
    groups,
  };
}

/** Builds the project geometry by moving only mounted editor nodes. Wide mode
 * creates one root-level editor row and leaves the complete PTY/Agent grid
 * below it intact. Narrow mode tabs the editor with the active live panel.
 * Popouts and renderer instances are never replaced. */
export function applyProjectReviewLayout(
  api: DockviewApi,
  editor: IDockviewPanel,
  mode: ProjectReviewLayoutMode = 'wide',
): boolean {
  if (editor.api.location.type !== 'grid') return false;
  const interaction = captureInteractionState(api);
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const panels = gridPanels(api);
  const editors = panels.filter((panel) => panel.api.component === 'project-editor');
  const livePanels = panels.filter((panel) => panel.api.component !== 'project-editor');
  if (livePanels.length === 0) {
    restoreInteractionState(api, interaction);
    return true;
  }

  if (mode === 'narrow') {
    const reference = api.activePanel?.api.location.type === 'grid'
      && api.activePanel.api.component !== 'project-editor'
      ? api.activePanel
      : livePanels[0]!;
    for (const projectEditor of editors) moveInto(projectEditor, reference);
    restoreInteractionState(api, interaction);
    return true;
  }

  const editorOnlyGroup = editors.find((candidate) => (
    candidate.api.group.panels.every((panel) => panel.api.component === 'project-editor')
  ))?.api.group;
  const topGroup = editorOnlyGroup ?? api.addGroup({ direction: 'above', skipSetActive: true });
  for (const projectEditor of editors) {
    if (projectEditor.api.group.id !== topGroup.id) {
      projectEditor.api.moveTo({ group: topGroup, position: 'center', skipSetActive: true });
    }
  }
  topGroup.api.setSize({ height: Math.max(240, Math.round(api.height * 0.68)) });
  restoreInteractionState(api, interaction);
  return true;
}

function center(group: ReviewLayoutGroupSnapshot): { x: number; y: number } {
  return { x: group.x + group.width / 2, y: group.y + group.height / 2 };
}

/** Restores the captured group membership and geometry without fromJSON, so
 * mounted PTYs and their draft/output/focus state survive. Panels opened during
 * review are attached to the former active group. */
export function restoreProjectReviewLayout(
  api: DockviewApi,
  snapshot: ProjectReviewLayoutSnapshot,
): boolean {
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
  const available = new Map(gridPanels(api).map((panel) => [panel.id, panel]));
  const savedGroups = snapshot.groups
    .map((group) => ({
      ...group,
      panels: group.panelIds.map((id) => available.get(id)).filter((panel): panel is IDockviewPanel => Boolean(panel)),
    }))
    .filter((group) => group.panels.length > 0)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const anchor = (snapshot.activePanelId ? available.get(snapshot.activePanelId) : undefined)
    ?? savedGroups[0]?.panels[0]
    ?? gridPanels(api)[0];
  if (!anchor) {
    restoreFocus(snapshot.focusedElement);
    return false;
  }
  for (const panel of gridPanels(api)) moveInto(panel, anchor);

  const created: Array<{ snapshot: ReviewLayoutGroupSnapshot; representative: IDockviewPanel }> = [];
  for (const [index, group] of savedGroups.entries()) {
    const representative = group.panels[0]!;
    if (index > 0) {
      const targetCenter = center(group);
      const reference = created.reduce((best, candidate) => {
        const candidateCenter = center(candidate.snapshot);
        const distance = Math.hypot(targetCenter.x - candidateCenter.x, targetCenter.y - candidateCenter.y);
        if (!best || distance < best.distance) return { candidate, distance };
        return best;
      }, null as { candidate: typeof created[number]; distance: number } | null)?.candidate;
      if (reference) {
        const from = center(reference.snapshot);
        const dx = targetCenter.x - from.x;
        const dy = targetCenter.y - from.y;
        const position = Math.abs(dx) >= Math.abs(dy)
          ? dx >= 0 ? 'right' as const : 'left' as const
          : dy >= 0 ? 'bottom' as const : 'top' as const;
        representative.api.moveTo({
          group: reference.representative.api.group,
          position,
          skipSetActive: true,
        });
      }
    }
    for (const panel of group.panels.slice(1)) moveInto(panel, representative);
    created.push({ snapshot: group, representative });
  }

  const formerActive = snapshot.activePanelId ? available.get(snapshot.activePanelId) : undefined;
  const destination = formerActive ?? savedGroups[0]?.panels[0] ?? anchor;
  for (const panel of gridPanels(api)) {
    if (!snapshot.panelIds.has(panel.id)) moveInto(panel, destination);
  }
  for (const group of created) {
    group.representative.api.group.api.setSize({
      width: Math.max(120, Math.round(group.snapshot.width)),
      height: Math.max(100, Math.round(group.snapshot.height)),
    });
  }
  if (snapshot.maximizedGroupId) {
    const maximized = created.find((group) => group.snapshot.id === snapshot.maximizedGroupId);
    if (maximized) api.maximizeGroup(maximized.representative);
  }
  for (const group of created) {
    const savedActive = group.snapshot.activePanelId
      ? available.get(group.snapshot.activePanelId)
      : undefined;
    if (
      savedActive
      && savedActive.api.group.id === group.representative.api.group.id
      && savedActive.api.group.activePanel?.id !== savedActive.id
    ) {
      savedActive.api.setActive();
    }
  }
  if (api.activePanel?.id !== (formerActive ?? destination).id) {
    (formerActive ?? destination).api.setActive();
  }
  restoreFocus(snapshot.focusedElement);
  return true;
}
