import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { MobileTabBar } from './MobileTabBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MobileTabBar update badge', () => {
  it('announces an available update on the connected-only Settings entry', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(
      <MobileTabBar
        tab="home"
        agentAttention={0}
        updateAvailable
        onSelectTab={vi.fn()}
        onOpenPcControl={vi.fn()}
        onOpenMore={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    ));
    const settings = container.querySelector<HTMLElement>('[data-testid="shell-rail-settings"]');
    expect(settings?.getAttribute('aria-label')).toContain('update');
    expect(settings?.querySelector('.mobile-shell-tab__update-dot')).not.toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
