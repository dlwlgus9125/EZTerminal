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
  navigation,
  terminalActive,
  destinationActive,
  tabRootActive,
  onRequestRoot,
  onRequestTabRoot,
}: {
  readonly terminal: ReactNode;
  readonly page?: ReactNode;
  readonly overlays?: ReactNode;
  /** Persistent shell navigation (tab bar / rail). Rendered outside both the
   * terminal and page layers so a tab switch never remounts it. */
  readonly navigation?: ReactNode;
  readonly terminalActive?: boolean;
  readonly destinationActive?: boolean;
  /** True while the shell is parked on a non-root tab. Owns the Back stop
   * BELOW any open sub-page, which is why the coordinator (rather than each
   * screen) registers it. */
  readonly tabRootActive?: boolean;
  readonly onRequestRoot?: () => void;
  readonly onRequestTabRoot?: () => void;
}): JSX.Element {
  return (
    <MobileNavigationHistoryProvider>
      <MobileWorkbenchLayers
        terminal={terminal}
        page={page}
        overlays={overlays}
        navigation={navigation}
        terminalActive={terminalActive}
        destinationActive={destinationActive}
        tabRootActive={tabRootActive}
        onRequestRoot={onRequestRoot}
        onRequestTabRoot={onRequestTabRoot}
      />
    </MobileNavigationHistoryProvider>
  );
}

function MobileWorkbenchLayers({
  terminal,
  page,
  overlays,
  navigation: navigationSlot,
  terminalActive,
  destinationActive,
  tabRootActive,
  onRequestRoot,
  onRequestTabRoot,
}: {
  readonly terminal: ReactNode;
  readonly page?: ReactNode;
  readonly overlays?: ReactNode;
  readonly navigation?: ReactNode;
  readonly terminalActive?: boolean;
  readonly destinationActive?: boolean;
  readonly tabRootActive?: boolean;
  readonly onRequestRoot?: () => void;
  readonly onRequestTabRoot?: () => void;
}): JSX.Element {
  const terminalLayerRef = useRef<HTMLDivElement | null>(null);
  const pageIsolationOwnerRef = useRef(Symbol('mobile-page-isolation'));
  const layerScope = useId();
  const tabLayerId = `mobile-tab-${layerScope}`;
  const pageLayerId = `mobile-page-${layerScope}`;
  const pageActive = page !== undefined && page !== null;
  const resolvedTerminalActive = terminalActive ?? !pageActive;
  const resolvedDestinationActive = destinationActive ?? pageActive;
  const navigation = useMobileNavigationHistory();
  const requestRootRef = useRef(onRequestRoot ?? (() => undefined));
  requestRootRef.current = onRequestRoot ?? (() => undefined);
  const requestTabRootRef = useRef(onRequestTabRoot ?? (() => undefined));
  requestTabRootRef.current = onRequestTabRoot ?? (() => undefined);

  useLayoutEffect(() => {
    const terminalLayer = terminalLayerRef.current;
    if (!terminalLayer) return;
    const owner = pageIsolationOwnerRef.current;
    setElementIsolated(terminalLayer, owner, !resolvedTerminalActive);
    return () => setElementIsolated(terminalLayer, owner, false);
  }, [resolvedTerminalActive]);

  // Declaration order IS Back order: the tab-root stop must be pushed before
  // the sub-page stop so Back unwinds sub-page -> tab root -> delegate.
  useEffect(() => {
    if (!tabRootActive) return;
    return navigation.pushLayer({
      id: tabLayerId,
      kind: 'page',
      onBack: () => requestTabRootRef.current(),
    });
  }, [navigation, tabLayerId, tabRootActive]);

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
      data-nav={navigationSlot ? 'true' : 'false'}
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
      {navigationSlot}
      <div className="mobile-sheet-dialog-host" data-testid="mobile-sheet-dialog-host">
        {overlays}
      </div>
    </div>
  );
}
