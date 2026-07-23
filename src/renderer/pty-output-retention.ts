/**
 * Renderer-side bounded retention for adaptive plain PTY output.
 *
 * The interpreter's byte ACK controls transport pressure, but plain mode ACKs
 * immediately and therefore needs its own replay/DOM bounds. The line limit is
 * the user's existing xterm scrollback setting; the byte/character ceiling also
 * bounds a pathological single line that contains no newline.
 */

export const PTY_PLAIN_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const PTY_PLAIN_DOM_MAX_CHARS = 8 * 1024 * 1024;

export interface RetainedPtyChunk {
  readonly bytes: Uint8Array;
  readonly suppressSideEffects: boolean;
  /** True when plain mode already advanced flow accounting for these bytes. */
  readonly alreadyConsumed: boolean;
}

export class PtyReplayBuffer {
  private chunks: RetainedPtyChunk[] = [];
  private retainedBytes = 0;
  private lineBreaks = 0;
  /** Cumulative historical bytes inspected by prefix-boundary searches.
   * Excludes the mandatory one-pass count over each newly appended chunk. */
  private trimBytesInspected = 0;

  append(
    chunk: RetainedPtyChunk,
    options?: { readonly maxLines: number; readonly maxBytes?: number },
  ): void {
    if (chunk.bytes.byteLength === 0) return;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.bytes.byteLength;
    this.lineBreaks += countByte(chunk.bytes, 0x0a);
    if (options) {
      this.limit(options.maxLines, options.maxBytes);
    }
  }

  limit(maxLines: number, maxBytes = PTY_PLAIN_HISTORY_MAX_BYTES): void {
    this.trimLines(Math.max(1, Math.trunc(maxLines)));
    this.trimBytes(Math.max(1, Math.trunc(maxBytes)));
  }

  snapshot(): readonly RetainedPtyChunk[] {
    return this.chunks;
  }

  prepend(chunks: readonly RetainedPtyChunk[]): void {
    if (chunks.length === 0) return;
    this.chunks = [...chunks, ...this.chunks];
    for (const chunk of chunks) {
      this.retainedBytes += chunk.bytes.byteLength;
      this.lineBreaks += countByte(chunk.bytes, 0x0a);
    }
  }

  drain(): RetainedPtyChunk[] {
    const chunks = this.chunks;
    this.chunks = [];
    this.retainedBytes = 0;
    this.lineBreaks = 0;
    return chunks;
  }

  clear(): void {
    this.chunks = [];
    this.retainedBytes = 0;
    this.lineBreaks = 0;
  }

  diagnostics(): { readonly bytes: number; readonly lineBreaks: number; readonly chunks: number } {
    return {
      bytes: this.retainedBytes,
      lineBreaks: this.lineBreaks,
      chunks: this.chunks.length,
    };
  }

  /** Test/diagnostic seam for the trimming-complexity invariant. Content never
   * crosses this interface; the counter saturates before losing integer safety. */
  workDiagnostics(): { readonly trimBytesInspected: number } {
    return { trimBytesInspected: this.trimBytesInspected };
  }

  private trimLines(maxLines: number): void {
    // N retained visual lines contain at most N-1 newline separators.
    const excess = this.lineBreaks - Math.max(0, maxLines - 1);
    if (excess <= 0) return;
    const desiredCut = this.offsetThroughLineBreaks(excess);
    this.removePrefixBytes(this.findAnsiSafeCut(desiredCut));
  }

  private offsetThroughLineBreaks(count: number): number {
    let remaining = count;
    let offset = 0;
    for (const chunk of this.chunks) {
      for (const byte of chunk.bytes) {
        offset += 1;
        if (byte === 0x0a) {
          remaining -= 1;
          if (remaining === 0) {
            this.recordTrimInspection(offset);
            return offset;
          }
        }
      }
    }
    this.recordTrimInspection(offset);
    return this.retainedBytes;
  }

  private trimBytes(maxBytes: number): void {
    const trimSlack = Math.min(64 * 1024, Math.floor(maxBytes / 8));
    if (this.retainedBytes <= maxBytes + trimSlack) return;
    const remove = this.retainedBytes - maxBytes;

    // Prefer beginning at a line boundary. This avoids replaying a suffix of a
    // terminal escape sequence in the common multi-line case.
    // A pathological single-line stream is exactly why the byte ceiling exists.
    // Avoid rescanning the complete ~8 MiB history looking for a newline we
    // already know is absent on every trim.
    const newlineCut = this.lineBreaks === 0
      ? null
      : this.findFirstLineBoundaryAtOrAfter(remove);
    const desiredCut = newlineCut ?? remove;
    this.removePrefixBytes(this.findAnsiSafeCut(desiredCut));
  }

  private findFirstLineBoundaryAtOrAfter(offset: number): number | null {
    let seen = 0;
    for (const chunk of this.chunks) {
      for (let i = 0; i < chunk.bytes.byteLength; i += 1) {
        seen += 1;
        if (seen >= offset && chunk.bytes[i] === 0x0a) {
          this.recordTrimInspection(seen);
          return seen;
        }
      }
    }
    this.recordTrimInspection(seen);
    return null;
  }

  /**
   * Advance a desired prefix cut until the VT parser is in ground state. This
   * prevents a bounded replay from beginning in the middle of CSI/OSC/DCS.
   */
  private findAnsiSafeCut(minimum: number): number {
    type State = 'ground' | 'escape' | 'csi' | 'osc' | 'osc-escape' | 'string' | 'string-escape';
    let state: State = 'ground';
    let offset = 0;

    for (const chunk of this.chunks) {
      for (const byte of chunk.bytes) {
        if (
          offset >= minimum
          && state === 'ground'
          && (byte & 0xc0) !== 0x80
        ) {
          this.recordTrimInspection(offset);
          return offset;
        }

        switch (state) {
          case 'ground':
            if (byte === 0x1b) state = 'escape';
            break;
          case 'escape':
            if (byte === 0x5b) state = 'csi'; // ESC [
            else if (byte === 0x5d) state = 'osc'; // ESC ]
            else if (
              byte === 0x50 // DCS: ESC P
              || byte === 0x58 // SOS: ESC X
              || byte === 0x5e // PM: ESC ^
              || byte === 0x5f // APC: ESC _
            ) state = 'string';
            else if (byte === 0x1b) state = 'escape';
            else state = 'ground';
            break;
          case 'csi':
            if (byte === 0x1b) state = 'escape';
            else if (byte >= 0x40 && byte <= 0x7e) state = 'ground';
            break;
          case 'osc':
            if (byte === 0x07) state = 'ground';
            else if (byte === 0x1b) state = 'osc-escape';
            break;
          case 'osc-escape':
            if (byte === 0x5c) state = 'ground'; // ST: ESC \
            else if (byte !== 0x1b) state = 'osc';
            break;
          case 'string':
            if (byte === 0x1b) state = 'string-escape';
            break;
          case 'string-escape':
            if (byte === 0x5c) state = 'ground';
            else if (byte !== 0x1b) state = 'string';
            break;
        }
        offset += 1;
      }
    }
    this.recordTrimInspection(offset);
    return state === 'ground' && offset >= minimum ? offset : this.retainedBytes;
  }

  private recordTrimInspection(bytes: number): void {
    this.trimBytesInspected = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.trimBytesInspected + bytes,
    );
  }

  private removePrefixBytes(bytes: number): void {
    let remaining = bytes;
    while (remaining > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (remaining >= first.bytes.byteLength) {
        remaining -= first.bytes.byteLength;
        this.dropFirstChunk();
      } else {
        // Never start replay in the middle of a UTF-8 continuation sequence.
        let cut = remaining;
        while (
          cut < first.bytes.byteLength
          && (first.bytes[cut] & 0xc0) === 0x80
        ) {
          cut += 1;
        }
        this.removePrefixFromFirst(cut);
        remaining = 0;
      }
    }
  }

  private dropFirstChunk(): void {
    const [first] = this.chunks.splice(0, 1);
    if (!first) return;
    this.retainedBytes -= first.bytes.byteLength;
    this.lineBreaks -= countByte(first.bytes, 0x0a);
  }

  private removePrefixFromFirst(count: number): void {
    const first = this.chunks[0];
    if (!first || count <= 0) return;
    if (count >= first.bytes.byteLength) {
      this.dropFirstChunk();
      return;
    }
    const removed = first.bytes.subarray(0, count);
    this.chunks[0] = {
      ...first,
      // `slice`, not `subarray`: the retained suffix must not keep a huge
      // transferred ArrayBuffer alive after most of it has been pruned.
      bytes: first.bytes.slice(count),
    };
    this.retainedBytes -= count;
    this.lineBreaks -= countByte(removed, 0x0a);
  }
}

/**
 * Incremental DOM owner used by PtyPlainView. It parses only the incoming HTML
 * fragment, tracks exact rendered text counts, and removes only the necessary
 * prefix. Sustained output therefore does not rescan the complete scrollback on
 * every frame.
 */
export class PlainOutputDomRetention {
  private chars = 0;
  private lineBreaks = 0;

  append(
    element: HTMLElement,
    html: string,
    maxLines: number,
    maxChars = PTY_PLAIN_DOM_MAX_CHARS,
  ): void {
    const template = element.ownerDocument.createElement('template');
    template.innerHTML = html;
    const text = template.content.textContent ?? '';
    this.chars += text.length;
    this.lineBreaks += countCharacter(text, '\n');
    element.append(template.content);
    this.limit(element, maxLines, maxChars);
  }

  appendText(
    element: HTMLElement,
    text: string,
    maxLines: number,
    maxChars = PTY_PLAIN_DOM_MAX_CHARS,
  ): void {
    if (text.length === 0) return;
    this.chars += text.length;
    this.lineBreaks += countCharacter(text, '\n');
    element.append(element.ownerDocument.createTextNode(text));
    this.limit(element, maxLines, maxChars);
  }

  limit(
    element: HTMLElement,
    maxLines: number,
    maxChars = PTY_PLAIN_DOM_MAX_CHARS,
  ): void {
    const safeLines = Math.max(1, Math.trunc(maxLines));
    const safeChars = Math.max(1, Math.trunc(maxChars));
    const removeLineBreaks = Math.max(0, this.lineBreaks - Math.max(0, safeLines - 1));
    const removeChars = Math.max(0, this.chars - safeChars);
    if (removeLineBreaks === 0 && removeChars === 0) return;
    const removed = deletePlainOutputPrefix(element, removeLineBreaks, removeChars);
    this.chars = Math.max(0, this.chars - removed.chars);
    this.lineBreaks = Math.max(0, this.lineBreaks - removed.lineBreaks);
  }

  reset(): void {
    this.chars = 0;
    this.lineBreaks = 0;
  }

  diagnostics(): { readonly chars: number; readonly lineBreaks: number } {
    return { chars: this.chars, lineBreaks: this.lineBreaks };
  }
}

/**
 * Delete the oldest rendered text while preserving the remaining DOM markup.
 * `Range.deleteContents()` trims text nodes in place, so ANSI `<span>` styling
 * around the retained suffix remains valid and no `innerHTML` rewrite is needed.
 */
export function prunePlainOutputDom(
  element: HTMLElement,
  maxLines: number,
  maxChars = PTY_PLAIN_DOM_MAX_CHARS,
): void {
  const text = element.textContent ?? '';
  const safeLines = Math.max(1, Math.trunc(maxLines));
  const safeChars = Math.max(1, Math.trunc(maxChars));

  let lineCut = 0;
  let excessBreaks = countCharacter(text, '\n') - Math.max(0, safeLines - 1);
  if (excessBreaks > 0) {
    for (let i = 0; i < text.length && excessBreaks > 0; i += 1) {
      if (text[i] === '\n') {
        excessBreaks -= 1;
        lineCut = i + 1;
      }
    }
  }
  let cut = Math.max(lineCut, text.length - safeChars);
  if (cut <= 0) return;
  // Avoid retaining a lone low surrogate after a character-based cut.
  if (
    cut < text.length
    && isLowSurrogate(text.charCodeAt(cut))
    && isHighSurrogate(text.charCodeAt(cut - 1))
  ) {
    cut += 1;
  }

  deletePlainOutputPrefix(element, 0, cut);
}

function deletePlainOutputPrefix(
  element: HTMLElement,
  minimumLineBreaks: number,
  minimumChars: number,
): { readonly chars: number; readonly lineBreaks: number } {
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
  let removedChars = 0;
  let removedLineBreaks = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  outer: for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    for (let offset = 0; offset < node.data.length; offset += 1) {
      removedChars += 1;
      if (node.data[offset] === '\n') removedLineBreaks += 1;
      if (
        removedChars >= minimumChars
        && removedLineBreaks >= minimumLineBreaks
      ) {
        endNode = node;
        endOffset = offset + 1;
        break outer;
      }
    }
  }

  if (!endNode) {
    element.textContent = '';
    return { chars: removedChars, lineBreaks: removedLineBreaks };
  }
  if (
    endOffset < endNode.data.length
    && isHighSurrogate(endNode.data.charCodeAt(endOffset - 1))
    && isLowSurrogate(endNode.data.charCodeAt(endOffset))
  ) {
    endOffset += 1;
    removedChars += 1;
  }

  const range = element.ownerDocument.createRange();
  range.setStart(element, 0);
  range.setEnd(endNode, endOffset);
  range.deleteContents();

  // Range deletion can leave empty ANSI spans at the front. Remove only empty
  // leading nodes; styled ancestors containing retained text are untouched.
  while (element.firstChild && element.firstChild.textContent === '') {
    element.firstChild.remove();
  }
  return { chars: removedChars, lineBreaks: removedLineBreaks };
}

function countByte(bytes: Uint8Array, needle: number): number {
  let count = 0;
  for (const byte of bytes) if (byte === needle) count += 1;
  return count;
}

function countCharacter(text: string, needle: string): number {
  let count = 0;
  for (const character of text) if (character === needle) count += 1;
  return count;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
