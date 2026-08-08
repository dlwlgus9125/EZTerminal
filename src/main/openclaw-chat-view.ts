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
 * Config retained by `docs/design/external-integrations.md`:
 * `sandbox: true`, `contextIsolation: true`,
 * NO preload, partition `persist:openclaw-chat` (isolated from the app's own
 * session/CSP — the packaged CSP is injected onto `session.defaultSession`
 * only, so this partition sits outside it by design; the anti-embed headers
 * this view actually needs are the real gateway's own). The Control UI fully
 * renders and authenticates via the `#token=` URL fragment with this exact
 * configuration — no `shell.openExternal` fallback is needed (M0 delta 5).
 *
 * Visibility has three independent inputs, ANDed together in `applyVisibility`:
 * the renderer-reported "desired" visibility (drawer/palette/tab-switch
 * z-order, App.tsx's effective-visibility derivation) and this manager's own
 * `hasError` / `loading` latches. While either is set the native view is
 * force-hidden so the DOM
 * placeholder's "reconnect" button underneath is actually clickable (a
 * visible WebContentsView would otherwise intercept every click, since it
 * paints and hit-tests above the DOM regardless of the DOM element's own
 * CSS visibility).
 */
import { shell, WebContentsView, type BrowserWindow, type Rectangle } from 'electron';

import type { OpenClawChatViewState } from '../shared/openclaw';

export type { OpenClawChatViewState } from '../shared/openclaw';

export interface OpenClawChatViewManagerDeps {
  /** Resolves the `#token=`-bearing chat URL, or null if no token is available
   * yet (see OpenClawService.getChatUrl) — the manager never assembles this
   * itself, keeping the token read in exactly one place. */
  readonly getChatUrl: () => Promise<string | null>;
  readonly openExternal?: (url: string) => Promise<void>;
  /** Pushed on every loading / unavailable / loaded transition. */
  readonly onStateChange: (state: OpenClawChatViewState) => void;
}

const EMPTY_BOUNDS: Rectangle = { x: 0, y: 0, width: 0, height: 0 };

function httpOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

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
  /** Invalidates async URL/view creation after an external close. */
  private lifecycleGeneration = 0;
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
    return this.trackCreation(this.view ? this.recreateIfOriginChanged() : this.doCreate());
  }

  private trackCreation(operation: Promise<void>): Promise<void> {
    const tracked = operation.finally(() => {
      if (this.creating === tracked) this.creating = null;
    });
    this.creating = tracked;
    return tracked;
  }

  /** A view already exists — see `ensureView`'s doc. */
  private async recreateIfOriginChanged(): Promise<void> {
    const view = this.view;
    const generation = this.lifecycleGeneration;
    const origin = await this.resolveOrigin();
    if (generation !== this.lifecycleGeneration || this.view !== view) return;
    if (!origin) {
      this.markError();
      return;
    }
    if (origin === this.currentOrigin) return;
    this.teardownView(true);
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
    return httpOrigin(url);
  }

  private async doCreate(): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const generation = this.lifecycleGeneration;
    this.markLoading();
    let url: string | null;
    try {
      url = await this.deps.getChatUrl();
    } catch {
      if (
        generation === this.lifecycleGeneration
        && this.win === win
        && !win.isDestroyed()
        && !this.view
      ) {
        this.markError();
      }
      return;
    }
    if (
      generation !== this.lifecycleGeneration
      || this.win !== win
      || win.isDestroyed()
      || this.view
    ) {
      return;
    }
    if (!url) {
      this.markError();
      return;
    }
    const origin = httpOrigin(url);
    if (!origin) {
      this.markError();
      return;
    }

    let view: WebContentsView;
    try {
      view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:openclaw-chat' },
      });
      this.view = view;
      this.currentOrigin = origin;
      win.contentView.addChildView(view);
      view.setBounds(this.desiredBounds);
      this.applyVisibility();
    } catch {
      this.teardownView(true);
      this.markError();
      return;
    }

    // Navigation hardening (mirrors main.ts's mainWindow gate, architecture
    // decision (a)): only the gateway's own origin may navigate this view
    // in-place; anything else (an external link inside the Control UI) opens
    // in the OS browser instead of hijacking the embed.
    try {
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
        if (/^https?:/i.test(openUrl)) {
          const openExternal = this.deps.openExternal ?? ((target: string) => shell.openExternal(target));
          void openExternal(openUrl).catch(() => undefined);
        }
        return { action: 'deny' };
      });

      view.webContents.on('did-fail-load', (_event, errorCode, _desc, _validatedUrl, isMainFrame) => {
        if (!isMainFrame) return; // a sub-frame/asset failure isn't "the gateway is unreachable"
        if (this.view !== view) return;
        this.markError(errorCode);
      });
      view.webContents.on('did-finish-load', () => {
        if (this.view !== view) return;
        this.markLoaded();
      });
      // M6: fires on every navigation this view starts (the initial loadURL
      // below AND every later webContents.reload()) — a single listener here
      // covers both without needing a manual flag flip at each call site.
      view.webContents.on('did-start-loading', () => {
        if (this.view !== view) return;
        // The real Control UI starts a subresource-only cycle after its main
        // document finishes. It has no matching did-finish-load, so latching
        // that cycle would hide the already-loaded chat indefinitely.
        if (!view.webContents.isLoadingMainFrame()) return;
        this.markLoading();
      });
    } catch {
      if (this.view === view) {
        this.teardownView(true);
        this.markError();
      }
      return;
    }

    try {
      await view.webContents.loadURL(url);
    } catch {
      // Electron normally emits did-fail-load before rejecting. If it did not,
      // synthesize the same explicit retry state instead of hanging on loading.
      if (this.view === view && this.loading) this.markError();
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
    this.view?.setVisible(this.desiredVisible && !this.hasError && !this.loading);
  }

  private markLoading(): void {
    this.hasError = false;
    this.loading = true;
    this.applyVisibility();
    this.publishState();
  }

  private markError(errorCode?: number): void {
    this.hasError = true;
    this.loading = false;
    this.applyVisibility();
    this.publishState(errorCode);
  }

  private markLoaded(): void {
    this.hasError = false;
    this.loading = false;
    this.applyVisibility();
    this.publishState();
  }

  private publishState(errorCode?: number): void {
    try {
      this.deps.onStateChange({
        hasError: this.hasError,
        loading: this.loading,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    } catch {
      // Renderer notification failures cannot break the native view lifecycle.
    }
  }

  /** Reconnect action (the placeholder's "재연결" button, and the panel's
   * stopped->running edge when a previous error is still latched — M5) —
   * re-resolves the fresh chat URL first: if the origin changed since the
   * view was created (a `gateway.port` config-set + restart), destroys +
   * recreates pointed at the new origin rather than blindly re-navigating a
   * dead one; otherwise a same-origin plain `webContents.reload()`. If URL
   * creation previously failed before a view existed, this retries creation.
   *
   * Shares `ensureView()`'s `creating` mutex: concurrent create/reload
   * requests coalesce onto the same operation, preventing duplicate views. */
  async reload(): Promise<void> {
    if (this.creating) return this.creating;
    const view = this.view;
    return this.trackCreation(view ? this.doReload(view) : this.doCreate());
  }

  /** `reload()`'s body, run under the `creating` mutex — re-checks
   * `this.view === view` after the `resolveOrigin()` await: the captured
   * view could have been torn down from outside the mutex (e.g. the owning
   * panel closing and calling `destroy()` directly) while this awaited. */
  private async doReload(view: WebContentsView): Promise<void> {
    const origin = await this.resolveOrigin();
    if (this.view !== view) return; // superseded — nothing left to reload
    if (!origin) {
      this.markError();
      return;
    }
    if (origin !== this.currentOrigin) {
      this.teardownView(true);
      await this.doCreate();
      return;
    }
    if (view.webContents.isDestroyed()) {
      this.teardownView(true);
      await this.doCreate();
      return;
    }
    try {
      this.markLoading();
      view.webContents.reload();
    } catch {
      this.markError();
    }
  }

  /** Tears the view down entirely (singleton panel closed, or the owning
   * window closed/reloaded — packetCaptureRegistry teardown hygiene
   * precedent). Idempotent. Never touches the gateway itself. */
  destroy(): void {
    this.teardownView(false);
  }

  private teardownView(preserveCreating: boolean): void {
    this.lifecycleGeneration += 1;
    if (!preserveCreating) this.creating = null;
    const view = this.view;
    this.view = null;
    this.hasError = false;
    this.loading = false;
    this.currentOrigin = null;
    if (!view) return;
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
