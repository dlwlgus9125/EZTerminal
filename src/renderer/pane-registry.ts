/**
 * Deep renderer-side seam between workspace chrome and live TerminalPane
 * instances. Dockview params cannot carry mutable pane state, so consumers
 * query a narrow handle rather than growing parallel module-level maps.
 */

import type { DestroySessionGuardResult, ExecutionKind } from '../shared/ipc';
import { sameActiveRunSet } from '../shared/close-risk';
import type { BlockSnapshot, PtyControlTargetIdentity } from './block-controller';

export interface PaneSnapshot {
  readonly panelId: string;
  readonly sessionId: string | null;
  readonly cwd: string;
  readonly history: readonly string[];
  readonly draft: string;
  readonly isBusy: boolean;
  readonly isDead: boolean;
  /** True while this mounted pane can still bind or create a session after an
   * asynchronous list/create reply. Destructive workspace replacement must
   * fail closed while any such binding is unresolved. */
  readonly sessionBindingPending: boolean;
  /** True only for the creator pane whose unmount destroys the backend session. */
  readonly destroysSessionOnClose: boolean;
  /** Renderer observation used only as a guarded-destroy precondition. The
   * interpreter remains authoritative and rejects a changed set. */
  readonly activeRunIds: readonly string[];
  readonly executionKind: ExecutionKind | null;
  readonly hasSshPrompt: boolean;
  readonly activePty: boolean;
  readonly activeCommand: string | null;
}

export type PaneActionFailure =
  | 'unavailable'
  | 'busy'
  | 'dead'
  | 'draft-not-empty'
  | 'not-pty'
  | 'empty';

export type PaneActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PaneActionFailure };

export interface PaneHandle {
  getSnapshot(): PaneSnapshot;
  /** Called only after guarded destruction was acknowledged (or shared-fate
   * death is known), so unmount does not issue a redundant second destroy. */
  markSessionDestroyHandled(destroyedSessionId: string): boolean;
  insertText(text: string): PaneActionResult;
  runText(text: string): PaneActionResult;
  pasteToPty(text: string): PaneActionResult;
  focus(): void;
}

/** Minimal controller surface admitted to the mounted-PTY registry. Keeping
 * this structural avoids exposing BlockController internals to workspace UI. */
export interface MountedPtyControllerSource {
  getSnapshot(): Pick<BlockSnapshot, 'status' | 'shape' | 'hasControl'>;
  subscribe(listener: () => void): () => void;
  claimControl(): void;
}

export interface MountedPtyControlSnapshot {
  readonly status: BlockSnapshot['status'];
  readonly shape: BlockSnapshot['shape'];
  readonly hasControl: boolean;
}

/** Immutable handle returned by the read-only enumeration seam. Commands are
 * explicit methods; merely listing targets can never claim control. */
export interface MountedPtyControlTarget extends PtyControlTargetIdentity {
  /** Unique mounted surface. A run may have several surfaces. */
  readonly targetId: string;
  /** Shared run identity used to prevent mirrors from fighting each other. */
  readonly runKey: string;
  isMounted(): boolean;
  getSnapshot(): MountedPtyControlSnapshot;
  subscribe(listener: () => void): () => void;
  claimControl(): void;
}

export type GuardedPaneCloseOutcome =
  | 'closed'
  | 'state-changed'
  | 'unavailable'
  | 'pane-changed';

/** Keep Dockview ownership intact until the interpreter has authoritatively
 * destroyed the creator session. This seam is deliberately UI-framework
 * agnostic so the ACK-before-close ordering has a deterministic unit test. */
export async function closePaneAfterGuardedSessionDestroy(
  snapshot: PaneSnapshot,
  destroyGuarded: (
    sessionId: string,
    expectedActiveRunIds: readonly string[],
  ) => Promise<DestroySessionGuardResult>,
  getCurrentSnapshot: () => PaneSnapshot | null,
  markDestroyHandled: (destroyedSessionId: string) => boolean,
  close: () => void,
): Promise<GuardedPaneCloseOutcome> {
  if (!snapshot.destroysSessionOnClose || snapshot.sessionId === null) return 'pane-changed';
  if (snapshot.isDead) {
    const current = getCurrentSnapshot();
    if (
      !current
      || current.panelId !== snapshot.panelId
      || current.sessionId !== snapshot.sessionId
      || !current.destroysSessionOnClose
      || !current.isDead
    ) {
      return 'pane-changed';
    }
    if (!markDestroyHandled(snapshot.sessionId)) return 'pane-changed';
    close();
    return 'closed';
  }
  let result: DestroySessionGuardResult;
  try {
    result = await destroyGuarded(snapshot.sessionId, Object.freeze([...snapshot.activeRunIds]));
  } catch {
    return 'unavailable';
  }
  if (!result.ok) return result.reason;
  const current = getCurrentSnapshot();
  if (
    !current
    || current.panelId !== snapshot.panelId
    || current.sessionId !== snapshot.sessionId
    || !current.destroysSessionOnClose
  ) {
    return 'pane-changed';
  }
  if (!markDestroyHandled(snapshot.sessionId)) return 'pane-changed';
  close();
  return 'closed';
}

const panes = new Map<string, PaneHandle>();
const legacyCwds = new Map<string, string>();
const legacyInputs = new Map<string, (text: string) => void>();
const listeners = new Set<() => void>();
let revision = 0;

interface MountedPtyRegistration {
  readonly token: object;
  readonly target: MountedPtyControlTarget;
  readonly unsubscribe: () => void;
}

const mountedPtyControllers = new Map<MountedPtyControllerSource, MountedPtyRegistration>();
const mountedPtyListeners = new Set<() => void>();
let mountedPtyRevision = 0;

function emit(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function emitMountedPtyChanged(): void {
  mountedPtyRevision += 1;
  for (const listener of mountedPtyListeners) listener();
}

function readMountedPtySnapshot(source: MountedPtyControllerSource): MountedPtyControlSnapshot {
  const snapshot = source.getSnapshot();
  return Object.freeze({
    status: snapshot.status,
    shape: snapshot.shape,
    hasControl: snapshot.hasControl,
  });
}

/** Register one actually-mounted PTY surface. The cleanup is token-guarded so
 * a stale React effect cannot remove a newer registration for the same source. */
export function registerMountedPtyController(
  source: MountedPtyControllerSource,
  identity: PtyControlTargetIdentity,
): () => void {
  const prior = mountedPtyControllers.get(source);
  prior?.unsubscribe();

  const token = {};
  const target = Object.freeze({
    ...identity,
    targetId: `${identity.panelId}\u0000${identity.runId}`,
    runKey: `${identity.sessionId}\u0000${identity.runId}`,
    isMounted: (): boolean => mountedPtyControllers.get(source)?.token === token,
    getSnapshot: (): MountedPtyControlSnapshot => readMountedPtySnapshot(source),
    subscribe: (listener: () => void): (() => void) => source.subscribe(listener),
    claimControl: (): void => source.claimControl(),
  }) satisfies MountedPtyControlTarget;

  let observed = readMountedPtySnapshot(source);
  const unsubscribe = source.subscribe(() => {
    const next = readMountedPtySnapshot(source);
    if (
      next.status === observed.status
      && next.shape === observed.shape
      && next.hasControl === observed.hasControl
    ) {
      return;
    }
    observed = next;
    emitMountedPtyChanged();
  });

  mountedPtyControllers.set(source, { token, target, unsubscribe });
  emitMountedPtyChanged();

  return () => {
    const current = mountedPtyControllers.get(source);
    if (!current || current.token !== token) return;
    current.unsubscribe();
    mountedPtyControllers.delete(source);
    emitMountedPtyChanged();
  };
}

/** Frozen, side-effect-free snapshot of mounted control handles. */
export function listMountedPtyControlTargets(): readonly MountedPtyControlTarget[] {
  return Object.freeze([...mountedPtyControllers.values()].map(({ target }) => target));
}

export function getMountedPtyControlTarget(
  source: MountedPtyControllerSource,
): MountedPtyControlTarget | undefined {
  return mountedPtyControllers.get(source)?.target;
}

export function subscribeMountedPtyRegistry(listener: () => void): () => void {
  mountedPtyListeners.add(listener);
  return () => mountedPtyListeners.delete(listener);
}

export function getMountedPtyRegistryRevision(): number {
  return mountedPtyRevision;
}

export function registerPane(panelId: string, handle: PaneHandle): () => void {
  panes.set(panelId, handle);
  emit();
  return () => {
    if (panes.get(panelId) !== handle) return;
    panes.delete(panelId);
    emit();
  };
}

export function notifyPaneChanged(panelId: string): void {
  if (panes.has(panelId)) emit();
}

export function subscribePaneRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPaneRegistryRevision(): number {
  return revision;
}

export function getPaneHandle(panelId: string): PaneHandle | undefined {
  return panes.get(panelId);
}

export function listPaneSnapshots(): PaneSnapshot[] {
  return [...panes.values()].map((pane) => pane.getSnapshot());
}

/** Creator-only, immutable snapshot used across async preset validation. */
export function listCreatorPaneSnapshots(
  snapshots: readonly PaneSnapshot[] = listPaneSnapshots(),
): readonly PaneSnapshot[] {
  return Object.freeze(snapshots
    .filter((pane) => pane.destroysSessionOnClose && pane.sessionId !== null)
    .map((pane) => Object.freeze({
      ...pane,
      activeRunIds: Object.freeze([...pane.activeRunIds]),
    })));
}

/** A pending bind is intentionally separate from creator snapshots: it may
 * not have a session id yet, but can become a creator after the caller's
 * current snapshot. Never begin an irreversible preset teardown in that gap. */
export function hasPendingSessionBinding(
  snapshots: readonly PaneSnapshot[] = listPaneSnapshots(),
): boolean {
  return snapshots.some((pane) => pane.sessionBindingPending);
}

/** Exact creator/session/run identity check before any destructive request. */
export function hasExactCreatorPaneSet(
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

/** After an accepted destroy, missing creators and completed/cancelled runs
 * are safe. A new creator, replacement session, or new run is not. */
export function hasNoUnexpectedCreatorPanes(
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

// Compatibility helpers for the existing File Explorer while it migrates to
// the richer handle. They preserve the old return contracts.
export function setPaneCwd(panelId: string, cwd: string): void {
  legacyCwds.set(panelId, cwd);
}

export function getPaneCwd(panelId: string): string | undefined {
  return panes.get(panelId)?.getSnapshot().cwd || legacyCwds.get(panelId);
}

export function removePaneCwd(panelId: string): void {
  legacyCwds.delete(panelId);
}

export function registerPaneInput(panelId: string, fn: (text: string) => void): void {
  legacyInputs.set(panelId, fn);
}

export function unregisterPaneInput(panelId: string): void {
  legacyInputs.delete(panelId);
}

export function insertIntoPaneInput(panelId: string, text: string): boolean {
  const pane = panes.get(panelId);
  if (pane) return pane.insertText(text).ok;
  const legacy = legacyInputs.get(panelId);
  if (!legacy) return false;
  legacy(text);
  return true;
}
