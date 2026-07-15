import { describe, expect, it, vi } from 'vitest';

const bootstrap = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('./webview-compat', () => ({
  installWebViewCompatibility: vi.fn(() => bootstrap.calls.push('compatibility')),
  isWebViewCompatibilityInstalled: vi.fn(() => true),
}));

vi.mock('./main', () => {
  bootstrap.calls.push('application');
  return {};
});

describe('mobile WebView bootstrap', () => {
  it('installs compatibility before evaluating any application dependency', async () => {
    const { mobileAppReady } = await import('./bootstrap');
    await mobileAppReady;

    expect(bootstrap.calls).toEqual(['compatibility', 'application']);
  });
});
