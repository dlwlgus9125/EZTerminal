import { describe, expect, it, vi } from 'vitest';

import { resolveOpenClawVisibility } from './openclaw-visibility';

describe('resolveOpenClawVisibility', () => {
  it('lets off win without probing an installed CLI', async () => {
    const isInstalled = vi.fn(async () => true);

    await expect(resolveOpenClawVisibility('off', isInstalled)).resolves.toBe(false);
    expect(isInstalled).not.toHaveBeenCalled();
  });

  it('lets on win without probing an absent CLI', async () => {
    const isInstalled = vi.fn(async () => false);

    await expect(resolveOpenClawVisibility('on', isInstalled)).resolves.toBe(true);
    expect(isInstalled).not.toHaveBeenCalled();
  });

  it('delegates auto mode to the installed probe', async () => {
    const isInstalled = vi.fn(async () => true);

    await expect(resolveOpenClawVisibility('auto', isInstalled)).resolves.toBe(true);
    expect(isInstalled).toHaveBeenCalledOnce();
  });
});
