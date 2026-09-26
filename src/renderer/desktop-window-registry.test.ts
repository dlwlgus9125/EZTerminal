// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveAppDocument,
  registerAuxiliaryWindow,
} from './desktop-window-registry';
import { applyEffects } from './effects';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  applyEffects(new Set());
  vi.restoreAllMocks();
});

describe('desktop window registry', () => {
  it('mirrors the separate flicker layer into popouts and removes it on toggle off', async () => {
    applyEffects(new Set(['flicker']));
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    cleanups.push(() => frame.remove());
    const auxiliary = frame.contentWindow!;
    cleanups.push(registerAuxiliaryWindow(auxiliary));
    expect(auxiliary.document.getElementById('ez-fx-flicker')?.parentElement).toBe(auxiliary.document.body);
    applyEffects(new Set());
    await Promise.resolve();
    expect(auxiliary.document.getElementById('ez-fx-flicker')).toBeNull();
  });
  it('prefers the last focused auxiliary document when both documents report focus', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    cleanups.push(() => frame.remove());
    const auxiliary = frame.contentWindow!;
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(auxiliary.document, 'hasFocus').mockReturnValue(true);
    const unregister = registerAuxiliaryWindow(auxiliary);
    cleanups.push(unregister);

    const focusEvent = auxiliary.document.createEvent('Event');
    focusEvent.initEvent('focus', false, false);
    auxiliary.dispatchEvent(focusEvent);

    expect(getActiveAppDocument()).toBe(auxiliary.document);
  });
});
