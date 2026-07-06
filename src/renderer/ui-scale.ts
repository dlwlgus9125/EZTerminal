/**
 * UI scale (v0.2.0 D1) — a single CSS variable multiplier applied to the
 * document root, composed with each theme's own base px (index.css:62/114,
 * themes.ts's `fontSize`). Mirrors the `dataset.theme`+`ez:theme` mechanism
 * in themes.ts: `dataset.uiScale` + `ez:ui-scale` notify open PtyBlocks to
 * re-scale their xterm fontSize.
 *
 * Dependency-free by design (no imports) — this module is shared verbatim by
 * the mobile app later, so it must not pull in anything DOM-only at the
 * module level. `clampUiScale` is pure (safe on either side); `applyUiScale`/
 * `getActiveUiScale` assume a `document` (desktop renderer / mobile webview).
 */

export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 10;
export const UI_SCALE_DEFAULT = 100;

/** Snap to the nearest step, then clamp to [MIN, MAX]. Non-finite input
 * (NaN, or a value that arrived as undefined/corrupt) falls back to the
 * default — this is the UI-side half of the schema+UI double clamp (v0.2.0
 * risk #3: a persisted or IPC-relayed value must never reach the DOM
 * unclamped). */
export function clampUiScale(n: number): number {
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT;
  const snapped = Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, snapped));
}

/** Apply a UI scale percent to the document root: sets the `--ez-ui-scale`
 * multiplier index.css's calc() expressions read, mirrors it into
 * `dataset.uiScale` (so getActiveUiScale/other readers don't need the raw
 * percent threaded through), and notifies listeners (PtyBlock's xterm
 * fontSize re-scale) via the same event-on-window shape as 'ez:theme'. */
export function applyUiScale(percent: number): void {
  const clamped = clampUiScale(percent);
  document.documentElement.style.setProperty('--ez-ui-scale', String(clamped / 100));
  document.documentElement.dataset.uiScale = String(clamped);
  window.dispatchEvent(new Event('ez:ui-scale'));
}

/** Read the UI scale currently applied to the document (defaults to 100 for
 * an absent/invalid value) — same shape as themes.ts's getActiveThemeName. */
export function getActiveUiScale(): number {
  const attr = document.documentElement.dataset.uiScale;
  const n = Number(attr);
  return attr !== undefined && Number.isFinite(n) ? n : UI_SCALE_DEFAULT;
}
