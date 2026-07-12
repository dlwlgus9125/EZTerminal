/**
 * OpenClawChatViewManager — owns the ONE WebContentsView that embeds the
 * OpenClaw Control UI's chat inside the desktop 'openclaw-chat' dockview
 * panel (openclaw-management M3 — architecture decision (a)). Main creates
 * and positions this view; the renderer's `OpenClawChatPanel` is a plain DOM
 * placeholder that only reports its bounding rect + effective visibility
 * over IPC (see main.ts's `openclaw:chat-*` handlers) — the WebContentsView
 * paints ABOVE the renderer's DOM natively, so the placeholder never renders
 * chat content itself.
 *
 * Config verified live in the M0 Stage-0 spike (docs/research/
 * 2026-07-12-openclaw-stage0.md ②): `sandbox: true`, `contextIsolation: true`,
 * NO preload, partition `persist:openclaw-chat` (isolated from the app's own
 * session/CSP — the packaged CSP is injected onto `session.defaultSession`
 * only, so this partition sits outside it by design; the anti-embed headers
 * this view actually needs are the real gateway's own). The Control UI fully
 * renders and authenticates via the `#token=` URL fragment with this exact
 * configuration — no `shell.openExternal` fallback is needed (M0 delta 5).
 *
 * Visibility has two independent inputs, ANDed together in `applyVisibility`:
 * the renderer-reported "desired" visibility (drawer/palette/tab-switch
 * z-order, App.tsx's effective-visibility derivation) and this manager's own
 * `hasError` latch (set by `did-fail-load`, cleared by `did-finish-load`) —
 * while an error is latched the native view is force-hidden so the DOM
 * placeholder's "reconnect" button underneath is actually clickable (a
 * visible WebContentsView would otherwise intercept every click, since it
 * paints and hit-tests above the DOM regardless of the DOM element's own
 * CSS visibility).
 */
import { shell, WebContentsView, type BrowserWindow, type Rectangle } from 'electron';

export interface OpenClawChatViewState {
  readonly hasError: boolean;
  readonly errorCode?: number;
  readonly loading: boolean;
}

export interface OpenClawChatViewManagerDeps {
  /** Resolves the `#token=`-bearing chat URL, or null if no token is available
   * yet (see OpenClawService.getChatUrl) — the manager never assembles this
   * itself, keeping the token read in exactly one place. */
  readonly getChatUrl: () => Promise<string | null>;
  /** Pushed on every did-fail-load / did-finish-load transition. */
  readonly onStateChange: (state: OpenClawChatViewState) => void;
}

const EMPTY_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

export class OpenClawChatViewManager {
  private win: BrowserWindow | null = null;
  private view: WebContentsView | null = null;
  private creating: Promise<void> | null = null;
  private desiredVisible = false;
  private desiredBounds: Rectangle = EMPTY_BOUNDS;
  private hasError = false;
  /** True from did-start-loading until the load settles (openclaw-
   * stabilization M6 — see OpenClawChatViewState's doc). */
  private loading = false;
  /** The origin (scheme+host+port) the CURRENT view was created/last
   * recreated with — see `ensureView`/`reload`'s origin-change recreation
   * (openclaw-stabilization M5): a `gateway.port` config-set + restart
   * changes the chat URL's origin, which otherwise left a live view pointed
   * at a dead one forever. `null` while no view exists. */
  private currentOrigin: string | null = null;

  constructor(private readonly deps: OpenClawChatViewManagerDeps) {}

  /** Call once the target window exists (createWindow). Re-attaching (a fresh
   * window after the previous one closed) is safe — `destroy()` clears the
   * stale reference first in main.ts's window 'closed' hook. */
  attach(win: BrowserWindow): void {
    this.win = win;
  }

  /**
   * Idempotent lazy create: creates the view if none exists yet (a no-op if
   * no token is available — nothing to load, the caller's next visibility/
   * status push will retry). If a view already exists, re-resolves the
   * fresh chat URL and destroys + recreates it ONLY if the origin changed
   * since creation (M5 — a `gateway.port` config-set + restart) — a
   * same-origin call is a cheap no-op. This does NOT retry a latched error
   * on the SAME origin; that's `reload()`'s job (see OpenClawChatPanel's
   * stopped->running edge). Never throws.
   */
  async ensureView(): Promise<void> {
    if (this.creating) return this.creating;
    this.creating = (this.view ? this.recreateIfOriginChanged() : this.doCreate()).finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  /** A view already exists — see `ensureView`'s doc. */
  private async recreateIfOriginChanged(): Promise<void> {
    const origin = await this.resolveOrigin();
    if (!origin || origin === this.currentOrigin) return;
    this.destroy();
    await this.doCreate();
  }

  /** Resolves the CURRENT chat URL's origin, or `null` on any failure (no
   * token yet / an unparsable URL) — shared by `recreateIfOriginChanged` and
   * `reload()`. Never throws. */
  private async resolveOrigin(): Promise<string | null> {
    let url: string | null;
    try {
      url = await this.deps.getChatUrl();
    } catch {
      return null;
    }
    if (!url) return null;
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  private async doCreate(): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    let url: string | null;
    try {
      url = await this.deps.getChatUrl();
    } catch {
      return;
    }
    if (!url || !this.win || this.win.isDestroyed() || this.view) return; // re-check post-await races
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }

    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:openclaw-chat' },
    });
    this.view = view;
    this.currentOrigin = origin;
    this.win.contentView.addChildView(view);
    view.setBounds(this.desiredBounds);
    view.setVisible(this.desiredVisible && !this.hasError);

    // Navigation hardening (mirrors main.ts's mainWindow gate, architecture
    // decision (a)): only the gateway's own origin may navigate this view
    // in-place; anything else (an external link inside the Control UI) opens
    // in the OS browser instead of hijacking the embed.
    view.webContents.on('will-navigate', (event, navUrl) => {
      let navOrigin: string;
      try {
        navOrigin = new URL(navUrl).origin;
      } catch {
        event.preventDefault();
        return;
      }
      if (navOrigin !== origin) event.preventDefault();
    });
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      if (/^https?:/i.test(openUrl)) void shell.openExternal(openUrl);
      return { action: 'deny' };
    });

    view.webContents.on('did-fail-load', (_event, errorCode, _desc, _validatedUrl, isMainFrame) => {
      if (!isMainFrame) return; // a sub-frame/asset failure isn't "the gateway is unreachable"
      this.hasError = true;
      this.loading = false;
      this.applyVisibility();
      this.deps.onStateChange({ hasError: true, errorCode, loading: this.loading });
    });
    view.webContents.on('did-finish-load', () => {
      this.hasError = false;
      this.loading = false;
      this.applyVisibility();
      this.deps.onStateChange({ hasError: false, loading: this.loading });
    });
    // M6: fires on every navigation this view starts (the initial loadURL
    // below AND every later webContents.reload()) — a single listener here
    // covers both without needing a manual flag flip at each call site.
    view.webContents.on('did-start-loading', () => {
      this.loading = true;
      this.deps.onStateChange({ hasError: this.hasError, loading: this.loading });
    });

    try {
      await view.webContents.loadURL(url);
    } catch {
      // Expected on a connection-refused/unreachable gateway — `did-fail-load`
      // above already latched `hasError` and notified the renderer; loadURL's
      // own promise rejecting on the SAME failure is not a second error.
    }
  }

  setBounds(bounds: Rectangle): void {
    this.desiredBounds = bounds;
    this.view?.setBounds(bounds);
  }

  setVisible(visible: boolean): void {
    this.desiredVisible = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.view?.setVisible(this.desiredVisible && !this.hasError);
  }

  /** Reconnect action (the placeholder's "재연결" button, and the panel's
   * stopped->running edge when a previous error is still latched — M5) —
   * re-resolves the fresh chat URL first: if the origin changed since the
   * view was created (a `gateway.port` config-set + restart), destroys +
   * recreates pointed at the new origin rather than blindly re-navigating a
   * dead one; otherwise a same-origin plain `webContents.reload()`. No-op if
   * the view was never created (nothing to reconnect, e.g. no token was
   * ever available).
   *
   * Shares `ensureView()`'s `creating` mutex (race fix): awaits any in-
   * flight create/recreate first, then holds the mutex itself while it may
   * destroy/recreate, so a concurrent `ensureView()` can't run at the same
   * time and double-destroy/create the view. */
  async reload(): Promise<void> {
    if (this.creating) await this.creating;
    const view = this.view;
    if (!view) return;
    this.creating = this.doReload(view).finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  /** `reload()`'s body, run under the `creating` mutex — re-checks
   * `this.view === view` after the `resolveOrigin()` await: the captured
   * view could have been torn down from outside the mutex (e.g. the owning
   * panel closing and calling `destroy()` directly) while this awaited. */
  private async doReload(view: WebContentsView): Promise<void> {
    const origin = await this.resolveOrigin();
    if (this.view !== view) return; // superseded — nothing left to reload
    if (origin && origin !== this.currentOrigin) {
      this.destroy();
      await this.doCreate();
      return;
    }
    if (!view.webContents.isDestroyed()) view.webContents.reload();
  }

  /** Tears the view down entirely (singleton panel closed, or the owning
   * window closed/reloaded — packetCaptureRegistry teardown hygiene
   * precedent). Idempotent. Never touches the gateway itself. */
  destroy(): void {
    const view = this.view;
    if (!view) return;
    this.view = null;
    this.hasError = false;
    this.loading = false;
    this.currentOrigin = null;
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.contentView.removeChildView(view);
      } catch {
        /* window already tearing down */
      }
    }
    try {
      view.webContents.close();
    } catch {
      /* already destroyed */
    }
  }
}
