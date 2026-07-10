// paste-routing.ts — pure decision logic for the terminal long-press menu's
// Paste action (WT-parity M3): pasted clipboard text goes straight to a
// running PTY child if one is active, or into the composer draft otherwise
// (MobileSessionView.tsx's `command` state) — the same fallback path a
// paste-into-terminal from Files already uses (`registerPaneInput`). Kept
// free of React/BlockController so it's directly unit-testable, same shape
// as long-press.ts's `LongPressTracker` and upload-queue.ts's `createUploadQueue`.

/** The subset of `BlockController.getSnapshot()` this decision needs — kept
 * duck-typed rather than importing the real `BlockSnapshot` so tests can pass
 * plain object literals. */
export interface PasteTargetSnapshot {
  readonly status: string;
  readonly shape: string | null;
}

export type PasteTarget = 'pty' | 'composer';

/** `null` (no active run) or anything other than a RUNNING `pty`-shape block
 * falls back to the composer draft. */
export function resolvePasteTarget(snapshot: PasteTargetSnapshot | null): PasteTarget {
  return snapshot && snapshot.status === 'running' && snapshot.shape === 'pty' ? 'pty' : 'composer';
}

/** Appends `text` to the composer draft `prev`, space-separated unless `prev`
 * is empty or already ends in whitespace — the exact rule
 * `MobileSessionView.tsx`'s `registerPaneInput` callback uses for a
 * paste-path-into-terminal from Files, shared here so the long-press Paste
 * action lands identically. */
export function appendToComposer(prev: string, text: string): string {
  return prev === '' || /\s$/.test(prev) ? `${prev}${text}` : `${prev} ${text}`;
}
