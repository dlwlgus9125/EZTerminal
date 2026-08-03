// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuxiliaryCloseDialog, type AuxiliaryCloseChoice } from './AuxiliaryCloseDialog';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('AuxiliaryCloseDialog', () => {
  it('requires an explicit close policy for every risky terminal', () => {
    const onConfirm = vi.fn<(choices: ReadonlyMap<string, AuxiliaryCloseChoice>) => void>();
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <AuxiliaryCloseDialog
          requestId="request-1"
          paneCount={3}
          riskyPanes={[
            { panelId: 'tab-1', title: 'Terminal 1', risk: 'A command is running.' },
            { panelId: 'tab-2', title: 'Terminal 2', risk: 'An SSH prompt is open.' },
          ]}
          busy={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </AppI18nProvider>,
    ));

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="auxiliary-close-confirm"]',
    )!;
    const terminateFirst = document.querySelector<HTMLInputElement>(
      'input[name="auxiliary-close-tab-1"][value="terminate"]',
    )!;
    const keepSecond = document.querySelector<HTMLInputElement>(
      'input[name="auxiliary-close-tab-2"][value="keep"]',
    )!;

    expect(confirm.disabled).toBe(true);
    act(() => terminateFirst.click());
    expect(confirm.disabled).toBe(true);
    act(() => keepSecond.click());
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());

    expect(onConfirm).toHaveBeenCalledOnce();
    const choices = onConfirm.mock.calls[0]![0];
    expect([...choices.entries()]).toEqual([
      ['tab-1', 'terminate'],
      ['tab-2', 'keep'],
    ]);
  });

  it('locks every decision control while the guarded close is in flight', () => {
    act(() => root.render(
      <AppI18nProvider locale="en" languages={['en']}>
        <AuxiliaryCloseDialog
          requestId="request-2"
          paneCount={1}
          riskyPanes={[
            { panelId: 'tab-1', title: 'Terminal 1', risk: 'A command is running.' },
          ]}
          busy
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </AppI18nProvider>,
    ));

    const controls = document.querySelectorAll<HTMLInputElement>(
      '.auxiliary-close-pane input[type="radio"]',
    );
    expect([...controls].every((control) => control.disabled)).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(
      '[data-testid="auxiliary-close-confirm"]',
    )?.disabled).toBe(true);
  });
});
