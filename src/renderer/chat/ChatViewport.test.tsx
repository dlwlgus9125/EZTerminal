// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppI18nProvider } from '../i18n';
import { clearSessionViewStates, saveSessionViewState } from '../session-view-state';
import { ChatViewport } from './ChatViewport';
import type { ChatRow } from './model/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no CSS.escape; ids here need no escaping.
(globalThis as { CSS?: { escape: (value: string) => string } }).CSS ??= { escape: (value) => value };

const OLD = '2026-10-01T00:00:00.000Z';
const notice = (id: string, createdAt = OLD): ChatRow => ({ kind: 'notice', id, createdAt, text: id });

let container: HTMLDivElement;
let root: Root;

function render(rows: readonly ChatRow[]): void {
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <ChatViewport rows={rows} stateKey="viewport-test" label="Conversation" renderRow={(row) => <p>{row.id}</p>} />
    </AppI18nProvider>,
  ));
}

const divider = (): string | null => container.querySelector('.chat-new-divider')?.closest('[data-row-id]')?.getAttribute('data-row-id') ?? null;

beforeEach(() => {
  clearSessionViewStates();
  // The reader left this conversation scrolled up, so the view does not follow the tail.
  saveSessionViewState('viewport-test:chat-anchor', { rowId: 'a', offset: 0, follow: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearSessionViewStates();
});

describe('ChatViewport tail', () => {
  it('stays pinned to the end when the panel itself gets shorter (a dock or child track opens below)', () => {
    const observed: { target: Element; callback: (entries: unknown[]) => void }[] = [];
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: (entries: unknown[]) => void) {}
      observe(target: Element): void { observed.push({ target, callback: this.callback }); }
      disconnect(): void { /* nothing to release */ }
      unobserve(): void { /* nothing to release */ }
    } as unknown as typeof ResizeObserver;
    try {
      clearSessionViewStates();
      render([notice('a'), notice('b')]);
      const scroller = container.querySelector<HTMLElement>('.chat-viewport__scroll')!;
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 });
      scroller.scrollTop = 0;
      const panel = observed.filter((entry) => entry.target === scroller);
      expect(panel.length, 'the scroll container itself is observed').toBeGreaterThan(0);
      const box = { inlineSize: 400, blockSize: 300 };
      act(() => { for (const entry of panel) entry.callback([{ target: scroller, contentRect: { width: 400, height: 300 }, borderBoxSize: [box], contentBoxSize: [box] }]); });
      expect(scroller.scrollTop).toBe(900);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe('ChatViewport follow', () => {
  const metrics = (element: HTMLElement, scrollHeight: number, clientHeight = 400): void => {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
  };
  const scrollTo = (element: HTMLElement, top: number): void => {
    act(() => { element.scrollTop = top; element.dispatchEvent(new Event('scroll')); });
  };
  const pill = (): boolean => container.querySelector('.chat-jump') !== null;

  it('keeps following when rows below grow (row measurement, highlighting) without the reader moving', () => {
    clearSessionViewStates();
    render([notice('a'), notice('b')]);
    const scroller = container.querySelector<HTMLElement>('.chat-viewport__scroll')!;
    metrics(scroller, 1000);
    scrollTo(scroller, 600);
    expect(pill()).toBe(false);
    // Measured rows made the list taller; the browser reports a scroll at the same offset.
    metrics(scroller, 1760);
    scrollTo(scroller, 600);
    expect(pill(), 'growth below is not the reader leaving the tail').toBe(false);
  });

  it('stops following once the reader scrolls up', () => {
    clearSessionViewStates();
    render([notice('a'), notice('b')]);
    const scroller = container.querySelector<HTMLElement>('.chat-viewport__scroll')!;
    metrics(scroller, 1000);
    scrollTo(scroller, 600);
    scrollTo(scroller, 300);
    expect(pill()).toBe(true);
  });
});

describe('ChatViewport "New" divider', () => {
  it('does not mark the initial load, later pages of it, or earlier pages loaded above', () => {
    render([]);
    render([notice('a'), notice('b')]);
    render([notice('a'), notice('b'), notice('c')]);
    render([notice('z'), notice('a'), notice('b'), notice('c')]);
    expect(divider()).toBeNull();
  });

  it('marks the first row that arrives after the reader scrolled away', () => {
    render([notice('a'), notice('b')]);
    render([notice('a'), notice('b'), notice('c', new Date().toISOString()), notice('d', new Date().toISOString())]);
    expect(divider()).toBe('c');
  });
});
