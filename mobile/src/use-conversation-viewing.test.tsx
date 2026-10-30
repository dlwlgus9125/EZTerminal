import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { CONVERSATION_VIEWING_HEARTBEAT_MS } from '../../src/shared/conversation-viewing';
import { useConversationViewing } from './use-conversation-viewing';

type Report = (sessionIds: readonly string[]) => void;
type Client = { readonly reportConversationViewing: Mock<Report> };

function Harness({ client, sessionId, visible }: { readonly client: Client | undefined; readonly sessionId: string | null; readonly visible: boolean }): null {
  useConversationViewing(client, sessionId, visible);
  return null;
}

describe('useConversationViewing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const transport = (): Client => ({ reportConversationViewing: vi.fn<Report>() });

  function render(client: Client | undefined, sessionId: string | null, visible: boolean) {
    const root = createRoot(document.createElement('div'));
    const update = (next: string | null, nextVisible: boolean): void => {
      act(() => root.render(<Harness client={client} sessionId={next} visible={nextVisible} />));
    };
    update(sessionId, visible);
    return { update, unmount: () => act(() => root.unmount()) };
  }

  it('reports the open conversation while the app is in front, and resends it', () => {
    const client = transport();
    const view = render(client, 'session-1', true);
    expect(client.reportConversationViewing.mock.calls).toEqual([[['session-1']]]);
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(client.reportConversationViewing).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('reports nothing open when no conversation is, with no resend', () => {
    const client = transport();
    const view = render(client, null, true);
    expect(client.reportConversationViewing.mock.calls).toEqual([[[]]]);
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(client.reportConversationViewing).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('stops at once when the app goes to the back or another conversation opens', () => {
    const client = transport();
    const view = render(client, 'session-1', true);
    view.update('session-1', false);
    expect(client.reportConversationViewing).toHaveBeenLastCalledWith([]);
    client.reportConversationViewing.mockClear();
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(client.reportConversationViewing).not.toHaveBeenCalled();
    view.update('session-2', true);
    expect(client.reportConversationViewing).toHaveBeenLastCalledWith(['session-2']);
    view.unmount();
  });

  it('says nothing is open when the view goes away (the agents tab closed)', () => {
    const client = transport();
    const view = render(client, 'session-1', true);
    view.unmount();
    expect(client.reportConversationViewing).toHaveBeenLastCalledWith([]);
    client.reportConversationViewing.mockClear();
    vi.advanceTimersByTime(CONVERSATION_VIEWING_HEARTBEAT_MS * 2);
    expect(client.reportConversationViewing).not.toHaveBeenCalled();
  });

  it('does nothing without a transport', () => {
    expect(() => render(undefined, 'session-1', true).unmount()).not.toThrow();
  });
});
