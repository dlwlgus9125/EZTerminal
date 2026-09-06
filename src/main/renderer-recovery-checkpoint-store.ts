import {
  validateRendererRecoveryCheckpoint,
  type RendererRecoveryCheckpoint,
} from '../shared/renderer-recovery';

export const RENDERER_RECOVERY_CHECKPOINT_TTL_MS = 5 * 60_000;

interface RecoveryRecord {
  checkpoint: RendererRecoveryCheckpoint;
  recoverableUntil: number | null;
}

/** Main-process, memory-only checkpoint escrow keyed by WebContents identity. */
export class RendererRecoveryCheckpointStore {
  private readonly records = new Map<number, RecoveryRecord>();

  constructor(
    private readonly ttlMs = RENDERER_RECOVERY_CHECKPOINT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  save(webContentsId: number, value: unknown): boolean {
    const checkpoint = validateRendererRecoveryCheckpoint(value);
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0 || !checkpoint) return false;
    const current = this.records.get(webContentsId);
    this.records.set(webContentsId, {
      checkpoint,
      recoverableUntil: current?.recoverableUntil ?? null,
    });
    return true;
  }

  markRecoverable(webContentsId: number): void {
    const current = this.records.get(webContentsId);
    if (!current) return;
    current.recoverableUntil = this.now() + this.ttlMs;
  }

  consume(webContentsId: number): RendererRecoveryCheckpoint | null {
    const current = this.records.get(webContentsId);
    if (!current || current.recoverableUntil === null) return null;
    const recoverableUntil = current.recoverableUntil;
    const now = this.now();
    const hasPendingStructuredAgentCreate = current.checkpoint.structuredAgentCreates.length > 0;
    // Delivery uncertainty has no safe time-based resolution. Keep that exact,
    // memory-only envelope for this main-process lifetime; ordinary checkpoints
    // continue to obey both TTL bounds below.
    if (
      !hasPendingStructuredAgentCreate
      && (now > recoverableUntil || now > current.checkpoint.savedAt + this.ttlMs)
    ) {
      this.records.delete(webContentsId);
      return null;
    }
    current.recoverableUntil = null;
    return current.checkpoint;
  }

  hasPendingStructuredAgentCreate(webContentsId: number): boolean {
    return (this.records.get(webContentsId)?.checkpoint.structuredAgentCreates.length ?? 0) > 0;
  }

  blocksMainWindowClose(webContentsId: number, keepRunning: boolean): boolean {
    return !keepRunning && this.hasPendingStructuredAgentCreate(webContentsId);
  }

  clear(webContentsId: number): void {
    this.records.delete(webContentsId);
  }

  clearAll(): void {
    this.records.clear();
  }
}
