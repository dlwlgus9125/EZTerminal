import type {
  RendererRecoveryCheckpoint,
  RendererRecoveryPane,
} from '../shared/renderer-recovery';

let panesByPanelId: ReadonlyMap<string, RendererRecoveryPane> = new Map();
let recoveredActivePanelId: string | null = null;
let recoveryCheckpoint: RendererRecoveryCheckpoint | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

export const RENDERER_RECOVERY_STATE_CLEAR_DELAY_MS = 5_000;

/** Seeds volatile state before Dockview synchronously mounts restored panels. */
export function seedRendererRecoveryState(checkpoint: RendererRecoveryCheckpoint): void {
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = null;
  recoveryCheckpoint = checkpoint;
  panesByPanelId = new Map(checkpoint.panes.map((pane) => [pane.panelId, pane]));
  recoveredActivePanelId = checkpoint.activePanelId;
}

/** Reuses the one-shot main escrow value across Dockview's StrictMode
 * attachment generations. Both startup transactions must see the same input. */
export function peekRendererRecoveryCheckpoint(): RendererRecoveryCheckpoint | null {
  return recoveryCheckpoint;
}

export function peekRendererRecoveryPane(panelId: string): RendererRecoveryPane | undefined {
  return panesByPanelId.get(panelId);
}

export function peekRendererRecoveryActivePanelId(): string | null {
  return recoveredActivePanelId;
}

export function clearRendererRecoveryState(): void {
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = null;
  recoveryCheckpoint = null;
  panesByPanelId = new Map();
  recoveredActivePanelId = null;
}

/** Clear only after startup attachment churn has gone quiet. A later onReady
 * resets this timer by reseeding the cached checkpoint. */
export function scheduleRendererRecoveryStateClear(
  delayMs = RENDERER_RECOVERY_STATE_CLEAR_DELAY_MS,
): void {
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = setTimeout(clearRendererRecoveryState, Math.max(0, delayMs));
}
