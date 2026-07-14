// IME input regression (mobile duplication fix): the Android soft-keyboard
// path never delivers printable keydowns — everything arrives as keyCode 229
// plus mutations of xterm's hidden helper textarea, which xterm diffs against
// the PREVIOUS textarea value (CompositionHelper._handleAnyTextareaChanges).
// Because that textarea was only ever cleared on Enter/blur, committed text
// accumulated as stale "surrounding context"; the moment the keyboard rewrote
// any of it (Samsung autocorrect / prediction), the String.replace-based diff
// failed and xterm re-sent the ENTIRE accumulated buffer to the PTY — the
// "previous conversation multiplies while typing" bug reported on Z Fold 7.
//
// The fix (PtyBlock's IME hygiene) empties the helper textarea after every
// non-composing commit, so the keyboard never has stale context to rewrite.
// These specs drive the REAL xterm listeners with the same synthetic event
// sequences Android keyboards produce (keydown 229 + value mutation + input,
// and compositionstart/update/end), and read back exactly what bytes reached
// the PTY via the RX<"..."> framing of fixtures/ime-echo.js.
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchApp } from './launch-app';
import { readXtermBuffer } from './xterm-buffer';

const IME_ECHO_FIXTURE = path.resolve(__dirname, 'fixtures', 'ime-echo.js');

async function startImeEchoRun(window: Page): Promise<void> {
  await expect(window.getByRole('heading', { name: 'EZTerminal' })).toBeVisible();
  await window.getByTestId('cmd-input').fill(`node ${IME_ECHO_FIXTURE}`);
  await window.getByTestId('btn-run').click();
  await expect(window.getByTestId('pty-block')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => readXtermBuffer(window.getByTestId('pty-block')), { timeout: 15_000 })
    .toContain('IME-READY');
}

/** Current xterm viewport text — RX<"..."> lines land here. */
function screenText(window: Page): Promise<string> {
  return readXtermBuffer(window.getByTestId('pty-block'));
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Simulate an Android soft-keyboard COMMIT (no composition): keydown 229
 * followed by a mutation of the helper textarea and an `input` event — the
 * exact trace shape of xterm.js issue #3679. `op` models what the keyboard
 * does to the field it currently sees:
 *  - append:      insert `text` at the end (plain commitText)
 *  - autocorrect: rewrite a word ANYWHERE in the current field
 *                 (`from`→`to`), then append `text` — Samsung-style rewrite
 *                 of already-committed context.
 */
async function keyboardCommit(
  window: Page,
  op: { kind: 'append'; text: string } | { kind: 'autocorrect'; from: string; to: string; text: string },
): Promise<void> {
  await window.evaluate((o) => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!ta) throw new Error('xterm helper textarea not found');
    const kd = new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true });
    Object.defineProperty(kd, 'keyCode', { get: () => 229 });
    ta.dispatchEvent(kd);
    if (o.kind === 'append') {
      ta.value = ta.value + o.text;
    } else {
      ta.value = ta.value.replace(o.from, o.to) + o.text;
    }
    ta.dispatchEvent(
      new InputEvent('input', { inputType: 'insertText', data: o.kind === 'append' ? o.text : o.text || o.to, bubbles: true, composed: true }),
    );
  }, op);
}

/**
 * Simulate an IME composition session (Korean syllable assembly / suggestion
 * pick): compositionstart, then for each step a keydown 229 + textarea
 * mutation + compositionupdate, then compositionend. The composed text is
 * whatever the LAST step left in the field beyond the pre-composition value.
 */
async function imeCompose(window: Page, steps: string[]): Promise<void> {
  await window.evaluate((stepList) => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!ta) throw new Error('xterm helper textarea not found');
    const base = ta.value;
    ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const step of stepList) {
      const kd = new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true });
      Object.defineProperty(kd, 'keyCode', { get: () => 229 });
      ta.dispatchEvent(kd);
      ta.value = base + step;
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: step, bubbles: true }));
    }
    ta.dispatchEvent(
      new CompositionEvent('compositionend', { data: stepList[stepList.length - 1] ?? '', bubbles: true }),
    );
  }, steps);
}

function helperTextareaValue(window: Page): Promise<string> {
  return window.evaluate(
    () => document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.value ?? '<missing>',
  );
}

test('ime-input: a soft-keyboard commit reaches the PTY once and the helper textarea empties', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await startImeEchoRun(window);

  await keyboardCommit(window, { kind: 'append', text: 'hello wrld' });

  // The committed text reaches the PTY exactly once…
  await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('RX<"hello wrld">');
  expect(countOccurrences(await screenText(window), 'hello wrld')).toBe(1);

  // …and the helper textarea is emptied so the keyboard keeps NO stale
  // context to rewrite later (the root of the duplication bug).
  await expect.poll(() => helperTextareaValue(window), { timeout: 5_000 }).toBe('');

  await app.close();
});

test('ime-input: a keyboard rewrite of earlier text does not re-send it (duplication bug)', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await startImeEchoRun(window);

  // Commit a "pasted paragraph" the way the keyboard clipboard panel does —
  // as an IME commit into the helper textarea, NOT a ClipboardEvent paste.
  await keyboardCommit(window, { kind: 'append', text: 'prevconvo wrld tail' });
  await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('prevconvo');

  // Now the keyboard "fixes" a word it sees in the field and the user keeps
  // typing. Against stale context the old replace()-diff re-sent the ENTIRE
  // buffer (prevconvo appears twice); with hygiene the field is empty, the
  // rewrite finds nothing, and only the new keystroke goes out.
  await keyboardCommit(window, { kind: 'autocorrect', from: 'wrld', to: 'world', text: ' x' });

  await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('RX<" x">');
  expect(countOccurrences(await screenText(window), 'prevconvo')).toBe(1);

  await app.close();
});

test('ime-input: Korean composition commits exactly once and leaves no residue', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await startImeEchoRun(window);

  // ㅎ → 하 → 한 syllable assembly, then commit.
  await imeCompose(window, ['ㅎ', '하', '한']);

  await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('RX<"한">');
  expect(countOccurrences(await screenText(window), 'RX<"한">')).toBe(1);
  await expect.poll(() => helperTextareaValue(window), { timeout: 5_000 }).toBe('');

  // A second syllable after the reset still lands cleanly (start index 0).
  await imeCompose(window, ['ㄱ', '가']);
  await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('RX<"가">');
  expect(countOccurrences(await screenText(window), 'RX<"가">')).toBe(1);

  await app.close();
});

test('ime-input: picking a suggestion mid-composition sends exactly that word', async () => {
  const app = await launchApp();
  const window = await app.firstWindow();
  await startImeEchoRun(window);

  // Type "hell" composing, then tap the "hello " suggestion — the composition
  // is replaced wholesale and committed.
  await imeCompose(window, ['h', 'he', 'hel', 'hell', 'hello ']);

  await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('RX<"hello ">');
  expect(countOccurrences(await screenText(window), 'RX<"hello ">')).toBe(1);
  await expect.poll(() => helperTextareaValue(window), { timeout: 5_000 }).toBe('');

  await app.close();
});
