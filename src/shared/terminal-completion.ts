/**
 * Tab completion for the desktop terminal's command line. The interpreter that
 * owns the session's folder and environment answers; the line and caret go in,
 * the text to replace and the candidates come out. Desktop only: the phone's
 * bridge and the remote protocol do not carry it.
 */

export const TERMINAL_COMPLETION_MAX_LINE = 4_096;
export const TERMINAL_COMPLETION_MAX_CANDIDATES = 200;

export interface TerminalCompletionRequest {
  readonly sessionId: string;
  readonly line: string;
  /** Caret position in `line` (UTF-16 index); text after it is kept. */
  readonly caret: number;
}

export type TerminalCompletionKind = 'builtin' | 'executable' | 'directory' | 'file' | 'drive';

export interface TerminalCompletionCandidate {
  /** What the list shows (the entry's own name, a folder with its separator). */
  readonly label: string;
  readonly kind: TerminalCompletionKind;
  /** The text that replaces `[replaceStart, replaceEnd)` when this one is chosen (quoted when needed). */
  readonly insertText: string;
}

export type TerminalCompletionResult =
  | {
    readonly ok: true;
    readonly replaceStart: number;
    readonly replaceEnd: number;
    /** Longest text all candidates share, ready to insert; equals the typed word when nothing is shared beyond it. */
    readonly commonText: string;
    readonly candidates: readonly TerminalCompletionCandidate[];
    /** More matched than were returned. */
    readonly truncated: boolean;
  }
  | { readonly ok: false; readonly reason: 'none' | 'busy' | 'unavailable' };

export function isTerminalCompletionRequest(value: unknown): value is TerminalCompletionRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<TerminalCompletionRequest>;
  return typeof request.sessionId === 'string' && request.sessionId.length > 0 && request.sessionId.length <= 200
    && typeof request.line === 'string' && request.line.length <= TERMINAL_COMPLETION_MAX_LINE
    && typeof request.caret === 'number' && Number.isInteger(request.caret)
    && request.caret >= 0 && request.caret <= request.line.length;
}
