import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

import type { OpenClawChatViewState, OpenClawStatus, OpenClawStatusState } from '../shared/openclaw';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useAppTranslation } from './i18n';
import { useNativeOverlayOpen } from './native-overlay';
import { useDockPanelHost } from './use-dock-panel-host';

/**
 * Whether any overlay that visually sits above the dockview area (drawer/
 * palette/menu) is currently open — App.tsx computes this as a single
 * derivation from its own state and provides it here. The chat panel ANDs
 * this with its own dockview visibility (`props.api.isVisible`) to get
 * "effective visibility" (architecture decision (a)'s z-order rule): the
 * native WebContentsView paints above the renderer DOM, so it must be
 * explicitly hidden whenever a DOM overlay would otherwise sit underneath it.
 * Defaults to `false` (no overlay) so a panel rendered outside App's
 * provider — e.g. an isolated unit test — doesn't spuriously hide the view.
 */
export const OpenClawOverlayContext = createContext<boolean>(false);

/** Throttles the ResizeObserver/scroll/layout-change bounds reports to one
 * per animation frame — dockview drag-resize and window resize can otherwise
 * fire many times per frame. */
function useThrottledRaf(callback: () => void, ownerWindow: Window): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const pendingRef = useRef<{
    readonly ownerWindow: Window;
    frameId: number;
  } | null>(null);
  useEffect(() => () => {
    const pending = pendingRef.current;
    if (!pending || pending.ownerWindow !== ownerWindow) return;
    pendingRef.current = null;
    try {
      ownerWindow.cancelAnimationFrame(pending.frameId);
    } catch {
      // A closing auxiliary window may already have torn down its frame clock.
    }
  }, [ownerWindow]);
  return useCallback(() => {
    if (pendingRef.current) return;
    const pending = { ownerWindow, frameId: 0 };
    pendingRef.current = pending;
    pending.frameId = ownerWindow.requestAnimationFrame(() => {
      if (pendingRef.current !== pending) return;
      pendingRef.current = null;
      callbackRef.current();
    });
  }, [ownerWindow]);
}

const STATE_LABEL_KEY = {
  'not-installed': 'openClaw.state.notInstalled',
  stopped: 'openClaw.state.stopped',
  starting: 'openClaw.state.starting',
  running: 'openClaw.state.running',
  unknown: 'openClaw.state.unknown',
} as const satisfies Record<OpenClawStatusState, string>;

const openClawChatSurfaceInstanceId = globalThis.crypto.randomUUID();
let openClawChatSurfaceRevision = 0;

/**
 * Desktop chat dockview panel (openclaw-management M3) — a plain DOM
 * placeholder. It never renders chat content itself: the main process owns
 * a WebContentsView (OpenClawChatViewManager) that paints natively ABOVE
 * this element, positioned/sized to match this div's bounding rect. This
 * component's whole job is reporting that rect + effective visibility (its
 * own dockview tab visibility ANDed with `OpenClawOverlayContext`, App.tsx's
 * single derivation) over IPC, and rendering fallback UI (guidance /
 * reconnect) for the states where no embedded content should be showing —
 * see openclaw-chat-view.ts's module doc for why a visible native view
 * would otherwise obscure this UI.
 */
export function OpenClawChatPanel(
  props: IDockviewPanelProps & { readonly capabilities?: CapabilityAccess },
): JSX.Element {
  const { t } = useAppTranslation();
  const capabilities = props.capabilities ?? rendererCapabilities;
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [viewState, setViewState] = useState<OpenClawChatViewState>({ hasError: false, loading: false });
  const [observationFailed, setObservationFailed] = useState(false);
  const [busyLifecycle, setBusyLifecycle] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false); // edge-trigger: chat-open sent once per stopped->running transition
  const host = useDockPanelHost(containerRef, props.api);

  // ── Effective visibility: this tab's own dockview visibility (hidden when
  // another tab in its group is active) ANDed with "no overlay above it".
  const contextOverlayOpen = useContext(OpenClawOverlayContext);
  const registeredOverlayOpen = useNativeOverlayOpen();
  const overlayOpen = contextOverlayOpen || registeredOverlayOpen;
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setPanelVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange((event) => setPanelVisible(event.isVisible));
    return () => disposable.dispose();
  }, [props.api]);
  const surfaceStateRef = useRef({ visible: false, ownerWindow: host.ownerWindow });
  surfaceStateRef.current = {
    visible: panelVisible && !overlayOpen && status?.state === 'running',
    ownerWindow: host.ownerWindow,
  };

  const publishSurface = useCallback((mounted: boolean): void => {
    const element = containerRef.current;
    const ownerWindow = element?.ownerDocument.defaultView ?? surfaceStateRef.current.ownerWindow;
    const windowName = ownerWindow === window ? 'main' : ownerWindow.name;
    if (!windowName) return;
    const rect = mounted && element
      ? element.getBoundingClientRect()
      : { x: 0, y: 0, width: 0, height: 0 };
    openClawChatSurfaceRevision += 1;
    capabilities.openClaw.setChatSurface({
      surfaceId: 'openclaw-chat',
      instanceId: openClawChatSurfaceInstanceId,
      revision: openClawChatSurfaceRevision,
      mounted,
      windowName,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      },
      visible: mounted && surfaceStateRef.current.visible,
    });
  }, [capabilities]);

  useEffect(() => () => publishSurface(false), [publishSurface]);

  // ── Status: seed + subscribe. Independent of the drawer's own gate (main.ts
  // refcounts both — see openclaw:chat-panel-mounted). Sent for the panel's
  // entire mounted lifetime, NOT gated on running state: this is exactly how
  // the panel detects a stopped->running transition and requests the view.
  useEffect(() => {
    return capabilities.openClaw.observeChat({
      onStatus: (nextStatus) => {
        setObservationFailed(false);
        setStatus(nextStatus);
      },
      onViewState: (nextState) => {
        setObservationFailed(false);
        setViewState(nextState);
      },
      onError: () => {
        setObservationFailed(true);
        setViewState({ hasError: true, loading: false });
      },
    });
  }, [capabilities]);

  // ── Request the view exactly once per stopped->running transition. If an
  // error is still latched from BEFORE this transition (viewState.hasError),
  // a plain re-open is a no-op against the existing (errored) view — recover
  // via the SAME reload path the 재연결 button uses instead, so the panel
  // doesn't stay stuck behind the reconnect card forever once the gateway is
  // healthy again (openclaw-stabilization M5).
  useEffect(() => {
    if (status?.state === 'running') {
      if (observationFailed) return;
      if (!openedRef.current) {
        openedRef.current = true;
        if (viewState.hasError) {
          capabilities.openClaw.reloadChat();
        } else {
          capabilities.openClaw.openChat();
        }
      }
    } else {
      openedRef.current = false;
    }
  }, [capabilities, observationFailed, status?.state, viewState.hasError]);

  // ── Bounds reporting: rAF-throttled ResizeObserver + scroll/layout nudges.
  const reportSurface = useThrottledRaf(() => publishSurface(true), host.ownerWindow);

  useEffect(() => {
    reportSurface();
  }, [host.revision, overlayOpen, panelVisible, reportSurface, status?.state]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ownerWindow = (el.ownerDocument.defaultView ?? host.ownerWindow) as Window & typeof globalThis;
    reportSurface();
    const observer = new ownerWindow.ResizeObserver(reportSurface);
    observer.observe(el);
    ownerWindow.addEventListener('resize', reportSurface);
    ownerWindow.addEventListener('scroll', reportSurface, true);
    ownerWindow.addEventListener('ez:refit', reportSurface);
    return () => {
      observer.disconnect();
      ownerWindow.removeEventListener('resize', reportSurface);
      ownerWindow.removeEventListener('scroll', reportSurface, true);
      ownerWindow.removeEventListener('ez:refit', reportSurface);
    };
  }, [host.ownerWindow, reportSurface]);

  const startGateway = useCallback(async (): Promise<void> => {
    setBusyLifecycle(true);
    try {
      await capabilities.openClaw.runLifecycle('start');
      const fresh = await capabilities.openClaw.getStatus(true);
      if (fresh) setStatus(fresh);
    } catch {
      // The existing guidance remains actionable; avoid an unhandled IPC rejection.
    } finally {
      setBusyLifecycle(false);
    }
  }, [capabilities]);

  const reconnect = useCallback((): void => {
    capabilities.openClaw.reloadChat();
  }, [capabilities]);

  const openInBrowser = useCallback((): void => {
    void capabilities.openClaw.openChatExternal().catch(() => undefined);
  }, [capabilities]);

  const state = status?.state;
  const showGuidance = !observationFailed && state !== 'running';
  const showReconnect = observationFailed || (state === 'running' && viewState.hasError);
  const showLoading =
    !observationFailed && state === 'running' && viewState.loading && !viewState.hasError;

  return (
    <div
      className="openclaw-chat-panel"
      data-testid="openclaw-chat-panel"
      ref={containerRef}
      role="region"
      aria-label={t('openClaw.chatTitle')}
    >
      {showGuidance && (
        <div className="openclaw-chat-guidance" data-testid="openclaw-chat-guidance">
          <p className="openclaw-guidance-text">
            {state === 'not-installed'
              ? t('openClaw.notInstalled')
              : status
                ? t('openClaw.gatewayState', { state: t(STATE_LABEL_KEY[status.state]) })
                : t('openClaw.checking')}
          </p>
          {state === 'not-installed' ? (
            <code className="openclaw-guidance-cmd">npm i -g openclaw</code>
          ) : (
            <button
              type="button"
              className="btn btn-split"
              disabled={busyLifecycle || state === 'starting' || state === undefined}
              onClick={() => void startGateway()}
              data-testid="openclaw-chat-start"
            >
              {t('openClaw.start')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-split"
            onClick={openInBrowser}
            data-testid="openclaw-chat-open-external"
          >
            {t('openClaw.openBrowser')}
          </button>
        </div>
      )}
      {showReconnect && (
        <div className="openclaw-chat-guidance" data-testid="openclaw-chat-reconnect">
          <p className="openclaw-guidance-text">{t('openClaw.chatUnavailable')}</p>
          <button type="button" className="btn btn-split" onClick={reconnect} data-testid="openclaw-chat-reconnect-btn">
            {t('openClaw.reconnect')}
          </button>
          <button
            type="button"
            className="btn btn-split"
            onClick={openInBrowser}
            data-testid="openclaw-chat-open-external"
          >
            {t('openClaw.openBrowser')}
          </button>
        </div>
      )}
      {showLoading && (
        <div className="openclaw-chat-guidance" data-testid="openclaw-chat-loading">
          <p className="openclaw-guidance-text">{t('openClaw.chatLoading')}</p>
        </div>
      )}
    </div>
  );
}
