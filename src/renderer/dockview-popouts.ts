import type { DockviewApi, IDockviewPanel } from 'dockview-react';

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

  // A popout accepts DOM-backed terminal and Agent Session panels. Keep
  // main-owned native surfaces such as OpenClaw chat out of auxiliary windows.
  disposables.push(api.onWillShowOverlay((event) => {
    if (event.group?.api.location.type !== 'popout') return;
    const transfer = event.getData();
    if (!transfer?.panelId || !isDetachablePanel(api.getPanel(transfer.panelId))) {
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

  disposables.push(api.onWillDragPanel((event) => {
    if (!isDetachablePanel(event.panel) || event.nativeEvent.type !== 'dragstart') return;
    const sourceDocument = (event.nativeEvent.target as Node | null)?.ownerDocument
      ?? event.panel.group.element.ownerDocument;
    let dockviewDropCompleted = false;
    const dropDisposable = api.onDidDrop(() => {
      dockviewDropCompleted = true;
    });

    const onDragEnd = (nativeEvent: Event): void => {
      dropDisposable.dispose();
      const dragEvent = nativeEvent as DragEvent;
      if (
        dockviewDropCompleted
        || pointIsInsideAppWindow(dragEvent.screenX, dragEvent.screenY)
      ) {
        return;
      }
      const current = api.getPanel(event.panel.id);
      if (!current || current !== event.panel || !isDetachablePanel(current)) return;

      const groupRect = current.group.element.getBoundingClientRect();
      const sourceWindow = sourceDocument.defaultView ?? window;
      const screenX = Number.isFinite(dragEvent.screenX)
        ? dragEvent.screenX
        : sourceWindow.screenX + groupRect.left;
      const screenY = Number.isFinite(dragEvent.screenY)
        ? dragEvent.screenY
        : sourceWindow.screenY + groupRect.top;
      const position = {
        // Dockview adds the main realm's screen origin when opening.
        left: screenX - window.screenX - 120,
        top: screenY - window.screenY - 18,
        width: clamp(groupRect.width, MIN_POPOUT_WIDTH, MAX_POPOUT_WIDTH),
        height: clamp(groupRect.height, MIN_POPOUT_HEIGHT, MAX_POPOUT_HEIGHT),
      };
      void api.addPopoutGroup(current, { position, popoutUrl }).then((opened) => {
        if (!opened) options.onOpenFailed?.();
      }).catch(() => options.onOpenFailed?.());
    };
    sourceDocument.addEventListener('dragend', onDragEnd, { capture: true, once: true });
  }));

  return {
    dispose: () => {
      disposed = true;
      for (const disposable of disposables.splice(0)) disposable.dispose();
      for (const unregister of registered.values()) unregister();
      registered.clear();
    },
  };
}
