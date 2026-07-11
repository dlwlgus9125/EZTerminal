// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { attachXtermImeHygiene, type ImeHygieneTerminal } from './xterm-ime-hygiene';

// A fake of the Terminal slice the hygiene reads (same duck-typing approach
// as pty-keys.test.ts): a real jsdom textarea (composition listeners attach to
// it) plus a manually-fired onData listener list.
function fakeTerm(): ImeHygieneTerminal & { fireData(data: string): void } {
  const textarea = document.createElement('textarea');
  const listeners = new Set<(data: string) => void>();
  return {
    textarea,
    onData(listener: (data: string) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fireData(data: string) {
      for (const listener of listeners) listener(data);
    },
  };
}

describe('attachXtermImeHygiene', () => {
  it('empties the helper textarea after a non-composing commit', () => {
    const term = fakeTerm();
    attachXtermImeHygiene(term);

    term.textarea!.value = 'hello wrld';
    term.fireData('hello wrld');

    expect(term.textarea!.value).toBe('');
  });

  it('leaves the textarea alone while a composition is active', () => {
    const term = fakeTerm();
    attachXtermImeHygiene(term);

    term.textarea!.dispatchEvent(new Event('compositionstart'));
    term.textarea!.value = '하';
    // e.g. an xterm auto-reply (DA/DSR) fires onData mid-composition — the
    // in-progress syllable must NOT be wiped out from under the IME.
    term.fireData('\x1b[?1;2c');

    expect(term.textarea!.value).toBe('하');
  });

  it('clears once the composition has ended and its data is sent', () => {
    const term = fakeTerm();
    attachXtermImeHygiene(term);

    term.textarea!.dispatchEvent(new Event('compositionstart'));
    term.textarea!.value = '한';
    term.textarea!.dispatchEvent(new Event('compositionend'));
    // CompositionHelper sends the composed text from a setTimeout AFTER
    // compositionend — by then composing is false and the clear applies.
    term.fireData('한');

    expect(term.textarea!.value).toBe('');
  });

  it('skips the clear when the NEXT composition already started (fast typing)', () => {
    const term = fakeTerm();
    attachXtermImeHygiene(term);

    term.textarea!.dispatchEvent(new Event('compositionstart'));
    term.textarea!.value = '한';
    term.textarea!.dispatchEvent(new Event('compositionend'));
    // Next syllable begins before the previous syllable's deferred send fires:
    term.textarea!.dispatchEvent(new Event('compositionstart'));
    term.textarea!.value = '한글';
    term.fireData('한');

    expect(term.textarea!.value).toBe('한글');
  });

  it('stops clearing after dispose', () => {
    const term = fakeTerm();
    const handle = attachXtermImeHygiene(term);
    handle.dispose();

    term.textarea!.value = 'left alone';
    term.fireData('x');

    expect(term.textarea!.value).toBe('left alone');
  });
});
