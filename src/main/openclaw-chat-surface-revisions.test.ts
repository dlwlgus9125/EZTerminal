import { describe, expect, it } from 'vitest';

import type { OpenClawChatSurfaceSnapshot } from '../shared/openclaw';
import { OpenClawChatSurfaceRevisionGate } from './openclaw-chat-surface-revisions';

function surface(instanceId: string, revision: number): OpenClawChatSurfaceSnapshot {
  return {
    surfaceId: 'openclaw-chat',
    instanceId,
    revision,
    mounted: true,
    windowName: 'main',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    visible: true,
  };
}

describe('OpenClawChatSurfaceRevisionGate', () => {
  it('accepts only increasing revisions within a renderer instance', () => {
    const gate = new OpenClawChatSurfaceRevisionGate();
    const instance = '00000000-0000-4000-8000-000000000001';

    expect(gate.accept(surface(instance, 1))).toBe(true);
    expect(gate.accept(surface(instance, 1))).toBe(false);
    expect(gate.accept(surface(instance, 0))).toBe(false);
    expect(gate.accept(surface(instance, 2))).toBe(true);
  });

  it('lets a reloaded renderer restart at one and never revives its retired predecessor', () => {
    const gate = new OpenClawChatSurfaceRevisionGate();
    const previous = '00000000-0000-4000-8000-000000000001';
    const reloaded = '00000000-0000-4000-8000-000000000002';

    expect(gate.accept(surface(previous, 99))).toBe(true);
    expect(gate.accept(surface(reloaded, 1))).toBe(true);
    expect(gate.accept(surface(previous, 100))).toBe(false);
    expect(gate.accept(surface(reloaded, 2))).toBe(true);
  });
});
