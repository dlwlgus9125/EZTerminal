import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobileAppUpdateController } from './use-mobile-app-update';
import { MobileAppUpdateCard } from './MobileAppUpdateCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobileAppUpdateCard', () => {
  it('keeps the verified APK open action available after install permission is requested', async () => {
    const controller: MobileAppUpdateController = {
      snapshot: {
        phase: 'error',
        currentVersion: '1.0.0',
        checkedAt: 100,
        release: {
          version: '1.2.3',
          publishedAt: '2026-07-30T00:00:00Z',
          sizeBytes: 8_000_000,
          assetName: 'EZTerminal-Android-1.2.3-vc44.apk',
          androidVersionCode: 44,
        },
        download: {
          name: 'EZTerminal-Android-1.2.3-vc44.apk',
          locationLabel: 'Downloads/EZTerminal',
          requiresUnsignedConfirmation: false,
        },
        error: {
          stage: 'permission',
          code: 'INSTALL_PERMISSION_REQUIRED',
          retryable: true,
        },
      },
      check: vi.fn(async () => undefined),
      download: vi.fn(async () => undefined),
      cancelDownload: vi.fn(async () => undefined),
      openDownloaded: vi.fn(async () => ({ ok: true as const })),
    };
    act(() => root.render(<MobileAppUpdateCard controller={controller} />));
    expect(container.textContent).toContain('Allow EZTerminal');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mobile-app-update-open"]')!.click();
      await Promise.resolve();
    });
    expect(controller.openDownloaded).toHaveBeenCalledTimes(1);
  });
});
