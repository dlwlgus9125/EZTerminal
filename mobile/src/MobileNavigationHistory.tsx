import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export type MobileNavigationLayerKind = 'page' | 'sheet';

export interface MobileNavigationLayer {
  readonly id: string;
  readonly kind: MobileNavigationLayerKind;
  readonly onBack: () => void;
}

export type MobileNavigationCloseReason = 'ui' | 'back';

interface MobileNavigationHistoryValue {
  pushLayer(layer: MobileNavigationLayer): () => void;
  replaceTopLayer(transition: () => void): void;
  closeLayer(id: string, reason: MobileNavigationCloseReason): void;
}

interface NavigationMarker {
  readonly owner: string;
  readonly layerId: string;
  readonly kind: MobileNavigationLayerKind;
}

const HISTORY_KEY = 'ezterminalNavigation';
const LEGACY_PAGE_KEY = 'ezterminalPage';
const LEGACY_SHEET_KEY = 'ezterminalSheet';

const MobileNavigationHistoryContext = createContext<MobileNavigationHistoryValue | null>(null);

function withoutNavigationMarkers(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const copy = { ...(state as Record<string, unknown>) };
  delete copy[HISTORY_KEY];
  delete copy[LEGACY_PAGE_KEY];
  delete copy[LEGACY_SHEET_KEY];
  return copy;
}

function markerFromState(state: unknown): NavigationMarker | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const marker = (state as Record<string, unknown>)[HISTORY_KEY];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const candidate = marker as Partial<NavigationMarker>;
  if (
    typeof candidate.owner !== 'string'
    || typeof candidate.layerId !== 'string'
    || (candidate.kind !== 'page' && candidate.kind !== 'sheet')
  ) return null;
  return candidate as NavigationMarker;
}

/**
 * The authenticated mobile shell's single browser-history owner. React layer
 * lifetimes update one logical stack, while browser traversals are serialized
 * so a programmatic close can never consume a layer opened in the same turn.
 */
export function MobileNavigationHistoryProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const owner = `ezterminal-mobile-${useId()}`;
  const layersRef = useRef<MobileNavigationLayer[]>([]);
  const registrationsRef = useRef(new Set<string>());
  const pendingTraversalRef = useRef(false);
  const replacementRef = useRef<{ fromId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const mountedRef = useRef(true);

  const stateForLayer = useCallback((layer: MobileNavigationLayer, state: unknown): Record<string, unknown> => ({
    ...withoutNavigationMarkers(state),
    [HISTORY_KEY]: {
      owner,
      layerId: layer.id,
      kind: layer.kind,
    } satisfies NavigationMarker,
  }), [owner]);

  const pushHistoryEntry = useCallback((layer: MobileNavigationLayer): void => {
    try {
      window.history.pushState(stateForLayer(layer, window.history.state), '');
    } catch {
      // Explicit controls remain functional in embedded contexts without a
      // writable history implementation.
    }
  }, [stateForLayer]);

  const replaceHistoryEntry = useCallback((layer: MobileNavigationLayer): void => {
    try {
      window.history.replaceState(stateForLayer(layer, window.history.state), '');
    } catch {
      // See pushHistoryEntry: logical navigation does not depend on History.
    }
  }, [stateForLayer]);

  const rebuildDeferredEntries = useCallback((state: unknown): void => {
    const layers = layersRef.current;
    const marker = markerFromState(state);
    const targetIndex = marker?.owner === owner
      ? layers.findIndex((layer) => layer.id === marker.layerId)
      : -1;

    if (marker?.owner === owner && targetIndex < 0) {
      try {
        window.history.replaceState(withoutNavigationMarkers(state), '');
      } catch {
        // Ignore an unavailable History implementation.
      }
    }

    for (const layer of layers.slice(targetIndex + 1)) pushHistoryEntry(layer);
  }, [owner, pushHistoryEntry]);

  const traverseClosedEntries = useCallback((count: number): void => {
    if (count < 1 || pendingTraversalRef.current) return;
    const marker = markerFromState(window.history.state);
    if (marker?.owner !== owner) return;
    pendingTraversalRef.current = true;
    try {
      if (count === 1) window.history.back();
      else window.history.go(-count);
    } catch {
      pendingTraversalRef.current = false;
    }
  }, [owner]);

  const releaseLayer = useCallback((id: string, invokeBack: boolean): void => {
    const index = layersRef.current.findIndex((layer) => layer.id === id);
    if (index < 0) return;
    const removed = layersRef.current.splice(index);
    if (invokeBack) {
      for (const layer of [...removed].reverse()) layer.onBack();
    }
    traverseClosedEntries(removed.length);
  }, [traverseClosedEntries]);

  const pushLayer = useCallback((layer: MobileNavigationLayer): (() => void) => {
    registrationsRef.current.add(layer.id);
    const existing = layersRef.current.find((candidate) => candidate.id === layer.id);
    if (existing) {
      const index = layersRef.current.indexOf(existing);
      layersRef.current[index] = layer;
    } else {
      layersRef.current.push(layer);
      const replacement = replacementRef.current;
      if (replacement) {
        clearTimeout(replacement.timer);
        replacementRef.current = null;
        if (!pendingTraversalRef.current) replaceHistoryEntry(layer);
      } else if (!pendingTraversalRef.current) {
        pushHistoryEntry(layer);
      }
    }

    return () => {
      registrationsRef.current.delete(layer.id);
      // React StrictMode performs setup/cleanup/setup with a stable useId.
      // Deferring release lets that probe re-register without a history hop.
      queueMicrotask(() => {
        if (mountedRef.current && !registrationsRef.current.has(layer.id)) {
          releaseLayer(layer.id, false);
        }
      });
    };
  }, [pushHistoryEntry, releaseLayer, replaceHistoryEntry]);

  const replaceTopLayer = useCallback((transition: () => void): void => {
    const current = layersRef.current[layersRef.current.length - 1];
    if (!current) {
      transition();
      return;
    }

    layersRef.current.pop();
    if (replacementRef.current) clearTimeout(replacementRef.current.timer);
    const timer = setTimeout(() => {
      if (replacementRef.current?.fromId !== current.id) return;
      replacementRef.current = null;
      // No replacement layer mounted. Consume the now-closed layer entry so
      // it cannot become a ghost Back stop.
      traverseClosedEntries(1);
    }, 0);
    replacementRef.current = { fromId: current.id, timer };

    try {
      transition();
    } catch (error) {
      clearTimeout(timer);
      replacementRef.current = null;
      layersRef.current.push(current);
      throw error;
    }
  }, [traverseClosedEntries]);

  const closeLayer = useCallback((id: string, reason: MobileNavigationCloseReason): void => {
    // A history-originated close has already consumed its entry. UI closes
    // are immediate, then the matching synthetic entry is traversed once.
    releaseLayer(id, true);
    if (reason === 'back') pendingTraversalRef.current = false;
  }, [releaseLayer]);

  useEffect(() => {
    mountedRef.current = true;
    const registrations = registrationsRef.current;
    const onPopState = (event: PopStateEvent): void => {
      const state = event.state ?? window.history.state;
      if (pendingTraversalRef.current) {
        pendingTraversalRef.current = false;
        rebuildDeferredEntries(state);
        return;
      }

      const marker = markerFromState(state);
      const layers = layersRef.current;
      const targetIndex = marker?.owner === owner
        ? layers.findIndex((layer) => layer.id === marker.layerId)
        : -1;
      const removed = layers.splice(targetIndex + 1);
      for (const layer of [...removed].reverse()) layer.onBack();
    };

    window.addEventListener('popstate', onPopState);
    const nativeBackHandle = Capacitor.getPlatform() === 'android'
      ? CapacitorApp.addListener('backButton', ({ canGoBack }) => {
          // A programmatic history traversal is already reconciling a UI
          // close. Consuming another Back here could skip the terminal page.
          if (pendingTraversalRef.current || replacementRef.current) return;
          const layers = layersRef.current;
          const top = layers[layers.length - 1];
          if (!top) {
            if (canGoBack) {
              try {
                window.history.back();
                return;
              } catch {
                // If WebView traversal is unavailable, fall through to the
                // same explicit Activity exit used at the history root.
              }
            }
            void CapacitorApp.exitApp().catch((error: unknown) => {
              console.error('[mobile-navigation] Android app exit failed:', error);
            });
            return;
          }

          const marker = markerFromState(window.history.state);
          if (marker?.owner === owner) {
            try {
              window.history.back();
              return;
            } catch {
              // Fall through to the logical layer close below.
            }
          }
          layers.pop();
          top.onBack();
        }).catch((error: unknown) => {
          console.error('[mobile-navigation] Android Back listener failed:', error);
          return null;
        })
      : null;
    return () => {
      mountedRef.current = false;
      window.removeEventListener('popstate', onPopState);
      if (nativeBackHandle) {
        void nativeBackHandle.then((handle) => handle?.remove()).catch(() => undefined);
      }
      const replacementEntryCount = replacementRef.current ? 1 : 0;
      const ownedEntryCount = layersRef.current.length + replacementEntryCount;
      const marker = markerFromState(window.history.state);
      if (marker?.owner === owner && !pendingTraversalRef.current) {
        try {
          if (ownedEntryCount === 1) window.history.back();
          else if (ownedEntryCount > 1) window.history.go(-ownedEntryCount);
          else window.history.replaceState(withoutNavigationMarkers(window.history.state), '');
        } catch {
          try {
            window.history.replaceState(withoutNavigationMarkers(window.history.state), '');
          } catch {
            // Explicit navigation remains usable when History is unavailable.
          }
        }
      }
      if (replacementRef.current) clearTimeout(replacementRef.current.timer);
      replacementRef.current = null;
      layersRef.current = [];
      registrations.clear();
      pendingTraversalRef.current = false;
    };
  }, [owner, rebuildDeferredEntries]);

  const value = useMemo<MobileNavigationHistoryValue>(() => ({
    pushLayer,
    replaceTopLayer,
    closeLayer,
  }), [closeLayer, pushLayer, replaceTopLayer]);

  return (
    <MobileNavigationHistoryContext.Provider value={value}>
      {children}
    </MobileNavigationHistoryContext.Provider>
  );
}

export function useMobileNavigationHistory(): MobileNavigationHistoryValue {
  const value = useContext(MobileNavigationHistoryContext);
  if (!value) throw new Error('Mobile navigation layers require MobileNavigationHistoryProvider');
  return value;
}
