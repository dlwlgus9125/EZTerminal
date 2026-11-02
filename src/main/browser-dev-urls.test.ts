import { describe, expect, it, vi } from 'vitest';

import { BrowserDevUrls } from './browser-dev-urls';

const url = (port: number): string => `http://localhost:${String(port)}/`;

describe('BrowserDevUrls', () => {
  it('lists the latest first, with where each was seen', () => {
    const urls = new BrowserDevUrls();
    urls.add('workspace', url(1), 'terminal');
    urls.add('workspace', url(2), 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(2), source: 'ai' }, { url: url(1), source: 'terminal' }]);
  });

  it('keeps five to a workspace', () => {
    const urls = new BrowserDevUrls();
    for (const port of [1, 2, 3, 4, 5, 6, 7]) urls.add('workspace', url(port), 'terminal');
    expect(urls.candidates('workspace').map((entry) => entry.url)).toEqual([7, 6, 5, 4, 3].map(url));
  });

  it('keeps one entry for one address, as fresh as its last sighting', () => {
    const urls = new BrowserDevUrls();
    urls.add('workspace', url(1), 'terminal');
    urls.add('workspace', url(2), 'terminal');
    urls.add('workspace', url(1), 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(1), source: 'ai' }, { url: url(2), source: 'terminal' }]);
  });

  it('keeps workspaces apart', () => {
    const urls = new BrowserDevUrls();
    urls.add('one', url(1), 'terminal');
    expect(urls.candidates('two')).toEqual([]);
  });

  it('says when the list changed, and not when it did not', () => {
    const onChange = vi.fn();
    const urls = new BrowserDevUrls(onChange);
    urls.add('workspace', url(1), 'terminal');
    urls.add('workspace', url(1), 'terminal');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reads an AI\'s output from its end only', () => {
    const urls = new BrowserDevUrls();
    urls.addFromText('workspace', `${url(1)} ${'x'.repeat(20_000)} ${url(2)}`, 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(2), source: 'ai' }]);
  });

  it('never offers the app\'s own ports', () => {
    const urls = new BrowserDevUrls(undefined, () => new Set([1]));
    urls.addFromText('workspace', `${url(1)} ${url(2)}`, 'ai');
    expect(urls.candidates('workspace')).toEqual([{ url: url(2), source: 'ai' }]);
  });
});
