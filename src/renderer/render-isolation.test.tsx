// @vitest-environment jsdom

import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentResumeComposer } from './AgentResumeComposer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('composer render isolation', () => {
  it('does not re-render a transcript sibling while the resume prompt changes', () => {
    const transcriptRender = vi.fn(() => <div data-testid="heavy-transcript" />);

    function Harness(): JSX.Element {
      const [preparing] = useState(false);
      const submit = useCallback(() => undefined, []);
      return (
        <>
          {transcriptRender()}
          <AgentResumeComposer variant="desktop" preparing={preparing} onSubmit={submit} />
        </>
      );
    }

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
    expect(transcriptRender).toHaveBeenCalledTimes(1);

    setInput(host.querySelector<HTMLInputElement>('[data-testid="cmd-input"]')!, 'continue here');
    expect(transcriptRender).toHaveBeenCalledTimes(1);
  });
});
