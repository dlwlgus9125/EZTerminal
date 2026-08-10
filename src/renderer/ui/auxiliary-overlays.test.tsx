// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Menu, MenuItem, Popover } from './index';
import { isolateModalBackground } from './modal-isolation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let frame: HTMLIFrameElement;
let auxiliary: Window & typeof globalThis;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  auxiliary = frame.contentWindow! as Window & typeof globalThis;
  Object.defineProperty(auxiliary, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  container = auxiliary.document.createElement('div');
  auxiliary.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  frame.remove();
  vi.restoreAllMocks();
});

describe('auxiliary document overlay primitives', () => {
  it('isolates a main-realm background node adopted by the auxiliary document', () => {
    const adoptedBackground = document.createElement('div');
    auxiliary.document.body.appendChild(adoptedBackground);
    const modal = auxiliary.document.createElement('div');
    auxiliary.document.body.appendChild(modal);

    const release = isolateModalBackground(modal, [], auxiliary.document);
    expect(adoptedBackground.hasAttribute('inert')).toBe(true);
    expect(adoptedBackground.getAttribute('aria-hidden')).toBe('true');
    release();
    expect(adoptedBackground.hasAttribute('inert')).toBe(false);
    expect(adoptedBackground.hasAttribute('aria-hidden')).toBe(false);
  });

  it('handles Menu outside-pointer dismissal in its owning document', () => {
    act(() => root.render(
      <Menu trigger={<button type="button">Actions</button>} label="Panel actions">
        <MenuItem onSelect={vi.fn()}>Rename</MenuItem>
      </Menu>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    act(() => trigger.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    act(() => auxiliary.document.body.dispatchEvent(new auxiliary.MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
    })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it('handles Popover Escape and restores focus in its owning document', () => {
    act(() => root.render(
      <Popover trigger={<button type="button">Details</button>} ariaLabel="Details" initialFocus>
        <button type="button">Copy</button>
      </Popover>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    act(() => trigger.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => auxiliary.document.dispatchEvent(new auxiliary.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(auxiliary.document.activeElement).toBe(trigger);
  });
});
