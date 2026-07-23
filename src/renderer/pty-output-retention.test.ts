// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  BatchedPlainOutputDomRetention,
  PlainOutputDomRetention,
  PTY_PLAIN_DOM_BATCH_CHARS,
  PTY_PLAIN_DOM_MAX_LATENCY_MS,
  PtyReplayBuffer,
  prunePlainOutputDom,
} from './pty-output-retention';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function retainedText(buffer: PtyReplayBuffer): string {
  return buffer.snapshot().map((chunk) => decoder.decode(chunk.bytes)).join('');
}

describe('PtyReplayBuffer', () => {
  it('retains only the configured number of recent lines', () => {
    const buffer = new PtyReplayBuffer();
    buffer.append(
      {
        bytes: encoder.encode('one\ntwo\nthree\nfour'),
        suppressSideEffects: false,
        alreadyConsumed: true,
      },
      { maxLines: 3, maxBytes: 1_024 },
    );

    expect(retainedText(buffer)).toBe('two\nthree\nfour');
    expect(buffer.diagnostics()).toMatchObject({ lineBreaks: 2 });
  });

  it('bounds a newline-free stream and starts on a valid UTF-8 boundary', () => {
    const buffer = new PtyReplayBuffer();
    buffer.append(
      {
        bytes: encoder.encode(`prefix-${'한'.repeat(40)}`),
        suppressSideEffects: true,
        alreadyConsumed: true,
      },
      { maxLines: 100, maxBytes: 31 },
    );

    expect(buffer.diagnostics().bytes).toBeLessThanOrEqual(31);
    expect(retainedText(buffer)).not.toContain('\ufffd');
    expect(retainedText(buffer)).toMatch(/^한+$/);
  });

  it('does not interpret UTF-8 continuation bytes as 8-bit C1 controls', () => {
    const buffer = new PtyReplayBuffer();
    buffer.append(
      {
        // U+AC1B encodes as EA B0 9B. The final continuation byte must not be
        // mistaken for the single-byte CSI control used by non-UTF-8 terminals.
        bytes: encoder.encode(`discard-${'\uac1b'.repeat(20)}-SAFE`),
        suppressSideEffects: false,
        alreadyConsumed: true,
      },
      { maxLines: 100, maxBytes: 20 },
    );

    expect(retainedText(buffer)).toBe(`${'\uac1b'.repeat(5)}-SAFE`);
  });

  it('preserves replay metadata and releases all retained references on drain', () => {
    const buffer = new PtyReplayBuffer();
    buffer.append({
      bytes: encoder.encode('abc'),
      suppressSideEffects: true,
      alreadyConsumed: false,
    });

    expect(buffer.drain()).toEqual([
      expect.objectContaining({
        suppressSideEffects: true,
        alreadyConsumed: false,
      }),
    ]);
    expect(buffer.diagnostics()).toEqual({ bytes: 0, lineBreaks: 0, chunks: 0 });
  });

  it('never trims replay into the middle of a split OSC control sequence', () => {
    const buffer = new PtyReplayBuffer();
    const chunk = (text: string) => ({
      bytes: encoder.encode(text),
      suppressSideEffects: false,
      alreadyConsumed: true,
    });
    buffer.append(chunk('\x1b]0;old\n'), { maxLines: 10, maxBytes: 1_024 });
    buffer.append(chunk('title\x07safe'), { maxLines: 1, maxBytes: 1_024 });

    expect(retainedText(buffer)).toBe('safe');
  });

  it('drops an unterminated control suffix instead of replaying a CSI fragment', () => {
    const buffer = new PtyReplayBuffer();
    buffer.append({
      bytes: encoder.encode(`${'x'.repeat(70_000)}\x1b[38;5;196`),
      suppressSideEffects: false,
      alreadyConsumed: true,
    }, { maxLines: 100, maxBytes: 1 });

    expect(retainedText(buffer)).toBe('');
  });

  it('never cuts into an SOS string and activates controls from its ignored payload', () => {
    const buffer = new PtyReplayBuffer();
    const innerClipboardOsc = '\x1b]52;c;ignored-payload\x07';
    const source = [
      'A'.repeat(100),
      '\x1bX',
      'i'.repeat(100),
      innerClipboardOsc,
      'tail',
      '\x1b\\',
      'SAFE',
    ].join('');
    const bytes = encoder.encode(source);

    buffer.append({
      bytes,
      suppressSideEffects: false,
      alreadyConsumed: true,
    }, { maxLines: 100, maxBytes: bytes.byteLength - 120 });

    expect(retainedText(buffer)).toBe('SAFE');
    expect(retainedText(buffer)).not.toContain(innerClipboardOsc);
  });

  it('bounds a sustained newline-free stream with linear historical trimming work', () => {
    const buffer = new PtyReplayBuffer();
    const chunk = {
      bytes: new Uint8Array(64 * 1024).fill(0x61),
      suppressSideEffects: false,
      alreadyConsumed: true,
    };
    // Odd count catches a one-chunk trim slack that would retain 8 MiB + 64 KiB.
    const appendCount = 257;

    for (let index = 0; index < appendCount; index += 1) {
      buffer.append(chunk, { maxLines: 5_000, maxBytes: 8 * 1024 * 1024 });
    }

    expect(buffer.diagnostics().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const totalInputBytes = chunk.bytes.byteLength * appendCount;
    const { trimBytesInspected } = buffer.workDiagnostics();
    expect(trimBytesInspected).toBeGreaterThan(0);
    // The newline-free fast path scans only the prefix it actually removes.
    // Reintroducing a full-history newline search on every trim makes this
    // hundreds of MiB and violates the bound independent of host/CI load.
    expect(trimBytesInspected).toBeLessThanOrEqual(totalInputBytes);
  });
});

describe('prunePlainOutputDom', () => {
  it('deletes old text while preserving ANSI markup around the retained suffix', () => {
    const output = document.createElement('pre');
    output.innerHTML = '<span class="old">one\ntwo\n</span><b>three\nfour</b>';
    const createRange = vi.spyOn(output.ownerDocument, 'createRange');

    prunePlainOutputDom(output, 2, 1_024);

    expect(output.textContent).toBe('three\nfour');
    expect(output.querySelector('b')?.textContent).toBe('three\nfour');
    expect(output.querySelector('.old')).toBeNull();
    expect(createRange).toHaveBeenCalledOnce();
    createRange.mockRestore();
  });

  it('falls back for a mixed Text/ANSI prefix and preserves a retained selection', () => {
    const output = document.createElement('pre');
    const oldText = document.createTextNode('old\n');
    const styled = document.createElement('span');
    styled.className = 'styled';
    styled.textContent = 'styled\n';
    const retained = document.createTextNode('keep');
    output.append(oldText, styled, retained);
    document.body.append(output);
    const selection = window.getSelection();
    const selected = document.createRange();
    selected.selectNodeContents(retained);
    selection?.removeAllRanges();
    selection?.addRange(selected);
    const createRange = vi.spyOn(output.ownerDocument, 'createRange');

    prunePlainOutputDom(output, 1, 1_024);

    expect(output.textContent).toBe('keep');
    expect(output.querySelector('.styled')).toBeNull();
    expect(selection?.toString()).toBe('keep');
    expect(createRange).toHaveBeenCalledOnce();
    createRange.mockRestore();
    selection?.removeAllRanges();
    output.remove();
  });

  it('removes a direct Text-node prefix without invoking the Range fallback', () => {
    const output = document.createElement('pre');
    output.append(
      document.createTextNode('one\n'),
      document.createTextNode('two\n'),
      document.createTextNode('three\n'),
      document.createTextNode('four'),
    );
    const createRange = vi.spyOn(output.ownerDocument, 'createRange');

    prunePlainOutputDom(output, 2, 1_024);

    expect(output.textContent).toBe('three\nfour');
    expect(Array.from(output.childNodes).every((node) => node.nodeType === 3)).toBe(true);
    expect(createRange).not.toHaveBeenCalled();
    createRange.mockRestore();
  });

  it('uses direct Text.deleteData without leaving a split surrogate', () => {
    const output = document.createElement('pre');
    const face = '\ud83d\ude00';
    output.textContent = `discard-${face.repeat(20)}`;
    const createRange = vi.spyOn(output.ownerDocument, 'createRange');

    prunePlainOutputDom(output, 100, 9);

    expect(Array.from(output.textContent ?? '').every((character) => character === face)).toBe(true);
    expect((output.textContent ?? '').length).toBeLessThanOrEqual(10);
    expect(createRange).not.toHaveBeenCalled();
    createRange.mockRestore();
  });

  it('bounds a pathological single line without splitting a surrogate pair', () => {
    const output = document.createElement('pre');
    output.textContent = `discard-${'🙂'.repeat(20)}`;

    prunePlainOutputDom(output, 100, 9);

    expect(output.textContent).toMatch(/^(?:🙂)+$/u);
    expect(Array.from(output.textContent ?? '').every((character) => character === '🙂')).toBe(true);
    expect((output.textContent ?? '').length).toBeLessThanOrEqual(10);
  });
});

describe('PlainOutputDomRetention', () => {
  it('incrementally bounds many tiny ANSI fragments without changing retained markup', () => {
    const output = document.createElement('pre');
    const retention = new PlainOutputDomRetention();

    for (let index = 0; index < 1_000; index += 1) {
      retention.append(output, `<span class="line">line-${index}\n</span>`, 100, 100_000);
    }

    expect(retention.diagnostics().lineBreaks).toBeLessThanOrEqual(99);
    expect(output.textContent).not.toContain('line-900\n');
    expect(output.textContent).toContain('line-901\n');
    expect(output.textContent).toContain('line-999\n');
    expect(output.querySelectorAll('.line').length).toBeLessThanOrEqual(100);
  });

  it('bounds literal text without interpreting markup', () => {
    const output = document.createElement('pre');
    const retention = new PlainOutputDomRetention();

    retention.appendText(output, '<b>one</b>\ntwo\nthree', 2, 1_024);

    expect(output.textContent).toBe('two\nthree');
    expect(output.querySelector('b')).toBeNull();
    expect(retention.diagnostics()).toEqual({
      chars: 'two\nthree'.length,
      lineBreaks: 1,
    });
  });
});

describe('BatchedPlainOutputDomRetention', () => {
  it('uses bounded max latency instead of flushing every animation frame', () => {
    vi.useFakeTimers();
    try {
      const output = document.createElement('pre');
      const retention = new BatchedPlainOutputDomRetention();

      retention.append(output, 'live', 100);
      vi.advanceTimersByTime(PTY_PLAIN_DOM_MAX_LATENCY_MS - 1);
      expect(output.textContent).toBe('');

      vi.advanceTimersByTime(1);
      expect(output.textContent).toBe('live');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces small fragments and applies the exact line bound when flushed', () => {
    const output = document.createElement('pre');
    const scheduled: Array<() => void> = [];
    const retention = new BatchedPlainOutputDomRetention((callback) => {
      scheduled.push(callback);
      return () => {};
    });

    retention.append(output, '<span>one\ntwo\n</span>', 2);
    retention.append(output, '<b>three\nfour</b>', 2);

    expect(output.textContent).toBe('');
    expect(scheduled).toHaveLength(1);
    scheduled[0]();

    expect(output.textContent).toBe('three\nfour');
    expect(output.querySelector('b')?.textContent).toBe('three\nfour');
    expect(retention.diagnostics()).toEqual({
      chars: 'three\nfour'.length,
      lineBreaks: 1,
      pendingChars: 0,
    });
  });

  it('flushes synchronously at the bounded batch threshold', () => {
    const output = document.createElement('pre');
    let cancelled = false;
    const retention = new BatchedPlainOutputDomRetention(
      () => () => {
        cancelled = true;
      },
      8,
    );

    retention.append(output, '1234', 100);
    expect(output.textContent).toBe('');
    retention.append(output, '5678', 100);

    expect(cancelled).toBe(true);
    expect(output.textContent).toBe('12345678');
    expect(retention.diagnostics().pendingChars).toBe(0);
  });

  it('keeps the production 2 MiB boundary at exactly 32 64-KiB fragments', () => {
    const output = document.createElement('pre');
    let cancelled = false;
    const retention = new BatchedPlainOutputDomRetention(() => () => {
      cancelled = true;
    });
    const fragment = 'x'.repeat(64 * 1024);

    for (let index = 0; index < 31; index += 1) {
      retention.append(output, fragment, 10_000);
    }
    expect(output.textContent).toBe('');
    expect(retention.diagnostics().pendingChars).toBe(31 * fragment.length);

    retention.append(output, fragment, 10_000);

    expect(cancelled).toBe(true);
    expect(output.textContent).toHaveLength(PTY_PLAIN_DOM_BATCH_CHARS);
    expect(retention.diagnostics().pendingChars).toBe(0);
  });

  it('cancels stale scheduled work and enforces the character cap after flush', () => {
    const output = document.createElement('pre');
    const scheduled: Array<() => void> = [];
    let cancellations = 0;
    const retention = new BatchedPlainOutputDomRetention((callback) => {
      scheduled.push(callback);
      return () => {
        cancellations += 1;
      };
    });

    retention.append(output, '<span>discard-KEEP</span>', 100, 4);
    retention.flush();

    expect(cancellations).toBe(1);
    expect(output.textContent).toBe('KEEP');
    expect(retention.diagnostics()).toEqual({
      chars: 4,
      lineBreaks: 0,
      pendingChars: 0,
    });

    // A cancelled callback is harmless even if a test scheduler delivers it.
    scheduled[0]();
    expect(output.textContent).toBe('KEEP');

    retention.append(output, 'pending-reset', 100);
    output.textContent = '';
    retention.reset();
    scheduled[1]();
    expect(output.textContent).toBe('');

    retention.append(output, 'pending-dispose', 100);
    retention.dispose();
    scheduled[2]();
    expect(output.textContent).toBe('');
  });
});
