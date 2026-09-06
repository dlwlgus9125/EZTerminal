export type MobileWorkspaceTerminalFailureReason =
  | 'authority-refresh-failed'
  | 'authority-unavailable'
  | 'workspace-unavailable'
  | 'workspace-root-unavailable'
  | 'surface-open-failed';

export type MobileWorkspaceTerminalResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: MobileWorkspaceTerminalFailureReason;
    };
