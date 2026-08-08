import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createFeatureModuleLoader, preloadOnIntent } from './feature-loader';

const View = (() => null) as ComponentType<Record<string, never>>;

describe('feature module loader', () => {
  it('deduplicates concurrent preload and rendered-load requests', async () => {
    const loadModule = vi.fn(async () => ({ View }));
    const loader = createFeatureModuleLoader(loadModule, (module) => module.View);

    expect(loader.status()).toBe('idle');
    const pending = Promise.all([loader.preload(), loader.preload(), loader.preload()]);
    expect(loader.status()).toBe('loading');
    await pending;

    expect(loadModule).toHaveBeenCalledTimes(1);
    expect(loader.status()).toBe('loaded');
    expect(loader.lazyComponent()).toBeTypeOf('object');
    await loader.preload();
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it('drops a failed promise so a retry can load the feature', async () => {
    const loadModule = vi.fn<() => Promise<{ View: typeof View }>>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ View });
    const loader = createFeatureModuleLoader(loadModule, (module) => module.View);

    await expect(loader.preload()).rejects.toThrow('chunk unavailable');
    await expect(loader.preload()).resolves.toBeUndefined();
    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it('supports explicit cache reset and makes intent preload failure non-fatal', async () => {
    const loadModule = vi.fn(async () => ({ View }));
    const loader = createFeatureModuleLoader(loadModule, (module) => module.View);

    await loader.preload();
    loader.reset();
    expect(loader.status()).toBe('idle');
    await loader.preload();
    expect(loadModule).toHaveBeenCalledTimes(2);

    const rejected = createFeatureModuleLoader(
      () => Promise.reject(new Error('offline')),
      (module: { View: typeof View }) => module.View,
    );
    expect(() => preloadOnIntent(rejected)).not.toThrow();
    await Promise.resolve();
  });
});
