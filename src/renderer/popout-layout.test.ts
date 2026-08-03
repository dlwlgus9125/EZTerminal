import { describe, expect, it } from 'vitest';

import { prepareLayoutForDockviewRestore } from './popout-layout';

describe('prepareLayoutForDockviewRestore', () => {
  it('converts persisted absolute popout coordinates to Dockview-relative coordinates', () => {
    const input = {
      grid: {
        root: { type: 'branch', data: [] },
        width: 1000,
        height: 700,
        orientation: 'HORIZONTAL',
      },
      panels: {},
      popoutGroups: [{
        data: { id: 'group-2', views: ['tab-2'] },
        position: { left: -1200, top: 80, width: 800, height: 600 },
        url: 'https://stale.invalid/',
        gridReferenceGroup: 'stale',
      }],
    };

    const prepared = prepareLayoutForDockviewRestore(input, { screenX: -1920, screenY: 0 });

    expect(prepared.popoutGroups?.[0]).toEqual({
      data: { id: 'group-2', views: ['tab-2'] },
      position: { left: 720, top: 80, width: 800, height: 600 },
    });
    expect(input.popoutGroups[0].position.left).toBe(-1200);
  });
});
