// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppUpdateSnapshot } from '../shared/app-update';
import { AppI18nProvider } from './i18n';
import { AppUpdateCard } from './AppUpdateCard';
import type { AppUpdateController } from './use-app-update';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function controller(snapshot: AppUpdateSnapshot): AppUpdateController {
  return {
    snapshot,
    check: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    cancelDownload: vi.fn(async () => undefined),
    openDownloaded: vi.fn(async () => ({ ok: true as const })),
  };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll('.ez-ui-dialog-backdrop').forEach((node) => node.remove());
});

describe('AppUpdateCard', () => {
  it('shows download progress with an accessible native progress element', () => {
    const value = controller({
      phase: 'downloading',
      currentVersion: '1.0.0',
      checkedAt: 100,
      release: {
        version: '1.2.3',
        publishedAt: '2026-07-30T00:00:00Z',
        sizeBytes: 1_000,
        assetName: 'EZTerminal-Setup.exe',
        windowsAuthenticode: 'NotSigned',
      },
      progress: {
        receivedBytes: 400,
        totalBytes: 1_000,
        percent: 40,
      },
    });
    act(() => {
      root.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <AppUpdateCard controller={value} />
        </AppI18nProvider>,
      );
    });
    const progress = container.querySelector('progress');
    expect(progress?.getAttribute('value')).toBe('400');
    expect(container.textContent).toContain('40%');
  });

  it('requires the warning dialog before opening an unsigned installer', async () => {
    const value = controller({
      phase: 'downloaded',
      currentVersion: '1.0.0',
      checkedAt: 100,
      release: {
        version: '1.2.3',
        publishedAt: '2026-07-30T00:00:00Z',
        sizeBytes: 1_000,
        assetName: 'EZTerminal-Setup.exe',
        windowsAuthenticode: 'NotSigned',
      },
      download: {
        name: 'EZTerminal-Setup-1.2.3.exe',
        locationLabel: 'Downloads/EZTerminal',
        requiresUnsignedConfirmation: true,
      },
    });
    act(() => {
      root.render(
        <AppI18nProvider locale="en" languages={['en']}>
          <AppUpdateCard controller={value} />
        </AppI18nProvider>,
      );
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="app-update-open"]')!.click());
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(value.openDownloaded).not.toHaveBeenCalled();

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="app-update-confirm-unsigned"]')!.click();
      await Promise.resolve();
    });
    expect(value.openDownloaded).toHaveBeenCalledWith(true);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
