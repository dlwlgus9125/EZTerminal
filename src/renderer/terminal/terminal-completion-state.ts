import type { TerminalCompletionCandidate, TerminalCompletionResult } from '../../shared/terminal-completion';

/**
 * Tab completion on the prompt line, as plain state: what an answer does to
 * the line, and the candidate list the person moves through. Pure, so the
 * pane and its tests read one rule.
 */

export interface CompletionList {
  readonly candidates: readonly TerminalCompletionCandidate[];
  readonly active: number;
  readonly replaceStart: number;
  /** The end of the text a chosen candidate replaces (the end of the shared part that went in). */
  readonly replaceEnd: number;
  readonly truncated: boolean;
}

export interface LineEdit {
  readonly line: string;
  readonly caret: number;
}

/** Whether Tab should complete: idle shell, no modifier, and a word right before the caret. */
export function wantsCompletion(line: string, caret: number): boolean {
  if (caret <= 0 || caret > line.length) return false;
  return !/\s/u.test(line[caret - 1]!);
}

/** `caretBack`: the caret stops that many characters before the end of `text` (inside a closing quote). */
function replace(line: string, start: number, end: number, text: string, caretBack = 0): LineEdit {
  return { line: `${line.slice(0, start)}${text}${line.slice(end)}`, caret: start + text.length - caretBack };
}

/**
 * Apply an answer to the line it was asked for. One candidate fills in; several
 * fill their shared part and open the list. A stale answer (the line or caret
 * moved since) or no match changes nothing.
 */
export function applyCompletion(
  asked: LineEdit,
  current: LineEdit,
  result: TerminalCompletionResult,
): { readonly edit: LineEdit | null; readonly list: CompletionList | null } {
  if (asked.line !== current.line || asked.caret !== current.caret || !result.ok) return { edit: null, list: null };
  if (result.candidates.length === 1) {
    const only = result.candidates[0]!;
    return { edit: replace(current.line, result.replaceStart, result.replaceEnd, only.insertText, only.caretBack), list: null };
  }
  const typed = current.line.slice(result.replaceStart, result.replaceEnd);
  const edit = result.commonText !== typed
    ? replace(current.line, result.replaceStart, result.replaceEnd, result.commonText, result.commonCaretBack)
    : null;
  return {
    edit,
    list: {
      candidates: result.candidates,
      active: 0,
      replaceStart: result.replaceStart,
      // A chosen candidate replaces the whole shared part, its closing quote included.
      replaceEnd: edit ? result.replaceStart + result.commonText.length : result.replaceEnd,
      truncated: result.truncated,
    },
  };
}

/** Choose a candidate from the open list. */
export function chooseCandidate(line: string, list: CompletionList, index = list.active): LineEdit | null {
  const candidate = list.candidates[index];
  return candidate ? replace(line, list.replaceStart, list.replaceEnd, candidate.insertText, candidate.caretBack) : null;
}

/** Move the list's active candidate, wrapping around. */
export function moveActive(list: CompletionList, step: 1 | -1): CompletionList {
  const count = list.candidates.length;
  return count === 0 ? list : { ...list, active: (list.active + step + count) % count };
}
