import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileSettingsView } from './MobileSettingsView';
import { MobileUiPreferencesProvider } from './MobileUiPreferencesProvider';
import { terminalAccessoryLayoutStore } from './terminal-accessory-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  terminalAccessoryLayoutStore.reload();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MobileUiPreferencesProvider>
        <MobileSettingsView
          onClose={vi.fn()}
          onDisconnect={vi.fn()}
          openclawMode="auto"
          onOpenClawModeChange={vi.fn()}
        />
      </MobileUiPreferencesProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('MobileUiPreferencesProvider + MobileSettingsView', () => {
  it('applies and persists language and density changes immediately', async () => {
    expect(container.querySelector('.mobile-settings-title')?.textContent).toBe('Settings');

    const language = container.querySelector<HTMLSelectElement>('[data-testid="settings-language"]')!;
    await act(async () => {
      setSelectValue(language, 'ko');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('.mobile-settings-title')?.textContent).toBe('설정');
    expect(document.documentElement.lang).toBe('ko');
    expect(JSON.parse(localStorage.getItem('ezterminal-mobile-ui-preferences') ?? '{}').preferences.locale).toBe('ko');

    const density = container.querySelector<HTMLSelectElement>('[data-testid="settings-density"]')!;
    act(() => setSelectValue(density, 'compact'));

    expect(document.documentElement.dataset.density).toBe('compact');
    expect(JSON.parse(localStorage.getItem('ezterminal-mobile-ui-preferences') ?? '{}').preferences.density).toBe('compact');
  });

  it('keeps the session change but reports a device-local persistence failure', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const language = container.querySelector<HTMLSelectElement>('[data-testid="settings-language"]')!;

    await act(async () => {
      setSelectValue(language, 'ko');
      await Promise.resolve();
    });

    expect(container.querySelector('.mobile-settings-title')?.textContent).toBe('설정');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('인터페이스 환경설정을 저장하지 못했습니다.');
    expect(localStorage.getItem('ezterminal-mobile-ui-preferences')).toBeNull();
  });
});
