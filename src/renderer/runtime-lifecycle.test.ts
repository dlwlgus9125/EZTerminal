import { describe, expect, it, vi } from 'vitest';

import { RuntimeSurfaceLifecycle } from './runtime-lifecycle';

const ACTIVE = {
  panelVisible: true,
  windowFocused: true,
  windowVisible: true,
  windowMinimized: false,
} as const;

describe('RuntimeSurfaceLifecycle', () => {
  it('keeps a visible unfocused popout passive without parking it', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const lifecycle = new RuntimeSurfaceLifecycle((tier) => seen.push(tier));
    expect(lifecycle.update(ACTIVE)).toBe('active');
    expect(lifecycle.update({ ...ACTIVE, windowFocused: false })).toBe('passive');
    vi.advanceTimersByTime(120_000);
    expect(lifecycle.currentTier).toBe('passive');
    expect(seen).toEqual(['active', 'passive']);
    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('parks an invisible tab only after the grace period and restores immediately', () => {
    vi.useFakeTimers();
    const lifecycle = new RuntimeSurfaceLifecycle(() => undefined);
    lifecycle.update(ACTIVE);
    lifecycle.update({ ...ACTIVE, panelVisible: false });
    vi.advanceTimersByTime(29_999);
    expect(lifecycle.currentTier).toBe('passive');
    vi.advanceTimersByTime(1);
    expect(lifecycle.currentTier).toBe('parked');
    expect(lifecycle.update(ACTIVE)).toBe('active');
    lifecycle.dispose();
    vi.useRealTimers();
  });

  it('cancels stale minimize timers across a quick restore', () => {
    vi.useFakeTimers();
    const lifecycle = new RuntimeSurfaceLifecycle(() => undefined);
    lifecycle.update(ACTIVE);
    lifecycle.update({ ...ACTIVE, windowMinimized: true, windowFocused: false });
    vi.advanceTimersByTime(20_000);
    lifecycle.update(ACTIVE);
    vi.advanceTimersByTime(20_000);
    expect(lifecycle.currentTier).toBe('active');
    lifecycle.dispose();
    vi.useRealTimers();
  });
});
