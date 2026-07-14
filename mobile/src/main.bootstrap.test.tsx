// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const bootstrap = vi.hoisted(() => ({
  calls: [] as string[],
  render: vi.fn(),
}));

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({ render: bootstrap.render })),
}));

vi.mock('./App', () => ({ App: () => null }));
vi.mock('./MobileUiPreferencesProvider', () => ({ MobileUiPreferencesProvider: () => null }));

vi.mock('./theme', () => ({
  loadCustomThemes: vi.fn(() => bootstrap.calls.push('loadCustomThemes')),
  loadFont: vi.fn(() => {
    bootstrap.calls.push('loadFont');
    return 'persisted-font';
  }),
  loadTheme: vi.fn(() => {
    bootstrap.calls.push('loadTheme');
    return 'persisted-theme';
  }),
  applyTheme: vi.fn(() => bootstrap.calls.push('applyTheme')),
}));

vi.mock('../../src/renderer/theme-runtime', () => ({
  setUserFontId: vi.fn(() => bootstrap.calls.push('setUserFontId')),
}));

vi.mock('./ui-scale', () => ({ loadUiScale: vi.fn(() => 1) }));
vi.mock('../../src/renderer/ui-scale', () => ({ applyUiScale: vi.fn() }));

describe('mobile bootstrap ordering', () => {
  beforeEach(() => {
    bootstrap.calls.length = 0;
    bootstrap.render.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
    vi.resetModules();
  });

  it('hydrates custom themes and font before resolving and applying the persisted theme', async () => {
    await import('./main');

    expect(bootstrap.calls).toEqual([
      'loadCustomThemes',
      'loadFont',
      'setUserFontId',
      'loadTheme',
      'applyTheme',
    ]);
    expect(bootstrap.render).toHaveBeenCalledTimes(1);
  });
});
