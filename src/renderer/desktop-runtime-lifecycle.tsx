import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { DesktopWindowState, DesktopWindowStatesSnapshot } from '../shared/desktop-window';
import type { RuntimeLifecycleTier } from '../shared/runtime-lifecycle';
import {
  getAppWindows,
  subscribeAuxiliaryWindows,
} from './desktop-window-registry';
import { RuntimeSurfaceLifecycle } from './runtime-lifecycle';

interface RuntimePanelApi {
  readonly isVisible: boolean;
  getWindow(): Window;
  onDidVisibilityChange(listener: (event: { readonly isVisible: boolean }) => void): { dispose(): void };
  onDidLocationChange(listener: () => void): { dispose(): void };
}

const DesktopWindowLifecycleContext = createContext<ReadonlyMap<string, DesktopWindowState>>(new Map());

function logicalWindowName(candidate: Window): string {
  return candidate === window ? 'main' : candidate.name;
}

function applyDocumentTier(candidate: Window, state: DesktopWindowState | undefined): void {
  if (candidate.closed) return;
  const root = candidate.document.documentElement;
  const name = logicalWindowName(candidate);
  root.dataset.runtimeWindowName = name;
  root.dataset.runtimeTier = state?.focused && state.visible && !state.minimized
    ? 'active'
    : 'passive';
}

function snapshotMap(snapshot: DesktopWindowStatesSnapshot): ReadonlyMap<string, DesktopWindowState> {
  return new Map(snapshot.windows.map((state) => [state.windowName, state]));
}

export function DesktopRuntimeLifecycleProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [states, setStates] = useState<ReadonlyMap<string, DesktopWindowState>>(new Map());
  const sequenceRef = useRef(-1);

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop?.getWindowStates || !desktop.onWindowStatesChanged) return;
    let alive = true;
    const accept = (snapshot: DesktopWindowStatesSnapshot): void => {
      if (!alive || snapshot.sequence < sequenceRef.current) return;
      sequenceRef.current = snapshot.sequence;
      setStates(snapshotMap(snapshot));
    };
    void desktop.getWindowStates().then((snapshot) => {
      if (snapshot) accept(snapshot);
    }).catch(() => undefined);
    const unsubscribe = desktop.onWindowStatesChanged(accept);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const sync = (): void => {
      for (const candidate of getAppWindows()) {
        applyDocumentTier(candidate, states.get(logicalWindowName(candidate)));
      }
    };
    sync();
    return subscribeAuxiliaryWindows(sync);
  }, [states]);

  const value = useMemo(() => states, [states]);
  return (
    <DesktopWindowLifecycleContext.Provider value={value}>
      {children}
    </DesktopWindowLifecycleContext.Provider>
  );
}

/** Connects one Dockview panel's live location/visibility to native window
 * state without mounting one IPC subscription per terminal. */
export function usePanelRuntimeLifecycle(api: RuntimePanelApi): RuntimeLifecycleTier {
  const states = useContext(DesktopWindowLifecycleContext);
  const [panelVisible, setPanelVisible] = useState(api.isVisible);
  const [ownerWindow, setOwnerWindow] = useState(() => api.getWindow());
  const [tier, setTier] = useState<RuntimeLifecycleTier>('passive');
  const lifecycleRef = useRef<RuntimeSurfaceLifecycle | null>(null);
  if (lifecycleRef.current === null) {
    lifecycleRef.current = new RuntimeSurfaceLifecycle(setTier);
  }

  useEffect(() => {
    const visibility = api.onDidVisibilityChange((event) => setPanelVisible(event.isVisible));
    const location = api.onDidLocationChange(() => setOwnerWindow(api.getWindow()));
    setPanelVisible(api.isVisible);
    setOwnerWindow(api.getWindow());
    return () => {
      visibility.dispose();
      location.dispose();
    };
  }, [api]);

  useEffect(() => () => lifecycleRef.current?.dispose(), []);

  const native = states.get(logicalWindowName(ownerWindow));
  let fallbackFocused = false;
  try {
    fallbackFocused = ownerWindow.document.hasFocus();
  } catch {
    // A closing popout is treated as non-visible until Dockview relocates it.
  }
  useLayoutEffect(() => {
    lifecycleRef.current?.update({
      panelVisible,
      windowFocused: native?.focused ?? fallbackFocused,
      windowVisible: native?.visible ?? !ownerWindow.closed,
      windowMinimized: native?.minimized ?? ownerWindow.closed,
    });
  }, [fallbackFocused, native, ownerWindow, panelVisible]);
  return tier;
}
