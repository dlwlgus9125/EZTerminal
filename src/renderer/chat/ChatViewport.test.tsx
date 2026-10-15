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
