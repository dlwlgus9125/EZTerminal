// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeatureModuleLoader, LazyFeature } from './feature-loader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

describe('LazyFeature feedback scheduling', () => {
  it('commits loading feedback before starting a cold module', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const Feature = (): JSX.Element => <div data-testid="feature-ready" />;
    const load = vi.fn(async () => ({ Feature }));
    const loader = createFeatureModuleLoader(load, (module) => module.Feature);

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(
      <LazyFeature
        loader={loader}
        componentProps={{}}
        loading={<div data-testid="feature-feedback">Loading</div>}
        errorMessage="failed"
        retryLabel="retry"
      />,
    ));

    expect(host.querySelector('[data-testid="feature-feedback"]')).not.toBeNull();
    expect(load).not.toHaveBeenCalled();

    await act(async () => {
      frames.shift()?.(performance.now());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="feature-ready"]')).not.toBeNull();
  });
});
