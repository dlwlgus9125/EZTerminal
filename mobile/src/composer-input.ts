// composer-input.ts — pure decision logic for the composer's `beforeinput`
// routing during a plain PTY run (mobile IME fix). Android soft keyboards
// deliver most non-composition commits (suggestion taps, the space that
// commits a word, keyboard clipboard-panel pastes) as `beforeinput` with
// keydown 229 ('Process'), which the keydown→keyToPtyBytes path can't route —
// without this they silently pile up in the input instead of reaching the
// PTY. Kept free of React/BlockController so it's directly unit-testable,
// same shape as paste-routing.ts's `resolvePasteTarget`.

/** The subset of a native `InputEvent` this decision needs — duck-typed so
 * tests can pass plain object literals. */
export interface BeforeInputLike {
  readonly isComposing: boolean;
  readonly inputType: string;
  readonly data: string | null;
  readonly dataTransfer?: { getData(format: string): string } | null;
}

/** Text this `beforeinput` should send to the PTY (the event must then be
 * preventDefault-ed), or `null` to leave the default input behavior alone —
 * composition text is hands-off (sent once, on compositionend), and so is
 * every mutating inputType other than a plain text/paste insertion. */
export function beforeInputTextForPty(ev: BeforeInputLike): string | null {
  if (ev.isComposing) return null;
  if (ev.inputType !== 'insertText' && ev.inputType !== 'insertFromPaste') return null;
  const text = ev.data ?? ev.dataTransfer?.getData('text/plain');
  return text ? text : null;
}
