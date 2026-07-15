import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';

import {
  MobileNavigationHistoryProvider,
  useMobileNavigationHistory,
} from './MobileNavigationHistory';
import { setElementIsolated } from './dom-isolation';

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
  return (
    <MobileNavigationHistoryProvider>
      <MobileWorkbenchLayers
        terminal={terminal}
        page={page}
        overlays={overlays}
        onRequestTerminal={onRequestTerminal}
      />
    </MobileNavigationHistoryProvider>
  );
}

function MobileWorkbenchLayers({
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
  const pageIsolationOwnerRef = useRef(Symbol('mobile-page-isolation'));
  const pageLayerId = `mobile-page-${useId()}`;
  const pageActive = page !== undefined && page !== null;
  const navigation = useMobileNavigationHistory();
  const requestTerminalRef = useRef(onRequestTerminal);
  requestTerminalRef.current = onRequestTerminal;

  useLayoutEffect(() => {
    const terminalLayer = terminalLayerRef.current;
    if (!terminalLayer) return;
    const owner = pageIsolationOwnerRef.current;
    setElementIsolated(terminalLayer, owner, pageActive);
    return () => setElementIsolated(terminalLayer, owner, false);
  }, [pageActive]);

  useEffect(() => {
    if (!pageActive) return;
    return navigation.pushLayer({
      id: pageLayerId,
      kind: 'page',
      onBack: () => requestTerminalRef.current(),
    });
  }, [navigation, pageActive, pageLayerId]);

  return (
    <div className="mobile-workbench-coordinator" data-page-active={pageActive ? 'true' : 'false'}>
      <div
        ref={terminalLayerRef}
        className="mobile-terminal-layer"
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
