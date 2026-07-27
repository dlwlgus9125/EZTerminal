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
  terminalActive,
  destinationActive,
  onRequestRoot,
  onRequestTerminal,
}: {
  readonly terminal: ReactNode;
  readonly page?: ReactNode;
  readonly overlays?: ReactNode;
  readonly terminalActive?: boolean;
  readonly destinationActive?: boolean;
  readonly onRequestRoot?: () => void;
  /** @deprecated Use onRequestRoot for the hub-centred shell. */
  readonly onRequestTerminal?: () => void;
}): JSX.Element {
  return (
    <MobileNavigationHistoryProvider>
      <MobileWorkbenchLayers
        terminal={terminal}
        page={page}
        overlays={overlays}
        terminalActive={terminalActive}
        destinationActive={destinationActive}
        onRequestRoot={onRequestRoot}
        onRequestTerminal={onRequestTerminal}
      />
    </MobileNavigationHistoryProvider>
  );
}

function MobileWorkbenchLayers({
  terminal,
  page,
  overlays,
  terminalActive,
  destinationActive,
  onRequestRoot,
  onRequestTerminal,
}: {
  readonly terminal: ReactNode;
  readonly page?: ReactNode;
  readonly overlays?: ReactNode;
  readonly terminalActive?: boolean;
  readonly destinationActive?: boolean;
  readonly onRequestRoot?: () => void;
  readonly onRequestTerminal?: () => void;
}): JSX.Element {
  const terminalLayerRef = useRef<HTMLDivElement | null>(null);
  const pageIsolationOwnerRef = useRef(Symbol('mobile-page-isolation'));
  const pageLayerId = `mobile-page-${useId()}`;
  const pageActive = page !== undefined && page !== null;
  const resolvedTerminalActive = terminalActive ?? !pageActive;
  const resolvedDestinationActive = destinationActive ?? pageActive;
  const navigation = useMobileNavigationHistory();
  const requestRootRef = useRef(onRequestRoot ?? onRequestTerminal ?? (() => undefined));
  requestRootRef.current = onRequestRoot ?? onRequestTerminal ?? (() => undefined);

  useLayoutEffect(() => {
    const terminalLayer = terminalLayerRef.current;
    if (!terminalLayer) return;
    const owner = pageIsolationOwnerRef.current;
    setElementIsolated(terminalLayer, owner, !resolvedTerminalActive);
    return () => setElementIsolated(terminalLayer, owner, false);
  }, [resolvedTerminalActive]);

  useEffect(() => {
    if (!resolvedDestinationActive) return;
    return navigation.pushLayer({
      id: pageLayerId,
      kind: 'page',
      onBack: () => requestRootRef.current(),
    });
  }, [navigation, pageLayerId, resolvedDestinationActive]);

  return (
    <div
      className="mobile-workbench-coordinator"
      data-page-active={pageActive ? 'true' : 'false'}
      data-destination-active={resolvedDestinationActive ? 'true' : 'false'}
      data-terminal-active={resolvedTerminalActive ? 'true' : 'false'}
    >
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
