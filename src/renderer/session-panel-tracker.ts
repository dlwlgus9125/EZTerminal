/**
 * Exact renderer-side ownership for panes that create or adopt interpreter
 * sessions. Dockview panel ids are reusable across layout replacement, so the
 * panel API object (unique for one mounted Dockview panel instance) is the
 * identity key. A session may intentionally be shown by more than one pane.
 */

export type PaneInstanceToken = object;

export interface SessionPaneBinding {
  readonly panelId: string;
  readonly instanceToken: PaneInstanceToken;
}

export interface SessionPaneCandidates {
  readonly bound: readonly SessionPaneBinding[];
  readonly pending: readonly SessionPaneBinding[];
}

export interface SessionPaneLease {
  /** Bind this exact pane instance once. False means the lease was disposed or
   * was already bound to a different session. */
  bind(actualSessionId: string): boolean;
  /** Idempotently release both pending-adopt and bound ownership. */
  dispose(): void;
}

export class SessionPanelTracker {
  private readonly boundBySession = new Map<
    string,
    Map<PaneInstanceToken, SessionPaneBinding>
  >();

  private readonly pendingBySession = new Map<
    string,
    Map<PaneInstanceToken, SessionPaneBinding>
  >();

  /** Only panes minted by App's session-added auto-mirror close a fallback
   * creator when the requested session is subsequently removed. Weak identity
   * survives StrictMode's effect replay without retaining disposed panels. */
  private readonly autoMirrorOrigins = new WeakMap<
    PaneInstanceToken,
    { readonly panelId: string; readonly requestedSessionId: string }
  >();

  public constructor(private readonly onBoundChange: () => void = () => undefined) {}

  /** Register an auto-mirror immediately after Dockview returns its panel API.
   * TerminalPane's later mount is idempotent with this registration. */
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
      // Reacquire only the provenance App registered before the first setup.
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

  public getBound(sessionId: string): readonly SessionPaneBinding[] {
    return [...(this.boundBySession.get(sessionId)?.values() ?? [])];
  }

  public getPending(sessionId: string): readonly SessionPaneBinding[] {
    return [...(this.pendingBySession.get(sessionId)?.values() ?? [])];
  }

  /** Atomically forget every candidate for a removed session. Callers keep the
   * returned immutable identities long enough to close only exact live panes. */
  public takeSession(sessionId: string): SessionPaneCandidates {
    const bound = this.getBound(sessionId);
    const pending = this.getPending(sessionId);
    this.boundBySession.delete(sessionId);
    this.pendingBySession.delete(sessionId);
    if (bound.length > 0) this.onBoundChange();
    return { bound, pending };
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
