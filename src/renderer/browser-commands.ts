import { browserElementAttachments } from '../shared/browser';
import type { BrowserPaneAccess } from './capability-access';
import type { ChatBrowserProp } from './chat/ChatContext';

/**
 * The in-app browser as a conversation uses it (`in-app-browser-v1`), on the desktop only: a phone reads the rows and nothing
 * here reaches it. The rows themselves come from the transcript, with no host help.
 */

export interface BrowserHostInput {
  readonly sessionId: string;
  readonly pane: Pick<BrowserPaneAccess, 'onPicked'>;
}

export function browserHost({ sessionId, pane }: BrowserHostInput): ChatBrowserProp {
  return {
    onPicked: (deliver) => pane.onPicked(sessionId, (picked) => deliver(browserElementAttachments(picked, () => crypto.randomUUID()))),
  };
}
