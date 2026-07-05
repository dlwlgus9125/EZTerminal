import { describe, expect, it } from 'vitest';

import { StatsVisibility } from './stats-visibility';

describe('StatsVisibility', () => {
  it('desktop-only: on then off applies true then false', () => {
    const calls: boolean[] = [];
    const v = new StatsVisibility((effective) => calls.push(effective));

    v.setDesktopVisible(true);
    v.setDesktopVisible(false);

    expect(calls).toEqual([true, false]);
  });

  it('mobile-only: acquire then release applies true then false', () => {
    const calls: boolean[] = [];
    const v = new StatsVisibility((effective) => calls.push(effective));

    v.acquire();
    v.release();

    expect(calls).toEqual([true, false]);
  });

  it('desktop and mobile overlapping: effective stays true until BOTH are off', () => {
    const calls: boolean[] = [];
    const v = new StatsVisibility((effective) => calls.push(effective));

    v.setDesktopVisible(true); // -> true
    v.acquire(); // already true, no redundant apply
    v.setDesktopVisible(false); // remoteCount still 1, stays true
    v.release(); // -> false

    expect(calls).toEqual([true, false]);
  });

  it('two overlapping remote viewers: only the last release flips effective off', () => {
    const calls: boolean[] = [];
    const v = new StatsVisibility((effective) => calls.push(effective));

    v.acquire(); // -> true
    v.acquire(); // still true
    v.release(); // remoteCount 1, stays true
    v.release(); // -> false

    expect(calls).toEqual([true, false]);
  });

  it('double-release clamps at 0 and does not go negative or re-apply', () => {
    const calls: boolean[] = [];
    const v = new StatsVisibility((effective) => calls.push(effective));

    v.acquire(); // -> true
    v.release(); // -> false
    v.release(); // clamped, already false, no-op
    v.release(); // clamped, already false, no-op

    expect(calls).toEqual([true, false]);
  });

  it('never calls apply redundantly for same-value transitions', () => {
    const calls: boolean[] = [];
    const v = new StatsVisibility((effective) => calls.push(effective));

    v.setDesktopVisible(false); // already false, no-op
    v.setDesktopVisible(true); // -> true
    v.setDesktopVisible(true); // already true, no-op
    v.acquire(); // already true, no-op
    v.acquire(); // already true, no-op

    expect(calls).toEqual([true]);
  });
});
