import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

import type { BlockController } from './block-controller';
import {
  getMountedPtyControlTarget,
  getMountedPtyRegistryRevision,
  listMountedPtyControlTargets,
  registerMountedPtyController,
  subscribeMountedPtyRegistry,
  type MountedPtyControlTarget,
} from './pane-registry';
import {
  mayRestorePtyControlFocus,
  reclaimPtyControls,
  selectPtyControlReclaimCandidates,
  type PtyControlReclaimResult,
} from './pty-control-reclaim';

interface PtyControlChipProps {
  readonly controller: BlockController;
  readonly hostRef: RefObject<HTMLElement | null>;
  readonly onRestoreFocus: () => void;
}

function formatResult(result: PtyControlReclaimResult): string {
  if (result.failed.length === 0 && result.skipped.length === 0) {
    return result.succeeded.length === 1
      ? 'Control restored.'
      : `Control restored for ${result.succeeded.length} terminals.`;
  }
  if (result.succeeded.length === 0 && result.failed.length === 0) {
    return 'No running terminals remained to reclaim.';
  }
  const parts = [`${result.succeeded.length} restored`];
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} ended`);
  return `${parts.join(' · ')}.`;
}

/** Compact ownership affordance shared by plain and xterm PTY views. It never
 * names an actor because the current protocol intentionally exposes only the
 * per-port hasControl bit. */
export function PtyControlChip({
  controller,
  hostRef,
  onRestoreFocus,
}: PtyControlChipProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const identity = controller.controlTarget;
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PtyControlReclaimResult | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!identity) return;
    return registerMountedPtyController(controller, identity);
  }, [controller, identity]);

  useSyncExternalStore(
    subscribeMountedPtyRegistry,
    getMountedPtyRegistryRevision,
    getMountedPtyRegistryRevision,
  );

  const initiator = getMountedPtyControlTarget(controller);
  const candidates = initiator
    ? selectPtyControlReclaimCandidates(listMountedPtyControlTargets(), initiator)
    : [];

  useEffect(() => {
    if (!result || result.failed.length > 0) return;
    const timer = setTimeout(() => setResult(null), 3_000);
    return () => clearTimeout(timer);
  }, [result]);

  const reclaim = useCallback(async (
    targets: readonly MountedPtyControlTarget[],
  ): Promise<void> => {
    if (pendingRef.current || targets.length === 0) return;
    pendingRef.current = true;
    setPending(true);
    setResult(null);
    const next = await reclaimPtyControls(targets);
    if (!mountedRef.current) return;
    pendingRef.current = false;
    setPending(false);
    setResult(next);
    if (initiator && next.succeeded.some((target) => target.targetId === initiator.targetId)) {
      requestAnimationFrame(() => {
        if (mayRestorePtyControlFocus(hostRef.current)) onRestoreFocus();
      });
    }
  }, [hostRef, initiator, onRestoreFocus]);

  const runningPty = snapshot.status === 'running' && snapshot.shape === 'pty';
  if (!runningPty) return null;
  if (snapshot.hasControl && !pending && !result) return null;

  return (
    <div
      className="pty-control-chip"
      data-testid="pty-control-chip"
      role="group"
      aria-label="Terminal input control"
      aria-busy={pending}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {!snapshot.hasControl && (
        <span className="pty-control-chip__label">Viewing only · input active elsewhere</span>
      )}
      {pending && (
        <span className="pty-control-chip__status" role="status" aria-live="polite">
          Taking control…
        </span>
      )}
      {!pending && result && (
        <span className="pty-control-chip__status" role="status" aria-live="polite">
          {formatResult(result)}
        </span>
      )}
      {!pending && !snapshot.hasControl && initiator && (
        <button
          type="button"
          className="pty-control-chip__action"
          data-testid="pty-take-control"
          onClick={() => void reclaim([initiator])}
        >
          Take control
        </button>
      )}
      {!pending && !snapshot.hasControl && candidates.length > 1 && (
        <button
          type="button"
          className="pty-control-chip__action"
          data-testid="pty-take-control-all"
          onClick={() => void reclaim(candidates)}
        >
          Take control all ({candidates.length})
        </button>
      )}
      {!pending && result && result.failed.length > 0 && (
        <button
          type="button"
          className="pty-control-chip__action"
          data-testid="pty-take-control-retry"
          onClick={() => void reclaim(result.failed)}
        >
          Retry failed ({result.failed.length})
        </button>
      )}
      {!pending && !identity && !snapshot.hasControl && (
        <button
          type="button"
          className="pty-control-chip__action"
          data-testid="pty-take-control"
          onClick={() => controller.claimControl()}
        >
          Take control
        </button>
      )}
    </div>
  );
}
