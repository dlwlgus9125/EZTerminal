/**
 * ANSI SGR → sanitized HTML, for external program text output (architecture §7).
 *
 * Uses ansi_up with `escape_html` ON (the default): the source text is
 * HTML-escaped (so `<script>` becomes `&lt;script&gt;` — no XSS) and only
 * ansi_up's own inline-styled color spans are emitted. The HTML is therefore
 * safe to inject into the DOM after conversion.
 *
 * `AnsiHtmlStream` is the STATEFUL streaming form: a single AnsiUp instance is
 * reused across chunks so SGR state (current fg/bg/bold) carries over, and
 * ansi_up internally buffers an escape sequence that is split across a chunk
 * boundary. A TextDecoder in stream mode likewise carries a multi-byte UTF-8
 * character split across byte chunks.
 */

import { AnsiUp } from 'ansi_up';

/**
 * ansi_up carries an incomplete CSI/OSC packet between calls. A malformed
 * process can otherwise keep an OSC hyperlink open forever while the PTY
 * transport continues to ACK, growing that private carry without bound.
 */
export const ANSI_PENDING_MAX_CHARS = 64 * 1024;

/** One-shot ANSI → sanitized HTML conversion. */
export function ansiToHtml(text: string): string {
  return new AnsiUp().ansi_to_html(text);
}

/** Stateful streaming ANSI → HTML decoder for a sequence of UTF-8 byte chunks. */
export class AnsiHtmlStream {
  private au = new AnsiUp();
  private readonly decoder = new TextDecoder('utf-8');

  /** Convert one byte chunk into sanitized HTML (may be '' if nothing decoded). */
  push(chunk: Uint8Array): string {
    return this.pushFragments(chunk).join('');
  }

  /**
   * Convert one byte chunk into independently parseable sanitized HTML
   * fragments. Each fragment comes from at most `ANSI_PENDING_MAX_CHARS`
   * decoded input characters (or the same bounded malformed-control carry).
   *
   * Consumers that append to a DOM should prefer this seam over {@link push}:
   * joining the fragments would turn a multi-megabyte PTY frame back into one
   * long, blocking HTML parse even though ansi_up converted it incrementally.
   */
  pushFragments(chunk: Uint8Array): readonly string[] {
    const text = this.decoder.decode(chunk, { stream: true });
    return text ? this.convertBounded(text) : [];
  }

  /**
   * Flush at end of stream: emit any bytes the streaming TextDecoder was still
   * holding (a partial multi-byte UTF-8 char split across the final chunk), run
   * through ansi_up so a trailing fragment isn't dropped. Call once after the last
   * push(); the instance is single-use afterward.
   */
  flush(): string {
    return this.flushFragments().join('');
  }

  /**
   * Fragment-preserving counterpart to {@link flush}. The stream is single-use
   * after this call, just like `flush()`.
   */
  flushFragments(): readonly string[] {
    const text = this.decoder.decode();
    const rendered = text ? this.convertBounded(text) : [];
    const pending = this.drainMalformedPending();
    if (pending) rendered.push(pending);
    return rendered;
  }

  /** Content-free diagnostic seam for the carry-memory invariant. */
  diagnostics(): { readonly pendingChars: number } {
    return { pendingChars: this.pendingText().length };
  }

  private convertBounded(text: string): string[] {
    const rendered: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + ANSI_PENDING_MAX_CHARS);
      // Do not split a supplementary Unicode character between converter calls.
      if (
        end < text.length
        && isHighSurrogate(text.charCodeAt(end - 1))
        && isLowSurrogate(text.charCodeAt(end))
      ) {
        end -= 1;
      }
      const html = this.au.ansi_to_html(text.slice(offset, end));
      if (html) rendered.push(html);
      offset = end;

      const pending = this.pendingText();
      if (pending.length >= ANSI_PENDING_MAX_CHARS) {
        // Reset all ANSI state after malformed carry. The retained bytes are
        // rendered as escaped plain text, so an OSC/CSI fragment cannot become
        // active later and ordinary process output is not silently discarded.
        this.au = new AnsiUp();
        rendered.push(escapeMalformedAnsiText(pending));
      }
    }
    return rendered;
  }

  private drainMalformedPending(): string {
    const pending = this.pendingText();
    if (pending.length === 0) return '';
    this.au = new AnsiUp();
    return escapeMalformedAnsiText(pending);
  }

  private pendingText(): string {
    // ansi_up 6.0.6 has no public carry diagnostic. Keep this dependency seam
    // explicit and fail closed if an upgrade removes or changes the buffer:
    // surfacing a block error is safer than restoring unbounded renderer memory.
    const pending = Reflect.get(this.au, '_buffer');
    if (typeof pending !== 'string') {
      throw new Error('Unsupported ansi_up streaming buffer interface');
    }
    return pending;
  }
}

function escapeMalformedAnsiText(text: string): string {
  let visible = '';
  for (const character of text) {
    const code = character.charCodeAt(0);
    // Preserve ordinary whitespace, but remove control introducers/terminators
    // so the fallback can never be reinterpreted as an active terminal packet.
    if (
      code <= 0x08
      || code === 0x0b
      || code === 0x0c
      || (code >= 0x0e && code <= 0x1f)
      || (code >= 0x7f && code <= 0x9f)
    ) {
      continue;
    }
    visible += character;
  }
  return visible
    .replace(/[&<>"']/gu, (character) => {
      switch (character) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#x27;';
      }
    });
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
