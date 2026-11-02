import { BaseWindow, session as electronSession, WebContentsView, type BrowserWindow, type WebContents } from 'electron';

import { addressBarUrl, BROWSER_PARTITION, siteClass, type BrowserRefusal, type BrowserSiteClass, type BrowserViewState } from '../shared/browser';
import { BrowserCdp } from './browser-cdp';
import {
  fileInsideRoots,
  installBrowserPartitionGuards,
  navigationRefusal,
  originOf as guardOrigin,
  realRoots,
  type BrowserNetworkGuardHost,
  type BrowserPartitionSession,
  type BrowserRequestReason,
  type BrowserViewPolicy,
} from './browser-network-guard';
import type { BrowserSiteStore } from './browser-site-store';

/**
 * One `WebContentsView` per conversation, shaped like `openclaw-chat-view.ts`, and every guard that rests on the view.
 *
 * Who is at the page is the whole design, and nothing here depends on what a model does:
 *  - A pane is `guarded` from the first tool call, for good: it survives 중지, the end of the turn and eviction of the
 *    view. `aiTurnId` only says a tool may run. No code path clears `guarded`.
 *  - The one exception is a navigation the person made: the address bar, back, forward, reload, or a real click on a link
 *    or a form while no tool runs. Its page keeps its own class, so an external one stays unread by the AI until allowed.
 *  - A real click is told from a script (measured): `input-event` comes first for real input and for CDP input alike, so
 *    it counts only while no tool runs; `Page.frameRequestedNavigation` then names the reason, and only a link or a form
 *    qualifies. `location.href`, a timer and a meta refresh are `scriptInitiated` or `metaTagRefresh`, and stay refused.
 *    A script's `a.click()` also reads `anchorClick`, so a real input just before it is required too.
 *
 * Never reaches `shell.openExternal`: a popup is denied, and a local or allowed target opens here instead.
 *
 * Suspicion is the partition's, not a pane's: a site that answered from where it must not is out of reach on every pane, and
 * after a restart, by every kind of request, and its live pages end. A person going there themselves is the one way in: that
 * visit is theirs, on that pane, and the page stays external, so the AI reads nothing. Only allowing the site again lifts it.
 *
 * A view no one looks at is parked in a small window off every screen, not hidden. Measured: a click never lands on a view
 * that is hidden or was never shown, and stalls 3 s or more; `capturePage` throws on one never shown. Parked, with
 * `backgroundThrottling` off, a click lands in about 200 ms even with the app minimized.
 */

/** A pane no one looks at, and the size the AI's coordinates and screenshots assume. */
const PARKED_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 } as const;
/** Off every screen: a window here is shown as far as Chromium knows, and no one can see, reach or Alt-Tab to it. */
const PARKING_PLACE = { x: -20_000, y: -20_000 } as const;
const LIVE_VIEWS = 3;
/** How long after a real click or key a link or a form still counts as the person's. */
const PERSON_GESTURE_MS = 1_000;
const PERSON_NAVIGATION_REASONS = new Set(['anchorClick', 'formSubmissionGet', 'formSubmissionPost']);
const PERSON_INPUT = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'gestureTap']);
const ERR_ABORTED = -3;
const ERR_BLOCKED_BY_CLIENT = -20;

interface Pane {
  readonly conversationId: string;
  view: WebContentsView | null;
  /** The window the view sits in now: the app's, or the parking one. */
  host: BaseWindow | null;
  cdp?: BrowserCdp;
  lastUrl: string;
  /** Set by the first tool call. Nothing ever clears it. */
  guarded: boolean;
  personNavigating: boolean;
  toolsRunning: number;
  toolEndedAt: number;
  personInputAt: number;
  requested?: { readonly url: string; readonly reason: string; readonly at: number };
  /** The turn whose tools may run now. */
  aiTurnId?: string;
  /** The person pressed 브라우저만 중지 during this turn: its tools are refused until it ends. */
  stoppedTurnId?: string;
  /** The suspect site the person went to on this pane: open to this pane until the page leaves it. */
  visit?: string;
  blocked?: BrowserViewState['blocked'];
  /** The site the person allowed from this pane, until something else happens to it. */
  allowedNow?: string;
  fault?: BrowserViewState['fault'];
  needsReopen: boolean;
  loading: boolean;
  surface?: { readonly bounds: Electron.Rectangle; readonly visible: boolean };
  usedAt: number;
  projectId?: string;
  /** Real paths (`realRoots`). */
  roots: readonly string[];
}

/** Where a conversation lives; read when its view is made, never per request. */
export interface BrowserConversationScope {
  readonly projectId: string;
  /** The conversation's folders. */
  readonly roots: readonly string[];
}

export interface BrowserViewManagerDeps {
  /** Undefined: no such conversation; nothing is then allowed and no folder is open. */
  readonly scope: (conversationId: string) => Promise<BrowserConversationScope | undefined>;
  /** The project's list, in memory and read on every decision: a revoke applies at once. */
  readonly allowedOrigins: (projectId: string) => readonly string[];
  /** Where the suspect sites outlive the app: beside the allow list. */
  readonly suspects?: Pick<BrowserSiteStore, 'suspects' | 'addSuspect' | 'clearSuspect'>;
  /** The app's own listening ports. */
  readonly controlPorts: () => ReadonlySet<number>;
  readonly onState: (state: BrowserViewState) => void;
  /** A guard stopped something during a turn the AI was at this page. What stops a person's own browsing writes no row. */
  readonly onBlocked?: (conversationId: string, blocked: NonNullable<BrowserViewState['blocked']>, turnId: string) => void;
  /** The person pressed 브라우저만 중지: where a held approval is voided. */
  readonly onStopped?: (conversationId: string) => void;
  /** The AI used this conversation's browser for the first time: its pane opens, without focus. */
  readonly onFirstUse?: (conversationId: string) => void;
  /** The last page of a conversation, for the pane after a restart. */
  readonly lastUrl?: (conversationId: string) => string | undefined;
  readonly rememberUrl?: (conversationId: string, url: string) => void;
  readonly partition?: () => BrowserPartitionSession;
  readonly now?: () => number;
}

export type BrowserPageResult =
  | { readonly ok: true; readonly contents: WebContents; readonly cdp: BrowserCdp; readonly url: string; readonly site: BrowserSiteClass }
  | { readonly ok: false; readonly reason: BrowserRefusal };

export class BrowserViewManager implements BrowserNetworkGuardHost {
  private win: BrowserWindow | null = null;
  private parking: BaseWindow | null = null;
  private readonly panes = new Map<string, Pane>();
  private readonly byContents = new Map<number, Pane>();
  private uses = 0;
  private blocks = 0;
  private readonly now: () => number;
  /** One set for the one partition: a site does not stop being in doubt because another pane asks. */
  private readonly suspects: Set<string>;

  constructor(private readonly deps: BrowserViewManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.suspects = new Set(deps.suspects?.suspects());
  }

  /** The window views live in; a pane is never detachable, so there is one. */
  attach(win: BrowserWindow): void {
    this.win = win;
  }

  /** The window went or reloaded: the views go, and each pane keeps its address, and its guard. */
  destroy(): void {
    for (const pane of this.panes.values()) this.teardown(pane, true);
    this.win = null;
    // It must not outlive the app's window, or `window-all-closed` would never fire.
    if (this.parking && !this.parking.isDestroyed()) this.parking.destroy();
    this.parking = null;
  }

  /** The person closed the pane. A later pane in this conversation stays guarded. */
  close(conversationId: string): void {
    const pane = this.panes.get(conversationId);
    if (pane) this.teardown(pane, true);
  }

  /** The conversation is gone. */
  forget(conversationId: string): void {
    const pane = this.panes.get(conversationId);
    if (!pane) return;
    this.teardown(pane, false);
    this.panes.delete(conversationId);
  }

  updateSurface(conversationId: string, surface: { readonly mounted: boolean; readonly bounds: Electron.Rectangle; readonly visible: boolean }): void {
    const pane = this.pane(conversationId);
    if (surface.mounted) pane.surface = { bounds: surface.bounds, visible: surface.visible };
    else delete pane.surface;
    this.place(pane);
    this.publish(pane);
  }

  state(conversationId: string): BrowserViewState {
    return this.viewState(this.pane(conversationId));
  }

  // ── The person ──────────────────────────────────────────────────────────

  /** The address bar and 다시 열기: a navigation the person made. Returns false when the text is nothing it can load. */
  async navigateAsPerson(conversationId: string, address: string): Promise<boolean> {
    const url = addressBarUrl(address);
    if (!url) return false;
    const pane = this.pane(conversationId);
    const contents = await this.readyView(pane);
    if (!contents) return false;
    delete pane.blocked;
    delete pane.fault;
    pane.personNavigating = true;
    this.load(pane, contents, url);
    return true;
  }

  reloadAsPerson(conversationId: string): void {
    const contents = this.liveContents(this.pane(conversationId));
    if (!contents) return;
    this.pane(conversationId).personNavigating = true;
    contents.reload();
  }

  goBackAsPerson(conversationId: string): void {
    const contents = this.liveContents(this.pane(conversationId));
    if (!contents?.navigationHistory.canGoBack()) return;
    this.pane(conversationId).personNavigating = true;
    contents.navigationHistory.goBack();
  }

  goForwardAsPerson(conversationId: string): void {
    const contents = this.liveContents(this.pane(conversationId));
    if (!contents?.navigationHistory.canGoForward()) return;
    this.pane(conversationId).personNavigating = true;
    contents.navigationHistory.goForward();
  }

  /** 브라우저만 중지: tools stop for this turn; the turn runs on, and every guard stays. */
  stopAi(conversationId: string): void {
    const pane = this.pane(conversationId);
    if (pane.aiTurnId !== undefined) pane.stoppedTurnId = pane.aiTurnId;
    delete pane.aiTurnId;
    this.liveContents(pane)?.stop();
    this.publish(pane);
    this.deps.onStopped?.(conversationId);
  }

  // ── The AI: the seam `browser-tools.ts` runs on ──────────────────────────

  /**
   * A tool is about to run: from here on the pane is guarded, whatever comes next. Undefined when the tool may go on;
   * pair it with `endTool`.
   */
  beginTool(conversationId: string, turnId: string): BrowserRefusal | undefined {
    const pane = this.pane(conversationId);
    if (pane.stoppedTurnId === turnId) return 'stopped';
    if (!pane.guarded) this.deps.onFirstUse?.(conversationId);
    pane.guarded = true;
    // The person's pass never carries over to a tool, whatever became of their navigation.
    pane.personNavigating = false;
    pane.aiTurnId = turnId;
    pane.toolsRunning += 1;
    pane.usedAt = (this.uses += 1);
    this.publish(pane);
    return undefined;
  }

  endTool(conversationId: string): void {
    const pane = this.pane(conversationId);
    pane.toolsRunning = Math.max(0, pane.toolsRunning - 1);
    pane.toolEndedAt = this.now();
  }

  /** The turn ended: tools stop until the next tool call. The guard stays. */
  turnEnded(conversationId: string, turnId: string): void {
    const pane = this.panes.get(conversationId);
    if (!pane) return;
    if (pane.aiTurnId === turnId) delete pane.aiTurnId;
    if (pane.stoppedTurnId === turnId) delete pane.stoppedTurnId;
    this.publish(pane);
  }

  /** The page a tool may touch, or why not. Class and all, read now: a person may have gone elsewhere since the last call. */
  page(conversationId: string): BrowserPageResult {
    const pane = this.pane(conversationId);
    if (pane.fault === 'gone') return { ok: false, reason: 'page-gone' };
    const contents = this.liveContents(pane);
    // With the view gone the address still says why: a suspect's page was ended, not lost.
    const url = contents?.mainFrame.url || pane.lastUrl;
    if (url && this.suspect(pane, url)) return { ok: false, reason: 'rebind-suspected' };
    if (!contents || !pane.cdp) return { ok: false, reason: 'no-page' };
    if (!url || url === 'about:blank') return { ok: false, reason: 'no-page' };
    return { ok: true, contents, cdp: pane.cdp, url, site: this.site(pane, url) };
  }

  /** The AI's own navigation: the caller has checked the target. Its redirects meet the guards like any other. */
  async navigateForTool(conversationId: string, url: string): Promise<WebContents | undefined> {
    const pane = this.pane(conversationId);
    const contents = await this.readyView(pane);
    if (!contents) return undefined;
    delete pane.blocked;
    delete pane.fault;
    this.load(pane, contents, url);
    return contents;
  }

  /** The class of a URL for this conversation. */
  classify(conversationId: string, url: string): BrowserSiteClass {
    return this.site(this.pane(conversationId), url);
  }

  /** This site answered from where it must not, on some pane, and is not the one the person is visiting on this one. */
  suspected(conversationId: string, url: string): boolean {
    return this.suspect(this.pane(conversationId), url);
  }

  /** A person changed a project's list: every open page shows its class now. Allowing a suspect site is what ends the doubt about it. */
  sitesChanged(projectId: string, origin: string, action: 'allow' | 'revoke'): void {
    if (action === 'allow' && this.suspects.delete(origin)) void this.deps.suspects?.clearSuspect(origin);
    for (const pane of this.panes.values()) {
      if (action === 'allow' && pane.visit === origin) delete pane.visit;
      if (pane.projectId === projectId) {
        if (action === 'allow') {
          if (pane.blocked?.origin === origin) {
            delete pane.blocked;
            pane.allowedNow = origin;
          }
        } else if (pane.allowedNow === origin) {
          delete pane.allowedNow;
        }
      }
      this.publish(pane);
    }
  }

  /** A tool asked for a site the host refused: the pane bar says so, and allowing it is the person's. */
  refuseNavigation(conversationId: string, url: string, reason: BrowserRefusal): void {
    this.block(this.pane(conversationId), url, reason, false);
  }

  // ── The guards ──────────────────────────────────────────────────────────

  policyFor(webContentsId: number | undefined): BrowserViewPolicy | undefined {
    const pane = webContentsId === undefined ? undefined : this.byContents.get(webContentsId);
    return pane ? this.policy(pane) : undefined;
  }

  controlPorts(): ReadonlySet<number> {
    return this.deps.controlPorts();
  }

  onBlocked(webContentsId: number | undefined, blocked: { readonly url: string; readonly resourceType: string; readonly reason: BrowserRequestReason }): void {
    const pane = webContentsId === undefined ? undefined : this.byContents.get(webContentsId);
    if (!pane) return;
    // A page up on a name that now leads here has rebound, whatever kind of request gave it away. A name some page merely
    // points here is not: that would let a page write this list.
    const origin = guardOrigin(blocked.url);
    if (blocked.reason === 'rebind-suspected' && origin === guardOrigin(this.liveContents(pane)?.mainFrame.url ?? '')) {
      this.onRebind(webContentsId, origin);
      return;
    }
    if (blocked.resourceType !== 'mainFrame' && blocked.resourceType !== 'subFrame') return;
    if (blocked.reason !== 'unresolved') {
      this.block(pane, blocked.url, blocked.reason === 'rebind-suspected' ? 'rebind-suspected' : 'site-not-allowed');
    } else if (blocked.resourceType === 'mainFrame') {
      // Nothing was stopped: a name with no address is a server that is not there.
      pane.fault = 'server-down';
      this.publish(pane);
    }
  }

  /** The site is in doubt on every pane from here on, and no page of it stays up, a visit of the person's included. */
  onRebind(webContentsId: number | undefined, origin: string): void {
    const owner = webContentsId === undefined ? undefined : this.byContents.get(webContentsId);
    if (!this.suspects.has(origin)) {
      this.suspects.add(origin);
      void this.deps.suspects?.addSuspect(origin);
    }
    for (const pane of this.panes.values()) {
      if (pane.visit === origin) delete pane.visit;
      const contents = this.liveContents(pane);
      const there = contents !== undefined && guardOrigin(contents.mainFrame.url) === origin;
      if (pane === owner) contents?.stop();
      if (pane === owner || there) this.block(pane, origin, 'rebind-suspected');
      // Closed, not sent elsewhere: nothing of it runs on, there is no Back into it, and the pane shows the app's own state.
      if (there) this.teardown(pane, true);
    }
  }

  onPersonNavigation(webContentsId: number | undefined, url: string): void {
    const pane = webContentsId === undefined ? undefined : this.byContents.get(webContentsId);
    const origin = guardOrigin(url);
    if (pane && this.suspects.has(origin)) pane.visit = origin;
  }

  onDownloadBlocked(webContentsId: number, url: string): void {
    const pane = this.byContents.get(webContentsId);
    if (pane) this.block(pane, url, 'download-blocked');
  }

  private pane(conversationId: string): Pane {
    let pane = this.panes.get(conversationId);
    if (!pane) {
      const lastUrl = this.deps.lastUrl?.(conversationId) ?? '';
      pane = {
        conversationId, view: null, host: null, lastUrl, guarded: false, personNavigating: false, toolsRunning: 0, toolEndedAt: 0,
        personInputAt: 0, needsReopen: lastUrl !== '', loading: false, usedAt: 0, roots: [],
      };
      this.panes.set(conversationId, pane);
    }
    return pane;
  }

  /** The list as it counts: a suspect stays on it for the person, and counts for nothing. So every class is suspect-aware, a frame's too. */
  private allowed(pane: Pane): readonly string[] {
    return pane.projectId === undefined ? [] : this.deps.allowedOrigins(pane.projectId).filter((origin) => !this.suspects.has(origin));
  }

  private suspect(pane: Pane, url: string): boolean {
    const origin = guardOrigin(url);
    return this.suspects.has(origin) && pane.visit !== origin;
  }

  /** A conversation's project and folders are read with each new view, before it loads anything: they do not move under a live page. */
  private async readyView(pane: Pane): Promise<WebContents | undefined> {
    const live = this.liveContents(pane);
    if (live) return live;
    const scope = await this.deps.scope(pane.conversationId);
    if (scope) pane.projectId = scope.projectId;
    else delete pane.projectId;
    pane.roots = realRoots(scope?.roots ?? []);
    return this.ensureView(pane);
  }

  private policy(pane: Pane): BrowserViewPolicy {
    const allowedOrigins = this.allowed(pane);
    const topUrl = this.liveContents(pane)?.mainFrame.url ?? '';
    return {
      guarded: pane.guarded,
      personNavigating: pane.personNavigating,
      topUrl,
      topExternal: siteClass(topUrl, allowedOrigins, { controlPorts: this.deps.controlPorts() }) === 'external',
      allowedOrigins,
      roots: pane.roots,
      suspectOrigins: pane.visit === undefined ? this.suspects : new Set([...this.suspects].filter((origin) => origin !== pane.visit)),
    };
  }

  private site(pane: Pane, url: string): BrowserSiteClass {
    const creator = this.liveContents(pane)?.mainFrame.url;
    const site = siteClass(url, this.allowed(pane), { ...(creator ? { creator } : {}), controlPorts: this.deps.controlPorts() });
    return site === 'file' && !fileInsideRoots(url, pane.roots) ? 'external' : site;
  }

  private liveContents(pane: Pane): WebContents | undefined {
    const contents = pane.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : undefined;
  }

  private ensureView(pane: Pane): WebContents | undefined {
    const live = this.liveContents(pane);
    if (live) return live;
    const win = this.win;
    if (!win || win.isDestroyed()) return undefined;
    installBrowserPartitionGuards(this.deps.partition?.() ?? electronSession.fromPartition(BROWSER_PARTITION), this);
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false,
        partition: BROWSER_PARTITION, disableDialogs: true, backgroundThrottling: false,
      },
    });
    pane.view = view;
    pane.needsReopen = false;
    pane.usedAt = (this.uses += 1);
    delete pane.fault;
    const contents = view.webContents;
    this.byContents.set(contents.id, pane);
    this.guard(pane, contents);
    this.place(pane);
    this.evict();
    return contents;
  }

  private parkingWindow(): BaseWindow {
    if (!this.parking || this.parking.isDestroyed()) {
      this.parking = new BaseWindow({
        ...PARKED_BOUNDS, ...PARKING_PLACE, frame: false, skipTaskbar: true, focusable: false, resizable: false, type: 'toolbar', show: false,
      });
      this.parking.showInactive();
    }
    return this.parking;
  }

  private guard(pane: Pane, contents: WebContents): void {
    // WebRTC reaches the network past `webRequest`.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(({ url }) => {
      this.openInPlace(pane, contents, url);
      return { action: 'deny' };
    });
    // The address bar's pass covers its own redirects. A page's own navigation never inherits it: it needs a gesture of its own.
    const top = (event: Electron.Event, url: string, redirect: boolean): void => {
      const personMade = redirect ? pane.personNavigating : this.personGesture(pane, url);
      const refusal = navigationRefusal(url, 'top', this.policy(pane), this.deps.controlPorts(), personMade);
      if (refusal) {
        event.preventDefault();
        this.block(pane, url, refusal);
      } else if (personMade) pane.personNavigating = true;
    };
    const sub = (event: Electron.Event, url: string): void => {
      const refusal = navigationRefusal(url, 'sub', this.policy(pane), this.deps.controlPorts(), false);
      if (refusal) {
        event.preventDefault();
        this.block(pane, url, refusal);
      }
    };
    contents.on('will-navigate', (event) => top(event, event.url, false));
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame) top(event, event.url, false);
      else sub(event, event.url);
    });
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame) top(event, event.url, true);
      else sub(event, event.url);
    });
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
    contents.on('input-event', (_event, input) => {
      if (pane.toolsRunning === 0 && PERSON_INPUT.has(input.type)) pane.personInputAt = this.now();
    });
    contents.on('did-start-loading', () => {
      pane.loading = true;
      this.publish(pane);
    });
    contents.on('did-stop-loading', () => {
      pane.loading = false;
      pane.personNavigating = false;
      this.publish(pane);
    });
    contents.on('did-navigate', (_event, url) => {
      pane.personNavigating = false;
      if (pane.visit !== guardOrigin(url)) delete pane.visit;
      pane.cdp?.clearRefs();
      this.remember(pane, url);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      // A back or forward inside the document is a navigation that commits nothing: the pass ends here too.
      pane.personNavigating = false;
      this.remember(pane, url);
    });
    contents.on('did-fail-load', (_event, code, _text, _url, isMainFrame) => {
      if (!isMainFrame) return;
      pane.personNavigating = false;
      if (code !== ERR_ABORTED && code !== ERR_BLOCKED_BY_CLIENT) pane.fault = 'server-down';
      this.publish(pane);
    });
    contents.on('render-process-gone', () => {
      pane.fault = 'gone';
      this.teardown(pane, true);
    });
    pane.cdp = new BrowserCdp(contents, {
      onNavigationRequested: (url, reason) => { pane.requested = { url, reason, at: this.now() }; },
      classify: (url) => this.site(pane, url),
    });
  }

  /** A real click or key, with no tool running since, that led to a link or a form at this very URL. */
  private personGesture(pane: Pane, url: string): boolean {
    const asked = pane.requested;
    return pane.toolsRunning === 0
      && pane.personInputAt > pane.toolEndedAt
      && this.now() - pane.personInputAt <= PERSON_GESTURE_MS
      && asked?.url === url
      // Older than the input, it was a page's own: a refused `a.click()` must not wait there for the person's next key.
      && asked.at >= pane.personInputAt
      && PERSON_NAVIGATION_REASONS.has(asked.reason);
  }

  private openInPlace(pane: Pane, contents: WebContents, url: string): void {
    if (this.suspect(pane, url)) this.block(pane, url, 'rebind-suspected');
    else if (this.site(pane, url) === 'external') this.block(pane, url, 'site-not-allowed');
    else this.load(pane, contents, url);
  }

  private load(pane: Pane, contents: WebContents, url: string): void {
    // A refused or superseded load already reached the hooks above.
    contents.loadURL(url).catch(() => undefined);
    this.publish(pane);
  }

  private remember(pane: Pane, url: string): void {
    pane.lastUrl = url;
    this.deps.rememberUrl?.(pane.conversationId, url);
    this.publish(pane);
  }

  /** `report: false`: the caller reports it, knowing more of what was tried. */
  private block(pane: Pane, url: string, reason: BrowserRefusal, report = true): void {
    const blocked = { origin: originOf(url) ?? url, reason, serial: (this.blocks += 1) };
    pane.blocked = blocked;
    delete pane.allowedNow;
    this.publish(pane);
    if (report && pane.aiTurnId !== undefined) this.deps.onBlocked?.(pane.conversationId, blocked, pane.aiTurnId);
  }

  private place(pane: Pane): void {
    const view = pane.view;
    if (!view) return;
    const shown = pane.surface?.visible === true && this.win !== null && !this.win.isDestroyed();
    const host = shown ? this.win! : this.parkingWindow();
    if (pane.host !== host) {
      if (pane.host && !pane.host.isDestroyed()) pane.host.contentView.removeChildView(view);
      host.contentView.addChildView(view);
      pane.host = host;
    }
    view.setBounds(shown ? pane.surface!.bounds : PARKED_BOUNDS);
    if (shown) pane.usedAt = (this.uses += 1);
  }

  /** The oldest hidden view goes, with no tool in it; its address and its guard stay. */
  private evict(): void {
    const live = [...this.panes.values()].filter((pane) => this.liveContents(pane));
    if (live.length <= LIVE_VIEWS) return;
    const oldest = live.filter((pane) => pane.surface?.visible !== true && pane.toolsRunning === 0).sort((left, right) => left.usedAt - right.usedAt)[0];
    if (oldest) this.teardown(oldest, true);
  }

  private teardown(pane: Pane, keep: boolean): void {
    const view = pane.view;
    const host = pane.host;
    pane.view = null;
    pane.host = null;
    pane.personNavigating = false;
    delete pane.visit;
    pane.loading = false;
    if (!view) return;
    const contents = view.webContents;
    this.byContents.delete(contents.id);
    pane.cdp?.close();
    delete pane.cdp;
    pane.needsReopen = pane.lastUrl !== '' && pane.fault !== 'gone';
    try {
      if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    } catch {
      // A closing window may already have detached the view.
    }
    try {
      if (!contents.isDestroyed()) contents.close();
    } catch {
      // Already going.
    }
    if (keep) this.publish(pane);
  }

  private viewState(pane: Pane): BrowserViewState {
    const contents = this.liveContents(pane);
    const url = pane.lastUrl;
    const ai = pane.aiTurnId !== undefined ? 'driving' : pane.stoppedTurnId !== undefined ? 'stopped' : 'none';
    return {
      conversationId: pane.conversationId,
      url,
      // Always the current URL's class, never the last action's.
      ...(url ? { site: this.site(pane, url) } : {}),
      loading: pane.loading,
      canBack: contents?.navigationHistory.canGoBack() ?? false,
      canForward: contents?.navigationHistory.canGoForward() ?? false,
      ai,
      ...(pane.blocked ? { blocked: pane.blocked } : {}),
      ...(pane.allowedNow ? { allowed: pane.allowedNow } : {}),
      ...(pane.fault ? { fault: pane.fault } : {}),
      ...(pane.needsReopen ? { needsReopen: true } : {}),
    };
  }

  private publish(pane: Pane): void {
    try {
      this.deps.onState(this.viewState(pane));
    } catch {
      // A renderer that is going away cannot break the native view's lifecycle.
    }
  }
}

function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
