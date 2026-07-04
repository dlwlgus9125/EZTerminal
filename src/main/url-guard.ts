/**
 * Navigation guard predicate (SEC-HIGH-2, hardened in B-M6).
 *
 * The renderer can emit OSC-8 hyperlinks (`<a href>`) from external-program output
 * (ansi_up → TextBlock). A click would otherwise navigate the BrowserWindow to a
 * remote origin that then INHERITS `window.ezterminal.runCommand`. Only the app's
 * own origin may ever load in the window: the packaged renderer's OWN index.html
 * file URL (not arbitrary `file://` — a hostile local html file must not gain the
 * bridge either), or the Vite dev-server URL in development. Everything else is
 * blocked (`will-navigate` is prevented; external `http(s)` links are opened in
 * the system browser instead).
 *
 * Kept as a pure function (no Electron imports) so it is unit-testable in isolation.
 */
export function isAppUrl(
  url: string,
  devServerUrl: string | undefined,
  appRendererUrl: string | undefined,
): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  // Packaged renderer: exactly our index.html (query/hash tolerated). Windows
  // file paths are case-insensitive, so compare case-insensitively — a
  // case-twiddled URL resolves to the same file and must still be allowed.
  if (appRendererUrl) {
    const u = url.toLowerCase();
    const base = appRendererUrl.toLowerCase();
    if (u === base || (u.startsWith(base) && (u[base.length] === '?' || u[base.length] === '#'))) {
      return true;
    }
  }
  // Dev renderer is served from the Vite dev server (http://localhost:<port>).
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return false;
}
