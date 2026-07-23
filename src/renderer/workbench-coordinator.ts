import type { DockviewApi, SerializedDockview } from 'dockview-react';

import { maxTabSuffix, type LayoutEnvelope } from '../shared/layout-schema';
import {
  advanceRecentPanelSwitch,
  reconcileRecentPanelSwitch,
  recordRecentPanelActivation,
  startRecentPanelSwitch,
  type RecentPanelSwitchSession,
} from './recent-panel-switching';

export type WorkbenchSplitDirection = 'right' | 'below';

export interface WorkbenchPanelPosition {
  readonly referencePanel: string;
  readonly direction: WorkbenchSplitDirection;
}

export interface TerminalPaneOpenRequest {
  readonly position?: WorkbenchPanelPosition;
  readonly cwd?: string;
  readonly adoptSessionId?: string;
  readonly allowDuringRecovery?: boolean;
}

export interface OpenedWorkbenchPane {
  readonly panelId: string;
  readonly instanceToken: object;
}

interface WorkbenchPaneAdapter {
  readonly id: string;
  readonly instanceToken: object;
  activate(): void;
  close(): void;
}

export interface WorkbenchDockAdapter {
  panelIds(): readonly string[];
  activePanelId(): string | null;
  getPanel(panelId: string): WorkbenchPaneAdapter | undefined;
  addTerminalPane(options: {
    readonly id: string;
    readonly title: string;
    readonly position?: WorkbenchPanelPosition;
    readonly cwd?: string;
    readonly adoptSessionId?: string;
  }): WorkbenchPaneAdapter;
  serialize(): unknown;
  restore(layout: unknown): void;
  focus(): void;
  onActivePanelChange(listener: (panelId: string | null) => void): { dispose(): void };
  onPanelRemoved(listener: () => void): { dispose(): void };
  onLayoutChange(listener: () => void): { dispose(): void };
}

export interface WorkbenchPersistenceAdapter {
  saveLayout(layout: unknown): Promise<void>;
  flushLayout(): Promise<void>;
  quarantineLayout(): Promise<void>;
}

export interface LayoutTransactionOptions {
  readonly quarantineOnCorrupt: boolean;
  readonly restoreBackupOnFailure: boolean;
  readonly beforeApply?: () => boolean;
}

export interface WorkbenchAttachment {
  isCurrent(): boolean;
  enableLayoutPersistence(): boolean;
}

export interface WorkbenchCoordinatorOptions {
  readonly persistence: WorkbenchPersistenceAdapter;
  readonly isPaneCreationLocked: () => boolean;
  readonly onActivePanelChange: (panelId: string | null, source: 'attach' | 'activation') => void;
  readonly onRecentPanelSwitchChange: (session: RecentPanelSwitchSession | null) => void;
  readonly focusPane: (panelId: string) => boolean;
  readonly requestFrame?: (callback: () => void) => void;
  readonly saveDebounceMs?: number;
  readonly onError?: (message: string, error: unknown) => void;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 300;

/**
 * Owns the stateful workbench invariants that used to be distributed across
 * App callbacks: Dockview instance generations, terminal pane identity,
 * layout transaction/save ordering, and recent-panel close reconciliation.
 *
 * Dockview itself is an Adapter at this Seam. Tests use an in-memory Adapter,
 * so the Interface is also the race/lifecycle test surface.
 */
export class WorkbenchCoordinator {
  private adapter: WorkbenchDockAdapter | null = null;
  private attachmentGeneration = 0;
  private transactionGeneration = 0;
  private panelCounter = 0;
  private savesSuppressed = true;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTail: Promise<void> = Promise.resolve();
  private activeDisposable: { dispose(): void } | null = null;
  private removeDisposable: { dispose(): void } | null = null;
  private layoutDisposable: { dispose(): void } | null = null;
  private recentPanelOrder: readonly string[] = [];
  private recentPanelSwitch: RecentPanelSwitchSession | null = null;

  public constructor(private readonly options: WorkbenchCoordinatorOptions) {}

  public attach(adapter: WorkbenchDockAdapter): WorkbenchAttachment {
    this.detach();
    this.adapter = adapter;
    this.savesSuppressed = true;
    const generation = this.attachmentGeneration;
    this.seedPanelCounter(adapter.panelIds());

    const initialActivePanelId = adapter.activePanelId();
    this.options.onActivePanelChange(initialActivePanelId, 'attach');
    if (initialActivePanelId) {
      this.recentPanelOrder = recordRecentPanelActivation(
        this.recentPanelOrder,
        initialActivePanelId,
        adapter.panelIds(),
      );
    }
    this.setRecentPanelSwitch(null);

    this.activeDisposable = adapter.onActivePanelChange((panelId) => {
      if (!this.isCurrent(adapter, generation)) return;
      this.options.onActivePanelChange(panelId, 'activation');
      if (panelId) {
        this.recentPanelOrder = recordRecentPanelActivation(
          this.recentPanelOrder,
          panelId,
          adapter.panelIds(),
        );
      }
      if (this.recentPanelSwitch && panelId !== this.recentPanelSwitch.originPanelId) {
        this.setRecentPanelSwitch(null);
      }
    });
    this.removeDisposable = adapter.onPanelRemoved(() => {
      if (!this.isCurrent(adapter, generation)) return;
      const availablePanelIds = adapter.panelIds();
      const available = new Set(availablePanelIds);
      this.recentPanelOrder = this.recentPanelOrder.filter((panelId) => available.has(panelId));
      if (this.recentPanelSwitch) {
        this.setRecentPanelSwitch(reconcileRecentPanelSwitch(this.recentPanelSwitch, availablePanelIds));
      }
    });

    return {
      isCurrent: () => this.isCurrent(adapter, generation),
      enableLayoutPersistence: () => this.enableLayoutPersistence(adapter, generation),
    };
  }

  public detach(): void {
    this.cancelScheduledSave();
    this.layoutDisposable?.dispose();
    this.layoutDisposable = null;
    this.activeDisposable?.dispose();
    this.activeDisposable = null;
    this.removeDisposable?.dispose();
    this.removeDisposable = null;
    this.adapter = null;
    this.savesSuppressed = true;
    this.attachmentGeneration += 1;
    this.transactionGeneration += 1;
    this.setRecentPanelSwitch(null);
  }

  public openTerminal(request: TerminalPaneOpenRequest = {}): OpenedWorkbenchPane | null {
    if (this.options.isPaneCreationLocked() && !request.allowDuringRecovery) return null;
    const adapter = this.adapter;
    if (!adapter) return null;
    this.panelCounter += 1;
    const panelId = `tab-${this.panelCounter}`;
    const panel = adapter.addTerminalPane({
      id: panelId,
      title: `Terminal ${this.panelCounter}`,
      ...(request.position ? { position: request.position } : {}),
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.adoptSessionId ? { adoptSessionId: request.adoptSessionId } : {}),
    });
    return { panelId: panel.id, instanceToken: panel.instanceToken };
  }

  public splitActive(direction: WorkbenchSplitDirection): OpenedWorkbenchPane | null {
    const activePanelId = this.adapter?.activePanelId();
    if (!activePanelId) return null;
    return this.openTerminal({ position: { referencePanel: activePanelId, direction } });
  }

  public activatePanel(panelId: string): boolean {
    const adapter = this.adapter;
    const panel = adapter?.getPanel(panelId);
    if (!adapter || !panel) return false;
    const generation = this.attachmentGeneration;
    const instanceToken = panel.instanceToken;
    panel.activate();
    this.requestFrame(() => {
      if (
        !this.isCurrent(adapter, generation)
        || adapter.getPanel(panelId)?.instanceToken !== instanceToken
      ) return;
      if (!this.options.focusPane(panelId)) adapter.focus();
    });
    return true;
  }

  public closePanel(panelId: string, expectedInstanceToken?: object): boolean {
    const panel = this.adapter?.getPanel(panelId);
    if (!panel || (expectedInstanceToken && panel.instanceToken !== expectedInstanceToken)) return false;
    panel.close();
    return true;
  }

  public focusActivePanel(): void {
    const panelId = this.adapter?.activePanelId();
    if (!panelId) return;
    const adapter = this.adapter;
    const instanceToken = adapter?.getPanel(panelId)?.instanceToken;
    if (!adapter || !instanceToken) return;
    const generation = this.attachmentGeneration;
    this.requestFrame(() => {
      if (
        !this.isCurrent(adapter, generation)
        || adapter.activePanelId() !== panelId
        || adapter.getPanel(panelId)?.instanceToken !== instanceToken
      ) return;
      if (!this.options.focusPane(panelId)) adapter.focus();
    });
  }

  public cycleRecentPanel(reverse: boolean): void {
    const adapter = this.adapter;
    const activePanelId = adapter?.activePanelId();
    if (!adapter || !activePanelId) return;
    const availablePanelIds = adapter.panelIds();
    if (this.recentPanelSwitch) {
      const reconciled = reconcileRecentPanelSwitch(this.recentPanelSwitch, availablePanelIds);
      this.setRecentPanelSwitch(reconciled ? advanceRecentPanelSwitch(reconciled, reverse) : null);
      return;
    }
    this.setRecentPanelSwitch(
      startRecentPanelSwitch(this.recentPanelOrder, availablePanelIds, activePanelId, reverse),
    );
  }

  public commitRecentPanelSwitch(): void {
    const session = this.recentPanelSwitch;
    const adapter = this.adapter;
    if (!session || !adapter) return;
    const reconciled = reconcileRecentPanelSwitch(session, adapter.panelIds());
    this.setRecentPanelSwitch(null);
    this.activatePanel(reconciled?.selectedPanelId ?? session.originPanelId);
  }

  public cancelRecentPanelSwitch(restoreFocus: boolean): void {
    const session = this.recentPanelSwitch;
    if (!session) return;
    this.setRecentPanelSwitch(null);
    if (restoreFocus) this.activatePanel(session.originPanelId);
  }

  public isRecentPanelSwitchOpen(): boolean {
    return this.recentPanelSwitch !== null;
  }

  public scheduleLayoutSave(): void {
    const adapter = this.adapter;
    if (!adapter || this.savesSuppressed) return;
    this.cancelScheduledSave();
    const generation = this.attachmentGeneration;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.isCurrent(adapter, generation) || this.savesSuppressed) return;
      const layout = adapter.serialize();
      void this.enqueueSave(layout, adapter, generation).catch(() => undefined);
    }, this.options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS);
  }

  public async flushLayoutSave(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter || this.savesSuppressed) return;
    this.cancelScheduledSave();
    const generation = this.attachmentGeneration;
    const saved = await this.enqueueSave(adapter.serialize(), adapter, generation);
    if (!saved || !this.isCurrent(adapter, generation) || this.savesSuppressed) return;
    await this.options.persistence.flushLayout();
  }

  public async runLayoutTransaction(
    source: () => Promise<LayoutEnvelope | null>,
    options: LayoutTransactionOptions,
  ): Promise<boolean> {
    const adapter = this.adapter;
    if (!adapter) return false;
    this.transactionGeneration += 1;
    const transactionGeneration = this.transactionGeneration;
    const attachmentGeneration = this.attachmentGeneration;
    const isStale = (): boolean =>
      transactionGeneration !== this.transactionGeneration
      || !this.isCurrent(adapter, attachmentGeneration);

    this.cancelScheduledSave();
    this.savesSuppressed = true;
    let applied = false;
    try {
      let envelope: LayoutEnvelope | null = null;
      try {
        envelope = await source();
      } catch {
        envelope = null;
      }
      if (isStale()) return false;

      if (envelope) {
        if (options.beforeApply && !options.beforeApply()) return false;
        const backup = options.restoreBackupOnFailure && adapter.panelIds().length > 0
          ? adapter.serialize()
          : null;
        try {
          this.panelCounter = Math.max(this.panelCounter, maxTabSuffix(envelope.layout));
          adapter.restore(envelope.layout);
          if (adapter.panelIds().length === 0) throw new Error('layout restored zero panels');
          applied = true;
        } catch (error) {
          if (isStale()) return false;
          this.reportError('layout apply failed', error);
          if (options.quarantineOnCorrupt) {
            try {
              await this.options.persistence.quarantineLayout();
            } catch {
              // Quarantine is best-effort; recovery below must still run.
            }
            if (isStale()) return false;
          }
          if (backup) {
            try {
              adapter.restore(backup);
            } catch {
              // A recovery pane below covers a failed backup restore.
            }
          }
          if (adapter.panelIds().length === 0) {
            this.openTerminal({ allowDuringRecovery: true });
          }
        }
      } else if (adapter.panelIds().length === 0) {
        this.openTerminal({ allowDuringRecovery: true });
      }
    } finally {
      if (!isStale()) this.savesSuppressed = false;
    }
    return applied;
  }

  private enableLayoutPersistence(adapter: WorkbenchDockAdapter, generation: number): boolean {
    if (!this.isCurrent(adapter, generation)) return false;
    this.layoutDisposable?.dispose();
    this.layoutDisposable = adapter.onLayoutChange(() => {
      if (this.isCurrent(adapter, generation)) this.scheduleLayoutSave();
    });
    return true;
  }

  private isCurrent(adapter: WorkbenchDockAdapter, generation: number): boolean {
    return this.adapter === adapter && this.attachmentGeneration === generation;
  }

  private setRecentPanelSwitch(session: RecentPanelSwitchSession | null): void {
    if (this.recentPanelSwitch === session) return;
    this.recentPanelSwitch = session;
    this.options.onRecentPanelSwitchChange(session);
  }

  private seedPanelCounter(panelIds: readonly string[]): void {
    for (const panelId of panelIds) {
      const match = /^tab-(\d+)$/.exec(panelId);
      if (match) this.panelCounter = Math.max(this.panelCounter, Number.parseInt(match[1]!, 10));
    }
  }

  private cancelScheduledSave(): void {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private enqueueSave(
    layout: unknown,
    adapter: WorkbenchDockAdapter,
    generation: number,
  ): Promise<boolean> {
    const attempt = this.saveTail.then(async () => {
      if (!this.isCurrent(adapter, generation) || this.savesSuppressed) return false;
      await this.options.persistence.saveLayout(layout);
      return true;
    });
    this.saveTail = attempt.then(
      () => undefined,
      (error: unknown) => {
      this.reportError('layout save failed', error);
      },
    );
    return attempt;
  }

  private requestFrame(callback: () => void): void {
    if (this.options.requestFrame) {
      this.options.requestFrame(callback);
      return;
    }
    requestAnimationFrame(callback);
  }

  private reportError(message: string, error: unknown): void {
    if (this.options.onError) {
      this.options.onError(message, error);
      return;
    }
    console.error(`[renderer] ${message}:`, error);
  }
}

export function createDockviewWorkbenchAdapter(api: DockviewApi): WorkbenchDockAdapter {
  const pane = (panelId: string): WorkbenchPaneAdapter | undefined => {
    const panel = api.getPanel(panelId);
    if (!panel) return undefined;
    return {
      id: panel.id,
      instanceToken: panel.api,
      activate: () => panel.api.setActive(),
      close: () => panel.api.close(),
    };
  };

  return {
    panelIds: () => api.panels.map((panel) => panel.id),
    activePanelId: () => api.activePanel?.id ?? null,
    getPanel: pane,
    addTerminalPane: (options) => {
      const params = {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.adoptSessionId ? { adoptSessionId: options.adoptSessionId } : {}),
      };
      const panel = api.addPanel({
        id: options.id,
        component: 'terminal',
        title: options.title,
        renderer: 'always',
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ...(options.position ? { position: options.position } : {}),
      });
      return {
        id: panel.id,
        instanceToken: panel.api,
        activate: () => panel.api.setActive(),
        close: () => panel.api.close(),
      };
    },
    serialize: () => api.toJSON(),
    restore: (layout) => api.fromJSON(layout as SerializedDockview),
    focus: () => api.focus(),
    onActivePanelChange: (listener) =>
      api.onDidActivePanelChange((event) => listener(event.panel?.id ?? null)),
    onPanelRemoved: (listener) => api.onDidRemovePanel(() => listener()),
    onLayoutChange: (listener) => api.onDidLayoutChange(listener),
  };
}
