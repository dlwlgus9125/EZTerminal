import type { DockviewApi, DockviewPanelApi, IDockviewPanel } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';

import { applyWorkbenchLayoutPreset } from './workbench-layout-presets';

interface FakeGroup {
  readonly id: string;
}

interface FakePanel {
  readonly panel: IDockviewPanel;
  readonly moveTo: ReturnType<typeof vi.fn>;
  readonly maximize: ReturnType<typeof vi.fn>;
  readonly setActive: ReturnType<typeof vi.fn>;
}

function fakePanel(id: string, initialGroup: FakeGroup): FakePanel {
  let group = initialGroup;
  const moveTo = vi.fn((target: { group: FakeGroup; position: string }) => {
    group = target.position === 'center'
      ? target.group
      : { id: `${id}-${target.position}-group` };
  });
  const maximize = vi.fn();
  const setActive = vi.fn();
  const api = {
    get group() {
      return group;
    },
    moveTo,
    maximize,
    setActive,
  } as unknown as DockviewPanelApi;
  return {
    panel: { id, api } as unknown as IDockviewPanel,
    moveTo,
    maximize,
    setActive,
  };
}

describe('applyWorkbenchLayoutPreset', () => {
  it('does nothing when the workbench has no panels', () => {
    const api = {
      activePanel: undefined,
      panels: [],
      hasMaximizedGroup: () => false,
      exitMaximizedGroup: vi.fn(),
    } as unknown as DockviewApi;

    expect(applyWorkbenchLayoutPreset(api, 'single')).toBe(false);
    expect(api.exitMaximizedGroup).not.toHaveBeenCalled();
  });

  it('turns Single into one tabbed group without removing or maximizing panels', () => {
    const primaryGroup = { id: 'primary' };
    const active = fakePanel('active', primaryGroup);
    const second = fakePanel('second', { id: 'second-group' });
    const third = fakePanel('third', { id: 'third-group' });
    const panels = [active.panel, second.panel, third.panel];
    const exitMaximizedGroup = vi.fn();
    const api = {
      activePanel: active.panel,
      panels,
      hasMaximizedGroup: () => true,
      exitMaximizedGroup,
    } as unknown as DockviewApi;

    expect(applyWorkbenchLayoutPreset(api, 'single')).toBe(true);
    expect(api.panels).toEqual(panels);
    expect(exitMaximizedGroup).toHaveBeenCalledOnce();
    expect(second.moveTo).toHaveBeenCalledWith({
      group: primaryGroup,
      position: 'center',
      skipSetActive: true,
    });
    expect(third.moveTo).toHaveBeenCalledWith({
      group: primaryGroup,
      position: 'center',
      skipSetActive: true,
    });
    expect(active.maximize).not.toHaveBeenCalled();
    expect(active.setActive).toHaveBeenCalledOnce();
  });

  it('builds 2x1 from the existing panel nodes and tabs overflow on the right', () => {
    const primaryGroup = { id: 'primary' };
    const active = fakePanel('active', primaryGroup);
    const right = fakePanel('right', { id: 'right-old' });
    const overflow = fakePanel('overflow', { id: 'overflow-old' });
    const panels = [active.panel, right.panel, overflow.panel];
    const api = {
      activePanel: active.panel,
      panels,
      hasMaximizedGroup: () => false,
      exitMaximizedGroup: vi.fn(),
    } as unknown as DockviewApi;

    expect(applyWorkbenchLayoutPreset(api, 'two-by-one')).toBe(true);
    expect(api.panels).toEqual(panels);
    expect(right.moveTo).toHaveBeenNthCalledWith(1, {
      group: primaryGroup,
      position: 'center',
      skipSetActive: true,
    });
    expect(right.moveTo).toHaveBeenNthCalledWith(2, {
      group: primaryGroup,
      position: 'right',
      skipSetActive: true,
    });
    expect(overflow.moveTo).toHaveBeenNthCalledWith(2, {
      group: { id: 'right-right-group' },
      position: 'center',
      skipSetActive: true,
    });
    expect(active.setActive).toHaveBeenCalledOnce();
  });

  it('builds 1+2 without removing panels and tabs further overflow below', () => {
    const primaryGroup = { id: 'primary' };
    const active = fakePanel('active', primaryGroup);
    const rightTop = fakePanel('right-top', { id: 'right-top-old' });
    const rightBottom = fakePanel('right-bottom', { id: 'right-bottom-old' });
    const overflow = fakePanel('overflow', { id: 'overflow-old' });
    const panels = [active.panel, rightTop.panel, rightBottom.panel, overflow.panel];
    const api = {
      activePanel: active.panel,
      panels,
      hasMaximizedGroup: () => true,
      exitMaximizedGroup: vi.fn(),
    } as unknown as DockviewApi;

    expect(applyWorkbenchLayoutPreset(api, 'one-plus-two')).toBe(true);
    expect(api.panels).toEqual(panels);
    expect(api.exitMaximizedGroup).toHaveBeenCalledOnce();
    expect(rightTop.moveTo).toHaveBeenNthCalledWith(2, {
      group: primaryGroup,
      position: 'right',
      skipSetActive: true,
    });
    expect(rightBottom.moveTo).toHaveBeenNthCalledWith(2, {
      group: { id: 'right-top-right-group' },
      position: 'bottom',
      skipSetActive: true,
    });
    expect(overflow.moveTo).toHaveBeenNthCalledWith(2, {
      group: { id: 'right-bottom-bottom-group' },
      position: 'center',
      skipSetActive: true,
    });
    expect(active.setActive).toHaveBeenCalledOnce();
  });
});
