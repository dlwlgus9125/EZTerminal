import type { IpcMainEvent, WebContents } from 'electron';

import {
  CONVERSATION_VIEWING_TTL_MS,
  isViewedSessionIds,
  MAX_DESKTOP_VIEWED_CONVERSATIONS,
  type ConversationViewingStatus,
} from '../shared/conversation-viewing';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface ViewingClaim {
  readonly sessionIds: ReadonlySet<string>;
  readonly at: number;
}

/**
 * What every client has on screen, in memory only. An old phone never reports, so it does not count as a
 * viewer: one idle in a pocket would otherwise silence every recap.
 */
export class ConversationViewers {
  private readonly claims = new Map<string, ViewingClaim>();
  private readonly now: () => number;

  constructor(private readonly options: {
    /** The app windows open now that should report: a window that has not is why a status is `unknown`. */
    readonly windows: () => readonly string[];
    readonly now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
  }

  report(clientKey: string, sessionIds: readonly string[]): void {
    this.claims.set(clientKey, { sessionIds: new Set(sessionIds), at: this.now() });
  }

  drop(clientKey: string): void {
    this.claims.delete(clientKey);
  }

  status(sessionId: string): ConversationViewingStatus {
    const now = this.now();
    for (const claim of this.claims.values()) {
      if (claim.sessionIds.has(sessionId) && now - claim.at < CONVERSATION_VIEWING_TTL_MS) return 'viewed';
    }
    return this.options.windows().some((client) => !this.claims.has(client)) ? 'unknown' : 'unviewed';
  }
}

export const desktopViewingClient = (webContentsId: number): string => `desktop:${String(webContentsId)}`;

/** `conversation-viewing:report` (send), for app windows only. A window that goes away takes its claim with it. */
export function installConversationViewingIpc(input: {
  readonly ipc: FeatureIpc;
  readonly viewers: Pick<ConversationViewers, 'report' | 'drop'>;
  /** The desktop person behind an EZTerminal window's session surface, or null for any other sender. */
  readonly principal: (event: IpcMainEvent, clientId: unknown) => string | null;
}): () => void {
  const ipc = new IpcRegistration(input.ipc);
  const wired = new WeakSet<WebContents>();
  const wire = (sender: WebContents, clientKey: string): void => {
    if (wired.has(sender)) return;
    wired.add(sender);
    const release = (): void => input.viewers.drop(clientKey);
    sender.on('destroyed', release);
    sender.on('render-process-gone', release);
    sender.on('did-navigate', release);
  };
  ipc.on('conversation-viewing:report', (event: IpcMainEvent, clientId: unknown, sessionIds: unknown) => {
    if (!input.principal(event, clientId) || !isViewedSessionIds(sessionIds, MAX_DESKTOP_VIEWED_CONVERSATIONS)) return;
    const clientKey = desktopViewingClient(event.sender.id);
    wire(event.sender, clientKey);
    input.viewers.report(clientKey, sessionIds);
  });
  return ipc.dispose;
}
