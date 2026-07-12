import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

import type { OpenClawChatViewState, OpenClawStatus, OpenClawStatusState } from '../shared/openclaw';

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
function useThrottledRaf(callback: () => void): () => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const pendingRef = useRef(false);
  return useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    requestAnimationFrame(() => {
      pendingRef.current = false;
      callbackRef.current();
    });
  }, []);
}

const STATE_LABEL: Record<OpenClawStatusState, string> = {
  'not-installed': '설치 안 됨',
  stopped: '중지됨',
  starting: '시작 중…',
  running: '실행 중',
  unknown: '알 수 없음',
};

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
export function OpenClawChatPanel(props: IDockviewPanelProps): JSX.Element {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [viewState, setViewState] = useState<OpenClawChatViewState>({ hasError: false });
  const [busyLifecycle, setBusyLifecycle] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(false); // edge-trigger: chat-open sent once per stopped->running transition

  // ── Effective visibility: this tab's own dockview visibility (hidden when
  // another tab in its group is active) ANDed with "no overlay above it".
  const overlayOpen = useContext(OpenClawOverlayContext);
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setPanelVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange((event) => setPanelVisible(event.isVisible));
    return () => disposable.dispose();
  }, [props.api]);
  useEffect(() => {
    window.ezterminalDesktop?.setOpenClawChatVisible(panelVisible && !overlayOpen);
  }, [panelVisible, overlayOpen]);

  // ── Status: seed + subscribe. Independent of the drawer's own gate (main.ts
  // refcounts both — see openclaw:chat-panel-mounted). Sent for the panel's
  // entire mounted lifetime, NOT gated on running state: this is exactly how
  // the panel detects a stopped->running transition and requests the view.
  useEffect(() => {
    let alive = true;
    const api = window.ezterminalDesktop;
    api?.setOpenClawChatPanelMounted(true);
    void api?.getOpenClawStatus().then((s) => {
      if (alive) setStatus(s);
    });
    const unsubStatus = api?.onOpenClawStatus((s) => setStatus(s));
    const unsubViewState = api?.onOpenClawChatViewState((s) => setViewState(s));
    return () => {
      alive = false;
      unsubStatus?.();
      unsubViewState?.();
      api?.setOpenClawChatPanelMounted(false);
      api?.closeOpenClawChatView();
    };
  }, []);

  // ── Request the view exactly once per stopped->running transition.
  useEffect(() => {
    if (status?.state === 'running') {
      if (!openedRef.current) {
        openedRef.current = true;
        window.ezterminalDesktop?.openOpenClawChatView();
      }
    } else {
      openedRef.current = false;
    }
  }, [status?.state]);

  // ── Bounds reporting: rAF-throttled ResizeObserver + scroll/layout nudges.
  const reportBounds = useThrottledRaf(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    window.ezterminalDesktop?.setOpenClawChatBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    reportBounds();
    const observer = new ResizeObserver(reportBounds);
    observer.observe(el);
    window.addEventListener('resize', reportBounds);
    window.addEventListener('scroll', reportBounds, true);
    window.addEventListener('ez:refit', reportBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reportBounds);
      window.removeEventListener('scroll', reportBounds, true);
      window.removeEventListener('ez:refit', reportBounds);
    };
  }, [reportBounds]);

  const startGateway = useCallback(async (): Promise<void> => {
    setBusyLifecycle(true);
    try {
      await window.ezterminalDesktop?.runOpenClawLifecycle('start');
      const fresh = await window.ezterminalDesktop?.getOpenClawStatus(true);
      if (fresh) setStatus(fresh);
    } finally {
      setBusyLifecycle(false);
    }
  }, []);

  const reconnect = useCallback((): void => {
    window.ezterminalDesktop?.reloadOpenClawChatView();
  }, []);

  const state = status?.state;
  const showGuidance = state !== 'running';
  const showReconnect = state === 'running' && viewState.hasError;

  return (
    <div className="openclaw-chat-panel" data-testid="openclaw-chat-panel" ref={containerRef}>
      {showGuidance && (
        <div className="openclaw-chat-guidance" data-testid="openclaw-chat-guidance">
          <p className="openclaw-guidance-text">
            {state === 'not-installed'
              ? 'OpenClaw CLI가 설치되어 있지 않습니다.'
              : `게이트웨이가 ${status ? STATE_LABEL[status.state] : '확인 중'}입니다.`}
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
              시작
            </button>
          )}
        </div>
      )}
      {showReconnect && (
        <div className="openclaw-chat-guidance" data-testid="openclaw-chat-reconnect">
          <p className="openclaw-guidance-text">채팅 연결이 끊어졌습니다.</p>
          <button type="button" className="btn btn-split" onClick={reconnect} data-testid="openclaw-chat-reconnect-btn">
            재연결
          </button>
        </div>
      )}
    </div>
  );
}
