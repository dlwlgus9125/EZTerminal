/**
 * Traceability from production navigation destinations to deterministic
 * Storybook evidence. This is not a second IA definition: tests compare these
 * keys with the runtime registries exported by ActivityRail and MobileWorkspace. A new destination therefore needs evidence in the same
 * change that makes it reachable.
 */

export interface DesignSurfaceEvidence {
  readonly storyId: string;
  readonly readySelector: string;
}

export const DESKTOP_DESTINATION_STORIES = {
  agents: { storyId: 'compositions-desktop-handoff--workbench-agent-hub', readySelector: '[data-testid="agent-hub"]' },
  monitor: { storyId: 'compositions-desktop-handoff--monitor', readySelector: '[data-testid="status-panel"]' },
  remote: { storyId: 'compositions-desktop-handoff--remote', readySelector: '[data-testid="remote-topology"]' },
  explorer: { storyId: 'compositions-desktop-handoff--explorer-breadcrumb', readySelector: '[data-testid="file-list"]' },
  openclaw: { storyId: 'compositions-desktop-handoff--openclaw-console', readySelector: '[data-testid="openclaw-panel"]' },
  settings: { storyId: 'compositions-desktop-handoff--settings', readySelector: '[data-testid="settings-panel"]' },
} as const satisfies Readonly<Record<string, DesignSurfaceEvidence>>;
/** I4 layout A: the feed is the root; the terminal, a project and the conversations open from it. */
export const MOBILE_PRIMARY_STORIES = {
  feed: { storyId: 'production-phone-phone-screens--feed-reference', readySelector: '[data-testid="mobile-feed"]' },
  terminal: { storyId: 'compositions-mobile-workbench-shell--terminal-english', readySelector: '[data-testid="mobile-workspace"]' },
  home: { storyId: 'workbench-mobile-v2--projects', readySelector: '[data-testid="mobile-projects-navigator"]' },
  agents: { storyId: 'workbench-mobile-v2--conversations', readySelector: '[data-testid="mobile-daemon-navigator"]' },
} as const satisfies Readonly<Record<string, DesignSurfaceEvidence>>;

export const MOBILE_SUB_PAGE_STORIES = {
  files: { storyId: 'compositions-mobile-active-surfaces--files', readySelector: '[data-testid="mobile-file-view"]' },
  stats: { storyId: 'compositions-mobile-active-surfaces--stats', readySelector: '[data-testid="mobile-stats-view"]' },
  openclaw: { storyId: 'compositions-mobile-active-surfaces--open-claw', readySelector: '[data-testid="mobile-openclaw-view"]' },
  settings: { storyId: 'compositions-mobile-workbench-shell--settings-page-english', readySelector: '[data-testid="mobile-settings-view"]' },
  'pc-control': { storyId: 'compositions-mobile-active-surfaces--pc-control-unavailable', readySelector: '[data-testid="mobile-pc-control"]' },
  sessions: { storyId: 'compositions-mobile-active-surfaces--sessions-sheet', readySelector: '[data-testid="mobile-session-sheet"]' },
} as const satisfies Readonly<Record<string, DesignSurfaceEvidence>>;

export const MOBILE_SHEET_STORIES = {
  sessions: MOBILE_SUB_PAGE_STORIES.sessions,
} as const satisfies Readonly<Record<string, DesignSurfaceEvidence>>;

export const MOBILE_AUXILIARY_STORIES = {
  connect: { storyId: 'compositions-mobile-workbench-shell--connect-english', readySelector: '[data-testid="connect-screen"]' },
  theme: { storyId: 'compositions-mobile-active-surfaces--theme-sheet', readySelector: '[data-testid="theme-menu"]' },
  scanner: { storyId: 'compositions-mobile-active-surfaces--pairing-scanner-unavailable', readySelector: '[data-testid="pairing-scanner"]' },
  'agent-history': { storyId: 'compositions-mobile-active-surfaces--agent-history-error', readySelector: '[data-testid="mobile-agent-history"]' },
  'agent-folder-picker': { storyId: 'compositions-mobile-active-surfaces--agent-folder-picker', readySelector: '[data-testid="mobile-agent-folder-picker"]' },
  dialog: { storyId: 'primitives-dialogs-and-panels--dialog-open', readySelector: '[role="dialog"]' },
  toast: { storyId: 'primitives-feedback--toast-variants', readySelector: '[role="status"]' },
  offline: { storyId: 'compositions-mobile-active-surfaces--agents-offline', readySelector: '[data-testid="mobile-agent-view"]' },
} as const satisfies Readonly<Record<string, DesignSurfaceEvidence>>;
