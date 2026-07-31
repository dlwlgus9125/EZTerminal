import type { DockviewApi, IDockviewPanel } from 'dockview-react';

import { AUXILIARY_WINDOW_QUERY } from '../shared/desktop-window';
import {
  pointIsInsideAppWindow,
  registerAuxiliaryWindow,
} from './desktop-window-registry';

const MIN_POPOUT_WIDTH = 640;
const MAX_POPOUT_WIDTH = 1_200;
const MIN_POPOUT_HEIGHT = 400;
const MAX_POPOUT_HEIGHT = 900;

export interface DockviewPopoutBehaviorOptions {
  readonly onOpenFailed?: () => void;
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

export function isDetachableTerminal(panel: IDockviewPanel | undefined): boolean {
  return panel?.api.component === 'terminal';
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
  const popoutUrl = auxiliaryPopoutUrl();

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

  // A popout is terminal-only. This also keeps a whole mixed/non-terminal
  // group from entering through group drag while individual terminal tabs can
  // move freely between main and auxiliary windows.
  disposables.push(api.onWillShowOverlay((event) => {
    if (event.group?.api.location.type !== 'popout') return;
    const transfer = event.getData();
    if (!transfer?.panelId || !isDetachableTerminal(api.getPanel(transfer.panelId))) {
      event.preventDefault();
    }
  }));

  disposables.push(api.onWillDragPanel((event) => {
    if (!isDetachableTerminal(event.panel) || event.nativeEvent.type !== 'dragstart') return;
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
      if (!current || current !== event.panel || !isDetachableTerminal(current)) return;

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
      for (const disposable of disposables.splice(0)) disposable.dispose();
      for (const unregister of registered.values()) unregister();
      registered.clear();
    },
  };
}
