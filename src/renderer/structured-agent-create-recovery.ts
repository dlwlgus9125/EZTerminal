import {
  RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES,
  type RendererRecoveryStructuredAgentCreate,
} from '../shared/renderer-recovery';

export type StructuredAgentCreateRecoveryListener = () => void;

/** Select every live panel-bound record, or fail when one checkpoint cannot hold them all. */
export function structuredAgentCreateCheckpointRecords(
  records: readonly RendererRecoveryStructuredAgentCreate[],
  panelIds: ReadonlySet<string>,
): readonly RendererRecoveryStructuredAgentCreate[] | null {
  const panelBound = records.filter((record) => panelIds.has(record.panelId));
  return panelBound.length <= RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES
    ? Object.freeze(panelBound)
    : null;
}

/**
 * App-lifetime owner for exact structured Agent create envelopes whose delivery
 * is not yet definitive. Components may remount, but entries live until the
 * matching command settles.
 */
export class StructuredAgentCreateRecoveryRegistry {
  private readonly records = new Map<string, RendererRecoveryStructuredAgentCreate>();
  private readonly listeners = new Set<StructuredAgentCreateRecoveryListener>();

  public readonly subscribe = (listener: StructuredAgentCreateRecoveryListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public get(panelId: string): RendererRecoveryStructuredAgentCreate | undefined {
    return this.records.get(panelId);
  }

  public list(): readonly RendererRecoveryStructuredAgentCreate[] {
    return Object.freeze([...this.records.values()]);
  }

  public register(record: RendererRecoveryStructuredAgentCreate): boolean {
    const current = this.records.get(record.panelId);
    if (current === record) return true;
    if (!current && this.records.size >= RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES) {
      return false;
    }
    this.records.set(record.panelId, record);
    this.emit();
    return true;
  }

  public markDeliveryUncertain(panelId: string, commandId: string): void {
    const current = this.records.get(panelId);
    if (!current || current.command.commandId !== commandId || current.phase === 'delivery-uncertain') return;
    this.records.set(panelId, Object.freeze({ ...current, phase: 'delivery-uncertain' }));
    this.emit();
  }

  /** A stale async completion cannot clear a newer revision-conflict retry. */
  public clear(panelId: string, commandId?: string): boolean {
    const current = this.records.get(panelId);
    if (!current || (commandId !== undefined && current.command.commandId !== commandId)) return false;
    this.records.delete(panelId);
    this.emit();
    return true;
  }

  public blocksPanelClose(panelId: string): boolean {
    return this.records.has(panelId);
  }

  public blocksAuxiliaryClose(panelIds: readonly string[]): boolean {
    return panelIds.some((panelId) => this.records.has(panelId));
  }

  public blocksWorkspaceReplacement(): boolean {
    return this.records.size > 0;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
