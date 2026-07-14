// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getMountedPtyControlTarget,
  listMountedPtyControlTargets,
  registerMountedPtyController,
  type MountedPtyControllerSource,
  type MountedPtyControlSnapshot,
  type MountedPtyControlTarget,
} from './pane-registry';
import {
  mayRestorePtyControlFocus,
  reclaimPtyControls,
  selectPtyControlReclaimCandidates,
} from './pty-control-reclaim';

interface FakeTarget {
  readonly target: MountedPtyControlTarget;
  setMounted(mounted: boolean): void;
  setSnapshot(next: Partial<MountedPtyControlSnapshot>): void;
  setClaim(handler: () => void): void;
}

function makeTarget(
  id: string,
  runKey = id,
  initial: Partial<MountedPtyControlSnapshot> = {},
): FakeTarget {
  let snapshot: MountedPtyControlSnapshot = {
    status: 'running',
    shape: 'pty',
    hasControl: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  let mounted = true;
  let claim = (): void => {};
  const target: MountedPtyControlTarget = Object.freeze({
    targetId: id,
    runKey,
    panelId: `panel-${id}`,
    sessionId: `session-${runKey}`,
    runId: `run-${runKey}`,
    isMounted: () => mounted,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    claimControl: () => claim(),
  });
  return {
    target,
    setMounted: (next) => {
      mounted = next;
      for (const listener of listeners) listener();
    },
    setSnapshot: (next) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
    setClaim: (handler) => {
      claim = handler;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('mounted PTY control registry', () => {
  it('enumerates only mounted sources through immutable handles', () => {
    let snapshot: MountedPtyControlSnapshot = {
      status: 'running',
      shape: 'pty',
      hasControl: false,
    };
    const listeners = new Set<() => void>();
    const source: MountedPtyControllerSource = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      claimControl: vi.fn(),
    };

    const unregister = registerMountedPtyController(source, {
      panelId: 'panel-a',
      sessionId: 'session-a',
      runId: 'run-a',
    });
    const listed = listMountedPtyControlTargets();

    expect(Object.isFrozen(listed)).toBe(true);
    expect(listed).toHaveLength(1);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect(getMountedPtyControlTarget(source)).toBe(listed[0]);
    expect(listed[0].getSnapshot()).toEqual(snapshot);

    snapshot = { ...snapshot, hasControl: true };
    for (const listener of listeners) listener();
    expect(listed[0].getSnapshot().hasControl).toBe(true);

    unregister();
    expect(listed[0].isMounted()).toBe(false);
    expect(listMountedPtyControlTargets()).toHaveLength(0);
  });
});

describe('selectPtyControlReclaimCandidates', () => {
  it('dedupes runs, preserves the explicit initiator, and leaves locally controlled runs alone', () => {
    const initiator = makeTarget('a-mirror', 'run-a');
    const sameRunController = makeTarget('a-controller', 'run-a', { hasControl: true });
    const bFirst = makeTarget('b-first', 'run-b');
    const bSecond = makeTarget('b-second', 'run-b');
    const cController = makeTarget('c-controller', 'run-c', { hasControl: true });
    const cMirror = makeTarget('c-mirror', 'run-c');

    expect(selectPtyControlReclaimCandidates([
      initiator.target,
      sameRunController.target,
      bFirst.target,
      bFirst.target,
      bSecond.target,
      cController.target,
      cMirror.target,
    ], initiator.target)).toEqual([
      initiator.target,
      bFirst.target,
    ]);
  });
});

describe('reclaimPtyControls', () => {
  it('caps claims at four concurrent targets and reports every success', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const targets = Array.from({ length: 7 }, (_, index) => {
      const fake = makeTarget(`target-${index}`);
      fake.setClaim(() => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => {
          active -= 1;
          fake.setSnapshot({ hasControl: true });
        }, 25);
      });
      return fake.target;
    });

    const pending = reclaimPtyControls(targets, { concurrency: 99, timeoutMs: 2_000 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(maxActive).toBe(4);
    expect(result.succeeded).toHaveLength(7);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('times out without guessing success and retries only the failed target', async () => {
    vi.useFakeTimers();
    const fake = makeTarget('slow');

    const firstPending = reclaimPtyControls([fake.target], { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const first = await firstPending;
    expect(first.failed).toEqual([fake.target]);
    expect(first.outcomes[0]).toMatchObject({ status: 'failed', reason: 'timed-out' });

    fake.setClaim(() => fake.setSnapshot({ hasControl: true }));
    const retry = await reclaimPtyControls(first.failed, { timeoutMs: 50 });
    expect(retry.succeeded).toEqual([fake.target]);
    expect(retry.failed).toHaveLength(0);
  });

  it('reports a target that ends while pending as skipped instead of retryable', async () => {
    vi.useFakeTimers();
    const fake = makeTarget('ending');
    fake.setClaim(() => setTimeout(() => fake.setSnapshot({ status: 'done' }), 10));

    const pending = reclaimPtyControls([fake.target], { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result.skipped).toEqual([fake.target]);
    expect(result.failed).toHaveLength(0);
    expect(result.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'ended' });
  });

  it('treats an unmounted target as stale without posting another claim', async () => {
    const fake = makeTarget('stale');
    const claim = vi.fn();
    fake.setClaim(claim);
    fake.setMounted(false);

    const result = await reclaimPtyControls([fake.target]);

    expect(claim).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([fake.target]);
    expect(result.failed).toHaveLength(0);
  });
});

describe('mayRestorePtyControlFocus', () => {
  it('never restores across panes after the user moves to another composer', () => {
    const paneA = document.createElement('section');
    paneA.className = 'pane';
    const host = document.createElement('div');
    const inputA = document.createElement('input');
    inputA.className = 'cmd-input';
    paneA.append(host, inputA);

    const paneB = document.createElement('section');
    paneB.className = 'pane';
    const inputB = document.createElement('input');
    inputB.className = 'cmd-input';
    paneB.append(inputB);
    document.body.append(paneA, paneB);

    expect(mayRestorePtyControlFocus(host, document.body)).toBe(true);
    expect(mayRestorePtyControlFocus(host, inputA)).toBe(true);
    expect(mayRestorePtyControlFocus(host, inputB)).toBe(false);

    host.remove();
    expect(mayRestorePtyControlFocus(host, document.body)).toBe(false);
  });
});
