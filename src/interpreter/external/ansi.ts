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

/** One-shot ANSI → sanitized HTML conversion. */
export function ansiToHtml(text: string): string {
  return new AnsiUp().ansi_to_html(text);
}

/** Stateful streaming ANSI → HTML decoder for a sequence of UTF-8 byte chunks. */
export class AnsiHtmlStream {
  private readonly au = new AnsiUp();
  private readonly decoder = new TextDecoder('utf-8');

  /** Convert one byte chunk into sanitized HTML (may be '' if nothing decoded). */
  push(chunk: Uint8Array): string {
    const text = this.decoder.decode(chunk, { stream: true });
    return text ? this.au.ansi_to_html(text) : '';
  }

  /**
   * Flush at end of stream: emit any bytes the streaming TextDecoder was still
   * holding (a partial multi-byte UTF-8 char split across the final chunk), run
   * through ansi_up so a trailing fragment isn't dropped. Call once after the last
   * push(); the instance is single-use afterward.
   */
  flush(): string {
    const text = this.decoder.decode();
    return text ? this.au.ansi_to_html(text) : '';
  }
}
