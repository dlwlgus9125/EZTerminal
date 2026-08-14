import { useLayoutEffect, useState, type RefObject } from 'react';
import type { DockviewPanelApi } from 'dockview-react';

export interface DockPanelHost {
  readonly ownerDocument: Document;
  readonly ownerWindow: Window & typeof globalThis;
  readonly revision: number;
}

function initialHost(): DockPanelHost {
  return { ownerDocument: document, ownerWindow: window, revision: 0 };
}

/** Tracks the actual document that owns a live Dockview-reparented node. */
export function useDockPanelHost(
  elementRef: RefObject<HTMLElement>,
  panelApi?: DockviewPanelApi,
): DockPanelHost {
  const [host, setHost] = useState<DockPanelHost>(initialHost);

  useLayoutEffect(() => {
    let disposed = false;
    let observedDocument: Document | null = null;
    let observer: MutationObserver | null = null;

    const refresh = (): void => {
      if (disposed) return;
      const element = elementRef.current;
      const ownerDocument = element?.ownerDocument;
      const ownerWindow = ownerDocument?.defaultView as (Window & typeof globalThis) | null;
      if (!element || !ownerDocument || !ownerWindow || ownerWindow.closed) return;
      if (observedDocument !== ownerDocument) {
        observer?.disconnect();
        observedDocument = ownerDocument;
        const Observer = ownerWindow.MutationObserver;
        observer = new Observer(() => {
          if (elementRef.current?.ownerDocument !== observedDocument) refresh();
        });
        observer.observe(ownerDocument.documentElement, { childList: true, subtree: true });
      }
      setHost((current) => (
        current.ownerDocument === ownerDocument && current.ownerWindow === ownerWindow
          ? current
          : { ownerDocument, ownerWindow, revision: current.revision + 1 }
      ));
    };

    refresh();
    const locationDisposable = panelApi?.onDidLocationChange?.(() => {
      const targetWindow = elementRef.current?.ownerDocument.defaultView;
      (targetWindow ?? window).requestAnimationFrame(refresh);
    });
    return () => {
      disposed = true;
      locationDisposable?.dispose();
      observer?.disconnect();
    };
  }, [elementRef, panelApi]);

  return host;
}
