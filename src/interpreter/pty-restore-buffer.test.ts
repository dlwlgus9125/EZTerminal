import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';

import {
  PtySemanticRestoreBuffer,
  type PtySemanticRestoreOptions,
} from './pty-restore-buffer';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fakeModel(options: {
  serialize?: (scrollback: number, text: string) => string;
  asyncWrites?: boolean;
} = {}): {
  createModel: NonNullable<PtySemanticRestoreOptions['createModel']>;
  flushWrite: () => void;
  serializeCalls: number[];
} {
  let text = '';
  const callbacks: Array<() => void> = [];
  const serializeCalls: number[] = [];
  return {
    createModel: () => ({
      terminal: {
        write(data, callback) {
          text += decoder.decode(data);
          if (options.asyncWrites) callbacks.push(callback);
          else callback();
        },
        resize() {},
        loadAddon() {},
        dispose() {},
      },
      serializer: {
        serialize({ scrollback }) {
          serializeCalls.push(scrollback);
          return options.serialize?.(scrollback, text) ?? `snapshot:${text}`;
        },
      },
    }),
    flushWrite: () => callbacks.shift()?.(),
    serializeCalls,
  };
}

describe('PtySemanticRestoreBuffer', () => {
  it('returns a serialized snapshot followed by the exact epoch-ordered tail', () => {
    const model = fakeModel();
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      snapshotIntervalBytes: 5,
    });

    restore.feed(encoder.encode('hello'));
    restore.feed(encoder.encode('!'));

    expect(restore.capture()).toEqual({
      mode: 'semantic',
      snapshot: encoder.encode('snapshot:hello'),
      tail: [encoder.encode('!')],
      snapshotEpoch: 1,
      replayEpoch: 2,
      tailBytes: 1,
      cols: 80,
      rows: 24,
    });
  });

  it('falls back while a resize is pending, then recovers after ordered processing', () => {
    const model = fakeModel({ asyncWrites: true });
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      snapshotIntervalBytes: 1,
    });
    restore.feed(encoder.encode('x'));
    restore.resize(120, 40);

    expect(restore.capture()).toMatchObject({ mode: 'fallback', reason: 'resize-pending' });
    model.flushWrite();
    expect(restore.capture()).toMatchObject({
      mode: 'semantic',
      snapshotEpoch: 1,
      replayEpoch: 1,
      cols: 120,
      rows: 40,
    });
  });

  it('fails closed when the pending operation bound would be exceeded', () => {
    const model = fakeModel({ asyncWrites: true });
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      maxPendingOperations: 2,
    });
    restore.feed(encoder.encode('1'));
    restore.feed(encoder.encode('2'));
    restore.feed(encoder.encode('3'));

    expect(restore.capture()).toMatchObject({
      mode: 'fallback',
      reason: 'semantic-gap',
      replayEpoch: 3,
    });
  });

  it('fails closed when the post-snapshot tail exceeds its byte cap', () => {
    const model = fakeModel({ asyncWrites: true });
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      maxTailBytes: 3,
    });
    restore.feed(encoder.encode('1234'));
    expect(restore.capture()).toMatchObject({ mode: 'fallback', reason: 'semantic-gap' });
  });

  it('reduces serialized scrollback until the snapshot fits the byte cap', () => {
    const model = fakeModel({
      serialize: (scrollback) => (scrollback === 0 ? 'ok' : 'too-large'),
    });
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      scrollbackLines: 8,
      maxSnapshotBytes: 2,
      snapshotIntervalBytes: 1,
    });
    restore.feed(encoder.encode('x'));

    expect(restore.capture()).toMatchObject({ mode: 'semantic', snapshot: encoder.encode('ok') });
    expect(model.serializeCalls).toEqual([8, 4, 2, 1, 0]);
  });

  it('uses a stable failure reason when even the viewport snapshot is too large', () => {
    const model = fakeModel({ serialize: () => 'oversized' });
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      maxSnapshotBytes: 1,
      snapshotIntervalBytes: 1,
    });
    restore.feed(encoder.encode('x'));
    expect(restore.capture()).toMatchObject({ mode: 'fallback', reason: 'snapshot-too-large' });
  });

  it('contains serializer exceptions and never exposes exception or terminal content', () => {
    const model = fakeModel({ serialize: () => {
      throw new Error('secret terminal text');
    } });
    const restore = new PtySemanticRestoreBuffer(80, 24, {
      createModel: model.createModel,
      snapshotIntervalBytes: 1,
    });
    restore.feed(encoder.encode('x'));
    expect(restore.capture()).toEqual({
      mode: 'fallback',
      reason: 'serializer-failed',
      snapshotEpoch: 0,
      replayEpoch: 1,
      gapAfterEpoch: 1,
    });
  });

  it('restores Unicode text and terminal modes with the official headless serializer', async () => {
    const restore = new PtySemanticRestoreBuffer(40, 10, { snapshotIntervalBytes: 1 });
    restore.feed(encoder.encode('\x1b[31m한글🙂\x1b[0m\x1b[?2004h'));

    await vi.waitFor(() => {
      const capture = restore.capture();
      expect(capture.mode).toBe('semantic');
      if (capture.mode === 'semantic') expect(capture.snapshotEpoch).toBe(1);
    });
    const capture = restore.capture();
    if (capture.mode !== 'semantic') throw new Error('semantic capture unavailable');

    const replay = new Uint8Array(
      capture.snapshot.byteLength + capture.tail.reduce((n, part) => n + part.byteLength, 0),
    );
    replay.set(capture.snapshot, 0);
    let offset = capture.snapshot.byteLength;
    for (const part of capture.tail) {
      replay.set(part, offset);
      offset += part.byteLength;
    }

    const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 10 });
    await new Promise<void>((resolve) => terminal.write(replay, resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toContain('한글🙂');
    terminal.dispose();
    restore.dispose();
  });
});
