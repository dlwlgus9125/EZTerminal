/**
 * Deep renderer-side seam between workspace chrome and live TerminalPane
 * instances. Dockview params cannot carry mutable pane state, so consumers
 * query a narrow handle rather than growing parallel module-level maps.
 */

import type { ExecutionKind } from '../shared/ipc';
import type { SessionSurfaceRole } from '../shared/session-surface';
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
  /** Host-issued close capability for this exact mounted surface. */
  readonly sessionSurfaceBindingId: string | null;
  /** Host-authoritative view role; renderer code must never infer ownership. */
  readonly sessionSurfaceRole: SessionSurfaceRole | null;
  /** Compatibility projection used by close-risk presentation. */
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
  insertText(text: string): PaneActionResult;
  runText(text: string): PaneActionResult;
  pasteToPty(text: string): PaneActionResult;
  /** Focuses the current keyboard surface and reports whether the owner
   * document accepted focus. A false result can mean a reparented overlay is
   * still hidden and lets the caller wait for layout instead of guessing. */
  focus(): boolean;
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

/** When each live pane was mounted, so a header can say how long it has been
 * open. Kept here rather than derived from the session, because a pane that
 * adopts an existing session has genuinely been open for less time than the
 * session has existed, and the header is talking about the pane. */
const paneOpenedAt = new Map<string, number>();

export function registerPane(panelId: string, handle: PaneHandle): () => void {
  panes.set(panelId, handle);
  paneOpenedAt.set(panelId, Date.now());
  emit();
  return () => {
    if (panes.get(panelId) !== handle) return;
    panes.delete(panelId);
    paneOpenedAt.delete(panelId);
    emit();
  };
}

export function getPaneOpenedAt(panelId: string): number | undefined {
  return paneOpenedAt.get(panelId);
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
