import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';

const activePageMarkers = new Set<string>();

/**
 * Keeps terminal-owned React/xterm state alive while opaque auxiliary pages
 * and modal surfaces are shown as siblings. This is the authenticated mobile
 * shell's only lifetime boundary.
 */
export function MobileWorkbenchCoordinator({
  terminal,
  page,
  overlays,
  onRequestTerminal,
}: {
  readonly terminal: ReactNode;
  readonly page?: ReactNode;
  readonly overlays?: ReactNode;
  readonly onRequestTerminal: () => void;
}): JSX.Element {
  const terminalLayerRef = useRef<HTMLDivElement | null>(null);
  const markerId = useId();
  const pageActive = page !== undefined && page !== null;
  const requestTerminalRef = useRef(onRequestTerminal);
  requestTerminalRef.current = onRequestTerminal;

  useLayoutEffect(() => {
    const terminalLayer = terminalLayerRef.current;
    if (!terminalLayer) return;
    terminalLayer.inert = pageActive;
    terminalLayer.toggleAttribute('inert', pageActive);
  }, [pageActive]);

  useEffect(() => {
    if (!pageActive) return;
    const marker = `ezterminal-page-${markerId}`;
    let pushed = false;
    let closedFromHistory = false;
    activePageMarkers.add(marker);

    try {
      if (window.history.state?.ezterminalPage !== marker) {
        window.history.pushState({ ...window.history.state, ezterminalPage: marker }, '');
      }
      pushed = true;
    } catch {
      // Embedded/test contexts may not expose navigation history. Explicit
      // Back controls remain the complete fallback.
    }

    const onPopState = (): void => {
      // A sheet pushes its own history entry on top of the active page. When
      // Android Back removes only that sheet entry, the page marker is still
      // current and the page must remain mounted behind the dismissing sheet.
      if (window.history.state?.ezterminalPage === marker) return;
      closedFromHistory = true;
      requestTerminalRef.current();
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      activePageMarkers.delete(marker);
      queueMicrotask(() => {
        if (
          pushed
          && !closedFromHistory
          && !activePageMarkers.has(marker)
          && window.history.state?.ezterminalPage === marker
        ) window.history.back();
      });
    };
  }, [markerId, pageActive]);

  return (
    <div className="mobile-workbench-coordinator" data-page-active={pageActive ? 'true' : 'false'}>
      <div
        ref={terminalLayerRef}
        className="mobile-terminal-layer"
        aria-hidden={pageActive ? true : undefined}
        data-testid="mobile-terminal-layer"
      >
        {terminal}
      </div>
      {pageActive && (
        <section className="mobile-page-shell" data-testid="mobile-page-shell">
          {page}
        </section>
      )}
      <div className="mobile-sheet-dialog-host" data-testid="mobile-sheet-dialog-host">
        {overlays}
      </div>
    </div>
  );
}
