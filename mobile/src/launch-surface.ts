import type { MobileWorkspaceRestore } from './workspace-restore';

/** Where the phone was last: the feed, a terminal or a conversation. */
export type LastSurface = 'feed' | 'terminal' | 'chat';

/** The shell roots the app can open on. */
export type LaunchSurface = 'feed' | 'terminal' | 'agents';

/** A record written before the feed existed (vc78) knows only its work destination. */
export function lastSurfaceOf(saved: Pick<MobileWorkspaceRestore, 'destination' | 'lastSurface'>): LastSurface {
  return saved.lastSurface ?? (saved.destination === 'agents' ? 'chat' : 'terminal');
}

/**
 * Where the app opens (I4): what waits on the person first, then the terminal or conversation they left if it is
 * still there, else the feed. A conversation being created is recovered before this rule runs.
 */
export function launchSurface(input: {
  readonly waiting: number;
  readonly last: LastSurface;
  readonly terminalRestored: boolean;
  readonly conversationExists: boolean;
}): LaunchSurface {
  if (input.waiting > 0) return 'feed';
  if (input.last === 'terminal' && input.terminalRestored) return 'terminal';
  if (input.last === 'chat' && input.conversationExists) return 'agents';
  return 'feed';
}
