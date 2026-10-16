import { createContext, type ComponentType, type ReactNode, type RefObject } from 'react';

export interface ConversationReviewOverlayProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement>;
}

/** The host owns modal navigation; conversation review owns its content/state. */
export const ConversationReviewOverlayContext = createContext<ComponentType<ConversationReviewOverlayProps> | null>(null);
