import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

import { allowableOrigin, type BrowserViewState } from '../shared/browser';
import { BrowserAllowSheet, type BrowserAllowPreset } from './browser/BrowserAllowSheet';
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
  if (!state?.url) return { kind: 'empty', candidates: state?.candidates ?? [] };
  if (state.fault === 'server-down') return { kind: 'server-down', origin: originOf(state.url) };
  if (state.fault === 'gone' || state.needsReopen) return { kind: 'gone', ...(state.blocked?.reason === 'rebind-suspected' ? { ended: 'rebind-suspected' as const } : {}) };
  return { kind: 'page' };
}

/**
 * The one line between the toolbar and the page: what stopped something outranks who is at the page. The bar offers Allow,
 * so it stands only for a site a person may allow: a suspected rebind, the app's own ports and files outside the folders are
 * not the person's to wave through, and a closed bar stays closed.
 */
export function browserPaneStrip(state: BrowserViewState | null, dismissed?: { readonly blocked?: number; readonly allowed?: string }): BrowserPaneStrip | undefined {
  if (!state) return undefined;
  const { blocked, allowed } = state;
  if (blocked && blocked.serial !== dismissed?.blocked && blocked.reason === 'site-not-allowed' && allowableOrigin(blocked.origin)) return { kind: 'blocked', origin: blocked.origin };
  if (allowed && allowed !== dismissed?.allowed) return { kind: 'allowed', origin: allowed };
  if (state.ai === 'driving') return { kind: 'driving' };
  if (state.ai === 'stopped') return { kind: 'stopped' };
  // Always the current URL's class: an external page is one the AI does not read.
  const origin = originOf(state.url);
  if (state.site === 'external' && state.url && allowableOrigin(origin)) return { kind: 'not-read', origin };
  return undefined;
}

export function BrowserPanel(
  props: IDockviewPanelProps<BrowserPanelParams> & { readonly capabilities?: CapabilityAccess },
): JSX.Element {
  const capabilities = props.capabilities ?? rendererCapabilities;
  const { conversationId } = props.params;
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

  const [dismissed, setDismissed] = useState<{ readonly blocked?: number; readonly allowed?: string }>({});
  const [sheet, setSheet] = useState<{ readonly origin: string; readonly projectId: string; readonly projectName: string; readonly preset: BrowserAllowPreset } | null>(null);
  const access = useMemo(() => ({ latestSnapshot: capabilities.daemon.getSnapshot, sendCommand: capabilities.daemon.sendCommand }), [capabilities]);

  /** The sheet says whose list this goes on and what the conversation's access means for it, from the host's own record. */
  const openAllowSheet = useCallback(async (origin: string): Promise<void> => {
    const snapshot = await capabilities.daemon.getSnapshot();
    const session = snapshot?.sessions.find((entry) => entry.id === conversationId);
    const project = snapshot?.projects.find((entry) => entry.id === session?.projectId);
    const agent = snapshot?.agents.find((entry) => entry.sessionId === conversationId);
    if (project && agent) setSheet({ origin, projectId: project.id, projectName: project.name, preset: agent.permissionPreset });
  }, [capabilities, conversationId]);

  const allow = useCallback((origin: string): void => {
    const target = sheet;
    setSheet(null);
    if (target) void sendCardCommand(access, 'browser.site', { projectId: target.projectId, origin, action: 'allow' });
  }, [access, sheet]);

  const onAction = useCallback((action: BrowserPaneAction): void => {
    const send = (payload: { readonly action: 'navigate' | 'reload' | 'back' | 'forward' | 'stop' | 'pick' | 'cancel-pick'; readonly target?: string }): void => {
      void sendCardCommand(access, 'browser.action', { sessionId: conversationId, ...payload });
    };
    switch (action.kind) {
      case 'navigate': send({ action: 'navigate', target: action.url }); return;
      case 'back': case 'forward': case 'reload': case 'pick': case 'cancel-pick': send({ action: action.kind }); return;
      case 'stop-ai': send({ action: 'stop' }); return;
      // The page failed or its view went: load the address again, as the person who pressed the button.
      case 'retry': case 'reopen':
        if (state?.url) send({ action: 'navigate', target: state.url });
        return;
      case 'allow-site': void openAllowSheet(action.origin); return;
      case 'dismiss': setDismissed({ ...(state?.blocked ? { blocked: state.blocked.serial } : {}), ...(state?.allowed ? { allowed: state.allowed } : {}) }); return;
      default:
    }
  }, [access, conversationId, openAllowSheet, state?.allowed, state?.blocked, state?.url]);

  const strip = browserPaneStrip(state, dismissed);
  const view: BrowserPaneProps = {
    address: state?.url ?? '',
    ...(state?.site ? { site: state.site } : {}),
    body,
    ...(strip ? { strip } : {}),
    canBack: state?.canBack ?? false,
    canForward: state?.canForward ?? false,
    picking: state?.picking === true,
    pageHidden: overlayOpen,
    pageRef: plateRef,
    onAction,
  };
  return (
    <>
      <BrowserPane {...view} />
      {sheet && <BrowserAllowSheet origin={sheet.origin} projectName={sheet.projectName} preset={sheet.preset} onCancel={() => setSheet(null)} onAllow={allow} />}
    </>
  );
}
