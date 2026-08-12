import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MOBILE_BACKGROUND_SUSPEND_MS,
  MobileAppLifecycleController,
} from './mobile-app-lifecycle';

afterEach(() => {
  vi.useRealTimers();
});

describe('MobileAppLifecycleController', () => {
  it('keeps a short background interruption warm', () => {
    vi.useFakeTimers();
    const suspend = vi.fn();
    const resume = vi.fn();
    const controller = new MobileAppLifecycleController({
      initiallyActive: true,
      onSuspend: suspend,
      onResume: resume,
    });

    controller.setActive(false);
    vi.advanceTimersByTime(MOBILE_BACKGROUND_SUSPEND_MS - 1);
    controller.setActive(true);
    vi.advanceTimersByTime(1);

    expect(suspend).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('suspends once after 30 seconds and resumes once on foreground', () => {
    vi.useFakeTimers();
    const suspend = vi.fn();
    const resume = vi.fn();
    const controller = new MobileAppLifecycleController({
      initiallyActive: true,
      onSuspend: suspend,
      onResume: resume,
    });

    controller.setActive(false);
    controller.setActive(false);
    vi.advanceTimersByTime(MOBILE_BACKGROUND_SUSPEND_MS);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(controller.isSuspended).toBe(true);

    controller.setActive(true);
    controller.setActive(true);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(controller.isSuspended).toBe(false);
  });

  it('cancels a stale timer across rapid background generations', () => {
    vi.useFakeTimers();
    const suspend = vi.fn();
    const controller = new MobileAppLifecycleController({
      initiallyActive: true,
      onSuspend: suspend,
      onResume: vi.fn(),
    });

    controller.setActive(false);
    vi.advanceTimersByTime(20_000);
    controller.setActive(true);
    controller.setActive(false);
    vi.advanceTimersByTime(10_000);
    expect(suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    expect(suspend).toHaveBeenCalledTimes(1);
  });
});
