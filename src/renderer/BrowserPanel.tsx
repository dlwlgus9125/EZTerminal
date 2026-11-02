import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

import type { BrowserViewState } from '../shared/browser';
import { BrowserPane, type BrowserPaneAction, type BrowserPaneBody, type BrowserPaneProps, type BrowserPaneStrip } from './browser/BrowserPane';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { useNativeOverlayOpen } from './native-overlay';
import { OpenClawOverlayContext } from './OpenClawChatPanel';
import { sendCardCommand } from './turn-wrap-up-commands';
import { useDockPanelHost } from './use-dock-panel-host';

/**
 * A conversation's in-app browser. The page itself is a native view the main process owns and places over the plate
 * below: this component reports that plate's rect and visibility, and turns what the person does into daemon commands.
 * While the plate shows the app's own state (empty, down, gone) or an overlay is open, the view is parked.
 *
 * The seams for later steps: `candidates` (step 13, dev-server discovery), `pick`/`cancel-pick` (step 14) and `allow-site`
 * (step 10) reach `onSeam`; nothing else is wired here.
 */

export interface BrowserPanelParams {
  readonly conversationId: string;
}

const browserSurfaceInstanceId = globalThis.crypto.randomUUID();
let browserSurfaceRevision = 0;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** What the plate shows. Only `page` means the native view is on screen. */
export function browserPaneBody(state: BrowserViewState | null): BrowserPaneBody {
  if (!state?.url) return { kind: 'empty', candidates: [] };
  if (state.fault === 'server-down') return { kind: 'server-down', origin: originOf(state.url) };
  if (state.fault === 'gone' || state.needsReopen) return { kind: 'gone' };
  return { kind: 'page' };
}

/** The one line between the toolbar and the page: what stopped something outranks who is at the page. */
export function browserPaneStrip(state: BrowserViewState | null): BrowserPaneStrip | undefined {
  if (!state) return undefined;
  if (state.blocked) return { kind: 'blocked', origin: state.blocked.origin };
  if (state.ai === 'driving') return { kind: 'driving' };
  if (state.ai === 'stopped') return { kind: 'stopped' };
  // Always the current URL's class: an external page is one the AI does not read.
  if (state.site === 'external' && state.url) return { kind: 'not-read', origin: originOf(state.url) };
  return undefined;
}

export function BrowserPanel(
  props: IDockviewPanelProps<BrowserPanelParams> & { readonly capabilities?: CapabilityAccess; readonly onSeam?: (action: BrowserPaneAction) => void },
): JSX.Element {
  const capabilities = props.capabilities ?? rendererCapabilities;
  const { conversationId } = props.params;
  const { onSeam } = props;
  const [state, setState] = useState<BrowserViewState | null>(null);
  useEffect(() => capabilities.browserPane?.observe(conversationId, setState), [capabilities, conversationId]);

  const plateRef = useRef<HTMLDivElement>(null);
  const host = useDockPanelHost(plateRef, props.api);
  const contextOverlayOpen = useContext(OpenClawOverlayContext);
  const registeredOverlayOpen = useNativeOverlayOpen();
  const overlayOpen = contextOverlayOpen || registeredOverlayOpen;
  const [panelVisible, setPanelVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setPanelVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange((event) => setPanelVisible(event.isVisible));
    return () => disposable.dispose();
  }, [props.api]);

  const body = useMemo(() => browserPaneBody(state), [state]);
  const surfaceRef = useRef({ visible: false, ownerWindow: host.ownerWindow });
  surfaceRef.current = { visible: panelVisible && !overlayOpen && body.kind === 'page', ownerWindow: host.ownerWindow };

  const publishSurface = useCallback((mounted: boolean): void => {
    const element = plateRef.current;
    const ownerWindow = element?.ownerDocument.defaultView ?? surfaceRef.current.ownerWindow;
    const rect = mounted && element ? element.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    browserSurfaceRevision += 1;
    capabilities.browserPane?.setSurface({
      conversationId,
      instanceId: browserSurfaceInstanceId,
      revision: browserSurfaceRevision,
      mounted,
      windowName: ownerWindow === window ? 'main' : ownerWindow.name,
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) },
      visible: mounted && surfaceRef.current.visible,
    });
  }, [capabilities, conversationId]);
  useEffect(() => () => publishSurface(false), [publishSurface]);

  // One report a frame: a drag-resize fires many times per frame.
  const framePending = useRef(false);
  const reportSurface = useCallback(() => {
    if (framePending.current) return;
    framePending.current = true;
    surfaceRef.current.ownerWindow.requestAnimationFrame(() => {
      framePending.current = false;
      publishSurface(true);
    });
  }, [publishSurface]);
  useEffect(() => { reportSurface(); }, [body.kind, host.revision, overlayOpen, panelVisible, reportSurface]);
  useEffect(() => {
    const element = plateRef.current;
    if (!element) return undefined;
    const ownerWindow = (element.ownerDocument.defaultView ?? host.ownerWindow) as Window & typeof globalThis;
    const observer = new ownerWindow.ResizeObserver(reportSurface);
    observer.observe(element);
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

  const onAction = useCallback((action: BrowserPaneAction): void => {
    const access = { latestSnapshot: capabilities.daemon.getSnapshot, sendCommand: capabilities.daemon.sendCommand };
    const send = (payload: { readonly action: 'navigate' | 'reload' | 'back' | 'forward' | 'stop'; readonly target?: string }): void => {
      void sendCardCommand(access, 'browser.action', { sessionId: conversationId, ...payload });
    };
    switch (action.kind) {
      case 'navigate': send({ action: 'navigate', target: action.url }); return;
      case 'back': case 'forward': case 'reload': send({ action: action.kind }); return;
      case 'stop-ai': send({ action: 'stop' }); return;
      // The page failed or its view went: load the address again, as the person who pressed the button.
      case 'retry': case 'reopen':
        if (state?.url) send({ action: 'navigate', target: state.url });
        return;
      default: onSeam?.(action);
    }
  }, [capabilities, conversationId, onSeam, state?.url]);

  const strip = browserPaneStrip(state);
  const view: BrowserPaneProps = {
    address: state?.url ?? '',
    ...(state?.site ? { site: state.site } : {}),
    body,
    ...(strip ? { strip } : {}),
    canBack: state?.canBack ?? false,
    canForward: state?.canForward ?? false,
    pageHidden: overlayOpen,
    pageRef: plateRef,
    onAction,
  };
  return <BrowserPane {...view} />;
}
