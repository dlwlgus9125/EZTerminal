/** Renderer-local MRU model for Ctrl+Tab pane switching. */

export const RECENT_PANEL_SWITCH_LIMIT = 8;

export interface RecentPanelSwitchSession {
  readonly originPanelId: string;
  readonly panelIds: readonly string[];
  readonly selectedPanelId: string;
}

function uniquePanelIds(panelIds: readonly string[]): string[] {
  return [...new Set(panelIds.filter((panelId) => panelId.length > 0))];
}

/**
 * Build a stable MRU projection over the panels that still exist. The active
 * pane is always first; panels that have never been activated are appended in
 * Dockview order so a newly-created pane remains reachable.
 */
export function buildRecentPanelOrder(
  recentPanelIds: readonly string[],
  availablePanelIds: readonly string[],
  activePanelId: string,
  limit = RECENT_PANEL_SWITCH_LIMIT,
): readonly string[] {
  const available = uniquePanelIds(availablePanelIds);
  const availableSet = new Set(available);
  if (!availableSet.has(activePanelId) || limit <= 0) return [];

  const ordered = [
    activePanelId,
    ...recentPanelIds.filter((panelId) => panelId !== activePanelId && availableSet.has(panelId)),
    ...available.filter((panelId) => panelId !== activePanelId),
  ];
  return uniquePanelIds(ordered).slice(0, limit);
}

/** Keep the unbounded MRU history no larger than the set of live panels. */
export function recordRecentPanelActivation(
  recentPanelIds: readonly string[],
  panelId: string,
  availablePanelIds: readonly string[],
): readonly string[] {
  const available = uniquePanelIds(availablePanelIds);
  const availableSet = new Set(available);
  if (!availableSet.has(panelId)) {
    return recentPanelIds.filter((candidate) => availableSet.has(candidate));
  }
  return uniquePanelIds([
    panelId,
    ...recentPanelIds.filter((candidate) => availableSet.has(candidate)),
    ...available,
  ]);
}

export function startRecentPanelSwitch(
  recentPanelIds: readonly string[],
  availablePanelIds: readonly string[],
  activePanelId: string,
  reverse: boolean,
): RecentPanelSwitchSession | null {
  const panelIds = buildRecentPanelOrder(recentPanelIds, availablePanelIds, activePanelId);
  if (panelIds.length <= 1) return null;
  const selectedIndex = reverse ? panelIds.length - 1 : 1;
  return {
    originPanelId: activePanelId,
    panelIds,
    selectedPanelId: panelIds[selectedIndex],
  };
}

export function advanceRecentPanelSwitch(
  session: RecentPanelSwitchSession,
  reverse: boolean,
): RecentPanelSwitchSession {
  const currentIndex = Math.max(0, session.panelIds.indexOf(session.selectedPanelId));
  const delta = reverse ? -1 : 1;
  const selectedIndex = (
    currentIndex + delta + session.panelIds.length
  ) % session.panelIds.length;
  return { ...session, selectedPanelId: session.panelIds[selectedIndex] };
}

/**
 * Remove panes that disappeared while the modifier is held. Losing the origin
 * or selected pane cancels the interaction instead of committing a stale id.
 */
export function reconcileRecentPanelSwitch(
  session: RecentPanelSwitchSession,
  availablePanelIds: readonly string[],
): RecentPanelSwitchSession | null {
  const available = new Set(uniquePanelIds(availablePanelIds));
  if (!available.has(session.originPanelId) || !available.has(session.selectedPanelId)) return null;
  const panelIds = session.panelIds.filter((panelId) => available.has(panelId));
  if (panelIds.length <= 1) return null;
  return { ...session, panelIds };
}

export interface RecentPanelKeyboardActions {
  isOpen(): boolean;
  cycle(reverse: boolean): void;
  commit(): void;
  cancel(restoreFocus: boolean): void;
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Install capture-phase bindings before xterm or the command composer sees
 * them. Ctrl release commits; Escape and window blur cancel.
 */
export function installRecentPanelKeybindings(
  target: Window,
  actions: RecentPanelKeyboardActions,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) {
      consume(event);
      actions.cycle(event.shiftKey);
      return;
    }
    if (event.code === 'Escape' && actions.isOpen()) {
      consume(event);
      actions.cancel(true);
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    const controlReleased = event.key === 'Control'
      || event.code === 'ControlLeft'
      || event.code === 'ControlRight';
    if (!controlReleased || !actions.isOpen()) return;
    consume(event);
    actions.commit();
  };
  const onBlur = (): void => {
    if (actions.isOpen()) actions.cancel(false);
  };

  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keyup', onKeyUp, true);
  target.addEventListener('blur', onBlur);
  return () => {
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keyup', onKeyUp, true);
    target.removeEventListener('blur', onBlur);
  };
}
