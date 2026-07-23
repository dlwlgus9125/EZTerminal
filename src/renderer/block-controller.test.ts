import { afterEach, describe, expect, it, vi } from 'vitest';

import { ANSI_PENDING_MAX_CHARS } from '../interpreter/external/ansi';
import type { InterpreterFrame, RendererControl } from '../shared/ipc';
import { BlockController, NOTIFY_THROTTLE_MS, PTY_ACK_QUANTUM } from './block-controller';

// A minimal stand-in for a DOM MessagePort: records the controls the controller
// posts, and lets the test deliver interpreter frames as if they arrived over the
// port. This exercises BlockController's windowed cache / prune / dedup logic
// without a real Electron MessageChannel (CODE-M2).
class FakePort {
  posted: RendererControl[] = [];
  started = false;
  closed = false;
  private listener: ((ev: { data: InterpreterFrame }) => void) | null = null;

  addEventListener(_type: 'message', cb: (ev: { data: InterpreterFrame }) => void): void {
    this.listener = cb;
  }
  start(): void {
    this.started = true;
  }
  postMessage(msg: RendererControl): void {
    this.posted.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  /** Deliver a frame as if the interpreter sent it over the port. */
  deliver(frame: InterpreterFrame): void {
    this.listener?.({ data: frame });
  }
}

function make(opts?: { mirror?: boolean }): { port: FakePort; controller: BlockController } {
  const port = new FakePort();
  const controller = new BlockController('cmd', port as unknown as MessagePort, opts);
  return { port, controller };
}

describe('BlockController — windowing / prune / dedup', () => {
  it('starts the port on construction', () => {
    const { port } = make();
    expect(port.started).toBe(true);
  });

  it('tracks the additive execution kind and keeps older start frames unknown', () => {
    const old = make();
    old.port.deliver({ type: 'start', commandText: 'echo old' });
    expect(old.controller.getSnapshot().executionKind).toBeNull();

    const ssh = make();
    ssh.port.deliver({ type: 'start', commandText: 'ssh-connect host', executionKind: 'ssh' });
    expect(ssh.controller.getSnapshot().executionKind).toBe('ssh');
  });

  it('caches delivered chunk rows and exposes them by absolute index', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'table', columns: [{ name: 'n', type: 'number' }] });
    port.deliver({ type: 'progress', count: 3, done: false });
    port.deliver({ type: 'chunk', start: 0, rows: [{ n: 1 }, { n: 2 }, { n: 3 }] });

    expect(controller.getSnapshot().rowCount).toBe(3);
    expect(controller.getRow(0)).toEqual({ n: 1 });
    expect(controller.getRow(2)).toEqual({ n: 3 });
    expect(controller.getRow(5)).toBeUndefined();
  });

  it('posts a window control when rows are requested', () => {
    const { port, controller } = make();
    controller.requestRows(0, 50);
    expect(port.posted).toContainEqual({ type: 'requestRows', start: 0, count: 50 });
  });

  it('de-dupes a repeated identical window request (one control posted)', () => {
    const { port, controller } = make();
    controller.requestRows(0, 50);
    controller.requestRows(0, 50); // identical window → suppressed
    expect(port.posted.filter((m) => m.type === 'requestRows')).toHaveLength(1);
  });

  it('does NOT de-dupe a genuinely different window', () => {
    const { port, controller } = make();
    controller.requestRows(0, 50);
    controller.requestRows(50, 50);
    expect(port.posted.filter((m) => m.type === 'requestRows')).toHaveLength(2);
  });

  it('drops non-finite row windows and clamps an oversized count', () => {
    const { port, controller } = make();
    controller.requestRows(Number.POSITIVE_INFINITY, 10);
    controller.requestRows(0, Number.NaN);
    expect(port.posted).toEqual([]);

    controller.requestRows(0, 1_000_000);
    expect(port.posted).toEqual([{ type: 'requestRows', start: 0, count: 10_000 }]);
  });

  it('prunes cached rows that fall far outside the active window', () => {
    const { port, controller } = make();
    port.deliver({ type: 'chunk', start: 0, rows: [{ n: 1 }] });
    expect(controller.getRow(0)).toEqual({ n: 1 });

    // Move the window far away — index 0 is now outside [start-KEEP, start+count+KEEP).
    controller.requestRows(10_000, 50);
    expect(controller.getRow(0)).toBeUndefined();
  });

  it('keeps cached rows that stay within the keep-buffer of the active window', () => {
    const { port, controller } = make();
    port.deliver({ type: 'chunk', start: 100, rows: [{ n: 100 }] });
    controller.requestRows(120, 10); // 100 is within the keep-buffer of [120, 130)
    expect(controller.getRow(100)).toEqual({ n: 100 });
  });

  it('does not let a late stale chunk repopulate rows pruned by a newer window', () => {
    const { port, controller } = make();
    controller.requestRows(0, 2);
    controller.requestRows(10_000, 2);

    // The first request completes after the viewport has already moved.
    port.deliver({ type: 'chunk', start: 0, rows: [{ n: 0 }, { n: 1 }] });
    port.deliver({ type: 'chunk', start: 10_000, rows: [{ n: 10_000 }, { n: 10_001 }] });

    expect(controller.getRow(0)).toBeUndefined();
    expect(controller.getRow(1)).toBeUndefined();
    expect(controller.getRow(10_000)).toEqual({ n: 10_000 });
    expect(controller.getRow(10_001)).toEqual({ n: 10_001 });
  });

  it('reflects terminal frames in the snapshot status', () => {
    const { port, controller } = make();
    expect(controller.getSnapshot().status).toBe('running');
    port.deliver({ type: 'end' });
    expect(controller.getSnapshot().status).toBe('done');
  });

  it('surfaces an error frame message', () => {
    const { port, controller } = make();
    port.deliver({ type: 'error', message: 'boom' });
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().errorMessage).toBe('boom');
  });

  it('settles a running block when its interpreter transport is interrupted', () => {
    const { port, controller } = make();
    const order: string[] = [];
    controller.setPlainDataSink(
      (html) => order.push(`data:${html}`),
      () => order.push('flush'),
    );
    order.length = 0;
    controller.subscribe(() => {
      if (controller.getSnapshot().status === 'error') order.push('error');
    });
    port.deliver({ type: 'pty-data', data: new Uint8Array([0xe2, 0x82]) });

    controller.markTransportInterrupted('interpreter restarted');
    expect(controller.getSnapshot().status).toBe('error');
    expect(controller.getSnapshot().errorMessage).toBe('interpreter restarted');
    expect(order[0]).toContain('data:\ufffd');
    expect(order.slice(1)).toEqual(['flush', 'error']);

    controller.markTransportInterrupted('late duplicate');
    expect(controller.getSnapshot().errorMessage).toBe('interpreter restarted');
  });

  it('dispose() posts a close control and closes the port', () => {
    const { port, controller } = make();
    controller.dispose();
    expect(port.posted).toContainEqual({ type: 'close' });
    expect(port.closed).toBe(true);
  });
});

describe('BlockController — progress notify throttle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a progress storm (leading + trailing) while the snapshot stays current', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { port, controller } = make();
    let notifies = 0;
    controller.subscribe(() => {
      notifies += 1;
    });

    // Storm: many progress frames in one tick (gen-rows 100M reports per 5000-row batch).
    for (let i = 1; i <= 1_000; i++) {
      port.deliver({ type: 'progress', count: i * 5_000, done: false });
    }

    expect(notifies).toBe(1); // leading edge only — React is not re-rendered per frame
    expect(controller.getSnapshot().rowCount).toBe(5_000_000); // snapshot updates every frame

    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS);
    expect(notifies).toBe(2); // trailing notify delivers the latest coalesced state
  });

  it('terminal frames bypass the throttle and cancel a pending trailing notify', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { port, controller } = make();
    let notifies = 0;
    controller.subscribe(() => {
      notifies += 1;
    });

    port.deliver({ type: 'progress', count: 5_000, done: false }); // leading → notify 1
    port.deliver({ type: 'progress', count: 10_000, done: false }); // trailing scheduled
    port.deliver({ type: 'cancelled' }); // urgent → notify 2, pending trailing cancelled

    expect(notifies).toBe(2);
    expect(controller.getSnapshot().status).toBe('cancelled');

    vi.advanceTimersByTime(NOTIFY_THROTTLE_MS * 3);
    expect(notifies).toBe(2); // no stale trailing notification fires afterwards
  });
});

describe('BlockController — PTY block, xterm mode (Phase 2 + Phase 3 upgraded)', () => {
  /** Puts the controller in xterm mode, as `pty-session.ts` does for `!cmd`
   * (forceXterm) or once its TuiSignalDetector fires — see the Phase 3
   * "plain mode" describe block below for the (now default) unupgraded path. */
  function upgrade(port: FakePort): void {
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({ type: 'pty-render-upgrade' });
  }

  it('routes pty-data to the registered sink and keeps it OUT of React state', () => {
    const { port, controller } = make();
    upgrade(port);
    const versionBefore = controller.getSnapshot().version;
    const received: Uint8Array[] = [];
    controller.setPtyDataSink((b) => received.push(b));

    port.deliver({ type: 'pty-data', data: new Uint8Array([1, 2, 3]) });

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([1, 2, 3]);
    // pty-data must NOT bump the snapshot version (no re-render churn).
    expect(controller.getSnapshot().version).toBe(versionBefore);
  });

  it('buffers pty-data that arrives before the sink, then flushes in order', () => {
    const { port, controller } = make();
    upgrade(port);
    port.deliver({ type: 'pty-data', data: new Uint8Array([1]) });
    port.deliver({ type: 'pty-data', data: new Uint8Array([2]) });

    const received: number[] = [];
    controller.setPtyDataSink((b) => received.push(b[0]));
    expect(received).toEqual([1, 2]); // flushed in arrival order on registration

    port.deliver({ type: 'pty-data', data: new Uint8Array([3]) });
    expect(received).toEqual([1, 2, 3]); // live after registration
  });

  it('preserves replay side-effect suppression through the pre-mount buffer and sink', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({
      type: 'pty-data',
      data: new Uint8Array([1]),
      suppressSideEffects: true,
    });
    port.deliver({ type: 'pty-render-upgrade' });
    port.deliver({ type: 'pty-data', data: new Uint8Array([2]) });

    const received: Array<{ byte: number; suppressSideEffects: boolean }> = [];
    controller.setPtyDataSink((bytes, _onFlushed, metadata) => {
      received.push({ byte: bytes[0], suppressSideEffects: metadata.suppressSideEffects });
    });
    port.deliver({ type: 'pty-data', data: new Uint8Array([3]) });

    expect(received).toEqual([
      { byte: 1, suppressSideEffects: true },
      { byte: 2, suppressSideEffects: false },
      { byte: 3, suppressSideEffects: false },
    ]);
  });

  it('unsubscribing the sink stops delivery', () => {
    const { port, controller } = make();
    upgrade(port);
    const received: number[] = [];
    const unsink = controller.setPtyDataSink((b) => received.push(b[0]));
    port.deliver({ type: 'pty-data', data: new Uint8Array([1]) });
    unsink();
    port.deliver({ type: 'pty-data', data: new Uint8Array([2]) });
    expect(received).toEqual([1]);
  });

  it('requeues unflushed xterm bytes across a sink-generation teardown', () => {
    const { port, controller } = make();
    upgrade(port);
    let staleFlush: (() => void) | null = null;
    const detach = controller.setPtyDataSink((_bytes, onFlushed) => {
      staleFlush = onFlushed;
    });
    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });

    detach();
    const replayed: number[] = [];
    controller.setPtyDataSink((bytes, onFlushed) => {
      replayed.push(bytes.byteLength);
      onFlushed();
    });
    (staleFlush as (() => void) | null)?.();

    expect(replayed).toEqual([PTY_ACK_QUANTUM]);
    expect(controller.getPtyFlowAccounting()).toEqual({
      received: PTY_ACK_QUANTUM,
      consumed: PTY_ACK_QUANTUM,
      acked: PTY_ACK_QUANTUM,
    });
  });

  it('requeues only the ordered unflushed suffix when xterm unmounts', () => {
    const { port, controller } = make();
    upgrade(port);
    const flushes: Array<() => void> = [];
    const detach = controller.setPtyDataSink((_bytes, onFlushed) => flushes.push(onFlushed));
    port.deliver({ type: 'pty-data', data: new Uint8Array([1]) });
    port.deliver({ type: 'pty-data', data: new Uint8Array([2]) });
    flushes[0]();

    detach();
    const replayed: number[] = [];
    controller.setPtyDataSink((bytes, onFlushed) => {
      replayed.push(bytes[0]);
      onFlushed();
    });

    expect(replayed).toEqual([2]);
    expect(controller.getPtyFlow()).toEqual({ received: 2, consumed: 2 });
  });

  it('sendPtyInput / sendPtyResize post the matching controls', () => {
    const { port, controller } = make();
    controller.sendPtyInput('ls\r');
    controller.sendPtyResize(120, 40);
    expect(port.posted).toContainEqual({ type: 'pty-input', data: 'ls\r' });
    expect(port.posted).toContainEqual({ type: 'pty-resize', cols: 120, rows: 40 });
  });

  it('a pty schema frame sets shape to pty (mounts the pty block)', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    expect(controller.getSnapshot().shape).toBe('pty');
  });

  it('preserves a restore warning until the next replay reset', () => {
    const { port, controller } = make({ mirror: true });
    port.deliver({
      type: 'pty-restore-warning',
      reason: 'serializer-failed',
      fallback: 'raw-ring',
      snapshotEpoch: 3,
      streamEpoch: 5,
    });
    expect(controller.getSnapshot().ptyRestoreWarning).toEqual({
      type: 'pty-restore-warning',
      reason: 'serializer-failed',
      fallback: 'raw-ring',
      snapshotEpoch: 3,
      streamEpoch: 5,
    });

    port.deliver({ type: 'pty-replay-reset' });
    expect(controller.getSnapshot().ptyRestoreWarning).toBeNull();
  });

  it('applies replay reset before warning and subsequent PTY data', () => {
    const { port, controller } = make({ mirror: true });
    const order: string[] = [];
    controller.setPtyReplayResetHandler(() => order.push('reset'));
    controller.setPlainDataSink(() => order.push('data'));

    port.deliver({ type: 'pty-replay-reset' });
    port.deliver({ type: 'pty-restore-warning', reason: 'semantic-gap', fallback: 'raw-ring' });
    order.push(controller.getSnapshot().ptyRestoreWarning ? 'warning' : 'missing-warning');
    port.deliver({ type: 'pty-data', data: new Uint8Array([0x78]) });

    expect(order).toEqual(['reset', 'warning', 'data']);
  });
});

describe('BlockController — paste seam (mobile long-press Paste, IME fix M3)', () => {
  it('falls back to a raw pty-input when no xterm view registered a handler', () => {
    const { port, controller } = make();
    controller.pasteText('line1\nline2');
    expect(port.posted).toContainEqual({ type: 'pty-input', data: 'line1\nline2' });
  });

  it('routes through the registered handler (term.paste → bracketed framing)', () => {
    const { port, controller } = make();
    const pasted: string[] = [];
    controller.setPasteHandler((text) => pasted.push(text));

    controller.pasteText('hello');

    expect(pasted).toEqual(['hello']);
    // The handler owns delivery — no raw pty-input alongside it.
    expect(port.posted.filter((m) => m.type === 'pty-input')).toHaveLength(0);
  });

  it('unregistering restores the raw fallback, and a stale unregister is a no-op', () => {
    const { port, controller } = make();
    const first: string[] = [];
    const unregisterFirst = controller.setPasteHandler((text) => first.push(text));
    unregisterFirst();
    controller.pasteText('raw again');
    expect(port.posted).toContainEqual({ type: 'pty-input', data: 'raw again' });

    // A replaced handler's unregister must not clobber the current one.
    const second: string[] = [];
    const unregisterA = controller.setPasteHandler(() => {});
    controller.setPasteHandler((text) => second.push(text));
    unregisterA(); // stale — current handler stays
    controller.pasteText('kept');
    expect(second).toEqual(['kept']);
  });
});

describe('BlockController — PTY block, plain mode (Phase 3 adaptive-render default)', () => {
  it('a pty schema frame defaults ptyRenderMode to plain (no upgrade yet)', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    expect(controller.getSnapshot().ptyRenderMode).toBe('plain');
  });

  it('routes pty-data to ansi->html and the registered plain sink, keeping it OUT of React state', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    const versionBefore = controller.getSnapshot().version;
    const received: string[] = [];
    controller.setPlainDataSink((html) => received.push(html));

    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('hello', 'utf8')) });

    expect(received.join('')).toContain('hello');
    expect(controller.getSnapshot().version).toBe(versionBefore);
  });

  it('delivers one large live PTY frame to the plain sink in bounded ordered fragments', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    const received: string[] = [];
    controller.setPlainDataSink((html) => received.push(html));
    const text = 'x'.repeat((ANSI_PENDING_MAX_CHARS * 2) + 17);

    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from(text, 'utf8')) });

    expect(received).toHaveLength(3);
    expect(received.every((html) => html.length <= ANSI_PENDING_MAX_CHARS)).toBe(true);
    expect(received.join('')).toBe(text);
    expect(controller.getPtyFlow()).toEqual({
      received: text.length,
      consumed: text.length,
    });
    expect(port.posted.filter((message) => message.type === 'pty-ack')).toEqual([
      { type: 'pty-ack', bytes: text.length },
    ]);
  });

  it('replays the already-accumulated HTML to a late-registering plain sink', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('early', 'utf8')) });

    const received: string[] = [];
    controller.setPlainDataSink((html) => received.push(html));
    expect(received.join('')).toContain('early'); // replayed on registration

    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('-late', 'utf8')) });
    expect(received.join('')).toContain('early');
    expect(received.join('')).toContain('-late');
  });

  it('replays a retained large PTY frame to a late plain sink in bounded fragments', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    const text = 'r'.repeat((ANSI_PENDING_MAX_CHARS * 2) + 31);
    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from(text, 'utf8')) });

    const replayed: string[] = [];
    controller.setPlainDataSink((html) => replayed.push(html));

    expect(replayed).toHaveLength(3);
    expect(replayed.every((html) => html.length <= ANSI_PENDING_MAX_CHARS)).toBe(true);
    expect(replayed.join('')).toBe(text);
  });

  it('acks IMMEDIATELY (no flush to wait for) once a quantum of plain bytes is received', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    controller.setPlainDataSink(() => {}); // a mounted plain view, never asked to flush anything

    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });

    expect(port.posted).toContainEqual({ type: 'pty-ack', bytes: PTY_ACK_QUANTUM });
    expect(controller.getPtyFlow()).toEqual({ received: PTY_ACK_QUANTUM, consumed: PTY_ACK_QUANTUM });
  });

  it('falls back to bounded raw xterm replay without stranding ACKs when the plain sink throws', () => {
    const { port, controller } = make();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    controller.setPlainDataSink(() => {
      throw new Error('synthetic DOM failure');
    });

    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });

    expect(controller.getSnapshot().ptyRenderMode).toBe('xterm');
    expect(controller.getPtyFlowAccounting()).toEqual({
      received: PTY_ACK_QUANTUM,
      consumed: PTY_ACK_QUANTUM,
      acked: PTY_ACK_QUANTUM,
    });
    expect(port.posted.filter((message) => message.type === 'pty-ack')).toEqual([
      { type: 'pty-ack', bytes: PTY_ACK_QUANTUM },
    ]);

    const replayed: number[] = [];
    controller.setPtyDataSink((bytes, onFlushed) => {
      replayed.push(bytes.byteLength);
      onFlushed();
    });
    expect(replayed).toEqual([PTY_ACK_QUANTUM]);
    expect(port.posted.filter((message) => message.type === 'pty-ack')).toHaveLength(1);
    expect(report).toHaveBeenCalledOnce();
    report.mockRestore();
  });

  it('publishes terminal completion after a plain DOM flush failure', () => {
    const { port, controller } = make();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failFlush = false;
    controller.setPlainDataSink(
      () => {},
      () => {
        if (failFlush) throw new Error('synthetic flush failure');
      },
    );
    failFlush = true;

    port.deliver({ type: 'end' });

    expect(controller.getSnapshot()).toMatchObject({
      status: 'done',
      ptyRenderMode: 'xterm',
    });
    expect(report).toHaveBeenCalledOnce();
    report.mockRestore();
  });

  it('flushes pending plain DOM output before publishing terminal completion', () => {
    const { port, controller } = make();
    const order: string[] = [];
    controller.setPlainDataSink(
      (html) => order.push(`data:${html}`),
      () => order.push('flush'),
    );
    order.length = 0; // Ignore the empty replay's registration flush.
    controller.subscribe(() => {
      if (controller.getSnapshot().status === 'done') order.push('done');
    });

    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('marker', 'utf8')) });
    port.deliver({ type: 'end' });

    expect(order).toEqual(['data:marker', 'flush', 'done']);
  });

  it.each([
    ['end', { type: 'end' }],
    ['error', { type: 'error', message: 'failed' }],
    ['cancelled', { type: 'cancelled' }],
  ] as const)('finishes a split UTF-8 tail before %s status publication', (_name, terminal) => {
    const { port, controller } = make();
    const order: string[] = [];
    controller.setPlainDataSink(
      (html) => order.push(`data:${html}`),
      () => order.push('flush'),
    );
    order.length = 0;
    controller.subscribe(() => {
      const status = controller.getSnapshot().status;
      if (status !== 'running') order.push(`status:${status}`);
    });

    port.deliver({ type: 'pty-data', data: new Uint8Array([0xe2, 0x82]) });
    port.deliver(terminal);

    expect(order[0]).toContain('data:\ufffd');
    expect(order[1]).toBe('flush');
    expect(order[2]).toMatch(/^status:/);
  });

  it('unsubscribing the plain sink stops delivery', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    const received: string[] = [];
    const unsink = controller.setPlainDataSink((html) => received.push(html));
    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('a', 'utf8')) });
    unsink();
    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('b', 'utf8')) });
    expect(received.join('')).toContain('a');
    expect(received.join('')).not.toContain('b');
  });
});

describe('BlockController — pty-render-upgrade (Phase 3, irreversible plain -> xterm)', () => {
  it('flips ptyRenderMode to xterm and drops the plain sink', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    const plainReceived: string[] = [];
    controller.setPlainDataSink((html) => plainReceived.push(html));

    port.deliver({ type: 'pty-render-upgrade' });
    expect(controller.getSnapshot().ptyRenderMode).toBe('xterm');

    // The plain sink is no longer fed (it is about to unmount).
    port.deliver({ type: 'pty-data', data: new Uint8Array(Buffer.from('after-upgrade', 'utf8')) });
    expect(plainReceived.join('')).not.toContain('after-upgrade');
  });

  it('replays everything buffered during plain mode into a freshly-registered xterm sink', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({ type: 'pty-data', data: new Uint8Array([1, 2]) }); // plain-mode bytes
    port.deliver({ type: 'pty-render-upgrade' });
    port.deliver({ type: 'pty-data', data: new Uint8Array([3]) }); // arrives before xterm mounts

    const received: number[] = [];
    controller.setPtyDataSink((b) => received.push(...b));
    expect(received).toEqual([1, 2, 3]); // full history, in order, at mount time

    port.deliver({ type: 'pty-data', data: new Uint8Array([4]) }); // live after mount
    expect(received).toEqual([1, 2, 3, 4]);
  });

  it('accounting stays monotonic across a plain -> xterm transition (no ack regression)', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) }); // plain: acks immediately
    const acksSoFar = port.posted.filter((m) => m.type === 'pty-ack').map((m) => (m as { bytes: number }).bytes);
    expect(acksSoFar).toEqual([PTY_ACK_QUANTUM]);

    port.deliver({ type: 'pty-render-upgrade' });
    controller.setPtyDataSink((_bytes, onFlushed) => onFlushed()); // xterm flushes replay immediately

    const acksAfter = port.posted.filter((m) => m.type === 'pty-ack').map((m) => (m as { bytes: number }).bytes);
    // Every reported cumulative value is non-decreasing — never a regression.
    for (let i = 1; i < acksAfter.length; i++) {
      expect(acksAfter[i]).toBeGreaterThanOrEqual(acksAfter[i - 1]);
    }
  });

  it('never consumes or ACKs plain history a second time during xterm replay', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });
    expect(controller.getPtyFlowAccounting()).toEqual({
      received: PTY_ACK_QUANTUM,
      consumed: PTY_ACK_QUANTUM,
      acked: PTY_ACK_QUANTUM,
    });

    port.deliver({ type: 'pty-render-upgrade' });
    controller.setPtyDataSink((_bytes, onFlushed) => {
      onFlushed();
      onFlushed(); // an erroneous duplicate callback is idempotent too
    });

    expect(controller.getPtyFlowAccounting()).toEqual({
      received: PTY_ACK_QUANTUM,
      consumed: PTY_ACK_QUANTUM,
      acked: PTY_ACK_QUANTUM,
    });
    expect(port.posted.filter((message) => message.type === 'pty-ack')).toEqual([
      { type: 'pty-ack', bytes: PTY_ACK_QUANTUM },
    ]);
  });

  it('keeps plain replay history within the active default scrollback', () => {
    const { port, controller } = make();
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({
      type: 'pty-data',
      data: new Uint8Array(Buffer.from('line\n'.repeat(6_000), 'utf8')),
    });

    expect(controller.getPtyRetention().lineBreaks).toBeLessThanOrEqual(4_999);
    expect(controller.getPtyRetention().bytes).toBeLessThan(6_000 * 5);
    const replay: string[] = [];
    controller.setPlainDataSink((html) => replay.push(html));
    expect(replay.join('')).not.toBe('');
  });
});

describe('BlockController — ssh-connect prompt (E5)', () => {
  it('an ssh-prompt frame populates snapshot.sshPrompt (urgent notify)', () => {
    const { port, controller } = make();
    let notifies = 0;
    controller.subscribe(() => {
      notifies += 1;
    });

    port.deliver({ type: 'ssh-prompt', promptId: 'p1', kind: 'password', message: 'Password for a@b:' });

    expect(notifies).toBe(1);
    expect(controller.getSnapshot().sshPrompt).toEqual({
      promptId: 'p1',
      kind: 'password',
      message: 'Password for a@b:',
      fingerprint: undefined,
      host: undefined,
    });
  });

  it('a schema frame clears sshPrompt (the channel is up, prompt phase is over)', () => {
    const { port, controller } = make();
    port.deliver({ type: 'ssh-prompt', promptId: 'p1', kind: 'password', message: 'Password:' });
    expect(controller.getSnapshot().sshPrompt).not.toBeNull();

    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    expect(controller.getSnapshot().sshPrompt).toBeNull();
  });

  it('an error frame clears sshPrompt (e.g. a host-key mismatch hard fail)', () => {
    const { port, controller } = make();
    port.deliver({ type: 'ssh-prompt', promptId: 'p1', kind: 'hostkey', message: 'Unknown host', fingerprint: 'SHA256:x' });
    port.deliver({ type: 'error', message: 'host key mismatch' });
    expect(controller.getSnapshot().sshPrompt).toBeNull();
  });

  it('a cancelled frame clears sshPrompt', () => {
    const { port, controller } = make();
    port.deliver({ type: 'ssh-prompt', promptId: 'p1', kind: 'password', message: 'Password:' });
    port.deliver({ type: 'cancelled' });
    expect(controller.getSnapshot().sshPrompt).toBeNull();
  });

  it('sendSshPromptResponse posts the control and clears the prompt locally', () => {
    const { port, controller } = make();
    port.deliver({ type: 'ssh-prompt', promptId: 'p1', kind: 'password', message: 'Password:' });

    controller.sendSshPromptResponse('p1', { value: 'hunter2' });

    expect(port.posted).toContainEqual({ type: 'ssh-prompt-response', promptId: 'p1', value: 'hunter2' });
    expect(controller.getSnapshot().sshPrompt).toBeNull();
  });

  it('sendSshPromptResponse for a hostkey decision sends accept/reject', () => {
    const { port, controller } = make();
    port.deliver({ type: 'ssh-prompt', promptId: 'p2', kind: 'hostkey', message: 'Unknown host', fingerprint: 'SHA256:x' });

    controller.sendSshPromptResponse('p2', { accept: true });

    expect(port.posted).toContainEqual({ type: 'ssh-prompt-response', promptId: 'p2', accept: true });
  });

  it('a stale promptId still posts the control but does not touch an unrelated live prompt', () => {
    const { port, controller } = make();
    port.deliver({ type: 'ssh-prompt', promptId: 'current', kind: 'password', message: 'Password:' });

    controller.sendSshPromptResponse('some-other-stale-id', { value: 'x' });

    expect(port.posted).toContainEqual({ type: 'ssh-prompt-response', promptId: 'some-other-stale-id', value: 'x' });
    expect(controller.getSnapshot().sshPrompt).toEqual(
      expect.objectContaining({ promptId: 'current' }),
    );
  });
});

describe('BlockController — pty-ack backpressure (Stage C, xterm mode)', () => {
  const acks = (posted: { type: string }[]): number[] =>
    posted.filter((m): m is { type: 'pty-ack'; bytes: number } => m.type === 'pty-ack')
      .map((m) => m.bytes);

  /** Puts the controller in xterm mode before any pty-data (see the Phase 3
   * "plain mode" describe block above for the now-default unupgraded path,
   * which acks immediately rather than on xterm's flush callback). */
  function upgrade(port: FakePort): void {
    port.deliver({ type: 'schema', shape: 'pty', columns: [] });
    port.deliver({ type: 'pty-render-upgrade' });
  }

  it('acks CUMULATIVE flushed bytes once per quantum — only when xterm flushes', () => {
    const { port, controller } = make();
    upgrade(port);
    // Sink that captures flush callbacks so the test controls WHEN xterm drains.
    const pendingFlushes: Array<() => void> = [];
    controller.setPtyDataSink((_bytes, onFlushed) => pendingFlushes.push(onFlushed));

    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });
    expect(acks(port.posted)).toEqual([]); // received but NOT flushed → no ack

    pendingFlushes.shift()?.(); // xterm flushed the first chunk
    expect(acks(port.posted)).toEqual([PTY_ACK_QUANTUM]);

    // Sub-quantum flushes accumulate without acking…
    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM - 1) });
    pendingFlushes.shift()?.();
    expect(acks(port.posted)).toEqual([PTY_ACK_QUANTUM]);
    // …until the next quantum boundary (cumulative value, not a delta).
    port.deliver({ type: 'pty-data', data: new Uint8Array(1) });
    pendingFlushes.shift()?.();
    expect(acks(port.posted)).toEqual([PTY_ACK_QUANTUM, PTY_ACK_QUANTUM * 2]);
  });

  it('pre-sink buffered bytes are counted as received but never acked until flushed', () => {
    const { port, controller } = make();
    upgrade(port);
    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM * 2) });
    expect(controller.getPtyFlow()).toEqual({ received: PTY_ACK_QUANTUM * 2, consumed: 0 });
    expect(acks(port.posted)).toEqual([]); // no sink → no flush → interpreter stays paused

    // Sink registration flushes the buffer through the SAME ack path.
    controller.setPtyDataSink((_bytes, onFlushed) => onFlushed());
    expect(controller.getPtyFlow()).toEqual({
      received: PTY_ACK_QUANTUM * 2,
      consumed: PTY_ACK_QUANTUM * 2,
    });
    expect(acks(port.posted)).toEqual([PTY_ACK_QUANTUM * 2]);
  });

  it('counts a live xterm flush exactly once even if its callback fires twice', () => {
    const { port, controller } = make();
    upgrade(port);
    controller.setPtyDataSink((_bytes, onFlushed) => {
      onFlushed();
      onFlushed();
    });

    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });

    expect(controller.getPtyFlowAccounting()).toEqual({
      received: PTY_ACK_QUANTUM,
      consumed: PTY_ACK_QUANTUM,
      acked: PTY_ACK_QUANTUM,
    });
    expect(acks(port.posted)).toEqual([PTY_ACK_QUANTUM]);
  });

  it('ignores a late flush callback after replay reset', () => {
    const { port, controller } = make();
    upgrade(port);
    let lateFlush: (() => void) | null = null;
    controller.setPtyDataSink((_bytes, onFlushed) => {
      lateFlush = onFlushed;
    });
    port.deliver({ type: 'pty-data', data: new Uint8Array(PTY_ACK_QUANTUM) });
    port.deliver({ type: 'pty-replay-reset' });

    (lateFlush as (() => void) | null)?.();

    expect(controller.getPtyFlowAccounting()).toEqual({
      received: 0,
      consumed: 0,
      acked: 0,
    });
  });
});

describe('BlockController — mirror mode / pty-dims (mobile mirroring fix, D3/D4)', () => {
  it('isMirror defaults to false when constructed without opts', () => {
    const { controller } = make();
    expect(controller.isMirror).toBe(false);
  });

  it('isMirror is true when constructed with {mirror: true}', () => {
    const { controller } = make({ mirror: true });
    expect(controller.isMirror).toBe(true);
  });

  it('ptyDims defaults to null', () => {
    const { controller } = make();
    expect(controller.getSnapshot().ptyDims).toBeNull();
  });

  it('a pty-dims frame updates snapshot.ptyDims and notifies', () => {
    const { port, controller } = make({ mirror: true });
    let notifies = 0;
    controller.subscribe(() => {
      notifies += 1;
    });

    port.deliver({ type: 'pty-dims', cols: 100, rows: 30 });

    expect(notifies).toBe(1);
    expect(controller.getSnapshot().ptyDims).toEqual({ cols: 100, rows: 30 });
  });

  it('a later pty-dims frame replaces the previous dims', () => {
    const { port, controller } = make({ mirror: true });
    port.deliver({ type: 'pty-dims', cols: 100, rows: 30 });
    port.deliver({ type: 'pty-dims', cols: 80, rows: 24 });
    expect(controller.getSnapshot().ptyDims).toEqual({ cols: 80, rows: 24 });
  });
});

describe('BlockController — control handoff (M8b, dynamic hasControl)', () => {
  it('hasControl starts true for a primary (no mirror opt)', () => {
    const { controller } = make();
    expect(controller.getSnapshot().hasControl).toBe(true);
  });

  it('hasControl starts false for an attach mirror', () => {
    const { controller } = make({ mirror: true });
    expect(controller.getSnapshot().hasControl).toBe(false);
  });

  it('a pty-control frame updates hasControl and notifies', () => {
    const { port, controller } = make({ mirror: true });
    let notifies = 0;
    controller.subscribe(() => {
      notifies += 1;
    });

    port.deliver({ type: 'pty-control', hasControl: true });

    expect(notifies).toBe(1);
    expect(controller.getSnapshot().hasControl).toBe(true);
  });

  it('a later pty-control frame can revert hasControl back to false', () => {
    const { port, controller } = make();
    port.deliver({ type: 'pty-control', hasControl: false });
    expect(controller.getSnapshot().hasControl).toBe(false);
    port.deliver({ type: 'pty-control', hasControl: true });
    expect(controller.getSnapshot().hasControl).toBe(true);
  });

  it('claimControl() posts a pty-claim-control control', () => {
    const { port, controller } = make({ mirror: true });
    controller.claimControl();
    expect(port.posted).toContainEqual({ type: 'pty-claim-control' });
  });
});
