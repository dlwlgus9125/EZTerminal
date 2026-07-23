// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from './AppErrorBoundary';

function BrokenView(): JSX.Element {
  throw new Error('render failed');
}

describe('AppErrorBoundary', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    sessionStorage.setItem('ezterminal.renderer-error-recovery.v1', String(Date.now()));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('stops a repeated render crash and exposes a manual recovery action', async () => {
    await act(async () => {
      root.render(
        <AppErrorBoundary>
          <BrokenView />
        </AppErrorBoundary>,
      );
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'renderer recovery stopped',
    );
    expect(host.querySelector('button')?.textContent).toBe('Reload interface');
  });
});
