import type { ReactNode } from 'react';
import { ConversationReviewOverlayContext, type ConversationReviewOverlayProps } from '../../src/renderer/conversation-review-overlay';
import { MobileActionSheet } from './MobileActionSheet';

function MobileReviewSheet(props: ConversationReviewOverlayProps): JSX.Element {
  return <MobileActionSheet {...props} testId="mobile-conversation-review-sheet" />;
}

export function MobileConversationReviewProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  return <ConversationReviewOverlayContext.Provider value={MobileReviewSheet}>{children}</ConversationReviewOverlayContext.Provider>;
}
