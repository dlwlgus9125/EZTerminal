// @vitest-environment jsdom

import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlockController } from './block-controller';

const blockRender = vi.hoisted(() => vi.fn(() => null));
vi.mock('./Block', () => ({ Block: blockRender }));

import { TerminalBlockEntries, type TerminalBlockEntry } from './TerminalBlockEntries';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES: readonly TerminalBlockEntry[] = [{
  id: 'run-1',
  controller: {} as BlockController,
}];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  blockRender.mockClear();
});

describe('TerminalBlockEntries', () => {
  it('keeps completed blocks out of command-draft renders', () => {
    function Harness(): JSX.Element {
      const [draft, setDraft] = useState('');
      const dismiss = useCallback(() => undefined, []);
      return (
        <>
          <input
            data-testid="draft"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <TerminalBlockEntries
            entries={ENTRIES}
            activeTakeoverController={null}
            pendingLabel="Starting"
            onDismiss={dismiss}
          />
        </>
      );
    }

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    expect(blockRender).toHaveBeenCalledTimes(1);

    const input = host.querySelector<HTMLInputElement>('[data-testid="draft"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(blockRender).toHaveBeenCalledTimes(1);
  });
});
