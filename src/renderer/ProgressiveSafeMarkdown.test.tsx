// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProgressiveSafeMarkdown } from './ProgressiveSafeMarkdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
});

describe('ProgressiveSafeMarkdown', () => {
  it('defers both the first large payload and a later streamed replacement', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const first = `# first\n\n${'a'.repeat(4_096)}`;
    const second = `# second\n\n${'b'.repeat(4_096)}`;

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ProgressiveSafeMarkdown markdown={first} priority={1} />));
    expect(host.querySelector('[data-markdown-pending="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain('first');

    act(() => frames.shift()?.(performance.now()));
    expect(host.textContent).toContain('first');

    act(() => root!.render(<ProgressiveSafeMarkdown markdown={second} priority={2} />));
    expect(host.querySelector('[data-markdown-pending="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain('second');

    act(() => frames.shift()?.(performance.now()));
    expect(host.textContent).toContain('second');
  });
});
