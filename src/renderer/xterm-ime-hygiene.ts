// xterm-ime-hygiene.ts — soft-keyboard input-duplication fix (mobile IME).
//
// xterm keeps everything an IME commits in its hidden helper textarea and only
// clears it on Enter/^C or blur (CoreBrowserTerminal). Soft keyboards (Samsung
// keyboard, Gboard) treat that value as the field's "surrounding text" and
// freely REWRITE it — autocorrect, prediction, backspace-recompose. xterm's
// CompositionHelper diffs the new value against the old with String.replace
// and absolute indices (_handleAnyTextareaChanges), so any rewrite that is not
// a pure append makes the diff fail and the ENTIRE accumulated buffer is
// re-sent to the PTY: pasted text and previous keystrokes multiply while
// typing (observed on Z Fold 7 + Samsung keyboard; e2e/ime-input.spec.ts
// reproduces the exact event trace).
//
// The structural fix: empty the textarea after every commit xterm turns into
// onData, so the keyboard never has stale context to rewrite — diffs then
// always start from an empty field. Emptying is skipped while a composition is
// active: programmatically mutating the value mid-composition would abort the
// IME's syllable assembly (Korean jamo). CompositionHelper sends composed text
// from a setTimeout AFTER compositionend, so for a finished composition the
// flag is already false when onData fires; if the NEXT composition has already
// started (fast typing), the clear is skipped and the following quiet commit
// picks it up — CompositionHelper's index math stays consistent either way
// because compositionstart re-reads value.length.

import type { Terminal } from '@xterm/xterm';

export interface ImeHygieneHandle {
  dispose(): void;
}

/** The slice of `Terminal` this needs — duck-typed so unit tests can pass a
 * plain object with a jsdom textarea instead of opening a real terminal. */
export interface ImeHygieneTerminal {
  readonly textarea: HTMLTextAreaElement | undefined;
  onData(listener: (data: string) => void): { dispose(): void };
}

export function attachXtermImeHygiene(term: ImeHygieneTerminal | Terminal): ImeHygieneHandle {
  let composing = false;
  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
  };

  // `term.textarea` exists once the terminal has been open()ed — PtyBlock
  // attaches right after. Guarded anyway so a not-yet-open terminal degrades
  // to a no-op instead of throwing.
  const textarea = term.textarea;
  textarea?.addEventListener('compositionstart', onCompositionStart);
  textarea?.addEventListener('compositionend', onCompositionEnd);

  const dataListener = term.onData(() => {
    if (composing) return;
    const ta = term.textarea;
    if (ta && ta.value.length > 0) ta.value = '';
  });

  return {
    dispose(): void {
      dataListener.dispose();
      textarea?.removeEventListener('compositionstart', onCompositionStart);
      textarea?.removeEventListener('compositionend', onCompositionEnd);
    },
  };
}
