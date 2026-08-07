// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { ActivityRail } from './ActivityRail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ActivityRail update badge', () => {
  it('places Files fourth in the primary rail order', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(
      <ActivityRail
        active={null}
        attentionCount={0}
        openclawVisible
        onSelect={vi.fn()}
      />,
    ));
    expect(Array.from(container.querySelectorAll<HTMLElement>('[data-destination]'))
      .map((item) => item.dataset.destination))
      .toEqual(['agents', 'monitor', 'remote', 'explorer', 'openclaw', 'settings']);
    act(() => root.unmount());
    container.remove();
  });

  it('marks Settings without changing its action semantics', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(
      <ActivityRail
        active={null}
        attentionCount={0}
        updateAvailable
        openclawVisible={false}
        onSelect={vi.fn()}
      />,
    ));
    expect(container.querySelector('[data-testid="settings-update-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="btn-toggle-settings"]')?.getAttribute('aria-label'))
      .toBe('Settings');
    act(() => root.unmount());
    container.remove();
  });
});
