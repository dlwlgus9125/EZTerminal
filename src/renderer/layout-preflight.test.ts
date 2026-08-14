// @vitest-environment jsdom

import { DockviewApi } from 'dockview-react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LAYOUT_SCHEMA_VERSION, type LayoutEnvelope } from '../shared/layout-schema';
import {
  preflightLayoutEnvelope,
  removePanelFromLayoutEnvelope,
} from './layout-preflight';

class NoopResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  takeRecords(): ResizeObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}

beforeAll(() => {
  // dockview still constructs an observer when auto layout is disabled; the
  // flag prevents callbacks from driving layout. Browsers provide this API,
  // while jsdom needs a no-op constructor for the detached preflight instance.
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function makeEnvelope(panelIds: string[] = ['tab-1']): LayoutEnvelope {
  const panels: LayoutEnvelope['layout']['panels'] = {};
  for (const id of panelIds) {
    panels[id] = {
      id,
      contentComponent: 'terminal',
      renderer: 'always',
      title: id,
    };
  }

  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    savedAt: '2026-07-14T00:00:00.000Z',
    layout: {
      grid: {
        root: {
          type: 'branch',
          data:
            panelIds.length === 0
              ? []
              : [
                  {
                    type: 'leaf',
                    data: {
                      activeView: panelIds[0],
                      id: 'group-1',
                      views: panelIds,
                    },
                    size: 800,
                  },
                ],
        },
        width: 800,
        height: 600,
        orientation: 'HORIZONTAL',
      },
      panels,
      activeGroup: panelIds.length === 0 ? undefined : 'group-1',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('preflightLayoutEnvelope', () => {
  it('accepts a layout that the real dockview deserializer restores with panels', () => {
    const dispose = vi.spyOn(DockviewApi.prototype, 'dispose');

    expect(preflightLayoutEnvelope(makeEnvelope(['tab-1', 'tab-2']))).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('fails closed when dockview fromJSON throws and still disposes', () => {
    vi.spyOn(DockviewApi.prototype, 'fromJSON').mockImplementation(() => {
      throw new Error('invalid nested grid');
    });
    const dispose = vi.spyOn(DockviewApi.prototype, 'dispose');

    expect(preflightLayoutEnvelope(makeEnvelope())).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a zero-panel restore before constructing a detached Dockview', () => {
    const dispose = vi.spyOn(DockviewApi.prototype, 'dispose');

    expect(preflightLayoutEnvelope(makeEnvelope([]))).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('fails closed when teardown itself cannot complete', () => {
    vi.spyOn(DockviewApi.prototype, 'dispose').mockImplementation(() => {
      throw new Error('dispose failed');
    });

    expect(preflightLayoutEnvelope(makeEnvelope())).toBe(false);
  });

  it('preflights main and popout grids independently without opening a window', () => {
    const envelope = makeEnvelope(['tab-1', 'tab-2']);
    const mainLeaf = envelope.layout.grid.root.data[0] as {
      data: { activeView: string; views: string[] };
    };
    mainLeaf.data.views = ['tab-1'];
    mainLeaf.data.activeView = 'tab-1';
    envelope.layout.popoutGroups = [{
      data: { id: 'popout-group', views: ['tab-2'], activeView: 'tab-2' },
      position: { left: -700, top: 40, width: 800, height: 600 },
    }];
    const fromJSON = vi.spyOn(DockviewApi.prototype, 'fromJSON');

    expect(preflightLayoutEnvelope(envelope)).toBe(true);
    expect(fromJSON).toHaveBeenCalledTimes(2);
    expect(fromJSON.mock.calls.every(([layout]) => !('popoutGroups' in layout))).toBe(true);
  });
});

describe('removePanelFromLayoutEnvelope', () => {
  it('removes a gated panel through dockview while preserving a valid terminal layout', () => {
    const envelope = makeEnvelope(['tab-1', 'openclaw-chat']);
    envelope.layout.panels['openclaw-chat'] = {
      id: 'openclaw-chat',
      contentComponent: 'openclaw-chat',
      renderer: 'always',
      title: 'OpenClaw Chat',
    };

    const filtered = removePanelFromLayoutEnvelope(envelope, 'openclaw-chat');

    expect(filtered).not.toBeNull();
    expect(filtered?.layout.panels['openclaw-chat']).toBeUndefined();
    expect(filtered?.layout.panels['tab-1']).toBeDefined();
    expect(filtered && preflightLayoutEnvelope(filtered)).toBe(true);
    expect(envelope.layout.panels['openclaw-chat']).toBeDefined();
  });

  it('returns null when the gated panel was the only restorable panel', () => {
    const envelope = makeEnvelope(['openclaw-chat']);
    envelope.layout.panels['openclaw-chat'] = {
      id: 'openclaw-chat',
      contentComponent: 'openclaw-chat',
      renderer: 'always',
      title: 'OpenClaw Chat',
    };

    expect(removePanelFromLayoutEnvelope(envelope, 'openclaw-chat')).toBeNull();
  });

  it('preserves an existing terminal popout while filtering a main-grid panel', () => {
    const envelope = makeEnvelope(['tab-1', 'openclaw-chat', 'tab-2']);
    envelope.layout.panels['openclaw-chat'] = {
      id: 'openclaw-chat',
      contentComponent: 'openclaw-chat',
      renderer: 'always',
      title: 'OpenClaw Chat',
    };
    const mainLeaf = envelope.layout.grid.root.data[0] as {
      data: { activeView: string; views: string[] };
    };
    mainLeaf.data.views = ['tab-1', 'openclaw-chat'];
    mainLeaf.data.activeView = 'tab-1';
    envelope.layout.popoutGroups = [{
      data: { id: 'popout-group', views: ['tab-2'], activeView: 'tab-2' },
      position: { left: 900, top: 40, width: 800, height: 600 },
    }];

    const filtered = removePanelFromLayoutEnvelope(envelope, 'openclaw-chat');

    expect(filtered?.layout.panels['openclaw-chat']).toBeUndefined();
    expect(filtered?.layout.panels['tab-2']).toBeDefined();
    expect(filtered?.layout.popoutGroups).toEqual(envelope.layout.popoutGroups);
  });

  it('removes a gated panel from a mixed popout while preserving its terminal sibling', () => {
    const envelope = makeEnvelope(['tab-1', 'openclaw-chat']);
    envelope.layout.panels['openclaw-chat'] = {
      id: 'openclaw-chat',
      contentComponent: 'openclaw-chat',
      renderer: 'always',
      title: 'OpenClaw Chat',
    };
    const mainLeaf = envelope.layout.grid.root.data[0] as {
      data: { activeView: string; views: string[] };
    };
    mainLeaf.data.views = [];
    envelope.layout.grid.root.data = [];
    envelope.layout.activeGroup = undefined;
    envelope.layout.popoutGroups = [{
      data: {
        id: 'popout-group',
        views: ['tab-1', 'openclaw-chat'],
        activeView: 'openclaw-chat',
      },
      position: { left: 900, top: 40, width: 800, height: 600 },
    }];

    const filtered = removePanelFromLayoutEnvelope(envelope, 'openclaw-chat');

    expect(filtered?.layout.panels['openclaw-chat']).toBeUndefined();
    expect(filtered?.layout.popoutGroups?.[0]?.data?.views).toEqual(['tab-1']);
    expect(filtered?.layout.popoutGroups?.[0]?.data?.activeView).toBe('tab-1');
    expect(filtered && preflightLayoutEnvelope(filtered)).toBe(true);
  });
});
