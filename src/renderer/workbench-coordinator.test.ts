import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LayoutEnvelope } from '../shared/layout-schema';
import {
  WorkbenchCoordinator,
  type TerminalPaneOpenRequest,
  type WorkbenchCoordinatorOptions,
  type WorkbenchDockAdapter,
} from './workbench-coordinator';

interface ListenerEntry<T> {
  readonly listener: T;
  disposed: boolean;
}

class FakeDockAdapter implements WorkbenchDockAdapter {
  public readonly added: Array<{
    readonly id: string;
    readonly title: string;
    readonly position?: { readonly referencePanel: string; readonly direction: 'right' | 'below' };
    readonly cwd?: string;
    readonly adoptSessionId?: string;
  }> = [];
  public readonly restores: unknown[] = [];
  public focusCount = 0;
  public failNextRestore = false;
  public serialized: unknown = { layout: 'initial' };
  private readonly panels = new Map<string, { readonly token: object; active: boolean; closed: boolean }>();
  private readonly activeListeners: Array<ListenerEntry<(panelId: string | null) => void>> = [];
  private readonly removeListeners: Array<ListenerEntry<() => void>> = [];
  private readonly layoutListeners: Array<ListenerEntry<() => void>> = [];
  private activeId: string | null = null;

  public constructor(panelIds: readonly string[] = [], activePanelId: string | null = panelIds[0] ?? null) {
    for (const panelId of panelIds) {
      this.panels.set(panelId, { token: {}, active: false, closed: false });
    }
    this.activeId = activePanelId;
  }

  public panelIds(): readonly string[] {
    return [...this.panels.entries()]
      .filter(([, panel]) => !panel.closed)
      .map(([panelId]) => panelId);
  }

  public activePanelId(): string | null {
    return this.activeId;
  }

  public getPanel(panelId: string) {
    const panel = this.panels.get(panelId);
    if (!panel || panel.closed) return undefined;
    return {
      id: panelId,
      instanceToken: panel.token,
      activate: () => {
        panel.active = true;
        this.activeId = panelId;
        this.emitActive(panelId);
      },
      close: () => {
        panel.closed = true;
        if (this.activeId === panelId) this.activeId = this.panelIds()[0] ?? null;
        this.emitRemoved();
      },
    };
  }

  public addTerminalPane(options: TerminalPaneOpenRequest & { readonly id: string; readonly title: string }) {
    this.added.push(options);
    const panel = { token: {}, active: true, closed: false };
    this.panels.set(options.id, panel);
    this.activeId = options.id;
    this.emitActive(options.id);
    return this.getPanel(options.id)!;
  }

  public serialize(): unknown {
    return this.serialized;
  }

  public restore(layout: unknown): void {
    this.restores.push(layout);
    if (this.failNextRestore) {
      this.failNextRestore = false;
      this.panels.clear();
      this.activeId = null;
      throw new Error('simulated restore failure');
    }
    const panelRecords = (layout as { panels?: Record<string, unknown> }).panels;
    if (!panelRecords) throw new Error('invalid fake layout');
    this.panels.clear();
    for (const panelId of Object.keys(panelRecords)) {
      this.panels.set(panelId, { token: {}, active: false, closed: false });
    }
    this.activeId = this.panelIds()[0] ?? null;
    this.emitActive(this.activeId);
  }

  public focus(): void {
    this.focusCount += 1;
  }

  public onActivePanelChange(listener: (panelId: string | null) => void) {
    return this.register(this.activeListeners, listener);
  }

  public onPanelRemoved(listener: () => void) {
    return this.register(this.removeListeners, listener);
  }

  public onLayoutChange(listener: () => void) {
    return this.register(this.layoutListeners, listener);
  }

  public emitActive(panelId: string | null, includeDisposed = false): void {
    this.activeId = panelId;
    this.emit(this.activeListeners, panelId, includeDisposed);
  }

  public emitRemoved(includeDisposed = false): void {
    this.emit(this.removeListeners, undefined, includeDisposed);
  }

  public emitLayout(includeDisposed = false): void {
    this.emit(this.layoutListeners, undefined, includeDisposed);
  }

  public replacePanel(panelId: string): void {
    this.panels.set(panelId, { token: {}, active: true, closed: false });
    this.activeId = panelId;
  }

  private register<T>(entries: Array<ListenerEntry<T>>, listener: T) {
    const entry = { listener, disposed: false };
    entries.push(entry);
    return { dispose: () => { entry.disposed = true; } };
  }

  private emit<T>(entries: readonly ListenerEntry<(value: T) => void>[], value: T, includeDisposed: boolean): void {
    for (const entry of entries) {
      if (includeDisposed || !entry.disposed) entry.listener(value);
    }
  }
}

function layoutEnvelope(panelIds: readonly string[]): LayoutEnvelope {
  return {
    schemaVersion: 1,
    savedAt: '2026-07-24T00:00:00.000Z',
    layout: {
      grid: {
        root: { type: 'branch', data: [] },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: Object.fromEntries(
        panelIds.map((id) => [id, { id, contentComponent: 'terminal' as const, renderer: 'always' as const }]),
      ),
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function coordinatorOptions(
  overrides: Partial<WorkbenchCoordinatorOptions> = {},
): WorkbenchCoordinatorOptions {
  return {
    persistence: {
      saveLayout: vi.fn(async () => undefined),
      flushLayout: vi.fn(async () => undefined),
      quarantineLayout: vi.fn(async () => undefined),
    },
    isPaneCreationLocked: () => false,
    onActivePanelChange: vi.fn(),
    onRecentPanelSwitchChange: vi.fn(),
    focusPane: vi.fn(() => true),
    requestFrame: (callback) => callback(),
    onError: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorkbenchCoordinator lifecycle', () => {
  it('rejects stale events, transactions, and attachment callbacks after replacement', async () => {
    const options = coordinatorOptions();
    const coordinator = new WorkbenchCoordinator(options);
    const first = new FakeDockAdapter(['tab-1'], 'tab-1');
    const second = new FakeDockAdapter(['tab-9'], 'tab-9');
    const firstAttachment = coordinator.attach(first);
    const pendingLayout = deferred<LayoutEnvelope | null>();
    const transaction = coordinator.runLayoutTransaction(
      () => pendingLayout.promise,
      { quarantineOnCorrupt: true, restoreBackupOnFailure: false },
    );

    const secondAttachment = coordinator.attach(second);
    first.emitActive('tab-1', true);
    first.emitRemoved(true);
    pendingLayout.resolve(layoutEnvelope(['tab-7']));

    await expect(transaction).resolves.toBe(false);
    expect(first.restores).toEqual([]);
    expect(firstAttachment.isCurrent()).toBe(false);
    expect(firstAttachment.enableLayoutPersistence()).toBe(false);
    expect(secondAttachment.isCurrent()).toBe(true);
    expect(options.onActivePanelChange).toHaveBeenLastCalledWith('tab-9', 'attach');
  });

  it('tears down idempotently and cancels queued work even if an Adapter fires disposed callbacks', async () => {
    vi.useFakeTimers();
    const saveLayout = vi.fn(async () => undefined);
    const options = coordinatorOptions({
      persistence: {
        saveLayout,
        flushLayout: vi.fn(async () => undefined),
        quarantineLayout: vi.fn(async () => undefined),
      },
    });
    const coordinator = new WorkbenchCoordinator(options);
    const dock = new FakeDockAdapter(['tab-1'], 'tab-1');
    const attachment = coordinator.attach(dock);
    await coordinator.runLayoutTransaction(
      async () => layoutEnvelope(['tab-1']),
      { quarantineOnCorrupt: false, restoreBackupOnFailure: false },
    );
    expect(attachment.enableLayoutPersistence()).toBe(true);
    dock.emitLayout();
    const activeNotificationsBeforeDetach = vi.mocked(options.onActivePanelChange).mock.calls.length;
    coordinator.detach();
    coordinator.detach();
    dock.emitLayout(true);
    dock.emitActive('tab-1', true);
    await vi.runAllTimersAsync();

    expect(saveLayout).not.toHaveBeenCalled();
    expect(options.onActivePanelChange).toHaveBeenCalledTimes(activeNotificationsBeforeDetach);
  });

  it('serializes debounced writes and flushes only after older writes settle', async () => {
    vi.useFakeTimers();
    const firstSave = deferred<void>();
    const calls: unknown[] = [];
    const saveLayout = vi.fn((layout: unknown) => {
      calls.push(layout);
      return calls.length === 1 ? firstSave.promise : Promise.resolve();
    });
    const flushLayout = vi.fn(async () => undefined);
    const coordinator = new WorkbenchCoordinator(coordinatorOptions({
      persistence: {
        saveLayout,
        flushLayout,
        quarantineLayout: vi.fn(async () => undefined),
      },
      saveDebounceMs: 10,
    }));
    const dock = new FakeDockAdapter(['tab-1'], 'tab-1');
    const attachment = coordinator.attach(dock);
    await coordinator.runLayoutTransaction(
      async () => layoutEnvelope(['tab-1']),
      { quarantineOnCorrupt: false, restoreBackupOnFailure: false },
    );
    attachment.enableLayoutPersistence();

    dock.serialized = { revision: 1 };
    dock.emitLayout();
    await vi.advanceTimersByTimeAsync(10);
    expect(saveLayout).toHaveBeenCalledTimes(1);

    dock.serialized = { revision: 2 };
    const flush = coordinator.flushLayoutSave();
    await Promise.resolve();
    expect(saveLayout).toHaveBeenCalledTimes(1);
    expect(flushLayout).not.toHaveBeenCalled();

    firstSave.resolve();
    await flush;
    expect(calls).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(flushLayout).toHaveBeenCalledOnce();
  });

  it('drops a queued save when its Dockview attachment is replaced', async () => {
    vi.useFakeTimers();
    const firstSave = deferred<void>();
    const calls: unknown[] = [];
    const saveLayout = vi.fn((layout: unknown) => {
      calls.push(layout);
      return calls.length === 1 ? firstSave.promise : Promise.resolve();
    });
    const flushLayout = vi.fn(async () => undefined);
    const coordinator = new WorkbenchCoordinator(coordinatorOptions({
      persistence: {
        saveLayout,
        flushLayout,
        quarantineLayout: vi.fn(async () => undefined),
      },
      saveDebounceMs: 10,
    }));
    const firstDock = new FakeDockAdapter(['tab-1'], 'tab-1');
    const firstAttachment = coordinator.attach(firstDock);
    await coordinator.runLayoutTransaction(
      async () => layoutEnvelope(['tab-1']),
      { quarantineOnCorrupt: false, restoreBackupOnFailure: false },
    );
    firstAttachment.enableLayoutPersistence();

    firstDock.serialized = { revision: 1 };
    firstDock.emitLayout();
    await vi.advanceTimersByTimeAsync(10);
    expect(saveLayout).toHaveBeenCalledTimes(1);

    firstDock.serialized = { revision: 2 };
    const staleFlush = coordinator.flushLayoutSave();
    coordinator.attach(new FakeDockAdapter(['tab-2'], 'tab-2'));
    firstSave.resolve();
    await staleFlush;

    expect(calls).toEqual([{ revision: 1 }]);
    expect(flushLayout).not.toHaveBeenCalled();
  });
});

describe('WorkbenchCoordinator pane and recent-panel contract', () => {
  it('owns terminal identity across restored ids and only bypasses locks for recovery', async () => {
    let locked = true;
    const coordinator = new WorkbenchCoordinator(coordinatorOptions({
      isPaneCreationLocked: () => locked,
    }));
    const dock = new FakeDockAdapter();
    coordinator.attach(dock);

    expect(coordinator.openTerminal()).toBeNull();
    await coordinator.runLayoutTransaction(
      async () => null,
      { quarantineOnCorrupt: false, restoreBackupOnFailure: false },
    );
    expect(dock.added[0]?.id).toBe('tab-1');
    await coordinator.runLayoutTransaction(
      async () => layoutEnvelope(['tab-41']),
      { quarantineOnCorrupt: false, restoreBackupOnFailure: false },
    );
    locked = false;
    expect(coordinator.openTerminal({ cwd: 'C:\\repo' })?.panelId).toBe('tab-42');
    expect(dock.added.at(-1)).toMatchObject({
      id: 'tab-42',
      title: 'Terminal 42',
      cwd: 'C:\\repo',
    });
  });

  it('quarantines a failed restore and reapplies the exact live backup before recovery', async () => {
    const quarantineLayout = vi.fn(async () => undefined);
    const coordinator = new WorkbenchCoordinator(coordinatorOptions({
      persistence: {
        saveLayout: vi.fn(async () => undefined),
        flushLayout: vi.fn(async () => undefined),
        quarantineLayout,
      },
    }));
    const dock = new FakeDockAdapter(['tab-5'], 'tab-5');
    const backup = layoutEnvelope(['tab-5']).layout;
    dock.serialized = backup;
    coordinator.attach(dock);
    dock.failNextRestore = true;

    await expect(coordinator.runLayoutTransaction(
      async () => layoutEnvelope(['tab-9']),
      { quarantineOnCorrupt: true, restoreBackupOnFailure: true },
    )).resolves.toBe(false);

    expect(quarantineLayout).toHaveBeenCalledOnce();
    expect(dock.restores).toEqual([layoutEnvelope(['tab-9']).layout, backup]);
    expect(dock.panelIds()).toEqual(['tab-5']);
    expect(dock.added).toEqual([]);
  });

  it('reconciles a close during switching and never activates a removed selection', () => {
    const switches: Array<unknown> = [];
    const focusPane = vi.fn(() => true);
    const coordinator = new WorkbenchCoordinator(coordinatorOptions({
      onRecentPanelSwitchChange: (session) => switches.push(session),
      focusPane,
    }));
    const dock = new FakeDockAdapter(['p1', 'p2', 'p3'], 'p1');
    coordinator.attach(dock);
    dock.emitActive('p2');
    dock.emitActive('p1');

    coordinator.cycleRecentPanel(false);
    expect(switches.at(-1)).toMatchObject({ originPanelId: 'p1', selectedPanelId: 'p2' });
    const selectedInstance = dock.getPanel('p2')!.instanceToken;
    expect(coordinator.closePanel('p2', {})).toBe(false);
    expect(coordinator.closePanel('p2', selectedInstance)).toBe(true);
    expect(switches.at(-1)).toBeNull();

    coordinator.commitRecentPanelSwitch();
    expect(focusPane).not.toHaveBeenCalled();
    expect(dock.activePanelId()).toBe('p1');
  });

  it('commits the current selection once and rejects stale frames after pane reuse or detach', () => {
    const frames: Array<() => void> = [];
    const focusPane = vi.fn(() => true);
    const coordinator = new WorkbenchCoordinator(coordinatorOptions({
      focusPane,
      requestFrame: (callback) => frames.push(callback),
    }));
    const dock = new FakeDockAdapter(['p1', 'p2'], 'p1');
    coordinator.attach(dock);
    dock.emitActive('p2');
    dock.emitActive('p1');
    coordinator.cycleRecentPanel(false);
    coordinator.commitRecentPanelSwitch();
    expect(dock.activePanelId()).toBe('p2');

    dock.replacePanel('p2');
    frames.shift()?.();
    expect(focusPane).not.toHaveBeenCalled();

    coordinator.activatePanel('p2');
    coordinator.detach();
    frames.splice(0).forEach((frame) => frame());
    expect(focusPane).not.toHaveBeenCalled();
  });
});
