// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppI18nProvider } from '../i18n';
import { clearSessionViewStates, saveSessionViewState } from '../session-view-state';
import { ChatViewport, type ChatTailDock } from './ChatViewport';
import type { ChatRow } from './model/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no CSS.escape; ids here need no escaping.
(globalThis as { CSS?: { escape: (value: string) => string } }).CSS ??= { escape: (value) => value };

const OLD = '2026-10-01T00:00:00.000Z';
const notice = (id: string, createdAt = OLD): ChatRow => ({ kind: 'notice', id, createdAt, text: id });

let container: HTMLDivElement;
let root: Root;

function render(rows: readonly ChatRow[], tailDock?: ChatTailDock): void {
  act(() => root.render(
    <AppI18nProvider locale="en" languages={['en']}>
      <ChatViewport rows={rows} stateKey="viewport-test" label="Conversation" renderRow={(row) => <p>{row.id}</p>} {...(tailDock ? { tailDock } : {})} />
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

describe('ChatViewport tail dock', () => {
  const metrics = (element: HTMLElement, scrollHeight: number): void => {
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 400 });
  };
  const dock = (room: boolean): ChatTailDock => ({ anchorRef: () => undefined, room });
  const rows = (): ChatRow[] => [notice('a'), notice('b')];
  /** A reader at the tail of a long conversation. */
  const atTail = (tailDock?: ChatTailDock): HTMLElement => {
    clearSessionViewStates();
    render(rows(), tailDock);
    const scroller = container.querySelector<HTMLElement>('.chat-viewport__scroll')!;
    metrics(scroller, 1000);
    act(() => { scroller.scrollTop = 600; scroller.dispatchEvent(new Event('scroll')); });
    return scroller;
  };

  it('holds the room below the rows, outside what is watched for growth, only while it is open', () => {
    const scroller = atTail(dock(false));
    expect(scroller.querySelector('.chat-viewport__room')).toBeNull();
    render(rows(), dock(true));
    expect(scroller.firstElementChild?.className).toBe('chat-viewport__content');
    expect(scroller.querySelector('.chat-viewport__room')?.parentElement).toBe(scroller);
    expect(container.querySelector('.chat-viewport')?.getAttribute('data-tail-room')).toBe('true');
  });

  it('leaves the tail where it is when the room opens and rows are only rebuilt: every snapshot rebuilds them', () => {
    const scroller = atTail(dock(false));
    render(rows(), dock(true));
    metrics(scroller, 1054);
    render(rows(), dock(true));
    expect(scroller.scrollTop, 'the room is the reader’s to scroll into, not the app’s').toBe(600);
  });

  it('follows a row that really arrives, past the room, so it clears what floats there', () => {
    const scroller = atTail(dock(true));
    metrics(scroller, 1200);
    render([...rows(), notice('c')], dock(true));
    expect(scroller.scrollTop).toBe(1200);
  });

  it('follows rebuilt rows as before where nothing floats', () => {
    const scroller = atTail();
    metrics(scroller, 1040);
    render(rows());
    expect(scroller.scrollTop).toBe(1040);
  });

  it('gives what floats there a place of its own, with or without room', () => {
    let anchor: HTMLElement | null = null;
    render(rows(), { anchorRef: (element) => { anchor = element; }, room: false });
    expect((anchor as HTMLElement | null)?.parentElement).toBe(container.querySelector('.chat-viewport'));
    expect((anchor as HTMLElement | null)?.closest('.chat-viewport__scroll')).toBeNull();
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
