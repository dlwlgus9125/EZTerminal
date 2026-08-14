import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview-react';

import {
  AUXILIARY_WINDOW_QUERY,
  isDetachablePanelComponent,
} from '../shared/desktop-window';
import {
  pointIsInsideAppWindow,
  registerAuxiliaryWindow,
} from './desktop-window-registry';

const MIN_POPOUT_WIDTH = 640;
const MAX_POPOUT_WIDTH = 1_200;
const MIN_POPOUT_HEIGHT = 400;
const MAX_POPOUT_HEIGHT = 900;
const CROSS_WINDOW_FOCUS_TIMEOUT_MS = 2_000;

export interface DockviewPopoutBehaviorOptions {
  readonly onOpenFailed?: () => void;
  readonly onPanelMovedAcrossWindows?: (panelId: string) => boolean;
  readonly onNonDetachablePanelInPopout?: (panel: IDockviewPanel) => void;
}

type DockviewDragSubject =
  | {
      readonly kind: 'panel';
      readonly groupId: string;
      readonly panelId: string;
      readonly panel: IDockviewPanel;
    }
  | {
      readonly kind: 'group';
      readonly groupId: string;
      readonly panelId: null;
      readonly group: DockviewGroupPanel;
    };

interface DockviewDragTransaction {
  readonly subject: DockviewDragSubject;
  readonly sourceElement: HTMLElement;
  readonly sourceWindow: Window;
  readonly onDragEnd: (event: Event) => void;
  readonly onEscape: (event: KeyboardEvent) => void;
  dockviewDropCompleted: boolean;
  cancelled: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

export function auxiliaryPopoutUrl(location: Location = window.location): string {
  const url = new URL(location.href);
  url.search = `?${AUXILIARY_WINDOW_QUERY}`;
  url.hash = '';
  return url.href;
}

export function isDetachablePanel(panel: IDockviewPanel | undefined): boolean {
  return isDetachablePanelComponent(panel?.api.component);
}

function isDetachableGroup(group: DockviewGroupPanel | undefined): boolean {
  return Boolean(group && group.panels.length > 0 && group.panels.every(isDetachablePanel));
}

function transferMatches(
  transaction: DockviewDragTransaction,
  transfer: { readonly groupId: string; readonly panelId: string | null } | undefined,
): boolean {
  return Boolean(
    transfer
    && transfer.groupId === transaction.subject.groupId
    && transfer.panelId === transaction.subject.panelId,
  );
}

/**
 * Adds native-window behavior around Dockview's live DOM reparenting. Nothing
 * here serializes a session or remounts a React tree.
 */
export function installDockviewPopoutBehavior(
  api: DockviewApi,
  options: DockviewPopoutBehaviorOptions = {},
): { dispose(): void } {
  const disposables: Array<{ dispose(): void }> = [];
  const registered = new Map<Window, () => void>();
  const focusGenerations = new WeakMap<IDockviewPanel, number>();
  const popoutUrl = auxiliaryPopoutUrl();
  let disposed = false;
  let activeDrag: DockviewDragTransaction | null = null;

  const register = (target: Window): void => {
    if (registered.has(target)) return;
    registered.set(target, registerAuxiliaryWindow(target));
  };
  for (const popout of api.getPopouts()) register(popout.window);

  disposables.push(api.onDidAddPopoutGroup((popout) => register(popout.window)));
  disposables.push(api.onDidRemovePopoutGroup((popout) => {
    registered.get(popout.window)?.();
    registered.delete(popout.window);
  }));
  disposables.push(api.onDidOpenPopoutWindowFail(() => options.onOpenFailed?.()));

  const enforcePanelLocation = (panel: IDockviewPanel): boolean => {
    if (isDetachablePanel(panel) || panel.api.location.type !== 'popout') return false;
    options.onNonDetachablePanelInPopout?.(panel);
    return true;
  };
  const deferPanelLocationCheck = (panel: IDockviewPanel): void => {
    queueMicrotask(() => {
      if (!disposed && api.getPanel(panel.id) === panel) enforcePanelLocation(panel);
    });
  };
  disposables.push(api.onDidAddPanel(deferPanelLocationCheck));
  disposables.push(api.onDidLayoutFromJSON(() => {
    for (const panel of api.panels) deferPanelLocationCheck(panel);
  }));

  // Reject unknown/unsupported transfers before Dockview mutates a popout.
  disposables.push(api.onWillShowOverlay((event) => {
    if (event.group?.api.location.type !== 'popout') return;
    const transfer = event.getData();
    const allowed = transfer?.panelId
      ? isDetachablePanel(api.getPanel(transfer.panelId))
      : isDetachableGroup(api.groups.find((group) => group.id === transfer?.groupId));
    if (!allowed) {
      event.preventDefault();
    }
  }));

  disposables.push(api.onDidMovePanel(({ panel, from }) => {
    if (enforcePanelLocation(panel)) return;
    const generation = (focusGenerations.get(panel) ?? 0) + 1;
    focusGenerations.set(panel, generation);
    const sourceWindow = from.api.getWindow();
    const destinationWindow = panel.api.getWindow();
    if (
      sourceWindow === destinationWindow
      || destinationWindow.closed
      || !options.onPanelMovedAcrossWindows
    ) {
      return;
    }
    const focus = options.onPanelMovedAcrossWindows;
    const expiresAt = destinationWindow.performance.now() + CROSS_WINDOW_FOCUS_TIMEOUT_MS;
    // Dockview schedules an `always` renderer's overlay positioning from the
    // main realm, while this destination window has an independent frame
    // clock. Wait until the live input actually accepts focus; a fixed number
    // of destination frames cannot order those two clocks.
    const focusWhenReady = (): void => {
      if (
        disposed
        || destinationWindow.closed
        || focusGenerations.get(panel) !== generation
        || api.getPanel(panel.id) !== panel
        || panel.api.getWindow() !== destinationWindow
        || api.activePanel !== panel
      ) {
        return;
      }
      if (focus(panel.id) || destinationWindow.performance.now() >= expiresAt) return;
      destinationWindow.requestAnimationFrame(focusWhenReady);
    };
    destinationWindow.requestAnimationFrame(focusWhenReady);
  }));

  const clearActiveDrag = (transaction = activeDrag): void => {
    if (!transaction) return;
    transaction.sourceElement.removeEventListener('dragend', transaction.onDragEnd, true);
    transaction.sourceWindow.removeEventListener('keydown', transaction.onEscape, true);
    if (activeDrag === transaction) activeDrag = null;
  };

  const startDrag = (subject: DockviewDragSubject, nativeEvent: DragEvent): void => {
    clearActiveDrag();
    const eventTarget = nativeEvent.currentTarget as HTMLElement | null;
    const sourceElement = eventTarget?.ownerDocument
      ? eventTarget
      : subject.kind === 'panel'
        ? subject.panel.group.element
        : subject.group.element;
    const sourceWindow = sourceElement.ownerDocument.defaultView ?? window;

    const transaction = {} as DockviewDragTransaction;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && activeDrag === transaction) transaction.cancelled = true;
    };
    const onDragEnd = (event: Event): void => {
      if (activeDrag !== transaction) return;
      clearActiveDrag(transaction);
      const dragEvent = event as DragEvent;
      if (
        transaction.cancelled
        || transaction.dockviewDropCompleted
        || pointIsInsideAppWindow(dragEvent.screenX, dragEvent.screenY)
      ) {
        return;
      }

      const item = transaction.subject.kind === 'panel'
        ? api.getPanel(transaction.subject.panelId)
        : api.groups.find((group) => group.id === transaction.subject.groupId);
      if (!item) return;
      if (transaction.subject.kind === 'panel') {
        if (
          item !== transaction.subject.panel
          || !isDetachablePanel(item as IDockviewPanel)
          || (
            (item as IDockviewPanel).api.location.type === 'popout'
            && (item as IDockviewPanel).group.panels.length === 1
          )
        ) return;
      } else if (
        item !== transaction.subject.group
        || !isDetachableGroup(item as DockviewGroupPanel)
        || (item as DockviewGroupPanel).api.location.type === 'popout'
      ) {
        return;
      }

      const group = transaction.subject.kind === 'panel'
        ? (item as IDockviewPanel).group
        : item as DockviewGroupPanel;
      const groupRect = group.element.getBoundingClientRect();
      const screenX = Number.isFinite(dragEvent.screenX)
        ? dragEvent.screenX
        : transaction.sourceWindow.screenX + groupRect.left;
      const screenY = Number.isFinite(dragEvent.screenY)
        ? dragEvent.screenY
        : transaction.sourceWindow.screenY + groupRect.top;
      const position = {
        // Dockview adds the main realm's screen origin when opening.
        left: screenX - window.screenX - 120,
        top: screenY - window.screenY - 18,
        width: clamp(groupRect.width, MIN_POPOUT_WIDTH, MAX_POPOUT_WIDTH),
        height: clamp(groupRect.height, MIN_POPOUT_HEIGHT, MAX_POPOUT_HEIGHT),
      };
      void api.addPopoutGroup(item, { position, popoutUrl }).then((opened) => {
        if (!opened) options.onOpenFailed?.();
      }).catch(() => options.onOpenFailed?.());
    };
    Object.assign(transaction, {
      subject,
      sourceElement,
      sourceWindow,
      onDragEnd,
      onEscape,
      dockviewDropCompleted: false,
      cancelled: false,
    });
    activeDrag = transaction;
    sourceElement.addEventListener('dragend', onDragEnd, { capture: true, once: true });
    sourceWindow.addEventListener('keydown', onEscape, true);
  };

  // Correlate a Dockview-handled drop with the one active native drag. A
  // permanent subscription avoids one global listener per gesture and keeps
  // unrelated drops from completing a stale transaction.
  disposables.push(api.onWillDrop((event) => {
    const transaction = activeDrag;
    if (!transaction || !transferMatches(transaction, event.getData())) return;
    queueMicrotask(() => {
      if (activeDrag === transaction && !event.defaultPrevented) {
        transaction.dockviewDropCompleted = true;
      }
    });
  }));
  disposables.push(api.onDidDrop((event) => {
    const transaction = activeDrag;
    if (transaction && transferMatches(transaction, event.getData())) {
      transaction.dockviewDropCompleted = true;
    }
  }));

  disposables.push(api.onWillDragPanel((event) => {
    if (!isDetachablePanel(event.panel) || event.nativeEvent.type !== 'dragstart') return;
    startDrag({
      kind: 'panel',
      groupId: event.panel.group.id,
      panelId: event.panel.id,
      panel: event.panel,
    }, event.nativeEvent as DragEvent);
  }));
  disposables.push(api.onWillDragGroup((event) => {
    if (!isDetachableGroup(event.group) || event.nativeEvent.type !== 'dragstart') return;
    startDrag({
      kind: 'group',
      groupId: event.group.id,
      panelId: null,
      group: event.group,
    }, event.nativeEvent as DragEvent);
  }));

  return {
    dispose: () => {
      disposed = true;
      clearActiveDrag();
      for (const disposable of disposables.splice(0)) disposable.dispose();
      for (const unregister of registered.values()) unregister();
      registered.clear();
    },
  };
}
