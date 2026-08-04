import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionInfo } from '../shared/ipc';
import type { SessionSurfaceBinding, SessionSurfaceRole } from '../shared/session-surface';
import {
  SessionMirroringCoordinator,
  type PaneInstanceToken,
  type SessionPaneLease,
} from './session-mirroring-coordinator';
import {
  WorkbenchCoordinator,
  type WorkbenchCoordinatorOptions,
  type WorkbenchDockAdapter,
  type WorkbenchPanelPosition,
} from './workbench-coordinator';

interface ListenerEntry<TListener> {
  readonly listener: TListener;
  active: boolean;
}

class SessionEventSource {
  public readonly additions: Array<ListenerEntry<(session: SessionInfo) => void>> = [];
  public readonly removals: Array<ListenerEntry<(sessionId: string) => void>> = [];

  public readonly onSessionAdded = (
    listener: (session: SessionInfo) => void,
  ): (() => void) => this.register(this.additions, listener);

  public readonly onSessionRemoved = (
    listener: (sessionId: string) => void,
  ): (() => void) => this.register(this.removals, listener);

  public emitAdded(sessionId: string): void {
    const session = sessionInfo(sessionId);
    for (const entry of this.additions) {
      if (entry.active) entry.listener(session);
    }
  }

  public emitRemoved(sessionId: string): void {
    for (const entry of this.removals) {
      if (entry.active) entry.listener(sessionId);
    }
  }

  public activeAdditionCount(): number {
    return this.additions.filter((entry) => entry.active).length;
  }

  private register<TListener>(
    entries: Array<ListenerEntry<TListener>>,
    listener: TListener,
  ): () => void {
    const entry = { listener, active: true };
    entries.push(entry);
    return () => {
      entry.active = false;
    };
  }
}

function sessionInfo(sessionId: string): SessionInfo {
  return { sessionId, cwd: `C:\\${sessionId}` };
}

let bindingCounter = 0;
function bindLease(
  lease: SessionPaneLease,
  sessionId: string,
  role: SessionSurfaceRole = 'owner',
): boolean {
  bindingCounter += 1;
  const binding: SessionSurfaceBinding = {
    surfaceId: lease.surfaceId,
    bindingId: `binding-${bindingCounter}`,
    session: sessionInfo(sessionId),
    role,
  };
  return lease.bind(binding);
}

function paneIdentities(
  coordinator: SessionMirroringCoordinator,
  sessionId: string,
): Array<{ readonly panelId: string; readonly instanceToken: PaneInstanceToken }> | undefined {
  return coordinator.getSnapshot().bindingsBySession.get(sessionId)?.map((binding) => ({
    panelId: binding.panelId,
    instanceToken: binding.instanceToken,
  }));
}

function harness() {
  const source = new SessionEventSource();
  const events: string[] = [];
  let panelCounter = 0;
  const openTerminal = vi.fn<WorkbenchCoordinator['openTerminal']>((request = {}) => {
    panelCounter += 1;
    events.push(`open:${request.adoptSessionId ?? 'fresh'}`);
    return { panelId: `panel-${panelCounter}`, instanceToken: {} };
  });
  const closePanel = vi.fn<WorkbenchCoordinator['closePanel']>((panelId) => {
    events.push(`close:${panelId}`);
    return true;
  });
  const onError = vi.fn();
  const releaseSessionSurface = vi.fn(async () => ({ ok: true as const }));
  let surfaceCounter = 0;
  const coordinator = new SessionMirroringCoordinator({
    workbench: { openTerminal, closePanel },
    onSessionAdded: source.onSessionAdded,
    onSessionRemoved: source.onSessionRemoved,
    releaseSessionSurface,
    newSurfaceId: () => `surface-${++surfaceCounter}`,
    onError,
  });
  return {
    coordinator,
    source,
    openTerminal,
    closePanel,
    onError,
    releaseSessionSurface,
    events,
  };
}

function openedPane(
  openTerminal: ReturnType<typeof harness>['openTerminal'],
  callIndex = 0,
): { readonly panelId: string; readonly instanceToken: PaneInstanceToken } {
  const pane = openTerminal.mock.results[callIndex]?.value;
  if (!pane) throw new Error(`expected opened pane at call ${callIndex}`);
  return pane;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionMirroringCoordinator pane ownership', () => {
  it('publishes stable snapshots and keeps multiple exact panes per session', () => {
    const h = harness();
    const listener = vi.fn();
    h.coordinator.subscribe(listener);
    const initial = h.coordinator.getSnapshot();
    expect(h.coordinator.getSnapshot()).toBe(initial);

    const firstToken = {};
    const secondToken = {};
    const first = h.coordinator.mountPane('panel-1', firstToken);
    const second = h.coordinator.mountPane('panel-2', secondToken, undefined, 'session-1');
    expect(h.coordinator.getSnapshot()).toBe(initial);

    expect(bindLease(first, 'session-1')).toBe(true);
    expect(bindLease(second, 'session-1', 'adopted')).toBe(true);
    expect(paneIdentities(h.coordinator, 'session-1')).toEqual([
      { panelId: 'panel-1', instanceToken: firstToken },
      { panelId: 'panel-2', instanceToken: secondToken },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);

    const bound = h.coordinator.getSnapshot();
    expect(h.coordinator.getSnapshot()).toBe(bound);
    second.dispose();
    vi.runOnlyPendingTimers();
    expect(paneIdentities(h.coordinator, 'session-1')).toEqual([
      { panelId: 'panel-1', instanceToken: firstToken },
    ]);
  });

  it('does not let cleanup from an old instance delete a reused panel id', () => {
    const h = harness();
    const oldToken = {};
    const replacementToken = {};
    const oldLease = h.coordinator.mountPane('panel-reused', oldToken, undefined, 'session-1');
    const replacementLease = h.coordinator.mountPane(
      'panel-reused',
      replacementToken,
      undefined,
      'session-1',
    );

    expect(bindLease(oldLease, 'session-1', 'adopted')).toBe(true);
    expect(bindLease(replacementLease, 'session-1', 'adopted')).toBe(true);
    oldLease.dispose();
    vi.runOnlyPendingTimers();

    expect(paneIdentities(h.coordinator, 'session-1')).toEqual([
      { panelId: 'panel-reused', instanceToken: replacementToken },
    ]);
  });

  it('removes a disposed pending adoption and rejects its late bind', () => {
    const h = harness();
    h.coordinator.connect();
    h.source.emitAdded('session-1');
    vi.runOnlyPendingTimers();
    const pane = openedPane(h.openTerminal);
    const lease = h.coordinator.mountPane(
      pane.panelId,
      pane.instanceToken,
      undefined,
      'session-1',
    );

    lease.dispose();
    vi.runOnlyPendingTimers();
    expect(bindLease(lease, 'session-1', 'adopted')).toBe(false);
    h.source.emitRemoved('session-1');
    vi.runOnlyPendingTimers();
    expect(h.closePanel).not.toHaveBeenCalled();
  });

  it('rejects a replacement binding for a missing live auto-mirror adoption', () => {
    const h = harness();
    h.coordinator.connect();
    h.source.emitAdded('requested-session');
    vi.runOnlyPendingTimers();
    const pane = openedPane(h.openTerminal);
    const lease = h.coordinator.mountPane(
      pane.panelId,
      pane.instanceToken,
      undefined,
      'requested-session',
    );

    expect(bindLease(lease, 'fallback-session')).toBe(false);
    expect(paneIdentities(h.coordinator, 'fallback-session')).toBeUndefined();

    h.source.emitRemoved('requested-session');
    vi.runOnlyPendingTimers();
    expect(h.closePanel).toHaveBeenCalledWith(pane.panelId, pane.instanceToken);
  });

  it('rejects a replacement binding for a missing manual adoption', () => {
    const h = harness();
    h.coordinator.connect();
    const token = {};
    const lease = h.coordinator.mountPane(
      'manual-panel', token, undefined, 'stale-session',
    );

    expect(lease.intent).toEqual({ kind: 'adopt', sessionId: 'stale-session' });
    expect(bindLease(lease, 'fresh-session')).toBe(false);
    h.source.emitRemoved('stale-session');
    vi.runOnlyPendingTimers();

    expect(h.closePanel).toHaveBeenCalledWith('manual-panel', token);
    expect(paneIdentities(h.coordinator, 'fresh-session')).toBeUndefined();
  });

  it('creates a fresh owner for a saved-layout pane without persisted session identity', () => {
    const h = harness();
    const token = {};
    const lease = h.coordinator.mountPane('restored-panel', token, '/restored');

    expect(lease.intent).toEqual({ kind: 'create', cwd: '/restored' });
    expect(bindLease(lease, 'fresh-session', 'owner')).toBe(true);
    expect(paneIdentities(h.coordinator, 'fresh-session')).toEqual([
      { panelId: 'restored-panel', instanceToken: token },
    ]);
  });

  it('reacquires auto-mirror provenance across a StrictMode-style remount', () => {
    const h = harness();
    h.coordinator.connect();
    h.source.emitAdded('session-1');
    vi.runOnlyPendingTimers();
    const pane = openedPane(h.openTerminal);

    h.coordinator
      .mountPane(pane.panelId, pane.instanceToken, undefined, 'session-1')
      .dispose();
    const liveLease = h.coordinator.mountPane(
      pane.panelId,
      pane.instanceToken,
      undefined,
      'session-1',
    );
    expect(bindLease(liveLease, 'session-1', 'adopted')).toBe(true);

    h.source.emitAdded('session-1');
    vi.runOnlyPendingTimers();
    expect(h.openTerminal).toHaveBeenCalledTimes(1);
  });
});

describe('SessionMirroringCoordinator event ordering', () => {
  it('coalesces additions and lets a same-turn local bind suppress its own echo', () => {
    const h = harness();
    h.coordinator.connect();
    h.source.emitAdded('external');
    h.source.emitAdded('external');
    vi.runOnlyPendingTimers();
    expect(h.openTerminal).toHaveBeenCalledTimes(1);

    h.source.emitAdded('local');
    bindLease(h.coordinator.mountPane('local-panel', {}), 'local');
    vi.runOnlyPendingTimers();
    expect(h.openTerminal).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending addition when the session is removed first', () => {
    const h = harness();
    h.coordinator.connect();

    h.source.emitAdded('short-lived');
    h.source.emitRemoved('short-lived');
    vi.runOnlyPendingTimers();

    expect(h.openTerminal).not.toHaveBeenCalled();
    expect(h.closePanel).not.toHaveBeenCalled();
  });

  it('closes every bound pane with its exact instance token', () => {
    const h = harness();
    h.coordinator.connect();
    const firstToken = {};
    const secondToken = {};
    bindLease(h.coordinator.mountPane('panel-reused', firstToken), 'session-1');
    bindLease(h.coordinator.mountPane('panel-reused', secondToken), 'session-1');

    h.source.emitRemoved('session-1');
    vi.runOnlyPendingTimers();

    expect(h.closePanel.mock.calls).toEqual([
      ['panel-reused', firstToken],
      ['panel-reused', secondToken],
    ]);
    expect(h.coordinator.getSnapshot().bindingsBySession.has('session-1')).toBe(false);
  });

  it('replaces subscriptions, cancels stale timers, and ignores stale cleanup', () => {
    const h = harness();
    const firstDisconnect = h.coordinator.connect();
    const staleListener = h.source.additions[0]!.listener;
    h.source.emitAdded('cancelled-with-first');

    const secondDisconnect = h.coordinator.connect();
    firstDisconnect();
    staleListener(sessionInfo('stale-callback'));
    h.source.emitAdded('current');
    vi.runOnlyPendingTimers();

    expect(h.source.activeAdditionCount()).toBe(1);
    expect(h.openTerminal).toHaveBeenCalledTimes(1);
    expect(h.openTerminal).toHaveBeenCalledWith({ adoptSessionId: 'current' });

    secondDisconnect();
    expect(h.source.activeAdditionCount()).toBe(0);
  });

  it('contains workbench failures inside event callbacks and reports diagnostics', () => {
    const h = harness();
    h.coordinator.connect();
    h.openTerminal.mockImplementationOnce(() => {
      throw new Error('add failed');
    });

    h.source.emitAdded('failed-add');
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(h.onError).toHaveBeenCalledWith(
      'could not mirror an added session',
      expect.any(Error),
    );

    bindLease(h.coordinator.mountPane('panel-1', {}), 'failed-remove');
    h.closePanel.mockImplementationOnce(() => {
      throw new Error('close failed');
    });
    h.source.emitRemoved('failed-remove');
    expect(() => vi.runOnlyPendingTimers()).not.toThrow();
    expect(h.onError).toHaveBeenCalledWith(
      'could not close a mirrored session pane',
      expect.any(Error),
    );
  });
});

describe('SessionMirroringCoordinator workspace replacement lease', () => {
  it('captures timers already pending when the replacement lock is acquired', () => {
    const h = harness();
    h.coordinator.connect();
    bindLease(h.coordinator.mountPane('panel-recreated', {}), 'recreated');
    h.source.emitRemoved('recreated');
    h.source.emitAdded('dropped');

    const lease = h.coordinator.acquireWorkspaceReplacementLease();
    h.source.emitAdded('recreated');
    h.source.emitRemoved('dropped');
    lease?.release();
    vi.runOnlyPendingTimers();

    expect(h.events).toEqual([
      'close:panel-recreated',
      'open:recreated',
    ]);
  });

  it('unlocks once, drops removed additions, and replays removals before additions', () => {
    const h = harness();
    h.coordinator.connect();
    bindLease(h.coordinator.mountPane('panel-gone', {}), 'gone');
    bindLease(h.coordinator.mountPane('panel-recreated', {}), 'recreated');
    const lockChanges: boolean[] = [];
    h.coordinator.subscribe(() => {
      lockChanges.push(h.coordinator.getSnapshot().replacementLocked);
    });

    const lease = h.coordinator.acquireWorkspaceReplacementLease();
    expect(lease).not.toBeNull();
    expect(h.coordinator.acquireWorkspaceReplacementLease()).toBeNull();
    expect(h.coordinator.getSnapshot().replacementLocked).toBe(true);

    h.source.emitAdded('old');
    h.source.emitRemoved('old');
    h.source.emitRemoved('gone');
    h.source.emitRemoved('recreated');
    h.source.emitAdded('recreated');
    h.source.emitAdded('new');
    expect(h.events).toEqual([]);

    lease?.release();
    lease?.release();
    expect(h.coordinator.getSnapshot().replacementLocked).toBe(false);
    expect(h.events).toEqual([]);
    expect(lockChanges).toEqual([true, false]);
    vi.runOnlyPendingTimers();

    expect(h.events).toEqual([
      'close:panel-gone',
      'close:panel-recreated',
      'open:recreated',
      'open:new',
    ]);
  });

  it('discards a disconnected generation instead of replaying it after reconnect', () => {
    const h = harness();
    const disconnect = h.coordinator.connect();
    const lease = h.coordinator.acquireWorkspaceReplacementLease();
    h.source.emitAdded('stale-buffer');

    disconnect();
    expect(h.coordinator.getSnapshot().replacementLocked).toBe(false);
    h.coordinator.connect();
    lease?.release();
    vi.runOnlyPendingTimers();
    expect(h.openTerminal).not.toHaveBeenCalled();

    h.source.emitAdded('current');
    vi.runOnlyPendingTimers();
    expect(h.openTerminal).toHaveBeenCalledWith({ adoptSessionId: 'current' });
  });
});

class MirroringDockAdapter implements WorkbenchDockAdapter {
  public readonly added: Array<{
    readonly id: string;
    readonly adoptSessionId?: string;
  }> = [];
  private readonly panels = new Map<string, { readonly token: object }>();
  private readonly activeListeners = new Set<(panelId: string | null) => void>();
  private readonly removeListeners = new Set<() => void>();
  private readonly layoutListeners = new Set<() => void>();
  private activeId: string | null = null;

  public panelIds(): readonly string[] {
    return [...this.panels.keys()];
  }

  public activePanelId(): string | null {
    return this.activeId;
  }

  public getPanel(panelId: string) {
    const panel = this.panels.get(panelId);
    if (!panel) return undefined;
    return {
      id: panelId,
      instanceToken: panel.token,
      activate: () => {
        this.activeId = panelId;
        for (const listener of this.activeListeners) listener(panelId);
      },
      close: () => {
        this.panels.delete(panelId);
        if (this.activeId === panelId) this.activeId = this.panelIds()[0] ?? null;
        for (const listener of this.removeListeners) listener();
      },
    };
  }

  public addTerminalPane(options: {
    readonly id: string;
    readonly title: string;
    readonly position?: WorkbenchPanelPosition;
    readonly cwd?: string;
    readonly adoptSessionId?: string;
  }) {
    this.added.push({
      id: options.id,
      ...(options.adoptSessionId ? { adoptSessionId: options.adoptSessionId } : {}),
    });
    this.panels.set(options.id, { token: {} });
    this.activeId = options.id;
    return this.getPanel(options.id)!;
  }

  public serialize(): unknown {
    return {};
  }

  public restore(): void {}

  public focus(): void {}

  public onActivePanelChange(listener: (panelId: string | null) => void) {
    return this.subscribe(this.activeListeners, listener);
  }

  public onPanelRemoved(listener: () => void) {
    return this.subscribe(this.removeListeners, listener);
  }

  public onLayoutChange(listener: () => void) {
    return this.subscribe(this.layoutListeners, listener);
  }

  private subscribe<TListener>(listeners: Set<TListener>, listener: TListener) {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }
}

function workbenchOptions(
  isPaneCreationLocked: () => boolean,
): WorkbenchCoordinatorOptions {
  return {
    persistence: {
      saveLayout: vi.fn(async () => undefined),
      flushLayout: vi.fn(async () => undefined),
      quarantineLayout: vi.fn(async () => undefined),
    },
    isPaneCreationLocked,
    onActivePanelChange: vi.fn(),
    onRecentPanelSwitchChange: vi.fn(),
    focusPane: vi.fn(() => true),
    requestFrame: (callback) => callback(),
    onError: vi.fn(),
  };
}

describe('SessionMirroringCoordinator with WorkbenchCoordinator', () => {
  it('opens and closes an adopted pane through the real workbench seam', () => {
    const source = new SessionEventSource();
    let mirroring: SessionMirroringCoordinator | null = null;
    const workbench = new WorkbenchCoordinator(
      workbenchOptions(() => mirroring?.getSnapshot().replacementLocked ?? false),
    );
    const dock = new MirroringDockAdapter();
    workbench.attach(dock);
    mirroring = new SessionMirroringCoordinator({
      workbench,
      onSessionAdded: source.onSessionAdded,
      onSessionRemoved: source.onSessionRemoved,
      releaseSessionSurface: async () => ({ ok: true }),
      newSurfaceId: () => 'surface-workbench',
    });
    mirroring.connect();

    source.emitAdded('session-1');
    vi.runOnlyPendingTimers();
    expect(dock.added).toEqual([{ id: 'tab-1', adoptSessionId: 'session-1' }]);
    const panel = dock.getPanel('tab-1');
    expect(panel).toBeDefined();
    bindLease(
      mirroring.mountPane('tab-1', panel!.instanceToken, undefined, 'session-1'),
      'session-1',
      'adopted',
    );

    source.emitRemoved('session-1');
    vi.runOnlyPendingTimers();
    expect(dock.panelIds()).toEqual([]);
  });
});
