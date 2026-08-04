import {
  classifyCloseRisk,
  countCloseRisks,
  sameActiveRunSet,
  type CloseRisk,
} from '../shared/close-risk';
import type {
  DestroySessionGuardResult,
  GuardedSessionDestroyRequest,
} from '../shared/ipc';
import type { LayoutEnvelope } from '../shared/layout-schema';
import type { PaneHandle, PaneSnapshot } from './pane-registry';
import type { WorkspaceReplacementLease } from './session-mirroring-coordinator';
import type { WorkbenchLayoutReplacementResult } from './workbench-coordinator';

const PREPARED_DATA: unique symbol = Symbol('prepared-workspace-replacement-data');

interface PreparedWorkspaceReplacementData {
  readonly owner: object;
  readonly creators: readonly PaneSnapshot[];
}

export interface PreparedWorkspaceReplacement {
  readonly summary: {
    readonly creatorCount: number;
    readonly riskCounts: Readonly<Record<CloseRisk, number>>;
  };
  readonly [PREPARED_DATA]: PreparedWorkspaceReplacementData;
}

export type WorkspaceReplacementOutcome =
  | { readonly kind: 'applied' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'busy'
        | 'state-changed'
        | 'preset-unavailable'
        | 'layout-invalid'
        | 'apply-failed';
    }
  | {
      readonly kind: 'destroy-failed';
      readonly reason: 'state-changed' | 'unavailable';
    };

export interface WorkspaceReplacementCoordinatorOptions {
  readonly getPaneHandle: (panelId: string) => PaneHandle | undefined;
  readonly listPaneSnapshots: () => readonly PaneSnapshot[];
  readonly destroySessionsGuarded: (
    sessions: readonly GuardedSessionDestroyRequest[],
  ) => Promise<DestroySessionGuardResult>;
  readonly loadPreset: (presetName: string) => Promise<LayoutEnvelope | null>;
  readonly preflightLayout: (envelope: LayoutEnvelope) => boolean;
  readonly replaceLayout: (
    envelope: LayoutEnvelope,
    authorize: () => boolean,
  ) => Promise<WorkbenchLayoutReplacementResult>;
  readonly acquireLease: () => WorkspaceReplacementLease | null;
  readonly onError?: (message: string, error: unknown) => void;
}

function freezeSnapshot(snapshot: PaneSnapshot): PaneSnapshot {
  return Object.freeze({
    ...snapshot,
    history: Object.freeze([...snapshot.history]),
    activeRunIds: Object.freeze([...snapshot.activeRunIds]),
  });
}

function creatorSnapshots(snapshots: readonly PaneSnapshot[]): readonly PaneSnapshot[] {
  return Object.freeze(snapshots
    .filter((pane) => pane.destroysSessionOnClose && pane.sessionId !== null)
    .map(freezeSnapshot));
}

function hasPendingSessionBinding(snapshots: readonly PaneSnapshot[]): boolean {
  return snapshots.some((pane) => pane.sessionBindingPending);
}

function hasExactCreatorPaneSet(
  expected: readonly PaneSnapshot[],
  current: readonly PaneSnapshot[],
): boolean {
  if (expected.length !== current.length) return false;
  const expectedByPanel = new Map(expected.map((pane) => [pane.panelId, pane]));
  return current.every((pane) => {
    const prior = expectedByPanel.get(pane.panelId);
    return prior !== undefined
      && pane.sessionId === prior.sessionId
      && sameActiveRunSet(pane.activeRunIds, prior.activeRunIds);
  });
}

function hasNoUnexpectedCreatorPanes(
  expected: readonly PaneSnapshot[],
  current: readonly PaneSnapshot[],
): boolean {
  const expectedByPanel = new Map(expected.map((pane) => [pane.panelId, pane]));
  return current.every((pane) => {
    const prior = expectedByPanel.get(pane.panelId);
    if (!prior || pane.sessionId !== prior.sessionId) return false;
    const expectedRuns = new Set(prior.activeRunIds);
    return pane.activeRunIds.every((runId) => expectedRuns.has(runId));
  });
}

function riskOf(
  snapshot: PaneSnapshot,
  activeAgentSessionIds: ReadonlySet<string>,
): CloseRisk | null {
  return classifyCloseRisk({
    destroysSession: snapshot.destroysSessionOnClose,
    isBusy: snapshot.isBusy,
    executionKind: snapshot.executionKind,
    hasSshPrompt: snapshot.hasSshPrompt,
    hasActiveAgent:
      snapshot.sessionId !== null && activeAgentSessionIds.has(snapshot.sessionId),
    isDead: snapshot.isDead,
  });
}

/**
 * Owns destructive runtime preset application as a single, fail-closed
 * transaction. UI presentation, Dockview, and React state are injected ports;
 * the coordinator owns the frozen creator baseline, global mutation lease,
 * guarded session destruction, final authorization, and typed outcome.
 */
export class WorkspaceReplacementCoordinator {
  private readonly identity = Object.freeze({});
  private readonly consumedPlans = new WeakSet<object>();
  private active = false;

  public constructor(private readonly options: WorkspaceReplacementCoordinatorOptions) {}

  /** Freeze the creator baseline and user-facing risk summary without side effects. */
  public prepare(
    activeAgentSessionIds: ReadonlySet<string>,
  ): PreparedWorkspaceReplacement {
    const creators = creatorSnapshots(this.options.listPaneSnapshots());
    const risks = creators
      .map((snapshot) => riskOf(snapshot, activeAgentSessionIds))
      .filter((risk): risk is CloseRisk => risk !== null);
    const riskCounts = Object.freeze({ ...countCloseRisks(risks) });
    const data = Object.freeze({ owner: this.identity, creators });
    return Object.freeze({
      summary: Object.freeze({ creatorCount: creators.length, riskCounts }),
      [PREPARED_DATA]: data,
    });
  }

  /** Execute a prepared runtime preset replacement at most once. */
  public async applyPreset(
    plan: PreparedWorkspaceReplacement,
    presetName: string,
  ): Promise<WorkspaceReplacementOutcome> {
    const data = plan[PREPARED_DATA];
    if (data.owner !== this.identity) {
      return { kind: 'rejected', reason: 'state-changed' };
    }
    if (this.active || this.consumedPlans.has(plan)) {
      return { kind: 'rejected', reason: 'busy' };
    }

    this.active = true;
    let lease: WorkspaceReplacementLease | null = null;
    try {
      try {
        lease = this.options.acquireLease();
      } catch (error) {
        this.reportError('workspace replacement lease acquisition failed', error);
        return { kind: 'rejected', reason: 'apply-failed' };
      }
      if (!lease) return { kind: 'rejected', reason: 'busy' };
      this.consumedPlans.add(plan);

      let preset: LayoutEnvelope | null;
      try {
        preset = await this.options.loadPreset(presetName);
      } catch (error) {
        this.reportError('workspace preset load failed', error);
        return { kind: 'rejected', reason: 'preset-unavailable' };
      }
      if (!preset) return { kind: 'rejected', reason: 'preset-unavailable' };

      try {
        if (!this.options.preflightLayout(preset)) {
          return { kind: 'rejected', reason: 'layout-invalid' };
        }
      } catch (error) {
        this.reportError('workspace preset preflight failed', error);
        return { kind: 'rejected', reason: 'layout-invalid' };
      }

      const currentCreators = this.readExactCreatorSet(data.creators);
      if (!currentCreators) return { kind: 'rejected', reason: 'state-changed' };

      const destroyResult = await this.destroyCreators(currentCreators);
      if (destroyResult) return destroyResult;

      let replacement: WorkbenchLayoutReplacementResult;
      try {
        replacement = await this.options.replaceLayout(
          preset,
          () => this.validateFinalization(data.creators),
        );
      } catch (error) {
        this.reportError('workspace layout replacement failed', error);
        return { kind: 'rejected', reason: 'apply-failed' };
      }
      if (replacement.kind === 'applied') return replacement;
      return { kind: 'rejected', reason: replacement.reason };
    } finally {
      try {
        lease?.release();
      } catch (error) {
        this.reportError('workspace replacement lease release failed', error);
      }
      this.active = false;
    }
  }

  private readExactCreatorSet(
    expected: readonly PaneSnapshot[],
  ): readonly PaneSnapshot[] | null {
    try {
      const snapshots = this.options.listPaneSnapshots();
      const currentCreators = creatorSnapshots(snapshots);
      return !hasPendingSessionBinding(snapshots)
        && hasExactCreatorPaneSet(expected, currentCreators)
        ? currentCreators
        : null;
    } catch (error) {
      this.reportError('workspace creator validation failed', error);
      return null;
    }
  }

  private validateFinalization(expected: readonly PaneSnapshot[]): boolean {
    try {
      const snapshots = this.options.listPaneSnapshots();
      return !hasPendingSessionBinding(snapshots)
        && hasNoUnexpectedCreatorPanes(expected, creatorSnapshots(snapshots));
    } catch (error) {
      this.reportError('workspace finalization validation failed', error);
      return false;
    }
  }

  private async destroyCreators(
    creators: readonly PaneSnapshot[],
  ): Promise<Extract<WorkspaceReplacementOutcome, { kind: 'destroy-failed' }> | null> {
    const liveCreators = creators.filter((pane) => !pane.isDead);
    if (liveCreators.length > 0) {
      let result: DestroySessionGuardResult;
      try {
        result = await this.options.destroySessionsGuarded(liveCreators.map((pane) => ({
          sessionId: pane.sessionId!,
          expectedActiveRunIds: pane.activeRunIds,
        })));
      } catch (error) {
        this.reportError('guarded workspace session destruction failed', error);
        return { kind: 'destroy-failed', reason: 'unavailable' };
      }
      if (!result.ok) return { kind: 'destroy-failed', reason: result.reason };
    }

    for (const pane of creators) {
      const handle = this.options.getPaneHandle(pane.panelId);
      if (handle && !handle.markSessionDestroyHandled(pane.sessionId!)) {
        return { kind: 'destroy-failed', reason: 'state-changed' };
      }
    }
    return null;
  }

  private reportError(message: string, error: unknown): void {
    if (this.options.onError) {
      this.options.onError(message, error);
      return;
    }
    console.error(`[renderer] ${message}:`, error);
  }
}
