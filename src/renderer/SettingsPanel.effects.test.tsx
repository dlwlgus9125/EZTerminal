// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TERMINAL_PASTE_PREFERENCES } from '../shared/terminal-clipboard';
import {
  DEFAULT_INTERFERENCE_PARAMS,
  DEFAULT_ROLLBAR_PARAMS,
} from './effect-params';
import { rendererCapabilities } from './capability-access';
import { EFFECT_CATALOG } from './effects';
import { SettingsPanel } from './SettingsPanel';
import { listThemes } from './themes';
import { DesktopUiPreferencesProvider } from './ui-preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const TEST_CAPABILITIES = {
  ...rendererCapabilities,
  remoteRuntime: {
    observe: (observer: Parameters<typeof rendererCapabilities.remoteRuntime.observe>[0]) => {
      observer.onStatus({
        desiredEnabled: false,
        state: 'off',
        port: 8_765,
        errorCode: null,
        error: null,
      });
      observer.onSecurity({ state: 'ready', error: null });
      return () => undefined;
    },
    setEnabled: rendererCapabilities.remoteRuntime.setEnabled,
    retry: rendererCapabilities.remoteRuntime.retry,
  },
};

function renderEffects(
  activeThemeEffects: readonly string[],
  effectToggles: Record<string, boolean> = {},
  theme: 'matrix' | 'high-contrast' = 'high-contrast',
): void {
  act(() => {
    root.render(
      <DesktopUiPreferencesProvider capabilities={TEST_CAPABILITIES}>
        <SettingsPanel
          requestedCategory="appearance"
          uiScale={100}
          onChangeUiScale={vi.fn()}
          scrollback={10_000}
          onChangeScrollback={vi.fn()}
          terminalRendererPreference="auto"
          onChangeTerminalRendererPreference={vi.fn()}
          confirmRiskyPaneClose
          onChangeConfirmRiskyPaneClose={vi.fn()}
          bootIntro
          onChangeBootIntro={vi.fn()}
          allowOsc52Clipboard={false}
          onChangeAllowOsc52Clipboard={vi.fn()}
          terminalPastePreferences={DEFAULT_TERMINAL_PASTE_PREFERENCES}
          onChangeTerminalPastePreferences={vi.fn()}
          theme={theme}
          onSelectTheme={vi.fn()}
          availableThemes={listThemes()}
          onImportTheme={async () => ({ ok: true })}
          fontId="share-tech-mono"
          onSelectFont={vi.fn()}
          activeThemeEffects={activeThemeEffects}
          effectToggles={effectToggles}
          onToggleEffect={vi.fn()}
          rollbar={DEFAULT_ROLLBAR_PARAMS}
          onChangeRollbar={vi.fn()}
          interference={DEFAULT_INTERFERENCE_PARAMS}
          onChangeEffectParams={vi.fn()}
          capabilities={TEST_CAPABILITIES}
        />
      </DesktopUiPreferencesProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('SettingsPanel theme effect support', () => {
  it('renders the complete catalog disabled with a connected reason for High Contrast', () => {
    renderEffects([]);

    const switches = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-testid^="settings-effect-"]'),
    ).filter((input) => input.type === 'checkbox');
    expect(switches).toHaveLength(Object.keys(EFFECT_CATALOG).length);
    for (const input of switches) {
      expect(input.disabled, input.dataset.testid).toBe(true);
      const descriptionId = input.getAttribute('aria-describedby');
      expect(descriptionId, input.dataset.testid).toBeTruthy();
      expect(document.getElementById(descriptionId ?? '')?.textContent).toMatch(/active theme/i);
    }
  });

  it('enables only Matrix-supported effects and hides parameters until enabled', () => {
    renderEffects(
      ['scanlines', 'phosphor-glow', 'crt-rollbar'],
      { scanlines: true, 'phosphor-glow': true, 'crt-rollbar': false },
      'matrix',
    );

    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-effect-scanlines"]')?.disabled)
      .toBe(false);
    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-effect-crt-rollbar"]')?.disabled)
      .toBe(false);
    expect(container.querySelector<HTMLInputElement>('[data-testid="settings-effect-flicker"]')?.disabled)
      .toBe(true);
    expect(container.querySelector('[data-testid="settings-rollbar-params"]')).toBeNull();

    renderEffects(
      ['scanlines', 'phosphor-glow', 'crt-rollbar'],
      { scanlines: true, 'phosphor-glow': true, 'crt-rollbar': true },
      'matrix',
    );
    expect(container.querySelector('[data-testid="settings-rollbar-params"]')).not.toBeNull();
  });
});
