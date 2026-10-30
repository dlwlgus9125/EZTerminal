// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONVERSATION_VIEWING_DEBOUNCE_MS, useConversationPanelOnScreen, useConversationViewing } from './conversation-viewing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function panelApi(location: 'grid' | 'floating' | 'popout' = 'grid') {
  const moved = new Set<() => void>();
  const visibility = new Set<(event: { readonly isVisible: boolean }) => void>();
  return {
    isVisible: true,
    location: { type: location as string },
    getWindow: () => window,
    onDidVisibilityChange: (listener: (event: { readonly isVisible: boolean }) => void) => {
      visibility.add(listener);
      return { dispose: () => visibility.delete(listener) };
    },
    onDidLocationChange: (listener: () => void) => {
      moved.add(listener);
      return { dispose: () => moved.delete(listener) };
    },
    show(isVisible: boolean) {
      this.isVisible = isVisible;
      for (const listener of visibility) listener({ isVisible });
    },
    move(type: string) {
      this.location = { type };
      for (const listener of moved) listener();
    },
  };
}

function Panel({ api, mainGridOnScreen, sessionId = 'session-1' }: {
  readonly api: ReturnType<typeof panelApi>;
  readonly mainGridOnScreen: boolean;
  readonly sessionId?: string | null;
}): null {
  useConversationViewing('panel-1', sessionId, useConversationPanelOnScreen(api, mainGridOnScreen));
  return null;
}

describe('a conversation panel on screen', () => {
  let root: Root;
  const report = vi.fn();
  const focused = vi.fn(() => true);

  beforeEach(() => {
    vi.useFakeTimers();
    report.mockClear();
    focused.mockReturnValue(true);
    vi.spyOn(document, 'hasFocus').mockImplementation(focused);
    vi.stubGlobal('ezterminalDesktop', { reportConversationViewing: report });
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    act(() => { vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS); });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const settle = (): void => act(() => { vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS); });

  it('counts a visible panel in a focused window', () => {
    act(() => root.render(<Panel api={panelApi()} mainGridOnScreen />));
    settle();
    expect(report).toHaveBeenLastCalledWith(['session-1']);
  });

  it('does not count the main grid under the board, which Dockview still calls visible', () => {
    const api = panelApi();
    act(() => root.render(<Panel api={api} mainGridOnScreen />));
    settle();
    act(() => root.render(<Panel api={api} mainGridOnScreen={false} />));
    settle();
    expect(api.isVisible).toBe(true);
    expect(report).toHaveBeenLastCalledWith([]);
  });

  it.each(['floating', 'popout'] as const)('counts a %s panel over the board, and stops once it docks back under it', (location) => {
    const api = panelApi(location);
    act(() => root.render(<Panel api={api} mainGridOnScreen={false} />));
    settle();
    expect(report).toHaveBeenLastCalledWith(['session-1']);
    act(() => api.move('grid'));
    settle();
    expect(report).toHaveBeenLastCalledWith([]);
  });

  it('does not count a hidden tab or an unfocused window', () => {
    const api = panelApi();
    act(() => root.render(<Panel api={api} mainGridOnScreen />));
    settle();
    act(() => api.show(false));
    settle();
    expect(report).toHaveBeenLastCalledWith([]);

    focused.mockReturnValue(false);
    const other = panelApi();
    act(() => root.render(<Panel key="other" api={other} mainGridOnScreen />));
    settle();
    expect(report).toHaveBeenLastCalledWith([]);
  });

  it('reports no draft that has no conversation yet', () => {
    act(() => root.render(<Panel api={panelApi()} mainGridOnScreen sessionId={null} />));
    settle();
    expect(report).not.toHaveBeenCalledWith(expect.arrayContaining(['session-1']));
  });

  it('stops reporting a panel that closes', () => {
    act(() => root.render(<Panel api={panelApi()} mainGridOnScreen />));
    settle();
    act(() => root.render(null));
    settle();
    expect(report).toHaveBeenLastCalledWith([]);
  });
});
