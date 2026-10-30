import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONVERSATION_VIEWING_HEARTBEAT_MS } from '../shared/conversation-viewing';
import { CONVERSATION_VIEWING_DEBOUNCE_MS, createConversationViewingReporter } from './conversation-viewing';

describe('conversation viewing reporter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function reporter() {
    const sent: (readonly string[])[] = [];
    return { sent, instance: createConversationViewingReporter((sessionIds) => sent.push(sessionIds)) };
  }

  it('reports once at the start even with nothing on screen, so the host knows this window answers', () => {
    const { instance, sent } = reporter();
    const stop = instance.start();
    expect(sent).toEqual([[]]);
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 3);
    expect(sent).toEqual([[]]);
    stop();
  });

  it('reports a change once after the debounce, across quick changes', () => {
    const { instance, sent } = reporter();
    const stop = instance.start();
    instance.set('panel-1', 'session-1');
    instance.set('panel-1', null);
    instance.set('panel-2', 'session-2');
    vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS - 1);
    expect(sent).toEqual([[]]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([[], ['session-2']]);
    stop();
  });

  it('counts split panes, a popout among them, and one conversation shown twice once', () => {
    const { instance, sent } = reporter();
    const stop = instance.start();
    instance.set('panel-1', 'session-1');
    instance.set('panel-2', 'session-2');
    instance.set('panel-3', 'session-1');
    vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS);
    expect(sent.at(-1)).toEqual(['session-1', 'session-2']);
    stop();
  });

  it('sends nothing when the set did not change', () => {
    const { instance, sent } = reporter();
    const stop = instance.start();
    instance.set('panel-1', 'session-1');
    vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS);
    const count = sent.length;
    instance.set('panel-1', null);
    instance.set('panel-1', 'session-1');
    vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS);
    expect(sent).toHaveLength(count);
    stop();
  });

  it('resends while the set is not empty, and stops once it is', () => {
    const { instance, sent } = reporter();
    const stop = instance.start();
    instance.set('panel-1', 'session-1');
    vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS);
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(sent.filter((ids) => ids.length === 1)).toHaveLength(3);
    instance.set('panel-1', null);
    vi.advanceTimersByTime(CONVERSATION_VIEWING_DEBOUNCE_MS);
    expect(sent.at(-1)).toEqual([]);
    const count = sent.length;
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(sent).toHaveLength(count);
    stop();
  });

  it('leaves no timer after it stops', () => {
    const { instance, sent } = reporter();
    const stop = instance.start();
    instance.set('panel-1', 'session-1');
    stop();
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(sent).toEqual([[]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
