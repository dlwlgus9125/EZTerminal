import {
  classifyCloseRisk,
  planPaneClose,
  sameActiveRunSet,
  type CloseRisk,
} from '../shared/close-risk';
import type {
  DestroySessionGuardResult,
  GuardedSessionDestroyRequest,
} from '../shared/ipc';
import type { PaneHandle, PaneSnapshot } from './pane-registry';

/**
 * React-independent lifecycle transaction types shared by ordinary pane
 * close, auxiliary-window close, and whole-workspace replacement. The caller
 * owns presentation and the final Dockview/layout mutation; this module owns
 * the live-pane invariants that must hold around irreversible session work.
 */

export type PaneLifecycleKind =
  | 'single-pane'
  | 'auxiliary-window'
  | 'workspace-replacement';

export type PaneDisposition = 'terminate' | 'keep';

export interface PaneLifecycleTarget {
  readonly panelId: string;
  readonly title: string;
  readonly component: string;
  readonly instanceToken: object;
}

export interface PaneLifecycleItem {
  readonly panelId: string;
  readonly title: string;
  readonly risk: CloseRisk | null;
  readonly creator: boolean;
  readonly passive: boolean;
}

export type PaneLifecycleRequest =
  | {
      readonly kind: 'single-pane';
      readonly target: PaneLifecycleTarget;
      readonly activeAgentSessionIds: ReadonlySet<string>;
      readonly confirmRiskyClose: boolean;
    }
  | {
      readonly kind: 'auxiliary-window';
      readonly targets: readonly PaneLifecycleTarget[];
      readonly activeAgentSessionIds: ReadonlySet<string>;
    }
  | {
      readonly kind: 'workspace-replacement';
      readonly activeAgentSessionIds: ReadonlySet<string>;
    };

export type PaneLifecycleFailureReason = 'state-changed' | 'unavailable' | 'busy';
export type PaneLifecycleFailureStage = 'validation' | 'destroy' | 'ownership' | 'busy';

export interface PaneLifecycleFailure {
  readonly ok: false;
  readonly reason: PaneLifecycleFailureReason;
  readonly stage: PaneLifecycleFailureStage;
}

const PREPARED_DATA: unique symbol = Symbol('prepared-pane-lifecycle-data');
const COMMITTED_DATA: unique symbol = Symbol('committed-pane-lifecycle-data');

interface PaneLifecycleCandidate {
  readonly panelId: string;
  readonly title: string;
  readonly component: string;
  readonly instanceToken: object | null;
  readonly snapshot: PaneSnapshot | null;
  readonly risk: CloseRisk | null;
}

interface PreparedPaneLifecycleData {
  readonly kind: PaneLifecycleKind;
  readonly candidates: readonly PaneLifecycleCandidate[];
  readonly singlePromptRequired: boolean;
  readonly mutationKey: string;
}

interface CommittedPaneLifecycleData {
  readonly kind: PaneLifecycleKind;
  readonly candidates: readonly PaneLifecycleCandidate[];
  readonly workspaceBaseline: readonly PaneSnapshot[];
}

export interface PreparedPaneLifecycle {
  readonly kind: PaneLifecycleKind;
  readonly items: readonly PaneLifecycleItem[];
  readonly requiresConfirmation: boolean;
  readonly [PREPARED_DATA]: PreparedPaneLifecycleData;
}

export interface CommittedPaneLifecycle {
  readonly kind: PaneLifecycleKind;
  readonly targets: readonly PaneLifecycleTarget[];
  readonly keptSessionIds: readonly string[];
  readonly [COMMITTED_DATA]: CommittedPaneLifecycleData;
}

export type PaneLifecyclePreparation =
  | { readonly ok: true; readonly plan: PreparedPaneLifecycle }
  | PaneLifecycleFailure;

export type PaneLifecycleCommitResult =
  | { readonly ok: true; readonly commit: CommittedPaneLifecycle }
  | PaneLifecycleFailure;

export type PaneLifecycleValidationResult =
  | { readonly ok: true }
  | PaneLifecycleFailure;

export interface PaneLifecycleCommitOptions {
  /** Must contain exactly one decision for every creator in the plan. */
  readonly dispositions: ReadonlyMap<string, PaneDisposition>;
  /** Required for auxiliary-window commits so membership and instance
   * identity can be checked before and after guarded destruction. */
  readonly resolveCurrentTargets?: () => readonly PaneLifecycleTarget[] | null;
  readonly activeAgentSessionIds?: ReadonlySet<string>;
}

export interface PaneLifecycleValidationOptions {
  readonly resolveCurrentTargets?: () => readonly PaneLifecycleTarget[] | null;
  readonly activeAgentSessionIds?: ReadonlySet<string>;
}

export interface PaneLifecycleCoordinatorOptions {
  /** Live-pane adapter. Dependencies are injected so policy tests cross the
   * same interface as App without constructing React or Dockview. */
  readonly getPaneHandle: (panelId: string) => PaneHandle | undefined;
  readonly listPaneSnapshots: () => readonly PaneSnapshot[];
  readonly destroySessionGuarded: (
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ) => Promise<DestroySessionGuardResult>;
  readonly destroySessionsGuarded: (
    sessions: readonly GuardedSessionDestroyRequest[],
  ) => Promise<DestroySessionGuardResult>;
}

function freezeSnapshot(snapshot: PaneSnapshot): PaneSnapshot {
  return Object.freeze({
    ...snapshot,
    history: Object.freeze([...snapshot.history]),
    activeRunIds: Object.freeze([...snapshot.activeRunIds]),
  });
}

function freezeTarget(target: PaneLifecycleTarget): PaneLifecycleTarget {
  return Object.freeze({ ...target });
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
    hasActiveAgent: snapshot.sessionId !== null && activeAgentSessionIds.has(snapshot.sessionId),
    isDead: snapshot.isDead,
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

function sameAuxiliarySnapshot(
  current: PaneSnapshot,
  expected: PaneSnapshot,
  currentRisk: CloseRisk | null,
  expectedRisk: CloseRisk | null,
): boolean {
  return current.panelId === expected.panelId
    && current.sessionId === expected.sessionId
    && current.sessionBindingPending === expected.sessionBindingPending
    && current.destroysSessionOnClose === expected.destroysSessionOnClose
    && current.isBusy === expected.isBusy
    && current.isDead === expected.isDead
    && current.executionKind === expected.executionKind
    && current.hasSshPrompt === expected.hasSshPrompt
    && sameActiveRunSet(current.activeRunIds, expected.activeRunIds)
    && currentRisk === expectedRisk;
}

function validationFailure(): PaneLifecycleFailure {
  return { ok: false, reason: 'state-changed', stage: 'validation' };
}

function unavailableFailure(stage: PaneLifecycleFailureStage = 'validation'): PaneLifecycleFailure {
  return { ok: false, reason: 'unavailable', stage };
}

function planTargets(candidates: readonly PaneLifecycleCandidate[]): readonly PaneLifecycleTarget[] {
  return Object.freeze(candidates.flatMap((candidate) => (
    candidate.instanceToken === null
      ? []
      : [Object.freeze({
          panelId: candidate.panelId,
          title: candidate.title,
          component: candidate.component,
          instanceToken: candidate.instanceToken,
        })]
  )));
}

function dispositionsCoverCreators(
  candidates: readonly PaneLifecycleCandidate[],
  dispositions: ReadonlyMap<string, PaneDisposition>,
  allowKeep: boolean,
): boolean {
  const creatorIds = new Set(
    candidates
      .filter((candidate) => candidate.snapshot?.destroysSessionOnClose)
      .map((candidate) => candidate.panelId),
  );
  if (creatorIds.size !== dispositions.size) return false;
  for (const [panelId, disposition] of dispositions) {
    if (!creatorIds.has(panelId)) return false;
    if (disposition !== 'terminate' && (!allowKeep || disposition !== 'keep')) return false;
  }
  return true;
}

/**
 * Coordinates a single-use, fail-closed lifecycle plan.
 *
 * `prepare` freezes the observed identities and risks without side effects.
 * `commit` revalidates as required, waits for authoritative guarded-destroy
 * ACKs, and only then transfers or marks ownership. Conflicting mutations
 * return `busy`; validation, transport, and ownership failures are explicit.
 * Multi-target callers must run `validateFinalization` immediately before
 * their final UI/layout mutation.
 */
export class PaneLifecycleCoordinator {
  private readonly consumedPlans = new WeakSet<object>();
  private readonly activeMutationKeys = new Set<string>();

  public constructor(private readonly options: PaneLifecycleCoordinatorOptions) {}

  /** Observe and freeze a plan; never mutates a pane or backend session. */
  public prepare(request: PaneLifecycleRequest): PaneLifecyclePreparation {
    if (request.kind === 'single-pane') return this.prepareSinglePane(request);
    if (request.kind === 'auxiliary-window') return this.prepareAuxiliaryWindow(request);
    return this.prepareWorkspaceReplacement(request);
  }

  /** Recheck a prepared plan across caller-owned awaits without consuming it. */
  public validatePreparation(
    plan: PreparedPaneLifecycle,
    options: PaneLifecycleValidationOptions = {},
  ): PaneLifecycleValidationResult {
    if (this.consumedPlans.has(plan)) {
      return { ok: false, reason: 'busy', stage: 'busy' };
    }
    return this.validatePreparedData(plan[PREPARED_DATA], options);
  }

  private validatePreparedData(
    data: PreparedPaneLifecycleData,
    options: PaneLifecycleValidationOptions,
  ): PaneLifecycleValidationResult {
    if (data.kind === 'single-pane') {
      if (!data.singlePromptRequired) return { ok: true };
      const expected = data.candidates[0]?.snapshot;
      if (!expected) return validationFailure();
      const current = this.options.getPaneHandle(expected.panelId)?.getSnapshot();
      return current
        && current.sessionId === expected.sessionId
        && sameActiveRunSet(current.activeRunIds, expected.activeRunIds)
        ? { ok: true }
        : validationFailure();
    }
    if (data.kind === 'auxiliary-window') {
      return this.validateAuxiliaryBeforeCommit(data.candidates, options);
    }
    const snapshots = this.options.listPaneSnapshots();
    const currentCreators = creatorSnapshots(snapshots);
    return !hasPendingSessionBinding(snapshots)
      && hasExactCreatorPaneSet(
        data.candidates.flatMap((candidate) => candidate.snapshot ? [candidate.snapshot] : []),
        currentCreators,
      )
      ? { ok: true }
      : validationFailure();
  }

  /** Execute the plan at most once and serialize overlapping mutation keys. */
  public async commit(
    plan: PreparedPaneLifecycle,
    options: PaneLifecycleCommitOptions,
  ): Promise<PaneLifecycleCommitResult> {
    const data = plan[PREPARED_DATA];
    if (this.consumedPlans.has(plan) || this.activeMutationKeys.has(data.mutationKey)) {
      return { ok: false, reason: 'busy', stage: 'busy' };
    }
    const allowKeep = data.kind !== 'workspace-replacement';
    if (!dispositionsCoverCreators(data.candidates, options.dispositions, allowKeep)) {
      return validationFailure();
    }

    this.consumedPlans.add(plan);
    this.activeMutationKeys.add(data.mutationKey);
    try {
      if (data.kind === 'single-pane') return await this.commitSinglePane(data, options);
      if (data.kind === 'auxiliary-window') return await this.commitAuxiliaryWindow(data, options);
      return await this.commitWorkspaceReplacement(data);
    } catch {
      return unavailableFailure('destroy');
    } finally {
      this.activeMutationKeys.delete(data.mutationKey);
    }
  }

  /** Recheck state after commit and immediately before the caller's final effect. */
  public validateFinalization(
    commit: CommittedPaneLifecycle,
    options: PaneLifecycleValidationOptions = {},
  ): PaneLifecycleValidationResult {
    const data = commit[COMMITTED_DATA];
    if (data.kind === 'single-pane') return { ok: true };
    if (data.kind === 'auxiliary-window') {
      return this.validateAuxiliaryTargets(data.candidates, options.resolveCurrentTargets, true)
        ? { ok: true }
        : validationFailure();
    }
    const snapshots = this.options.listPaneSnapshots();
    return !hasPendingSessionBinding(snapshots)
      && hasNoUnexpectedCreatorPanes(data.workspaceBaseline, creatorSnapshots(snapshots))
      ? { ok: true }
      : validationFailure();
  }

  private prepareSinglePane(
    request: Extract<PaneLifecycleRequest, { kind: 'single-pane' }>,
  ): PaneLifecyclePreparation {
    const snapshot = this.options.getPaneHandle(request.target.panelId)?.getSnapshot();
    if (!snapshot || (snapshot.destroysSessionOnClose && snapshot.sessionId === null)) {
      return unavailableFailure();
    }
    const frozenSnapshot = freezeSnapshot(snapshot);
    const risk = riskOf(frozenSnapshot, request.activeAgentSessionIds);
    const closePlan = planPaneClose({
      destroysSession: frozenSnapshot.destroysSessionOnClose,
      isBusy: frozenSnapshot.isBusy,
      executionKind: frozenSnapshot.executionKind,
      hasSshPrompt: frozenSnapshot.hasSshPrompt,
      hasActiveAgent:
        frozenSnapshot.sessionId !== null
        && request.activeAgentSessionIds.has(frozenSnapshot.sessionId),
      isDead: frozenSnapshot.isDead,
    }, request.confirmRiskyClose);
    if (closePlan.kind === 'blocked') return unavailableFailure();
    const candidate = Object.freeze({
      ...freezeTarget(request.target),
      snapshot: frozenSnapshot,
      risk,
    });
    return this.createPreparation(
      'single-pane',
      [candidate],
      closePlan.kind === 'confirm',
      `single:${request.target.panelId}`,
    );
  }

  private prepareAuxiliaryWindow(
    request: Extract<PaneLifecycleRequest, { kind: 'auxiliary-window' }>,
  ): PaneLifecyclePreparation {
    if (request.targets.length === 0) return unavailableFailure();
    const candidates: PaneLifecycleCandidate[] = [];
    for (const rawTarget of request.targets) {
      const target = freezeTarget(rawTarget);
      const handle = this.options.getPaneHandle(target.panelId);
      const snapshot = handle?.getSnapshot();
      if (!snapshot && target.component === 'agent-session' && !handle) {
        candidates.push(Object.freeze({ ...target, snapshot: null, risk: null }));
        continue;
      }
      if (
        !snapshot
        || snapshot.sessionBindingPending
        || (snapshot.destroysSessionOnClose && snapshot.sessionId === null)
      ) {
        return unavailableFailure();
      }
      const frozenSnapshot = freezeSnapshot(snapshot);
      candidates.push(Object.freeze({
        ...target,
        snapshot: frozenSnapshot,
        risk: riskOf(frozenSnapshot, request.activeAgentSessionIds),
      }));
    }
    const requiresConfirmation = candidates.length !== 1 || candidates[0]?.risk !== null;
    const targetKey = candidates
      .map((candidate) => candidate.panelId)
      .sort()
      .join(',');
    return this.createPreparation(
      'auxiliary-window',
      candidates,
      requiresConfirmation,
      `auxiliary:${targetKey}`,
    );
  }

  private prepareWorkspaceReplacement(
    request: Extract<PaneLifecycleRequest, { kind: 'workspace-replacement' }>,
  ): PaneLifecyclePreparation {
    const candidates = creatorSnapshots(this.options.listPaneSnapshots()).map((snapshot) => (
      Object.freeze({
        panelId: snapshot.panelId,
        title: snapshot.panelId,
        component: 'terminal',
        instanceToken: null,
        snapshot,
        risk: riskOf(snapshot, request.activeAgentSessionIds),
      })
    ));
    return this.createPreparation(
      'workspace-replacement',
      candidates,
      true,
      'workspace-replacement',
    );
  }

  private createPreparation(
    kind: PaneLifecycleKind,
    candidates: readonly PaneLifecycleCandidate[],
    requiresConfirmation: boolean,
    mutationKey: string,
  ): PaneLifecyclePreparation {
    const frozenCandidates = Object.freeze([...candidates]);
    const data = Object.freeze({
      kind,
      candidates: frozenCandidates,
      singlePromptRequired: kind === 'single-pane' && requiresConfirmation,
      mutationKey,
    });
    const items = Object.freeze(frozenCandidates.map((candidate) => Object.freeze({
      panelId: candidate.panelId,
      title: candidate.title,
      risk: candidate.risk,
      creator: candidate.snapshot?.destroysSessionOnClose ?? false,
      passive: candidate.snapshot === null,
    })));
    return {
      ok: true,
      plan: Object.freeze({
        kind,
        items,
        requiresConfirmation,
        [PREPARED_DATA]: data,
      }),
    };
  }

  private async commitSinglePane(
    data: PreparedPaneLifecycleData,
    options: PaneLifecycleCommitOptions,
  ): Promise<PaneLifecycleCommitResult> {
    const candidate = data.candidates[0];
    const expected = candidate?.snapshot;
    if (!candidate || !expected) return validationFailure();
    const disposition = expected.destroysSessionOnClose
      ? options.dispositions.get(candidate.panelId)
      : 'terminate';

    if (disposition === 'keep') {
      const kept = this.options.getPaneHandle(candidate.panelId)?.releaseSessionOwnership() ?? null;
      return this.createCommit(data, kept ? [kept] : []);
    }

    let snapshot = expected;
    if (data.singlePromptRequired) {
      const validation = this.validatePreparedData(data, options);
      if (!validation.ok) return validation;
      const current = this.options.getPaneHandle(candidate.panelId)?.getSnapshot();
      if (!current) return validationFailure();
      if (!current.destroysSessionOnClose) return this.createCommit(data, []);
      snapshot = freezeSnapshot(current);
    }
    if (!snapshot.destroysSessionOnClose || snapshot.sessionId === null) {
      return this.createCommit(data, []);
    }
    const result = await this.destroySingleCreator(snapshot);
    if (!result.ok) return result;
    return this.createCommit(data, []);
  }

  private async destroySingleCreator(snapshot: PaneSnapshot): Promise<PaneLifecycleValidationResult> {
    const currentHandle = (): PaneHandle | undefined => this.options.getPaneHandle(snapshot.panelId);
    if (snapshot.isDead) {
      const current = currentHandle()?.getSnapshot();
      if (
        !current
        || current.panelId !== snapshot.panelId
        || current.sessionId !== snapshot.sessionId
        || !current.destroysSessionOnClose
        || !current.isDead
      ) {
        return validationFailure();
      }
      return currentHandle()?.markSessionDestroyHandled(snapshot.sessionId!)
        ? { ok: true }
        : validationFailure();
    }

    let result: DestroySessionGuardResult;
    try {
      result = await this.options.destroySessionGuarded(
        snapshot.sessionId!,
        Object.freeze([...snapshot.activeRunIds]),
      );
    } catch {
      return unavailableFailure('destroy');
    }
    if (!result.ok) return { ok: false, reason: result.reason, stage: 'destroy' };
    const current = currentHandle()?.getSnapshot();
    if (
      !current
      || current.panelId !== snapshot.panelId
      || current.sessionId !== snapshot.sessionId
      || !current.destroysSessionOnClose
    ) {
      return validationFailure();
    }
    return currentHandle()?.markSessionDestroyHandled(snapshot.sessionId!)
      ? { ok: true }
      : { ok: false, reason: 'state-changed', stage: 'ownership' };
  }

  private async commitAuxiliaryWindow(
    data: PreparedPaneLifecycleData,
    options: PaneLifecycleCommitOptions,
  ): Promise<PaneLifecycleCommitResult> {
    const validation = this.validateAuxiliaryBeforeCommit(data.candidates, options);
    if (!validation.ok) return validation;

    const latest = new Map<string, PaneSnapshot>();
    for (const candidate of data.candidates) {
      if (!candidate.snapshot) continue;
      const snapshot = this.options.getPaneHandle(candidate.panelId)?.getSnapshot();
      if (!snapshot) return validationFailure();
      latest.set(candidate.panelId, freezeSnapshot(snapshot));
    }
    const terminate = data.candidates.filter((candidate) => (
      candidate.snapshot?.destroysSessionOnClose
      && options.dispositions.get(candidate.panelId) === 'terminate'
    ));
    const keep = data.candidates.filter((candidate) => (
      candidate.snapshot?.destroysSessionOnClose
      && options.dispositions.get(candidate.panelId) === 'keep'
    ));
    const liveTerminate = terminate.filter((candidate) => !candidate.snapshot!.isDead);
    if (liveTerminate.some((candidate) => candidate.snapshot!.sessionId === null)) {
      return unavailableFailure();
    }

    if (liveTerminate.length > 0) {
      let result: DestroySessionGuardResult;
      try {
        result = await this.options.destroySessionsGuarded(liveTerminate.map((candidate) => ({
          sessionId: candidate.snapshot!.sessionId!,
          expectedActiveRunIds: candidate.snapshot!.activeRunIds,
        })));
      } catch {
        return unavailableFailure('destroy');
      }
      if (!result.ok) return { ok: false, reason: result.reason, stage: 'destroy' };
    }

    if (!this.validateAuxiliaryTargets(data.candidates, options.resolveCurrentTargets, true)) {
      return validationFailure();
    }
    for (const candidate of terminate) {
      const sessionId = candidate.snapshot!.sessionId;
      if (sessionId) {
        this.options.getPaneHandle(candidate.panelId)?.markSessionDestroyHandled(sessionId);
      }
    }
    const keptSessionIds: string[] = [];
    for (const candidate of keep) {
      const expectedSessionId = latest.get(candidate.panelId)?.sessionId;
      const keptSessionId =
        this.options.getPaneHandle(candidate.panelId)?.releaseSessionOwnership() ?? null;
      if (!expectedSessionId || keptSessionId !== expectedSessionId) {
        return { ok: false, reason: 'state-changed', stage: 'ownership' };
      }
      keptSessionIds.push(keptSessionId);
    }
    return this.createCommit(data, keptSessionIds);
  }

  private async commitWorkspaceReplacement(
    data: PreparedPaneLifecycleData,
  ): Promise<PaneLifecycleCommitResult> {
    const snapshots = this.options.listPaneSnapshots();
    const currentCreators = creatorSnapshots(snapshots);
    const expectedCreators = data.candidates.flatMap((candidate) => (
      candidate.snapshot ? [candidate.snapshot] : []
    ));
    if (
      hasPendingSessionBinding(snapshots)
      || !hasExactCreatorPaneSet(expectedCreators, currentCreators)
    ) {
      return validationFailure();
    }

    const liveCreators = currentCreators.filter((pane) => !pane.isDead);
    if (liveCreators.length > 0) {
      let result: DestroySessionGuardResult;
      try {
        result = await this.options.destroySessionsGuarded(liveCreators.map((pane) => ({
          sessionId: pane.sessionId!,
          expectedActiveRunIds: pane.activeRunIds,
        })));
      } catch {
        return unavailableFailure('destroy');
      }
      if (!result.ok) return { ok: false, reason: result.reason, stage: 'destroy' };
    }
    for (const pane of currentCreators) {
      const handle = this.options.getPaneHandle(pane.panelId);
      if (handle && !handle.markSessionDestroyHandled(pane.sessionId!)) {
        return { ok: false, reason: 'state-changed', stage: 'ownership' };
      }
    }
    return this.createCommit(data, [], currentCreators);
  }

  private validateAuxiliaryBeforeCommit(
    candidates: readonly PaneLifecycleCandidate[],
    options: PaneLifecycleValidationOptions,
  ): PaneLifecycleValidationResult {
    if (!this.validateAuxiliaryTargets(candidates, options.resolveCurrentTargets, false)) {
      return validationFailure();
    }
    const activeAgentSessionIds = options.activeAgentSessionIds ?? new Set<string>();
    for (const candidate of candidates) {
      const handle = this.options.getPaneHandle(candidate.panelId);
      if (!candidate.snapshot) {
        if (candidate.component !== 'agent-session' || candidate.risk !== null || handle) {
          return validationFailure();
        }
        continue;
      }
      const snapshot = handle?.getSnapshot();
      if (
        !snapshot
        || !sameAuxiliarySnapshot(
          snapshot,
          candidate.snapshot,
          riskOf(snapshot, activeAgentSessionIds),
          candidate.risk,
        )
      ) {
        return validationFailure();
      }
    }
    return { ok: true };
  }

  private validateAuxiliaryTargets(
    candidates: readonly PaneLifecycleCandidate[],
    resolveCurrentTargets: (() => readonly PaneLifecycleTarget[] | null) | undefined,
    requirePassiveHandlesAbsent: boolean,
  ): boolean {
    const currentTargets = resolveCurrentTargets?.();
    if (!currentTargets || currentTargets.length !== candidates.length) return false;
    const byPanel = new Map(currentTargets.map((target) => [target.panelId, target]));
    if (byPanel.size !== currentTargets.length) return false;
    return candidates.every((candidate) => {
      const current = byPanel.get(candidate.panelId);
      if (
        !current
        || current.instanceToken !== candidate.instanceToken
        || current.component !== candidate.component
      ) {
        return false;
      }
      return !requirePassiveHandlesAbsent
        || candidate.snapshot !== null
        || !this.options.getPaneHandle(candidate.panelId);
    });
  }

  private createCommit(
    data: PreparedPaneLifecycleData,
    keptSessionIds: readonly string[],
    workspaceBaseline: readonly PaneSnapshot[] = [],
  ): PaneLifecycleCommitResult {
    const committedData = Object.freeze({
      kind: data.kind,
      candidates: data.candidates,
      workspaceBaseline: Object.freeze([...workspaceBaseline]),
    });
    return {
      ok: true,
      commit: Object.freeze({
        kind: data.kind,
        targets: planTargets(data.candidates),
        keptSessionIds: Object.freeze([...keptSessionIds]),
        [COMMITTED_DATA]: committedData,
      }),
    };
  }
}
