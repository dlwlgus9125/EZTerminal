/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDisposable, ILink, ILinkProvider, ITerminalAddon, Terminal } from '@xterm/xterm';
import type { ILinkProviderOptions } from '@xterm/addon-web-links';
import type { ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search';

// The production WebGL module probes a canvas at import time; this unit suite
// injects its own addon, so keep jsdom from emitting an irrelevant canvas error.
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));

import {
  XtermRuntime,
  isModifiedLinkActivation,
  normalizeExternalHttpUrl,
  type XtermRuntimeFactories,
} from './xterm-runtime';

class FakeAddon implements ITerminalAddon {
  activateCalls = 0;
  disposeCalls = 0;

  activate(): void {
    this.activateCalls++;
  }

  dispose(): void {
    this.disposeCalls++;
  }
}

class FakeFitAddon extends FakeAddon {
  fitCalls = 0;

  fit(): void {
    this.fitCalls++;
  }
}

class FakeSearchAddon extends FakeAddon {
  readonly nextCalls: Array<{ query: string; options?: ISearchOptions }> = [];
  readonly previousCalls: Array<{ query: string; options?: ISearchOptions }> = [];
  clearCalls = 0;
  private readonly resultListeners = new Set<(event: ISearchResultChangeEvent) => void>();

  readonly onDidChangeResults = (listener: (event: ISearchResultChangeEvent) => void): IDisposable => {
    this.resultListeners.add(listener);
    return { dispose: () => this.resultListeners.delete(listener) };
  };

  findNext(query: string, options?: ISearchOptions): boolean {
    this.nextCalls.push({ query, options });
    return true;
  }

  findPrevious(query: string, options?: ISearchOptions): boolean {
    this.previousCalls.push({ query, options });
    return true;
  }

  clearDecorations(): void {
    this.clearCalls++;
  }

  emitResults(event: ISearchResultChangeEvent): void {
    for (const listener of this.resultListeners) listener(event);
  }
}

class FakeWebglAddon extends FakeAddon {
  private readonly contextLossListeners = new Set<() => void>();

  constructor(private readonly failActivation = false) {
    super();
  }

  override activate(): void {
    super.activate();
    if (this.failActivation) throw new Error('no webgl');
  }

  readonly onContextLoss = (listener: () => void): IDisposable => {
    this.contextLossListeners.add(listener);
    return { dispose: () => this.contextLossListeners.delete(listener) };
  };

  loseContext(): void {
    for (const listener of [...this.contextLossListeners]) listener();
  }
}

class FakeTerminal {
  readonly unicode = { activeVersion: '6' };
  readonly options: { linkHandler?: unknown } = {};
  readonly loaded: ITerminalAddon[] = [];
  openedOn: HTMLElement | null = null;
  clearSelectionCalls = 0;
  lineText = '';
  linkProvider: ILinkProvider | null = null;
  readonly buffer = {
    active: {
      getLine: () => ({ translateToString: () => this.lineText }),
    },
  };

  loadAddon(addon: ITerminalAddon): void {
    this.loaded.push(addon);
    addon.activate(this as unknown as Terminal);
  }

  open(host: HTMLElement): void {
    this.openedOn = host;
  }

  clearSelection(): void {
    this.clearSelectionCalls++;
  }

  registerLinkProvider(provider: ILinkProvider): IDisposable {
    this.linkProvider = provider;
    return { dispose: () => { this.linkProvider = null; } };
  }
}

interface Harness {
  readonly terminal: FakeTerminal;
  readonly fit: FakeFitAddon;
  readonly search: FakeSearchAddon;
  readonly unicode: FakeAddon;
  readonly webgls: FakeWebglAddon[];
  readonly webLinkAddons: FakeAddon[];
  readonly linkHandlers: Array<(event: MouseEvent, uri: string) => void>;
  readonly linkOptions: ILinkProviderOptions[];
  readonly factories: XtermRuntimeFactories;
}

function createHarness(webglFails = false): Harness {
  const terminal = new FakeTerminal();
  const fit = new FakeFitAddon();
  const search = new FakeSearchAddon();
  const unicode = new FakeAddon();
  const webgls: FakeWebglAddon[] = [];
  const webLinkAddons: FakeAddon[] = [];
  const linkHandlers: Array<(event: MouseEvent, uri: string) => void> = [];
  const linkOptions: ILinkProviderOptions[] = [];
  const factories = {
    createFit: () => fit,
    createSearch: () => search,
    createUnicode11: () => unicode,
    createWebLinks: (handler: (event: MouseEvent, uri: string) => void, options: ILinkProviderOptions) => {
      linkHandlers.push(handler);
      linkOptions.push(options);
      const addon = new FakeAddon();
      webLinkAddons.push(addon);
      return addon;
    },
    createWebgl: () => {
      const addon = new FakeWebglAddon(webglFails);
      webgls.push(addon);
      return addon;
    },
  } as XtermRuntimeFactories;
  return { terminal, fit, search, unicode, webgls, webLinkAddons, linkHandlers, linkOptions, factories };
}

describe('xterm runtime URL policy', () => {
  it('normalizes only bounded http(s) URLs with a hostname', () => {
    expect(normalizeExternalHttpUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(normalizeExternalHttpUrl('http://localhost:8080/')).toBe('http://localhost:8080/');
    expect(normalizeExternalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalHttpUrl('file:///tmp/a')).toBeNull();
    expect(normalizeExternalHttpUrl('https://user:pass@example.com')).toBeNull();
    expect(normalizeExternalHttpUrl('https:///missing-host')).toBe('https://missing-host/');
    expect(normalizeExternalHttpUrl(`https://example.com/${'a'.repeat(8192)}`)).toBeNull();
  });

  it('requires Ctrl or Command/Meta activation', () => {
    expect(isModifiedLinkActivation({ ctrlKey: false, metaKey: false })).toBe(false);
    expect(isModifiedLinkActivation({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isModifiedLinkActivation({ ctrlKey: false, metaKey: true })).toBe(true);
  });
});

describe('XtermRuntime', () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });

  it('loads fit/search/Unicode 11 before opening and enables desktop WebGL auto', () => {
    const h = createHarness();
    const rendererChanges: string[] = [];
    const results: ISearchResultChangeEvent[] = [];
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'desktop', rendererPreference: 'auto' },
      { onRendererChange: (renderer) => rendererChanges.push(renderer), onSearchResults: (result) => results.push(result) },
      h.factories,
    );

    runtime.open();

    expect(h.terminal.loaded.slice(0, 3)).toEqual([h.fit, h.search, h.unicode]);
    expect(h.terminal.unicode.activeVersion).toBe('11');
    expect(h.terminal.openedOn).toBe(host);
    expect(runtime.renderer).toBe('webgl');
    expect(host.dataset.xtermRenderer).toBe('webgl');
    expect(rendererChanges).toEqual(['dom', 'webgl']);

    h.search.emitResults({ resultIndex: 1, resultCount: 3 });
    expect(results.at(-1)).toEqual({ resultIndex: 1, resultCount: 3 });

    expect(runtime.find('Hello', 'next', false, true)).toBe(true);
    expect(h.search.nextCalls[0]).toMatchObject({
      query: 'Hello',
      options: { regex: false, wholeWord: false, caseSensitive: false, incremental: true },
    });
    expect(h.search.nextCalls[0].options?.decorations).toBeDefined();

    runtime.setRendererPreference('dom');
    expect(runtime.renderer).toBe('dom');
    expect(h.webgls[0].disposeCalls).toBe(1);
  });

  it('keeps mobile on DOM even when auto is requested', () => {
    const h = createHarness();
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'mobile', rendererPreference: 'auto' },
      {},
      h.factories,
    );
    runtime.open();

    expect(runtime.renderer).toBe('dom');
    expect(h.webgls).toHaveLength(0);
  });

  it('registers contained-file candidates and requires modified activation on desktop', () => {
    const h = createHarness();
    h.terminal.lineText = 'error at ./src/a.ts:12:3';
    const opened: unknown[] = [];
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      {
        platform: 'desktop',
        rendererPreference: 'dom',
        getTerminalFileContext: () => ({ cwd: '/repo', executionKind: 'local' }),
        openTerminalFileLocation: (request) => opened.push(request),
      },
      {},
      h.factories,
    );
    runtime.open();
    let links: readonly ILink[] | undefined;
    h.terminal.linkProvider?.provideLinks(1, (provided) => { links = provided; });
    expect(links).toHaveLength(1);
    links?.[0].activate(new MouseEvent('click'), links[0].text);
    expect(opened).toEqual([]);
    links?.[0].activate(new MouseEvent('click', { ctrlKey: true }), links[0].text);
    expect(opened).toEqual([{ path: './src/a.ts', cwd: '/repo', executionKind: 'local', line: 12, column: 3 }]);
  });

  it('falls back after WebGL activation failure and does not retry this mount', () => {
    const h = createHarness(true);
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'desktop', rendererPreference: 'auto' },
      {},
      h.factories,
    );
    runtime.open();
    runtime.setRendererPreference('auto');

    expect(runtime.renderer).toBe('dom');
    expect(host.dataset.xtermRenderer).toBe('dom');
    expect(h.webgls).toHaveLength(1);
    expect(h.webgls[0].disposeCalls).toBe(1);
  });

  it('falls back on context loss and stays DOM without retrying', () => {
    const h = createHarness();
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'desktop', rendererPreference: 'auto' },
      {},
      h.factories,
    );
    runtime.open();
    h.webgls[0].loseContext();
    runtime.setRendererPreference('auto');

    expect(runtime.renderer).toBe('dom');
    expect(h.webgls).toHaveLength(1);
    expect(h.webgls[0].disposeCalls).toBe(1);
  });

  it('loads no link addon without a platform callback', () => {
    const h = createHarness();
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'desktop', rendererPreference: 'dom' },
      {},
      h.factories,
    );
    runtime.open();

    expect(h.webLinkAddons).toHaveLength(0);
    expect(h.terminal.options.linkHandler).toBeUndefined();
  });

  it('opens validated plain/OSC links only with a modifier and exposes a truthful hover title', () => {
    const h = createHarness();
    const opened = vi.fn();
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'desktop', rendererPreference: 'dom', openExternalHttpUrl: opened },
      {},
      h.factories,
    );
    runtime.open();

    const plainHandler = h.linkHandlers[0];
    plainHandler(new MouseEvent('click'), 'https://example.com/docs');
    expect(opened).not.toHaveBeenCalled();
    plainHandler(new MouseEvent('click', { ctrlKey: true }), 'https://example.com/docs');
    plainHandler(new MouseEvent('click', { ctrlKey: true }), 'javascript:alert(1)');
    expect(opened).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledWith('https://example.com/docs');

    h.linkOptions[0].hover?.(new MouseEvent('mouseover'), 'https://example.com/docs', {
      start: { x: 1, y: 1 },
      end: { x: 4, y: 1 },
    });
    expect(host.title).toContain('Ctrl/Cmd+click');
    expect(host.title).toContain('https://example.com/docs');
    h.linkOptions[0].leave?.(new MouseEvent('mouseout'), 'https://example.com/docs');
    expect(host.hasAttribute('title')).toBe(false);

    const oscHandler = h.terminal.options.linkHandler as {
      activate: (event: MouseEvent, text: string) => void;
      allowNonHttpProtocols: boolean;
    };
    expect(oscHandler.allowNonHttpProtocols).toBe(false);
    oscHandler.activate(new MouseEvent('click', { metaKey: true }), 'http://localhost:3000/path');
    expect(opened).toHaveBeenLastCalledWith('http://localhost:3000/path');
  });

  it('clears decorations/selection and rebuilds them with the latest search', () => {
    const h = createHarness();
    const runtime = new XtermRuntime(
      h.terminal as unknown as Terminal,
      host,
      { platform: 'desktop', rendererPreference: 'dom' },
      {},
      h.factories,
    );
    runtime.open();
    runtime.find('needle', 'previous', true);
    runtime.refreshSearchDecorations();

    expect(h.search.previousCalls).toHaveLength(2);
    expect(h.search.clearCalls).toBe(1);

    runtime.clearSearch();
    expect(h.search.clearCalls).toBe(2);
    expect(h.terminal.clearSelectionCalls).toBe(1);
  });
});
