// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EffectProfileMenu } from './EffectProfileMenu';
import type { EffectProfileId } from '../effect-profiles';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('EffectProfileMenu', () => {
  it('communicates paused requested motion and opens advanced settings', () => {
    let focusedWhenAdvancedOpened: Element | null = null;
    const onOpenAdvanced = vi.fn(() => {
      focusedWhenAdvancedOpened = document.activeElement;
    });
    act(() =>
      root.render(
        <EffectProfileMenu
          activeThemeEffects={['scanlines', 'phosphor-glow', 'crt-rollbar']}
          motionEffectsRequested
          profile="crt-signature"
          onOpenAdvanced={onOpenAdvanced}
          onSelectProfile={vi.fn()}
        />,
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="btn-effect-profile"]')!;
    expect(trigger.getAttribute('aria-label')).toContain('Effects: CRT');
    expect(trigger.getAttribute('aria-label')).toContain('paused');
    act(() => trigger.click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('paused');
    const advanced = container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-advanced"]')!;
    act(() => {
      advanced.focus();
      advanced.click();
    });
    expect(onOpenAdvanced).toHaveBeenCalledTimes(1);
    expect(focusedWhenAdvancedOpened).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it('disables unavailable profiles and does not claim that static effects are paused', () => {
    act(() =>
      root.render(
        <EffectProfileMenu
          activeThemeEffects={[]}
          motionEffectsRequested={false}
          profile="clean"
          onOpenAdvanced={vi.fn()}
          onSelectProfile={vi.fn()}
        />,
      ),
    );

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="btn-effect-profile"]')!.click());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-clean"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-static"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-crt-signature"]')?.disabled).toBe(
      true,
    );
  });

  it('disables named profiles that collapse to another canonical state for the active theme', () => {
    act(() =>
      root.render(
        <EffectProfileMenu
          activeThemeEffects={['scanlines']}
          motionEffectsRequested={false}
          profile="static"
          onOpenAdvanced={vi.fn()}
          onSelectProfile={vi.fn()}
        />,
      ),
    );

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="btn-effect-profile"]')!.click());
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-clean"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-static"]')?.disabled).toBe(false);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-crt-signature"]')?.disabled).toBe(
      true,
    );
    expect(container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-full-crt"]')?.disabled).toBe(true);
  });

  it('keeps the reduced-motion pause announcement after selecting a moving profile closes the menu', () => {
    function Harness(): JSX.Element {
      const [profile, setProfile] = useState<EffectProfileId>('static');
      return (
        <EffectProfileMenu
          activeThemeEffects={['scanlines', 'phosphor-glow', 'crt-rollbar']}
          motionEffectsRequested={profile === 'crt-signature' || profile === 'full-crt'}
          profile={profile}
          onOpenAdvanced={vi.fn()}
          onSelectProfile={setProfile}
        />
      );
    }

    act(() => root.render(<Harness />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="btn-effect-profile"]')!;
    act(() => trigger.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="effect-profile-crt-signature"]')!.click());

    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toContain('paused');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('paused');
  });
});
