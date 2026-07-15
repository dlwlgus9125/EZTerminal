// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StoryReadyBoundary } from '../.storybook/preview';

let host: HTMLDivElement;
let root: Root;
let nextFrameId: number;
let frames: Map<number, FrameRequestCallback>;

async function flushReadiness(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });

  for (let frame = 0; frame < 2; frame += 1) {
    act(() => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback(performance.now());
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  nextFrameId = 1;
  frames = new Map();
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId;
    nextFrameId += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete document.documentElement.dataset.storyReady;
  vi.unstubAllGlobals();
});

describe('StoryReadyBoundary', () => {
  it('re-establishes readiness when story args rerender without changing the ready key', async () => {
    const readyKey = 'story-id|matrix|en|adaptive|100';
    act(() => root.render(createElement(
      StoryReadyBoundary,
      { readyKey },
      createElement('span', null, 'first render'),
    )));
    await flushReadiness();
    expect(document.documentElement.dataset.storyReady).toBe(readyKey);

    // Mirrors the decorator invalidating readiness before Storybook applies
    // updated args whose globals (and therefore readyKey) are unchanged.
    delete document.documentElement.dataset.storyReady;
    act(() => root.render(createElement(
      StoryReadyBoundary,
      { readyKey },
      createElement('span', null, 'updated args'),
    )));
    await flushReadiness();

    expect(document.documentElement.dataset.storyReady).toBe(readyKey);
  });
});
