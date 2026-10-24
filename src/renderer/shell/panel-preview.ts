import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * The preview place (Board + Desk, approved 2026-10-24): a conversation opened
 * from a list takes the place of the last one opened from a list, until the
 * person keeps it — 📌, a message, typing, a double-click on its tab, moving it.
 *
 * Which tab is the preview lives only here, never in Dockview params: the
 * saved layout schema is strict, and a restored layout opens with every tab
 * kept. DockWindowCoordinator decides placement; this slot only remembers.
 */
export class PanelPreviewSlot {
  private current: string | null = null;
  private readonly listeners = new Set<() => void>();

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  public readonly getSnapshot = (): string | null => this.current;

  public get panelId(): string | null {
    return this.current;
  }

  /** The tab just opened from a list becomes the preview; an earlier one stays as an ordinary tab. */
  public mark(panelId: string): void {
    this.set(panelId);
  }

  /** The person kept the tab (or it closed): it is no longer the preview. */
  public keep(panelId: string): void {
    if (this.current === panelId) this.set(null);
  }

  private set(next: string | null): void {
    if (this.current === next) return;
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export const PanelPreviewContext = createContext<PanelPreviewSlot | null>(null);

const NO_PREVIEW = (): (() => void) => () => undefined;

/** Whether this tab is the preview, and how to keep it. */
export function usePanelPreview(panelId: string): { readonly preview: boolean; readonly keep: () => void } {
  const slot = useContext(PanelPreviewContext);
  const current = useSyncExternalStore(slot?.subscribe ?? NO_PREVIEW, slot?.getSnapshot ?? (() => null));
  const keep = useCallback(() => { slot?.keep(panelId); }, [slot, panelId]);
  return { preview: current === panelId, keep };
}
