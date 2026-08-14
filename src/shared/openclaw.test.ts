import { describe, expect, it } from 'vitest';

import { isOpenClawChatSurfaceSnapshot } from './openclaw';

const surface = {
  surfaceId: 'openclaw-chat',
  instanceId: '00000000-0000-4000-8000-000000000001',
  revision: 7,
  mounted: true,
  windowName: 'main',
  bounds: { x: 12, y: 24, width: 800, height: 560 },
  visible: true,
} as const;

describe('OpenClaw chat surface snapshots', () => {
  it('accepts a bounded, revisioned native-window surface', () => {
    expect(isOpenClawChatSurfaceSnapshot(surface)).toBe(true);
  });

  it('rejects stale-shaped and contradictory unmounted surfaces', () => {
    expect(isOpenClawChatSurfaceSnapshot({ ...surface, revision: 0 })).toBe(false);
    expect(isOpenClawChatSurfaceSnapshot({ ...surface, windowName: '' })).toBe(false);
    expect(isOpenClawChatSurfaceSnapshot({
      ...surface,
      mounted: false,
      visible: true,
    })).toBe(false);
    expect(isOpenClawChatSurfaceSnapshot({
      ...surface,
      bounds: { ...surface.bounds, width: -1 },
    })).toBe(false);
  });
});
