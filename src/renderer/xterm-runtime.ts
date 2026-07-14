import { FitAddon } from '@xterm/addon-fit';
import {
  SearchAddon,
  type ISearchOptions,
  type ISearchResultChangeEvent,
} from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon, type ILinkProviderOptions } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { IDisposable, ILink, ITerminalAddon, Terminal } from '@xterm/xterm';
import { normalizeExternalHttpUrl } from '../shared/external-url';
import type { TerminalRendererPreference } from '../shared/layout-schema';
import { findTerminalFileLinks, type TerminalFileLocationRequest } from '../shared/terminal-file-location';
import type { ExecutionKind } from '../shared/ipc';

export { normalizeExternalHttpUrl };

export type { TerminalRendererPreference } from '../shared/layout-schema';
export type ActiveTerminalRenderer = 'webgl' | 'dom';

/** Platform-owned capabilities for one xterm surface. The component never
 * reaches into Electron or Capacitor directly; its host supplies the adapter. */
export interface TerminalRuntimeOptions {
  readonly platform: 'desktop' | 'mobile';
  readonly rendererPreference: TerminalRendererPreference;
  readonly openExternalHttpUrl?: (url: string) => void;
  /** OSC 52 stays off unless the desktop user explicitly enables it. */
  readonly allowOsc52Clipboard?: boolean;
  readonly writeClipboardText?: (text: string) => Promise<void> | void;
  readonly openTerminalFileLocation?: (request: TerminalFileLocationRequest, event: MouseEvent) => void;
  readonly getTerminalFileContext?: () => { readonly cwd: string | null; readonly executionKind: ExecutionKind | null };
}

export const DEFAULT_TERMINAL_RUNTIME_OPTIONS: TerminalRuntimeOptions = Object.freeze({
  platform: 'desktop',
  rendererPreference: 'auto',
});

export interface TerminalSearchResults {
  /** Zero-based active result, or -1 when there is no active result. */
  readonly resultIndex: number;
  /** Bounded by the addon's 1000-result highlight limit. */
  readonly resultCount: number;
}

export interface XtermRuntimeEvents {
  readonly onSearchResults?: (results: TerminalSearchResults) => void;
  readonly onRendererChange?: (renderer: ActiveTerminalRenderer) => void;
}

type SearchAddonLike = ITerminalAddon &
  Pick<SearchAddon, 'findNext' | 'findPrevious' | 'clearDecorations' | 'onDidChangeResults'>;
type FitAddonLike = ITerminalAddon & Pick<FitAddon, 'fit'>;
type WebglAddonLike = ITerminalAddon & Pick<WebglAddon, 'onContextLoss'>;

/** Injectable only so the lifecycle/fallback logic can be tested without a
 * browser canvas. Product code always uses the stable xterm addon factories. */
export interface XtermRuntimeFactories {
  readonly createFit: () => FitAddonLike;
  readonly createSearch: () => SearchAddonLike;
  readonly createUnicode11: () => ITerminalAddon;
  readonly createWebLinks: (
    handler: (event: MouseEvent, uri: string) => void,
    options: ILinkProviderOptions,
  ) => ITerminalAddon;
  readonly createWebgl: () => WebglAddonLike;
}

const DEFAULT_FACTORIES: XtermRuntimeFactories = {
  createFit: () => new FitAddon(),
  createSearch: () => new SearchAddon({ highlightLimit: 1000 }),
  createUnicode11: () => new Unicode11Addon(),
  createWebLinks: (handler, options) => new WebLinksAddon(handler, options),
  createWebgl: () => new WebglAddon(),
};

interface LastSearch {
  readonly query: string;
  readonly direction: 'next' | 'previous';
  readonly caseSensitive: boolean;
  readonly incremental: boolean;
}

const EMPTY_RESULTS: TerminalSearchResults = Object.freeze({ resultIndex: -1, resultCount: 0 });

export function isModifiedLinkActivation(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return event.ctrlKey || event.metaKey;
}

function cssHex(host: HTMLElement, property: string, fallback: string): string {
  const value = getComputedStyle(host).getPropertyValue(property).trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

/** Owns addon setup/teardown and all optional-renderer policy for one Terminal.
 * PTY flow control, input, sizing policy, touch, and IME remain in PtyBlock. */
export class XtermRuntime {
  readonly fitAddon: FitAddonLike;

  private readonly searchAddon: SearchAddonLike;
  private readonly unicode11Addon: ITerminalAddon;
  private readonly events: XtermRuntimeEvents;
  private readonly factories: XtermRuntimeFactories;
  private readonly disposables: IDisposable[] = [];
  private webLinksAddon: ITerminalAddon | null = null;
  private webglAddon: WebglAddonLike | null = null;
  private webglContextLoss: IDisposable | null = null;
  private opened = false;
  private disposed = false;
  private webglSuppressed = false;
  private activeRenderer: ActiveTerminalRenderer = 'dom';
  private preference: TerminalRendererPreference;
  private lastSearch: LastSearch | null = null;

  constructor(
    private readonly terminal: Terminal,
    private readonly host: HTMLElement,
    private readonly options: TerminalRuntimeOptions = DEFAULT_TERMINAL_RUNTIME_OPTIONS,
    events: XtermRuntimeEvents = {},
    factories: XtermRuntimeFactories = DEFAULT_FACTORIES,
  ) {
    this.events = events;
    this.factories = factories;
    this.preference = options.rendererPreference;
    this.fitAddon = factories.createFit();
    this.searchAddon = factories.createSearch();
    this.unicode11Addon = factories.createUnicode11();
  }

  get renderer(): ActiveTerminalRenderer {
    return this.activeRenderer;
  }

  /** Load core addons before open, activate Unicode 11, then attempt desktop
   * WebGL. Search/links/Unicode are independent of the selected renderer. */
  open(): void {
    if (this.opened || this.disposed) return;

    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(this.unicode11Addon);
    this.terminal.unicode.activeVersion = '11';

    const resultDisposable = this.searchAddon.onDidChangeResults((result: ISearchResultChangeEvent) => {
      this.events.onSearchResults?.({ resultIndex: result.resultIndex, resultCount: result.resultCount });
    });
    this.disposables.push(resultDisposable);

    if (this.options.openExternalHttpUrl) this.installLinkHandling();
    if (this.options.openTerminalFileLocation && this.options.getTerminalFileContext) {
      this.installTerminalFileLinks();
    }

    this.terminal.open(this.host);
    this.opened = true;
    this.setRenderer('dom');
    this.setRendererPreference(this.preference);
  }

  private installTerminalFileLinks(): void {
    const disposable = this.terminal.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        const line = this.terminal.buffer.active.getLine(lineNumber - 1)?.translateToString(true) ?? '';
        const links: ILink[] = findTerminalFileLinks(line).map((match) => ({
          range: {
            start: { x: match.start + 1, y: lineNumber },
            end: { x: match.end, y: lineNumber },
          },
          text: match.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            if (this.options.platform === 'desktop' && !isModifiedLinkActivation(event)) return;
            const context = this.options.getTerminalFileContext?.();
            if (!context?.cwd || context.executionKind !== 'local') return;
            this.options.openTerminalFileLocation?.({
              path: match.path,
              cwd: context.cwd,
              executionKind: context.executionKind,
              ...(match.line === undefined ? {} : { line: match.line }),
              ...(match.column === undefined ? {} : { column: match.column }),
            }, event);
          },
        }));
        callback(links.length > 0 ? links : undefined);
      },
    });
    this.disposables.push(disposable);
  }

  setRendererPreference(preference: TerminalRendererPreference): void {
    this.preference = preference;
    if (!this.opened || this.disposed) return;
    if (this.options.platform === 'mobile' || preference === 'dom') {
      this.disableWebgl(false);
      return;
    }
    this.enableWebgl();
  }

  find(
    query: string,
    direction: 'next' | 'previous',
    caseSensitive: boolean,
    incremental = false,
  ): boolean {
    if (this.disposed) return false;
    if (query.length === 0) {
      this.clearSearch();
      return false;
    }

    this.lastSearch = { query, direction, caseSensitive, incremental };
    const searchOptions: ISearchOptions = {
      regex: false,
      wholeWord: false,
      caseSensitive,
      incremental: direction === 'next' && incremental,
      decorations: {
        matchBorder: cssHex(this.host, '--term-amber', '#e5b567'),
        matchOverviewRuler: cssHex(this.host, '--term-amber', '#e5b567'),
        activeMatchBorder: cssHex(this.host, '--term-blue', '#4d9fff'),
        activeMatchColorOverviewRuler: cssHex(this.host, '--term-blue', '#4d9fff'),
      },
    };
    return direction === 'next'
      ? this.searchAddon.findNext(query, searchOptions)
      : this.searchAddon.findPrevious(query, searchOptions);
  }

  clearSearch(): void {
    this.lastSearch = null;
    this.searchAddon.clearDecorations();
    this.terminal.clearSelection();
    this.events.onSearchResults?.(EMPTY_RESULTS);
  }

  /** Rebuild decorations after a theme changes so highlights use that theme's
   * semantic colors without resetting the user's query/case mode. */
  refreshSearchDecorations(): void {
    const last = this.lastSearch;
    if (!last) return;
    this.searchAddon.clearDecorations();
    this.find(last.query, last.direction, last.caseSensitive, last.incremental);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearLinkHover();
    this.webglContextLoss?.dispose();
    this.webglContextLoss = null;
    this.webglAddon?.dispose();
    this.webglAddon = null;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.webLinksAddon?.dispose();
    this.webLinksAddon = null;
    this.searchAddon.dispose();
    this.unicode11Addon.dispose();
    this.fitAddon.dispose();
  }

  private installLinkHandling(): void {
    const activate = (event: MouseEvent, raw: string): void => {
      if (!isModifiedLinkActivation(event)) return;
      const url = normalizeExternalHttpUrl(raw);
      if (!url) return;
      event.preventDefault();
      this.options.openExternalHttpUrl?.(url);
    };
    const hover = (_event: MouseEvent, raw: string): void => this.showLinkHover(raw);
    const leave = (): void => this.clearLinkHover();

    this.webLinksAddon = this.factories.createWebLinks(activate, { hover, leave });
    this.terminal.loadAddon(this.webLinksAddon);
    this.terminal.options.linkHandler = {
      activate,
      hover,
      leave,
      allowNonHttpProtocols: false,
    };
  }

  private showLinkHover(raw: string): void {
    const url = normalizeExternalHttpUrl(raw);
    if (!url) return;
    this.host.dataset.xtermLinkHover = url;
    this.host.title = `Ctrl/Cmd+click to open ${url}`;
  }

  private clearLinkHover(): void {
    delete this.host.dataset.xtermLinkHover;
    this.host.removeAttribute('title');
  }

  private enableWebgl(): void {
    if (
      this.webglAddon ||
      this.webglSuppressed ||
      this.options.platform !== 'desktop' ||
      this.preference !== 'auto'
    ) {
      return;
    }

    const addon = this.factories.createWebgl();
    const contextLoss = addon.onContextLoss(() => this.disableWebgl(true));
    try {
      this.terminal.loadAddon(addon);
      this.webglAddon = addon;
      this.webglContextLoss = contextLoss;
      this.setRenderer('webgl');
    } catch {
      contextLoss.dispose();
      try {
        addon.dispose();
      } catch {
        // A partially activated renderer must never prevent the DOM fallback.
      }
      this.webglSuppressed = true;
      this.setRenderer('dom');
    }
  }

  private disableWebgl(suppressRetry: boolean): void {
    if (suppressRetry) this.webglSuppressed = true;
    const addon = this.webglAddon;
    this.webglAddon = null;
    this.webglContextLoss?.dispose();
    this.webglContextLoss = null;
    if (addon) {
      try {
        addon.dispose();
      } catch {
        // The DOM renderer remains the safe diagnostic state even if teardown fails.
      }
    }
    this.setRenderer('dom');
  }

  private setRenderer(renderer: ActiveTerminalRenderer): void {
    this.activeRenderer = renderer;
    this.host.dataset.xtermRenderer = renderer;
    this.events.onRendererChange?.(renderer);
  }
}
