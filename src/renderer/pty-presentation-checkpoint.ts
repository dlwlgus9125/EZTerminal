import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal as BrowserTerminal } from '@xterm/xterm';

export const PTY_PRESENTATION_SCROLLBACK_LINES = 1_000;
export const PTY_PRESENTATION_SNAPSHOT_BYTES = 512 * 1024;
export const PTY_PRESENTATION_TAIL_BYTES = 256 * 1024;

export interface PtyPresentationSelection {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

export interface PtyPresentationCheckpoint {
  readonly serialized: string;
  readonly tail: readonly Uint8Array[];
  readonly cols: number;
  readonly rows: number;
  readonly viewportY: number;
  readonly selection: PtyPresentationSelection | null;
  readonly focused: boolean;
}

const encoder = new TextEncoder();

interface PtyPresentationReadableTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
    };
  };
  readonly options: {
    readonly scrollback?: number;
  };
  getSelectionPosition?(): {
    readonly start: { readonly x: number; readonly y: number };
    readonly end: { readonly x: number; readonly y: number };
  } | undefined;
}

interface PtyPresentationWritableTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
}

interface PtyPresentationSizedTerminal {
  readonly cols: number;
  readonly rows: number;
}

/** Capture a bounded official xterm serialization. Reducing scrollback before
 * failing keeps one pathological line from turning a parked surface into an
 * unbounded memory copy. */
export function capturePtyPresentation(
  terminal: PtyPresentationReadableTerminal,
  serializer: SerializeAddon,
  host: HTMLElement | null,
): PtyPresentationCheckpoint | null {
  try {
    let scrollback = Math.min(PTY_PRESENTATION_SCROLLBACK_LINES, terminal.options.scrollback ?? 0);
    let serialized = '';
    while (scrollback >= 0) {
      serialized = serializer.serialize({ scrollback });
      if (encoder.encode(serialized).byteLength <= PTY_PRESENTATION_SNAPSHOT_BYTES) break;
      if (scrollback === 0) return null;
      scrollback = scrollback === 1 ? 0 : Math.floor(scrollback / 2);
    }
    const range = terminal.getSelectionPosition?.();
    return Object.freeze({
      serialized,
      tail: Object.freeze([]),
      cols: terminal.cols,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY,
      selection: range
        ? Object.freeze({
            startX: range.start.x,
            startY: range.start.y,
            endX: range.end.x,
            endY: range.end.y,
          })
        : null,
      focused: Boolean(host?.contains(host.ownerDocument.activeElement)),
    });
  } catch {
    return null;
  }
}

export function restorePtyPresentationState(
  terminal: BrowserTerminal,
  checkpoint: PtyPresentationCheckpoint,
): void {
  terminal.scrollToLine(Math.max(0, checkpoint.viewportY));
  const selection = checkpoint.selection;
  if (!selection) return;
  const startColumn = Math.max(0, selection.startX - 1);
  const startRow = Math.max(0, selection.startY - 1);
  const endColumn = Math.max(0, selection.endX - 1);
  const endRow = Math.max(0, selection.endY - 1);
  const length = Math.max(0, ((endRow - startRow) * terminal.cols) + endColumn - startColumn);
  if (length > 0) terminal.select(startColumn, startRow, length);
}

/** Fail-open presentation fallback. A pathological serialization must never
 * strand the controller without a sink or prevent a parked pane from waking. */
export function emptyPtyPresentation(
  terminal: PtyPresentationSizedTerminal,
  host: HTMLElement | null,
): PtyPresentationCheckpoint {
  return Object.freeze({
    serialized: '',
    tail: Object.freeze([]),
    cols: terminal.cols,
    rows: terminal.rows,
    viewportY: 0,
    selection: null,
    focused: Boolean(host?.contains(host.ownerDocument.activeElement)),
  });
}

/** Queue the serialized screen and exact post-snapshot tail in xterm's own
 * write ordering domain. The empty write is the completion barrier. */
export function writePtyPresentation(
  terminal: PtyPresentationWritableTerminal,
  checkpoint: PtyPresentationCheckpoint | null,
  onFlushed: () => void,
): void {
  if (!checkpoint) {
    onFlushed();
    return;
  }
  if (checkpoint.serialized) terminal.write(checkpoint.serialized);
  for (const bytes of checkpoint.tail) terminal.write(bytes);
  terminal.write('', onFlushed);
}

export class PtyPresentationTail {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;

  public append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength >= PTY_PRESENTATION_TAIL_BYTES) {
      this.chunks.length = 0;
      const tail = bytes.slice(bytes.byteLength - PTY_PRESENTATION_TAIL_BYTES);
      this.chunks.push(tail);
      this.bytes = tail.byteLength;
      return;
    }
    this.chunks.push(Uint8Array.from(bytes));
    this.bytes += bytes.byteLength;
    while (this.bytes > PTY_PRESENTATION_TAIL_BYTES && this.chunks.length > 0) {
      const overflow = this.bytes - PTY_PRESENTATION_TAIL_BYTES;
      const first = this.chunks[0]!;
      if (first.byteLength <= overflow) {
        this.chunks.shift();
        this.bytes -= first.byteLength;
      } else {
        this.chunks[0] = first.slice(overflow);
        this.bytes -= overflow;
      }
    }
  }

  public merge(base: PtyPresentationCheckpoint | null): PtyPresentationCheckpoint | null {
    if (!base) return null;
    const newest: Uint8Array[] = [];
    let remaining = PTY_PRESENTATION_TAIL_BYTES;
    const candidates = [...base.tail, ...this.chunks];
    for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
      const chunk = candidates[index]!;
      if (chunk.byteLength <= remaining) {
        newest.unshift(chunk);
        remaining -= chunk.byteLength;
      } else {
        newest.unshift(chunk.slice(chunk.byteLength - remaining));
        remaining = 0;
      }
    }
    return Object.freeze({
      ...base,
      tail: Object.freeze(newest),
    });
  }

  public reset(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }
}
