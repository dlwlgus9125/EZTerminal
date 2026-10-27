import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ConversationChangeReview } from '../../src/renderer/ConversationChangeReview';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import { MobileConversationReviewProvider } from './MobileConversationReviewProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('closes review on Android history Back while retaining the conversation and restoring focus', async () => {
  window.history.replaceState({}, '');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<MobileNavigationHistoryProvider><MobileConversationReviewProvider>
      <textarea data-testid="draft" defaultValue="Keep this draft" />
      <ConversationChangeReview sessionId="native-review-back" items={[]} wide={false} mobile />
    </MobileConversationReviewProvider></MobileNavigationHistoryProvider>));
    const trigger = host.querySelector<HTMLButtonElement>('.conversation-review__trigger')!;
    trigger.focus();
    act(() => trigger.click());
    expect(host.querySelector('[data-testid="mobile-conversation-review-sheet"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="draft"]')?.getAttribute('aria-hidden')).toBe('true');
    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(host.querySelector('[data-testid="mobile-conversation-review-sheet"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')?.value).toBe('Keep this draft');
    expect(host.querySelector('[data-testid="draft"]')?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.activeElement).toBe(trigger);
  } finally {
    act(() => root.unmount()); host.remove(); window.history.replaceState({}, '');
  }
});

it('gives focus back to the host button when the host opens the review itself (the one-row header)', async () => {
  window.history.replaceState({}, '');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const headerButton = { current: null as HTMLButtonElement | null };
  const view = (request: number): JSX.Element => (
    <MobileNavigationHistoryProvider><MobileConversationReviewProvider>
      <button type="button" ref={headerButton} data-testid="header-review">Changed files</button>
      <ConversationChangeReview sessionId="native-review-host" items={[]} wide={false} mobile hideTrigger openRequest={request}
        returnFocusRef={headerButton as React.RefObject<HTMLButtonElement>} />
    </MobileConversationReviewProvider></MobileNavigationHistoryProvider>
  );
  try {
    act(() => root.render(view(0)));
    expect(host.querySelector('.conversation-review__trigger')).toBeNull();
    headerButton.current!.focus();
    act(() => root.render(view(1)));
    expect(host.querySelector('[data-testid="mobile-conversation-review-sheet"]')).not.toBeNull();
    act(() => {
      window.history.replaceState({}, '');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    });
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(host.querySelector('[data-testid="mobile-conversation-review-sheet"]')).toBeNull();
    expect(document.activeElement).toBe(headerButton.current);
  } finally {
    act(() => root.unmount()); host.remove(); window.history.replaceState({}, '');
  }
});
