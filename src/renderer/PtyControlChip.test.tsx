// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockController, BlockSnapshot, PtyControlTargetIdentity } from './block-controller';
import { PtyControlChip } from './PtyControlChip';
import { registerMountedPtyController } from './pane-registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeController {
  readonly controller: BlockController;
  setControl(hasControl: boolean): void;
}

function makeController(identity: PtyControlTargetIdentity): FakeController {
  const listeners = new Set<() => void>();
  let snapshot = {
    status: 'running',
    shape: 'pty',
    hasControl: false,
  } as BlockSnapshot;
  const source = {
    controlTarget: identity,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    claimControl: () => {
      snapshot = { ...snapshot, hasControl: true };
      for (const listener of listeners) listener();
    },
  } as unknown as BlockController;
  return {
    controller: source,
    setControl: (hasControl) => {
      snapshot = { ...snapshot, hasControl };
      for (const listener of listeners) listener();
    },
  };
}

let root: Root | null = null;
let pane: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  pane?.remove();
  pane = null;
  vi.unstubAllGlobals();
});

describe('PtyControlChip', () => {
  it('states view-only ownership without inventing an actor and restores only its initiating pane', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const fake = makeController({ panelId: 'panel-a', sessionId: 'session-a', runId: 'run-a' });
    const restoreFocus = vi.fn();
    pane = document.createElement('section');
    pane.className = 'pane';
    const host = document.createElement('div');
    pane.append(host);
    document.body.append(pane);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <PtyControlChip
          controller={fake.controller}
          hostRef={{ current: host }}
          onRestoreFocus={restoreFocus}
        />,
      );
    });

    expect(host.textContent).toContain('Viewing only · input active elsewhere');
    expect(host.textContent).not.toContain('phone');
    const takeControl = host.querySelector<HTMLButtonElement>('[data-testid="pty-take-control"]');
    expect(takeControl).not.toBeNull();

    await act(async () => {
      takeControl?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Control restored.');
    expect(restoreFocus).toHaveBeenCalledTimes(1);
  });

  it('offers one bounded bulk action for another eligible mounted run', async () => {
    const initiator = makeController({ panelId: 'panel-a', sessionId: 'session-a', runId: 'run-a' });
    const other = makeController({ panelId: 'panel-b', sessionId: 'session-b', runId: 'run-b' });
    const unregisterOther = registerMountedPtyController(other.controller, other.controller.controlTarget!);
    pane = document.createElement('section');
    pane.className = 'pane';
    const host = document.createElement('div');
    pane.append(host);
    document.body.append(pane);
    root = createRoot(host);

    await act(async () => {
      root?.render(
        <PtyControlChip
          controller={initiator.controller}
          hostRef={{ current: host }}
          onRestoreFocus={() => {}}
        />,
      );
    });

    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="pty-take-control-all"]')?.textContent,
    ).toBe('Take control all (2)');

    act(() => unregisterOther());
  });
});
