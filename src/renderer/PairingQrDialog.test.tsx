// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from './i18n';
import { PairingQrDialog, type PairingQrDialogProps } from './PairingQrDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderDialog(overrides: Partial<PairingQrDialogProps> = {}): void {
  const props: PairingQrDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    endpoint: 'ws://100.64.0.1:17420',
    code: { code: '7C2F-91KD', expiresAt: Date.now() + 500 },
    redeemed: false,
    issuing: false,
    issueFailed: false,
    onIssue: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <PairingQrDialog {...props} />
      </AppI18nProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-28T00:00:00Z'));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PairingQrDialog', () => {
  it('removes the QR and secret as soon as the one-time code expires', () => {
    renderDialog();
    expect(document.querySelector('[data-testid="pairing-qr-symbol"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pairing-code"]')?.textContent).toBe('7C2F-91KD');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(document.querySelector('[data-testid="pairing-qr-symbol"]')).toBeNull();
    expect(document.querySelector('[data-testid="pairing-code"]')).toBeNull();
    expect(document.querySelector('[data-testid="pairing-expired"]')).not.toBeNull();
  });

  it('exposes single-flight progress and a retryable issuance error', () => {
    renderDialog({ code: null, issuing: true });
    expect(document.querySelector('[data-testid="pairing-issuing"]')).not.toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-testid="pairing-issue"]')?.disabled).toBe(true);

    renderDialog({ code: null, issueFailed: true });
    expect(document.querySelector('[data-testid="pairing-error"]')?.getAttribute('role')).toBe('alert');
    expect(document.querySelector('[data-testid="pairing-issue"]')?.textContent).toContain('Retry');
  });

  it('uses an injected clock without starting a live countdown', () => {
    const currentTime = Date.now();
    renderDialog({
      code: { code: '7C2F-91KD', expiresAt: currentTime + 240_000 },
      currentTime,
    });

    expect(document.querySelector('[data-testid="pairing-countdown"]')?.textContent).toBe('04:00');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(document.querySelector('[data-testid="pairing-countdown"]')?.textContent).toBe('04:00');
    expect(vi.getTimerCount()).toBe(0);
  });
});
