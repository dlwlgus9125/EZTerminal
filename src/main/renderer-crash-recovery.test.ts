import { afterEach, describe, expect, it, vi } from 'vitest';

import { RendererCrashRecovery } from './renderer-crash-recovery';

afterEach(() => {
  vi.useRealTimers();
});

describe('RendererCrashRecovery', () => {
  it('reloads once and then breaks the crash loop', () => {
    const recovery = new RendererCrashRecovery(60_000, 1);
    expect(recovery.decide('crashed', 1_000)).toBe('reload');
    expect(recovery.decide('oom', 2_000)).toBe('show-failure');
  });

  it('allows recovery again after a stable window or explicit reset', () => {
    const recovery = new RendererCrashRecovery(60_000, 1);
    expect(recovery.decide('crashed', 1_000)).toBe('reload');
    expect(recovery.decide('crashed', 61_001)).toBe('reload');
    recovery.markStable();
    expect(recovery.decide('crashed', 61_002)).toBe('reload');
  });

  it('does not reload a clean renderer exit', () => {
    expect(new RendererCrashRecovery().decide('clean-exit')).toBe('ignore');
  });

  it('cancels the dead renderer stability timer before making a crash-loop decision', () => {
    vi.useFakeTimers();
    const recovery = new RendererCrashRecovery(60_000, 1);

    expect(recovery.decide('crashed', 1_000)).toBe('reload');
    recovery.armStabilityTimer();
    expect(recovery.decide('oom', 2_000)).toBe('show-failure');

    vi.advanceTimersByTime(60_000);
    expect(recovery.decide('crashed', 2_001)).toBe('show-failure');
  });

  it('marks a renderer stable only after the full observation window', () => {
    vi.useFakeTimers();
    const recovery = new RendererCrashRecovery(60_000, 1);

    expect(recovery.decide('crashed', 1_000)).toBe('reload');
    recovery.armStabilityTimer();
    vi.advanceTimersByTime(60_000);
    expect(recovery.decide('crashed', 2_000)).toBe('reload');
  });
});
