// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppI18nProvider } from '../i18n';
import { ArtifactFrame, type ArtifactPreviewAccess } from './ArtifactFrame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ArtifactFrame', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  const render = async (access: ArtifactPreviewAccess, kind: 'html' | 'pdf' = 'html'): Promise<void> => {
    await act(async () => {
      root.render(<AppI18nProvider locale="en" languages={['en']}><ArtifactFrame path={'C:\\work\\report.html'} kind={kind} title="report" access={access} /></AppI18nProvider>);
      await Promise.resolve();
    });
  };

  it('shows a granted HTML page fully sandboxed (no scripts), and gives the grant back when closed', async () => {
    const access = { grant: vi.fn(async () => ({ ok: true as const, token: 't1', url: 'ezartifact://t1/report.html' })), revoke: vi.fn(async () => undefined) };
    await render(access);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('ezartifact://t1/report.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(access.grant).toHaveBeenCalledWith('C:\\work\\report.html', 'html');
    act(() => root.unmount());
    expect(access.revoke).toHaveBeenCalledWith('t1');
    root = createRoot(container);
  });

  it('a page that moves offers the way back to its first document', async () => {
    const access = { grant: vi.fn(async () => ({ ok: true as const, token: 't1', url: 'ezartifact://t1/report.html' })), revoke: vi.fn(async () => undefined) };
    await render(access);
    const frame = () => container.querySelector('iframe')!;
    act(() => { frame().dispatchEvent(new Event('load')); });
    expect(container.querySelector('[data-testid="results-artifact-back"]')).toBeNull();
    act(() => { frame().dispatchEvent(new Event('load')); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="results-artifact-back"]')!.click());
    expect(container.querySelector('[data-testid="results-artifact-back"]')).toBeNull();
    expect(frame().getAttribute('src')).toBe('ezartifact://t1/report.html');
  });

  it('a PDF keeps the viewer (no sandbox attribute); refusals read as a reason, never a frame', async () => {
    await render({ grant: vi.fn(async () => ({ ok: true as const, token: 't2', url: 'ezartifact://t2/paper.pdf' })), revoke: vi.fn(async () => undefined) }, 'pdf');
    expect(container.querySelector('iframe')!.hasAttribute('sandbox')).toBe(false);
    await render({ grant: vi.fn(async () => ({ ok: false as const, error: 'too-large' as const })), revoke: vi.fn(async () => undefined) });
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('too large');
  });
});
