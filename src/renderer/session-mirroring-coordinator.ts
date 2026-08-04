import type { SessionInfo } from '../shared/ipc';
import type { WorkbenchCoordinator } from './workbench-coordinator';

export type PaneInstanceToken = object;

export interface SessionPaneBinding {
  readonly panelId: string;
  readonly instanceToken: PaneInstanceToken;
}

export interface SessionPaneLease {
  /** Bind this exact pane instance once. False means the lease was disposed or
   * was already bound to a different session. */
  bind(actualSessionId: string): boolean;
  /** Idempotently release both pending-adopt and bound ownership. */
  dispose(): void;
}

export interface SessionMirroringSnapshot {
  readonly replacementLocked: boolean;
  readonly bindingsBySession: ReadonlyMap<string, readonly SessionPaneBinding[]>;
}

export interface WorkspaceReplacementLease {
  release(): void;
}

export interface SessionMirroringCoordinatorOptions {
  readonly workbench: Pick<WorkbenchCoordinator, 'openTerminal' | 'closePanel'>;
  readonly onSessionAdded: (listener: (session: SessionInfo) => void) => () => void;
  readonly onSessionRemoved: (listener: (sessionId: string) => void) => () => void;
  readonly onError?: (message: string, error: unknown) => void;
}

interface SessionPaneCandidates {
  readonly bound: readonly SessionPaneBinding[];
  readonly pending: readonly SessionPaneBinding[];
}

interface PendingTimer {
  readonly generation: number;
  readonly token: object;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingAdditionTimer extends PendingTimer {
  readonly session: SessionInfo;
}

interface Connection {
  readonly generation: number;
  readonly unsubscribers: Array<() => void>;
}

interface ReplacementState {
  readonly token: object;
  readonly generation: number | null;
  readonly additions: Map<string, SessionInfo>;
  readonly removals: Set<string>;
}

/**
 * Exact renderer-side ownership for panes that create or adopt interpreter
 * sessions. Dockview panel ids are reusable across layout replacement, so the
 * panel API object (unique for one mounted Dockview panel instance) is the
 * identity key. A session may intentionally be shown by more than one pane.
 */
class SessionPaneRegistry {
  private readonly boundBySession = new Map<
    string,
    Map<PaneInstanceToken, SessionPaneBinding>
  >();

  private readonly pendingBySession = new Map<
    string,
    Map<PaneInstanceToken, SessionPaneBinding>
  >();

  /** Only panes minted by session-added auto-mirroring close a fallback
   * creator when the requested session is subsequently removed. Weak identity
   * survives StrictMode's effect replay without retaining disposed panels. */
  private readonly autoMirrorOrigins = new WeakMap<
    PaneInstanceToken,
    { readonly panelId: string; readonly requestedSessionId: string }
  >();

  public constructor(private readonly onBoundChange: () => void) {}

  /** Register an auto-mirror immediately after the workbench returns its exact
   * panel identity. TerminalPane's later mount is idempotent with this call. */
  public trackPending(
    requestedSessionId: string,
    panelId: string,
    instanceToken: PaneInstanceToken,
  ): void {
    this.autoMirrorOrigins.set(instanceToken, { panelId, requestedSessionId });
    if (this.boundBySession.get(requestedSessionId)?.has(instanceToken)) return;
    this.bucket(this.pendingBySession, requestedSessionId).set(instanceToken, {
      panelId,
      instanceToken,
    });
  }

  public mountPane(
    panelId: string,
    instanceToken: PaneInstanceToken,
    requestedAdoptSessionId?: string,
  ): SessionPaneLease {
    const autoMirrorOrigin = this.autoMirrorOrigins.get(instanceToken);
    if (
      requestedAdoptSessionId
      && autoMirrorOrigin?.requestedSessionId === requestedAdoptSessionId
      && autoMirrorOrigin.panelId === panelId
    ) {
      // StrictMode setup -> cleanup -> setup uses the same panel API object.
      // Reacquire only the provenance registered before the first setup.
      this.trackPending(requestedAdoptSessionId, panelId, instanceToken);
    }

    let disposed = false;
    let boundSessionId: string | null = null;

    return {
      bind: (actualSessionId: string): boolean => {
        if (disposed) return false;
        if (boundSessionId !== null) return boundSessionId === actualSessionId;

        this.bucket(this.boundBySession, actualSessionId).set(instanceToken, {
          panelId,
          instanceToken,
        });
        boundSessionId = actualSessionId;

        // A successful adoption is now represented by the bound bucket. An
        // auto-mirror fallback deliberately retains its pre-registered pending
        // entry; an ordinary restored/manual adoption has no such entry, so its
        // documented fresh-session fallback remains open.
        if (requestedAdoptSessionId === actualSessionId) {
          this.deleteExact(this.pendingBySession, requestedAdoptSessionId, instanceToken);
        }
        this.onBoundChange();
        return true;
      },
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        if (requestedAdoptSessionId) {
          this.deleteExact(this.pendingBySession, requestedAdoptSessionId, instanceToken);
        }
        if (
          boundSessionId !== null
          && this.deleteExact(this.boundBySession, boundSessionId, instanceToken)
        ) {
          this.onBoundChange();
        }
      },
    };
  }

  public hasSession(sessionId: string): boolean {
    return (this.boundBySession.get(sessionId)?.size ?? 0) > 0
      || (this.pendingBySession.get(sessionId)?.size ?? 0) > 0;
  }

  /** Atomically forget every candidate for a removed session. Callers keep the
   * returned identities long enough to close only exact live panes. */
  public takeSession(sessionId: string): SessionPaneCandidates {
    const bound = [...(this.boundBySession.get(sessionId)?.values() ?? [])];
    const pending = [...(this.pendingBySession.get(sessionId)?.values() ?? [])];
    this.boundBySession.delete(sessionId);
    this.pendingBySession.delete(sessionId);
    if (bound.length > 0) this.onBoundChange();
    return { bound, pending };
  }

  public snapshotBindings(): ReadonlyMap<string, readonly SessionPaneBinding[]> {
    return new Map(
      [...this.boundBySession].map(([sessionId, bindings]) => [
        sessionId,
        Object.freeze([...bindings.values()]),
      ]),
    );
  }

  private bucket(
    source: Map<string, Map<PaneInstanceToken, SessionPaneBinding>>,
    sessionId: string,
  ): Map<PaneInstanceToken, SessionPaneBinding> {
    const existing = source.get(sessionId);
    if (existing) return existing;
    const created = new Map<PaneInstanceToken, SessionPaneBinding>();
    source.set(sessionId, created);
    return created;
  }

  private deleteExact(
    source: Map<string, Map<PaneInstanceToken, SessionPaneBinding>>,
    sessionId: string,
    instanceToken: PaneInstanceToken,
  ): boolean {
    const bucket = source.get(sessionId);
    if (!bucket?.delete(instanceToken)) return false;
    if (bucket.size === 0) source.delete(sessionId);
    return true;
  }
}

/**
 * Owns the renderer's session-to-pane bindings, cross-surface mirroring event
 * ordering, and the short mutation lock used while replacing a workspace.
 *
 * Deliberately event-only: connect() never seeds existing sessions. Sessions
 * intentionally left running without a pane remain reclaimable through the
 * Command Center instead of being reopened automatically at renderer startup.
 */
export class SessionMirroringCoordinator {
  private readonly listeners = new Set<() => void>();
  private readonly registry = new SessionPaneRegistry(() => this.publishBindings());
  private connection: Connection | null = null;
  private nextGeneration = 0;
  private readonly pendingAdditions = new Map<string, PendingAdditionTimer>();
  private readonly pendingRemovals = new Map<string, PendingTimer>();
  private replacement: ReplacementState | null = null;
  private bindingsBySession: ReadonlyMap<string, readonly SessionPaneBinding[]> = new Map();
  private snapshot: SessionMirroringSnapshot = Object.freeze({
    replacementLocked: false,
    bindingsBySession: this.bindingsBySession,
  });

  public constructor(private readonly options: SessionMirroringCoordinatorOptions) {}

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public readonly getSnapshot = (): SessionMirroringSnapshot => this.snapshot;

  /** Replace any previous event connection. A cleanup returned by an older
   * generation cannot disconnect or replay work into the current one. */
  public connect(): () => void {
    this.disconnectCurrentConnection();
    // A lease acquired while disconnected belongs to no event generation and
    // must not carry a lock or buffered work into this new connection.
    if (this.replacement) {
      this.replacement = null;
      this.publishLock(false);
    }

    const generation = ++this.nextGeneration;
    const connection: Connection = { generation, unsubscribers: [] };
    this.connection = connection;

    this.subscribeToSource(
      connection,
      'could not subscribe to session-added events',
      () => this.options.onSessionAdded((session) => {
        this.handleEvent('could not handle a session-added event', () => {
          if (!this.isCurrentGeneration(generation)) return;
          if (this.deferAddition(session, generation)) return;
          this.scheduleAddition(session, generation);
        });
      }),
    );
    this.subscribeToSource(
      connection,
      'could not subscribe to session-removed events',
      () => this.options.onSessionRemoved((sessionId) => {
        this.handleEvent('could not handle a session-removed event', () => {
          if (!this.isCurrentGeneration(generation)) return;
          this.cancelPendingAddition(sessionId);
          if (this.deferRemoval(sessionId, generation)) return;
          this.scheduleRemoval(sessionId, generation);
        });
      }),
    );

    return () => this.disconnectGeneration(generation);
  }

  public mountPane(
    panelId: string,
    instanceToken: PaneInstanceToken,
    requestedAdoptSessionId?: string,
  ): SessionPaneLease {
    return this.registry.mountPane(panelId, instanceToken, requestedAdoptSessionId);
  }

  /** Acquire the sole workspace replacement authority. Events received while
   * held are buffered; release publishes the unlock before replaying removals
   * and then additions through the normal macrotask scheduling path. */
  public acquireWorkspaceReplacementLease(): WorkspaceReplacementLease | null {
    if (this.replacement) return null;
    const token = {};
    const generation = this.connection?.generation ?? null;
    const additions = new Map<string, SessionInfo>();
    const removals = new Set<string>();
    if (generation !== null) {
      // Events already waiting at the macrotask boundary happened before the
      // lock. Move them into the buffer synchronously so a later, locked event
      // with the same id retains its true remove-then-add/add-then-remove order.
      for (const [sessionId, pending] of this.pendingRemovals) {
        clearTimeout(pending.timer);
        if (pending.generation === generation) removals.add(sessionId);
      }
      for (const [sessionId, pending] of this.pendingAdditions) {
        clearTimeout(pending.timer);
        if (pending.generation === generation) additions.set(sessionId, pending.session);
      }
      this.pendingRemovals.clear();
      this.pendingAdditions.clear();
    }
    this.replacement = {
      token,
      generation,
      additions,
      removals,
    };
    this.publishLock(true);

    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        const replacement = this.replacement;
        if (!replacement || replacement.token !== token) return;

        this.replacement = null;
        const removals = [...replacement.removals];
        const additions = [...replacement.additions.values()];
        const replayGeneration = replacement.generation;

        // Unlock before replay so the scheduled callbacks cannot re-buffer.
        this.publishLock(false);
        if (
          replayGeneration === null
          || !this.isCurrentGeneration(replayGeneration)
        ) return;
        for (const sessionId of removals) {
          this.scheduleRemoval(sessionId, replayGeneration);
        }
        for (const session of additions) {
          this.scheduleAddition(session, replayGeneration);
        }
      },
    };
  }

  private subscribeToSource(
    connection: Connection,
    message: string,
    subscribe: () => () => void,
  ): void {
    try {
      const unsubscribe = subscribe();
      if (this.connection === connection) connection.unsubscribers.push(unsubscribe);
      else this.safeUnsubscribe(unsubscribe);
    } catch (error) {
      this.reportError(message, error);
    }
  }

  private scheduleAddition(session: SessionInfo, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.cancelPendingAddition(session.sessionId);
    const token = {};
    // TerminalPane's createSession reply binds in a promise microtask, whereas
    // Electron delivers onSessionAdded through a synchronous IPC listener. A
    // renderer IPC backlog can expose the broadcast before that microtask even
    // though main sent the reply first. Checking one macrotask later guarantees
    // the local binding is visible and prevents a duplicate self-mirror pane.
    const timer = setTimeout(() => {
      const pending = this.pendingAdditions.get(session.sessionId);
      if (
        !pending
        || pending.generation !== generation
        || pending.token !== token
      ) return;
      this.pendingAdditions.delete(session.sessionId);
      this.handleEvent('could not mirror an added session', () => {
        if (!this.isCurrentGeneration(generation)) return;
        if (this.deferAddition(session, generation)) return;
        if (this.registry.hasSession(session.sessionId)) return;

        const panel = this.options.workbench.openTerminal({
          adoptSessionId: session.sessionId,
        });
        if (!panel) return;
        if (!this.isCurrentGeneration(generation)) {
          this.closeExactPanel(panel.panelId, panel.instanceToken);
          return;
        }
        // Close the addPanel -> first React effect gap immediately with the
        // exact, non-reusable panel instance identity returned by the workbench.
        this.registry.trackPending(
          session.sessionId,
          panel.panelId,
          panel.instanceToken,
        );
      });
    }, 0);
    this.pendingAdditions.set(session.sessionId, {
      generation,
      token,
      timer,
      session,
    });
  }

  private scheduleRemoval(sessionId: string, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    const prior = this.pendingRemovals.get(sessionId);
    if (prior) clearTimeout(prior.timer);
    const token = {};
    const timer = setTimeout(() => {
      const pending = this.pendingRemovals.get(sessionId);
      if (
        !pending
        || pending.generation !== generation
        || pending.token !== token
      ) return;
      this.pendingRemovals.delete(sessionId);
      this.handleEvent('could not mirror a removed session', () => {
        if (!this.isCurrentGeneration(generation)) return;
        if (this.deferRemoval(sessionId, generation)) return;

        const candidates = this.registry.takeSession(sessionId);
        const seen = new Set<PaneInstanceToken>();
        for (const candidate of [...candidates.pending, ...candidates.bound]) {
          if (seen.has(candidate.instanceToken)) continue;
          seen.add(candidate.instanceToken);
          this.closeExactPanel(candidate.panelId, candidate.instanceToken);
        }
      });
    }, 0);
    this.pendingRemovals.set(sessionId, { generation, token, timer });
  }

  private deferAddition(session: SessionInfo, generation: number): boolean {
    const replacement = this.replacement;
    if (!replacement || replacement.generation !== generation) return false;
    replacement.additions.set(session.sessionId, session);
    return true;
  }

  private deferRemoval(sessionId: string, generation: number): boolean {
    const replacement = this.replacement;
    if (!replacement || replacement.generation !== generation) return false;
    replacement.additions.delete(sessionId);
    replacement.removals.add(sessionId);
    return true;
  }

  private cancelPendingAddition(sessionId: string): void {
    const pending = this.pendingAdditions.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAdditions.delete(sessionId);
  }

  private disconnectGeneration(generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.disconnectCurrentConnection();
  }

  private disconnectCurrentConnection(): void {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    this.cancelAllPendingWork();
    this.invalidateReplacement(connection.generation);
    for (const unsubscribe of connection.unsubscribers) this.safeUnsubscribe(unsubscribe);
  }

  private cancelAllPendingWork(): void {
    for (const pending of this.pendingAdditions.values()) clearTimeout(pending.timer);
    for (const pending of this.pendingRemovals.values()) clearTimeout(pending.timer);
    this.pendingAdditions.clear();
    this.pendingRemovals.clear();
  }

  private invalidateReplacement(generation: number): void {
    if (this.replacement?.generation !== generation) return;
    this.replacement = null;
    this.publishLock(false);
  }

  private closeExactPanel(panelId: string, instanceToken: PaneInstanceToken): void {
    try {
      this.options.workbench.closePanel(panelId, instanceToken);
    } catch (error) {
      this.reportError('could not close a mirrored session pane', error);
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.connection?.generation === generation;
  }

  private publishBindings(): void {
    this.bindingsBySession = this.registry.snapshotBindings();
    this.publishSnapshot();
  }

  private publishLock(locked: boolean): void {
    if (this.snapshot.replacementLocked === locked) return;
    this.snapshot = Object.freeze({
      replacementLocked: locked,
      bindingsBySession: this.bindingsBySession,
    });
    this.notifyListeners();
  }

  private publishSnapshot(): void {
    this.snapshot = Object.freeze({
      replacementLocked: this.replacement !== null,
      bindingsBySession: this.bindingsBySession,
    });
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.reportError('session mirroring snapshot listener failed', error);
      }
    }
  }

  private handleEvent(message: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.reportError(message, error);
    }
  }

  private safeUnsubscribe(unsubscribe: () => void): void {
    try {
      unsubscribe();
    } catch (error) {
      this.reportError('could not unsubscribe from session mirroring events', error);
    }
  }

  private reportError(message: string, error: unknown): void {
    try {
      this.options.onError?.(message, error);
    } catch {
      // Diagnostics must never turn an event callback into a user-visible error.
    }
  }
}
