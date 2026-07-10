/**
 * Scrollback (WT-parity M5) — a persisted line-count read by every open
 * PtyBlock's xterm instance. Mirrors `ui-scale.ts`'s mechanism exactly:
 * `dataset.scrollback` + `ez:scrollback` notify open PtyBlocks to re-apply
 * `term.options.scrollback` live, without remounting the terminal.
 *
 * Dependency-free by design (no imports) — same reasoning as ui-scale.ts:
 * this module is shared verbatim by the mobile app (PtyBlock.tsx is reused
 * there via Block.tsx). `clampScrollback` is pure (safe on either side);
 * `applyScrollback`/`getActiveScrollback` assume a `document` (desktop
 * renderer / mobile webview).
 */

export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 100000;
export const SCROLLBACK_DEFAULT = 5000;

/** Round to the nearest line, then clamp to [MIN, MAX]. Non-finite input
 * (NaN, or a value that arrived as undefined/corrupt) falls back to the
 * default — same double-clamp reasoning as clampUiScale (a persisted or
 * IPC-relayed value must never reach xterm unclamped). */
export function clampScrollback(n: number): number {
  if (!Number.isFinite(n)) return SCROLLBACK_DEFAULT;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(n)));
}

/** Apply a scrollback line count to the document root: mirrors it into
 * `dataset.scrollback` (so getActiveScrollback/other readers don't need the
 * raw value threaded through) and notifies listeners (PtyBlock's live
 * `term.options.scrollback` re-apply) via the same event-on-window shape as
 * 'ez:ui-scale'/'ez:theme'. */
export function applyScrollback(lines: number): void {
  const clamped = clampScrollback(lines);
  document.documentElement.dataset.scrollback = String(clamped);
  window.dispatchEvent(new Event('ez:scrollback'));
}

/** Read the scrollback line count currently applied to the document
 * (defaults to 5000 for an absent/invalid value) — same shape as
 * ui-scale.ts's getActiveUiScale. */
export function getActiveScrollback(): number {
  const attr = document.documentElement.dataset.scrollback;
  const n = Number(attr);
  return attr !== undefined && Number.isFinite(n) ? n : SCROLLBACK_DEFAULT;
}
