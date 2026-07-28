// @vitest-environment jsdom

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BootIntroOverlay } from './BootIntroOverlay';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  act(() => {
    root.render(
      <StrictMode>
        <AppI18nProvider locale="en" languages={['en']}>
          <BootIntroOverlay />
        </AppI18nProvider>
      </StrictMode>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stubDesktop(getBootIntro: () => Promise<boolean>): void {
  (window as unknown as { ezterminalDesktop?: unknown }).ezterminalDesktop = { getBootIntro };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { ezterminalDesktop?: unknown }).ezterminalDesktop;
  vi.restoreAllMocks();
});

describe('BootIntroOverlay', () => {
  // StrictMode re-runs mount effects in development. A guard that latched on
  // "a read was started" let the first read's callback be cancelled by the
  // simulated unmount while the second run skipped issuing its own, leaving the
  // overlay stuck before it ever rendered.
  it('still plays when effects are double-invoked', async () => {
    stubDesktop(() => Promise.resolve(true));
    mount();
    await settle();
    expect(container.querySelector('[data-testid="boot-intro"]')).not.toBeNull();
  });

  it('renders nothing when the preference is off', async () => {
    stubDesktop(() => Promise.resolve(false));
    mount();
    await settle();
    expect(container.querySelector('[data-testid="boot-intro"]')).toBeNull();
  });

  it('consumes the first key in capture phase while skipping', async () => {
    stubDesktop(() => Promise.resolve(true));
    mount();
    await settle();
    const reachedWorkbench = vi.fn();
    document.addEventListener('keydown', reachedWorkbench);

    const event = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true });
    act(() => {
      document.querySelector('[data-testid="boot-intro"]')?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(reachedWorkbench).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="boot-intro"]')).toBeNull();
    document.removeEventListener('keydown', reachedWorkbench);
  });

  it('renders nothing when the preference cannot be read', async () => {
    stubDesktop(() => Promise.reject(new Error('no bridge')));
    mount();
    await settle();
    expect(container.querySelector('[data-testid="boot-intro"]')).toBeNull();
  });

  it('skips outright under reduced motion without consulting the setting', async () => {
    const getBootIntro = vi.fn(() => Promise.resolve(true));
    stubDesktop(getBootIntro);
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    mount();
    await settle();
    expect(container.querySelector('[data-testid="boot-intro"]')).toBeNull();
    expect(getBootIntro).not.toHaveBeenCalled();
  });
});
