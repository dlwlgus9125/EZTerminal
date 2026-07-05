/**
 * packet-capture-host.ts (Phase 2B failure paths + M3's multi-port fan-out).
 *
 * `cap` is a real native module in node_modules (prebuilt for Electron's Node
 * ABI), so under plain Node (this vitest run) requiring it for real always
 * throws an ABI-mismatch error — permanent and by design, not environment-
 * specific (see the module's own header comment: "MUST NEVER be imported from
 * a plain-Node vitest run — it would ABI-mismatch outside Electron"). The
 * 'throw' scenario below therefore needs no stub at all: requiring the REAL
 * module already reproduces `npcap-missing` exactly.
 *
 * For the other three states, the real native module can't be exercised
 * (no Npcap device in CI), so those tests fake `cap`'s behavior. `vi.mock`/
 * `vi.doMock` do NOT work here: they only intercept `import`/dynamic
 * `import()`, which vite-node rewrites — but `packet-capture-host.ts` calls
 * the raw `require('cap')` global (deliberately, so a load failure is
 * catchable synchronously; see its own header comment), which bypasses
 * vite-node's transform entirely and resolves through Node's REAL module
 * system (confirmed empirically: mocking made no difference to what
 * `require('cap')` returned). Instead, `stubCap()` below pre-populates
 * Node's actual `require.cache` (keyed by `cap`'s resolved file path) — the
 * same cache `require()` itself checks first, before ever touching the real
 * native binary — with a fake module. `vi.resetModules()` only clears
 * vite-node's OWN module graph, not this Node-level cache, so the stub
 * installed by `stubCap()` survives across the fresh re-imports below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PACKET_FLUSH_INTERVAL_MS } from './packet-ring-buffer';

type CapMode = 'throw' | 'device-not-found' | 'open-fails' | 'capturing';

/** Written to by the fake `Cap` instance's methods, read by test assertions —
 * a side channel for observing `close()`/the registered packet listener. */
const capState = {
  packetListener: null as ((nbytes: number, truncated: boolean) => void) | null,
  closed: false,
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CAP_PATH = require.resolve('cap');

function fakeCapModule(mode: Exclude<CapMode, 'throw'>): unknown {
  return {
    Cap: class {
      static findDevice(): string | undefined {
        return mode === 'device-not-found' ? undefined : 'eth0';
      }
      open(): string {
        if (mode === 'open-fails') throw new Error('EPERM');
        return 'ETHERNET';
      }
      setMinBytes(): void {
        /* no-op */
      }
      on(event: string, cb: (nbytes: number, truncated: boolean) => void): void {
        if (event === 'packet') capState.packetListener = cb;
      }
      close(): void {
        capState.closed = true;
      }
    },
    decoders: {
      Ethernet: () => ({ info: { type: 1 }, offset: 14 }),
      IPV4: (_buf: Buffer, offset: number) => ({
        info: { srcaddr: '10.0.0.1', dstaddr: '10.0.0.2', protocol: 6 },
        offset,
        hdrlen: 20,
      }),
      PROTOCOL: { ETHERNET: { IPV4: 1 }, IP: { 6: 'TCP' } },
    },
  };
}

/** Installs (or removes) the `require.cache` stub for `cap`'s resolved path. */
function stubCap(mode: CapMode): void {
  if (mode === 'throw') {
    delete require.cache[CAP_PATH]; // no stub — the real ABI-mismatched module throws
    return;
  }
  require.cache[CAP_PATH] = {
    id: CAP_PATH,
    filename: CAP_PATH,
    loaded: true,
    exports: fakeCapModule(mode),
  } as NodeModule;
}

type MessageHandler = (event: { data: unknown; ports: readonly unknown[] }) => void;

/** Stubs `cap`, resets the module cache, and re-imports the host fresh —
 * returning the message handler it registers via
 * `process.parentPort.on('message', ...)`. */
async function importHost(mode: CapMode): Promise<MessageHandler> {
  stubCap(mode);
  vi.resetModules();
  capState.packetListener = null;
  capState.closed = false;
  let messageHandler: MessageHandler | undefined;
  (process as unknown as { parentPort: { on: (event: string, cb: MessageHandler) => void } }).parentPort = {
    on: (event, cb) => {
      if (event === 'message') messageHandler = cb;
    },
  };
  await import('./packet-capture-host');
  expect(messageHandler).toBeDefined();
  return messageHandler!;
}

/** A fake `MessagePortMain` — tracks posted frames and lets a test fire 'close'. */
function makeFakePort(): {
  postMessage: (msg: unknown) => void;
  on: (event: string, cb: () => void) => void;
  close: () => void;
  posted: unknown[];
  triggerClose: () => void;
} {
  const posted: unknown[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    postMessage: (msg: unknown) => posted.push(msg),
    on: (event, cb) => {
      if (event === 'close') closeHandlers.push(cb);
    },
    close: () => undefined,
    posted,
    triggerClose: () => {
      for (const h of closeHandlers) h();
    },
  };
}

describe('packet-capture-host', () => {
  afterEach(() => {
    delete require.cache[CAP_PATH];
  });

  describe('npcap-missing path', () => {
    it('sends status:npcap-missing over the port when `cap` fails to load', async () => {
      const messageHandler = await importHost('throw');
      const port = makeFakePort();

      messageHandler({ data: { type: 'init' }, ports: [port] });

      expect(port.posted).toEqual([{ type: 'status', status: 'npcap-missing' }]);
    });

    it('keeps the message loop alive: a late add-port is immediately replayed the failure status', async () => {
      const messageHandler = await importHost('throw');
      const primary = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [primary] });
      expect(primary.posted).toEqual([{ type: 'status', status: 'npcap-missing' }]);

      const late = makeFakePort();
      messageHandler({ data: { type: 'add-port' }, ports: [late] });

      expect(late.posted).toEqual([{ type: 'status', status: 'npcap-missing' }]);
      // The already-attached port is not re-sent to on a later add-port.
      expect(primary.posted).toHaveLength(1);
    });
  });

  describe('device/permission failure paths', () => {
    it('sends status:error when no capture device is found', async () => {
      const messageHandler = await importHost('device-not-found');
      const port = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [port] });
      expect(port.posted).toEqual([{ type: 'status', status: 'error' }]);
    });

    it('sends status:access-denied when opening the device throws', async () => {
      const messageHandler = await importHost('open-fails');
      const port = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [port] });
      expect(port.posted).toEqual([{ type: 'status', status: 'access-denied' }]);
    });
  });

  describe('capturing path — multi-port fan-out', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('broadcasts status:capturing to the init port, and replays it to N late-attached ports', async () => {
      const messageHandler = await importHost('capturing');
      const primary = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [primary] });
      expect(primary.posted).toEqual([{ type: 'status', status: 'capturing' }]);

      const viewerA = makeFakePort();
      messageHandler({ data: { type: 'add-port' }, ports: [viewerA] });
      expect(viewerA.posted).toEqual([{ type: 'status', status: 'capturing' }]);

      const viewerB = makeFakePort();
      messageHandler({ data: { type: 'add-port' }, ports: [viewerB] });
      expect(viewerB.posted).toEqual([{ type: 'status', status: 'capturing' }]);
    });

    it('fans out a captured packet batch to every attached port', async () => {
      const messageHandler = await importHost('capturing');
      const primary = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [primary] });
      const viewer = makeFakePort();
      messageHandler({ data: { type: 'add-port' }, ports: [viewer] });

      expect(capState.packetListener).toBeDefined();
      capState.packetListener!(60, false);
      vi.advanceTimersByTime(PACKET_FLUSH_INTERVAL_MS);

      const expectedBatch = {
        type: 'packets',
        rows: [{ at: expect.any(Number), src: '10.0.0.1', dst: '10.0.0.2', proto: 'TCP', len: 60 }],
      };
      expect(primary.posted).toContainEqual(expectedBatch);
      expect(viewer.posted).toContainEqual(expectedBatch);
    });

    it('prunes a port on its own close — no further frames are sent to it', async () => {
      const messageHandler = await importHost('capturing');
      const primary = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [primary] });
      const viewer = makeFakePort();
      messageHandler({ data: { type: 'add-port' }, ports: [viewer] });

      viewer.triggerClose();

      capState.packetListener!(60, false);
      vi.advanceTimersByTime(PACKET_FLUSH_INTERVAL_MS);

      expect(viewer.posted.some((m) => (m as { type: string }).type === 'packets')).toBe(false);
      expect(primary.posted.some((m) => (m as { type: string }).type === 'packets')).toBe(true);
    });

    it('closing the PRIMARY (init) port stops capture entirely (clears the flush timer, closes the device)', async () => {
      const messageHandler = await importHost('capturing');
      const primary = makeFakePort();
      messageHandler({ data: { type: 'init' }, ports: [primary] });
      const viewer = makeFakePort();
      messageHandler({ data: { type: 'add-port' }, ports: [viewer] });

      primary.triggerClose();
      expect(capState.closed).toBe(true);

      const postedBefore = viewer.posted.length;
      capState.packetListener?.(60, false);
      vi.advanceTimersByTime(PACKET_FLUSH_INTERVAL_MS * 2);
      expect(viewer.posted.length).toBe(postedBefore); // timer cleared — no further flush
    });
  });
});
