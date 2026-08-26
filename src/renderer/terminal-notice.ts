export type TerminalNoticeKind =
  | 'clipboard-empty'
  | 'clipboard-no-text'
  | 'clipboard-read-failed'
  | 'clipboard-write-succeeded'
  | 'clipboard-write-failed'
  | 'codex-interrupt-help';

export interface TerminalNoticeRuntime {
  readonly notifyTerminal?: (notice: TerminalNoticeKind, ownerDocument?: Document) => void;
}
