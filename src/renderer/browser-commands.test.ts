import { describe, expect, it, vi } from 'vitest';

import type { BrowserPickedElement } from '../shared/browser';
import { browserPicked } from './browser-commands';

const PICKED: BrowserPickedElement = { conversationId: 'chat', url: 'http://localhost:5173/cart', selector: 'button.pay', role: 'button', name: 'Pay now', imageBase64: '/9j/4AAQ' };

describe('browserPicked', () => {
  it('listens to this conversation, and hands an element over as the composer takes it', () => {
    let hear: (picked: BrowserPickedElement) => void = () => undefined;
    const stop = vi.fn();
    const onPicked = vi.fn((_sessionId: string, listener: (picked: BrowserPickedElement) => void) => { hear = listener; return stop; });
    const deliver = vi.fn();
    const unsubscribe = browserPicked('chat', { onPicked })(deliver);
    expect(onPicked).toHaveBeenCalledWith('chat', expect.any(Function));
    hear(PICKED);
    const [attachments] = deliver.mock.calls[0]! as [readonly { readonly id: string; readonly kind: string }[]];
    expect(attachments.map((attachment) => attachment.kind)).toEqual(['image', 'text']);
    expect(new Set(attachments.map((attachment) => attachment.id)).size).toBe(2);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
