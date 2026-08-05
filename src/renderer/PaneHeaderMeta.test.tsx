// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IDockviewHeaderActionsProps } from 'dockview';

import { PaneHeaderMeta } from './PaneHeaderMeta';
import {
  getPaneRegistryRevision,
  registerPane,
  type PaneHandle,
  type PaneSnapshot,
} from './pane-registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let unregisterPane: () => void;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  unregisterPane = () => undefined;
});

afterEach(() => {
  act(() => {
    unregisterPane();
    root.unmount();
  });
  container.remove();
});

function paneHandle(cwd: string): PaneHandle {
  return {
    getSnapshot: () => ({ cwd } as PaneSnapshot),
    insertText: () => ({ ok: false, reason: 'unavailable' }),
    runText: () => ({ ok: false, reason: 'unavailable' }),
    pasteToPty: () => ({ ok: false, reason: 'unavailable' }),
    focus: () => true,
  };
}

describe('PaneHeaderMeta', () => {
  it('shows cwd immediately when the active pane registers after the header mounts', () => {
    const props = {
      activePanel: { id: 'pane-1' },
      isGroupActive: true,
    } as unknown as IDockviewHeaderActionsProps;

    act(() => root.render(<PaneHeaderMeta {...props} />));
    expect(container.querySelector('[data-testid="pane-header-cwd"]')).toBeNull();

    const revisionBeforeRegistration = getPaneRegistryRevision();
    act(() => {
      unregisterPane = registerPane('pane-1', paneHandle('C:\\repo'));
    });

    expect(getPaneRegistryRevision()).toBe(revisionBeforeRegistration + 1);
    expect(container.querySelector('[data-testid="pane-header-cwd"]')?.textContent).toBe('C:\\repo');
  });
});
