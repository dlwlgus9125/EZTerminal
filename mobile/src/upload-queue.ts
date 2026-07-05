import { UPLOAD_MAX_FILE_BYTES } from '../../src/shared/files';

// upload-queue.ts — a pure, transport-agnostic upload state machine
// (file-explorer plan, M5). No React, no WS — same "plain class/function
// does the real work, directly unit-testable" shape as `long-press.ts`'s
// `LongPressTracker`. `MobileFileView.tsx` supplies `deps.uploadFile` (a
// thin wrapper around `WsEzTerminalTransport.uploadFile`) and renders
// whatever `onChange` hands it.
//
// Files upload STRICTLY SEQUENTIALLY, never in parallel — the wire's
// ack-gated chunk contract is already one-in-flight per upload, and queueing
// N of them at once would just contend for the same link and the same
// per-connection upload bookkeeping on the bridge for no benefit. A file
// that fails mid-upload is marked 'failed' and the queue moves on to the
// next pending item rather than stalling.
//
// Each `UploadItem` carries its OWN `dirPath`, captured at `enqueue` time —
// this is a per-ITEM field, not a queue-wide setting, specifically so a
// second `enqueue` call targeting a different folder (the caller navigated
// elsewhere and picked more files before the first batch finished) can never
// retroactively change where an earlier, still-pending item uploads to.

export interface UploadItem {
  readonly id: string;
  readonly name: string;
  /** The folder this item targets, captured at `enqueue` time — travels with
   * the item itself so a LATER batch targeting a different folder can never
   * bleed onto an earlier batch's still-pending items (see `enqueue`). */
  readonly dirPath: string;
  readonly size: number;
  readonly status: 'pending' | 'uploading' | 'done' | 'failed';
  readonly receivedBytes: number;
  readonly finalName?: string;
  readonly error?: string;
}

export interface UploadQueueDeps {
  readonly uploadFile: (
    dirPath: string,
    name: string,
    bytes: Uint8Array,
    onProgress: (sent: number) => void,
  ) => Promise<{ finalName: string }>;
  /** Defaults to `UPLOAD_MAX_FILE_BYTES` — override only for tests. */
  readonly maxFileBytes?: number;
  readonly onChange: (items: readonly UploadItem[]) => void;
}

export interface UploadQueue {
  /** Appends `files` to the queue, all targeting `dirPath` (captured NOW —
   * the folder the caller was viewing when these files were picked, even if
   * it later navigates elsewhere before this batch's turn comes up; each
   * item remembers its OWN `dirPath`, so a second `enqueue` call targeting a
   * different folder never affects the first batch's still-pending items).
   * Oversized files land 'failed' immediately, without a network call. A
   * no-op for an empty array — `onChange` never fires. */
  enqueue(files: readonly { readonly name: string; readonly bytes: Uint8Array }[], dirPath: string): void;
}

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const maxFileBytes = deps.maxFileBytes ?? UPLOAD_MAX_FILE_BYTES;
  const pendingBytes = new Map<string, Uint8Array>();
  let items: UploadItem[] = [];
  let idCounter = 0;
  let processing = false;

  const emit = (): void => deps.onChange(items);

  const patch = (id: string, changes: Partial<UploadItem>): void => {
    items = items.map((item) => (item.id === id ? { ...item, ...changes } : item));
    emit();
  };

  const processNext = async (): Promise<void> => {
    if (processing) return;
    const next = items.find((item) => item.status === 'pending');
    if (!next) return;
    processing = true;
    patch(next.id, { status: 'uploading' });
    const bytes = pendingBytes.get(next.id) as Uint8Array;
    try {
      const { finalName } = await deps.uploadFile(next.dirPath, next.name, bytes, (sent) => {
        patch(next.id, { receivedBytes: sent });
      });
      patch(next.id, { status: 'done', finalName, receivedBytes: next.size });
    } catch (err) {
      patch(next.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    } finally {
      pendingBytes.delete(next.id);
      processing = false;
      void processNext(); // continue with whatever's next, success or failure
    }
  };

  return {
    enqueue(files, dirPath) {
      if (files.length === 0) return;
      const added = files.map((file): UploadItem => {
        const id = `upload-${++idCounter}`;
        if (file.bytes.length > maxFileBytes) {
          return {
            id,
            name: file.name,
            dirPath,
            size: file.bytes.length,
            status: 'failed',
            receivedBytes: 0,
            error: `File exceeds the ${maxFileBytes}-byte upload limit`,
          };
        }
        pendingBytes.set(id, file.bytes);
        return { id, name: file.name, dirPath, size: file.bytes.length, status: 'pending', receivedBytes: 0 };
      });
      items = [...items, ...added];
      emit();
      void processNext();
    },
  };
}
