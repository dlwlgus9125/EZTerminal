import type { MountedPtyControlTarget } from './pane-registry';

export const PTY_CONTROL_RECLAIM_CONCURRENCY = 4;
export const PTY_CONTROL_RECLAIM_TIMEOUT_MS = 2_000;

export type PtyControlReclaimOutcome =
  | { readonly status: 'succeeded'; readonly target: MountedPtyControlTarget }
  | {
    readonly status: 'skipped';
    readonly target: MountedPtyControlTarget;
    readonly reason: 'already-controlled' | 'ended' | 'not-pty';
  }
  | {
    readonly status: 'failed';
    readonly target: MountedPtyControlTarget;
    readonly reason: 'timed-out' | 'unavailable';
  };

export interface PtyControlReclaimResult {
  readonly outcomes: readonly PtyControlReclaimOutcome[];
  readonly succeeded: readonly MountedPtyControlTarget[];
  readonly skipped: readonly MountedPtyControlTarget[];
  readonly failed: readonly MountedPtyControlTarget[];
}

function safeSnapshot(target: MountedPtyControlTarget) {
  try {
    return target.getSnapshot();
  } catch {
    return null;
  }
}

function isEligible(target: MountedPtyControlTarget): boolean {
  if (!target.isMounted()) return false;
  const snapshot = safeSnapshot(target);
  return snapshot?.status === 'running' && snapshot.shape === 'pty' && !snapshot.hasControl;
}

/** Choose at most one mounted surface for each run. A run already controlled
 * by another mounted desktop surface is left alone; the explicit initiator is
 * the sole exception, because "Take control" intentionally moves that run to
 * the pane whose chip the user clicked. */
export function selectPtyControlReclaimCandidates(
  targets: readonly MountedPtyControlTarget[],
  initiator?: MountedPtyControlTarget,
): readonly MountedPtyControlTarget[] {
  const uniqueTargets = new Map<string, MountedPtyControlTarget>();
  for (const target of targets) {
    if (!uniqueTargets.has(target.targetId)) uniqueTargets.set(target.targetId, target);
  }
  if (initiator) uniqueTargets.set(initiator.targetId, initiator);

  const groups = new Map<string, MountedPtyControlTarget[]>();
  for (const target of uniqueTargets.values()) {
    const group = groups.get(target.runKey);
    if (group) group.push(target);
    else groups.set(target.runKey, [target]);
  }

  const selected: MountedPtyControlTarget[] = [];
  if (initiator && isEligible(initiator)) {
    selected.push(initiator);
  }

  for (const group of groups.values()) {
    if (initiator && group.some((target) => target.targetId === initiator.targetId)) continue;
    if (group.some((target) => safeSnapshot(target)?.hasControl === true)) continue;
    const eligible = group.find(isEligible);
    if (eligible) selected.push(eligible);
  }

  return Object.freeze(selected);
}

function classifyUnavailable(target: MountedPtyControlTarget): PtyControlReclaimOutcome {
  if (!target.isMounted()) return { status: 'skipped', target, reason: 'ended' };
  const snapshot = safeSnapshot(target);
  if (snapshot?.hasControl) return { status: 'skipped', target, reason: 'already-controlled' };
  if (snapshot?.status !== 'running') return { status: 'skipped', target, reason: 'ended' };
  if (snapshot.shape !== 'pty') return { status: 'skipped', target, reason: 'not-pty' };
  return { status: 'failed', target, reason: 'unavailable' };
}

function reclaimOne(
  target: MountedPtyControlTarget,
  timeoutMs: number,
): Promise<PtyControlReclaimOutcome> {
  if (!target.isMounted()) {
    return Promise.resolve({ status: 'skipped', target, reason: 'ended' });
  }
  const initial = safeSnapshot(target);
  if (initial?.hasControl) {
    return Promise.resolve({ status: 'skipped', target, reason: 'already-controlled' });
  }
  if (initial?.status !== 'running') {
    return Promise.resolve({ status: 'skipped', target, reason: 'ended' });
  }
  if (initial.shape !== 'pty') {
    return Promise.resolve({ status: 'skipped', target, reason: 'not-pty' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (outcome: PtyControlReclaimOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe?.();
      resolve(outcome);
    };

    const observe = (): void => {
      if (!target.isMounted()) {
        finish({ status: 'skipped', target, reason: 'ended' });
        return;
      }
      const snapshot = safeSnapshot(target);
      if (snapshot?.hasControl) {
        finish({ status: 'succeeded', target });
      } else if (snapshot?.status !== 'running') {
        finish({ status: 'skipped', target, reason: 'ended' });
      } else if (snapshot.shape !== 'pty') {
        finish({ status: 'skipped', target, reason: 'not-pty' });
      }
    };

    try {
      unsubscribe = target.subscribe(observe);
      observe();
      if (settled) return;
      timer = setTimeout(() => {
        finish(target.isMounted()
          ? { status: 'failed', target, reason: 'timed-out' }
          : { status: 'skipped', target, reason: 'ended' });
      }, timeoutMs);
      target.claimControl();
      // A structural test double or future synchronous adapter may not notify.
      observe();
    } catch {
      finish(classifyUnavailable(target));
    }
  });
}

export async function reclaimPtyControls(
  requestedTargets: readonly MountedPtyControlTarget[],
  options?: { readonly concurrency?: number; readonly timeoutMs?: number },
): Promise<PtyControlReclaimResult> {
  const unique = [...new Map(requestedTargets.map((target) => [target.targetId, target])).values()];
  const timeoutMs = Math.max(1, options?.timeoutMs ?? PTY_CONTROL_RECLAIM_TIMEOUT_MS);
  const concurrency = Math.max(
    1,
    Math.min(options?.concurrency ?? PTY_CONTROL_RECLAIM_CONCURRENCY, PTY_CONTROL_RECLAIM_CONCURRENCY),
  );
  const outcomes = new Array<PtyControlReclaimOutcome>(unique.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < unique.length) {
      const index = nextIndex;
      nextIndex += 1;
      outcomes[index] = await reclaimOne(unique[index], timeoutMs);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));

  const succeeded: MountedPtyControlTarget[] = [];
  const skipped: MountedPtyControlTarget[] = [];
  const failed: MountedPtyControlTarget[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'succeeded') succeeded.push(outcome.target);
    else if (outcome.status === 'skipped') skipped.push(outcome.target);
    else failed.push(outcome.target);
  }

  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    succeeded: Object.freeze(succeeded),
    skipped: Object.freeze(skipped),
    failed: Object.freeze(failed),
  });
}

/** Restore focus only while the user is still in the initiating pane. Moving
 * to another pane or composer during the async claim always wins. */
export function mayRestorePtyControlFocus(
  host: HTMLElement | null,
  activeElement: Element | null = document.activeElement,
): boolean {
  if (!host?.isConnected) return false;
  const pane = host.closest('.pane');
  if (!pane) return false;
  if (activeElement === null || activeElement === document.body) return true;
  return pane.contains(activeElement);
}
