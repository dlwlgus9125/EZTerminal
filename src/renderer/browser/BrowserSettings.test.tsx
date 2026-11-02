// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserSettingsState } from '../../shared/browser';
import type { BrowserAccess } from '../capability-access';
import { BrowserSettingsSection } from './BrowserSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const access = (state: BrowserSettingsState): BrowserAccess => ({
  load: vi.fn(async () => state),
  save: vi.fn(async (settings) => settings),
  revokeSite: vi.fn(async () => []),
  clearData: vi.fn(async () => undefined),
});
const BASE: BrowserSettingsState = { settings: { enabled: true, autoCheck: false }, sites: [] };

async function shown(state: BrowserSettingsState): Promise<HTMLElement | null> {
  await act(async () => { root.render(<BrowserSettingsSection access={access(state)} />); });
  await act(async () => { await Promise.resolve(); });
  expect(host.querySelector('[data-testid="browser-enabled"]')).not.toBeNull();
  return host.querySelector<HTMLElement>('[data-testid="browser-sites-notice"]');
}

describe('BrowserSettingsSection: why the allowed sites are not what was saved', () => {
  it('says a list changed outside the app was set aside, and what to do', async () => {
    expect((await shown({ ...BASE, sitesNotice: 'discarded' }))?.textContent).toMatch(/changed outside the app/u);
  });

  it('says the list lasts only until the app closes when it cannot be protected', async () => {
    expect((await shown({ ...BASE, sitesNotice: 'unprotected' }))?.textContent).toMatch(/until the app closes/u);
  });

  it('says nothing when the list is what was saved', async () => {
    expect(await shown(BASE)).toBeNull();
  });
});
