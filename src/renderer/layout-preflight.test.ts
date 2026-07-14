// @vitest-environment jsdom

import { DockviewApi } from 'dockview-react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { LAYOUT_SCHEMA_VERSION, type LayoutEnvelope } from '../shared/layout-schema';
import { preflightLayoutEnvelope } from './layout-preflight';

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

  it('rejects a zero-panel restore and still disposes', () => {
    const dispose = vi.spyOn(DockviewApi.prototype, 'dispose');

    expect(preflightLayoutEnvelope(makeEnvelope([]))).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('fails closed when teardown itself cannot complete', () => {
    vi.spyOn(DockviewApi.prototype, 'dispose').mockImplementation(() => {
      throw new Error('dispose failed');
    });

    expect(preflightLayoutEnvelope(makeEnvelope())).toBe(false);
  });
});
