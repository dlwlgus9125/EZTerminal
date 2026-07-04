/**
 * Packet-capture utilityProcess entry (Phase 2B, off-by-default packet
 * preview sub-view). Forked by main PER SUBSCRIPTION (only main can fork a
 * utilityProcess — same reason script-host.ts/interpreter-process.ts are
 * forked by main, not by each other). Main hands this process one half of a
 * fresh MessageChannelMain via the `init` message; the OTHER half goes
 * straight to the renderer (main never relays packet traffic — see
 * src/shared/ipc.ts's packet-capture section and src/main/main.ts's
 * `packet-port` broker). Everything below flows over that port directly to
 * the renderer: both the batched `PacketBatchFrame`s and the
 * `PacketStatusFrame` status changes.
 *
 * SECURITY: header-only capture — src/dst IP, protocol name, and total frame
 * length ONLY. Payload bytes are read into the libpcap buffer (required to
 * decode headers) but never copied into a PacketRow, logged, or written to
 * disk.
 *
 * `cap` is the only maintained packet-capture binding for Node (spike:
 * .omc/artifacts/packet-spike/results-rerun.md §5) but requires Npcap on
 * Windows and is a real native module — `require('cap')` throws a catchable
 * error when Npcap/wpcap.dll is absent, reported as `npcap-missing` rather
 * than crashing the host. This file therefore `require()`s `cap` LAZILY,
 * inside the message handler's try/catch (never at module top-level, where a
 * throw would kill the process before any status could be reported), and
 * MUST NEVER be imported from a plain-Node vitest run — it would ABI-mismatch
 * outside Electron (see forge.config.ts's rebuild-hook comments). B5 mocks
 * this module and unit-tests the pure ring-buffer/throttle logic in
 * packet-ring-buffer.ts instead.
 */

import type { MessagePortMain } from 'electron';
import type { PacketCaptureFrame, PacketRow } from '../shared/ipc';
import { PACKET_FLUSH_INTERVAL_MS, PACKET_RING_CAPACITY, PacketRingBuffer } from './packet-ring-buffer';

type ElectronMsgEvent = { data: unknown; ports: ReadonlyArray<unknown> };

// cap ships no types (and no @types/cap exists); this shape matches its
// README exactly (node_modules/cap/README.md — Cap, decoders, PROTOCOL).
interface CapModule {
  Cap: CapStatic;
  decoders: {
    Ethernet(buf: Buffer, offset?: number): { info: { type: number }; offset: number };
    IPV4(
      buf: Buffer,
      offset: number,
    ): {
      info: { srcaddr: string; dstaddr: string; protocol: number };
      offset: number;
      hdrlen: number;
    };
    PROTOCOL: {
      ETHERNET: { readonly IPV4: number };
      IP: Record<number, string>;
    };
  };
}
interface CapInstance {
  open(device: string, filter: string, bufSize: number, buffer: Buffer): string;
  close(): void;
  setMinBytes?(n: number): void;
  on(event: 'packet', listener: (nbytes: number, truncated: boolean) => void): void;
}
interface CapStatic {
  new (): CapInstance;
  /** No-arg form (used here): first non-loopback device (README "Cap static methods"). */
  findDevice(): string | undefined;
}

function send(port: MessagePortMain, frame: PacketCaptureFrame): void {
  try {
    port.postMessage(frame);
  } catch {
    // Port already gone (renderer unsubscribed/closed) — nothing to send to.
  }
}

process.parentPort.once('message', (event: ElectronMsgEvent) => {
  const port = event.ports[0] as unknown as MessagePortMain;

  let cap: CapModule;
  try {
    // Lazy, catchable load (see header comment) — a static `import` would
    // throw at module-evaluation time, before this try/catch could run.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cap = require('cap') as CapModule;
  } catch {
    send(port, { type: 'status', status: 'npcap-missing' });
    return;
  }

  // `Cap.findDevice()` with no argument returns the first non-loopback device
  // (cap's own default-device heuristic).
  const device = cap.Cap.findDevice();
  if (!device) {
    send(port, { type: 'status', status: 'error' });
    return;
  }

  const c = new cap.Cap();
  const bufSize = 10 * 1024 * 1024;
  const buffer = Buffer.alloc(65535);
  let linkType: string;
  try {
    // '' filter — no BPF filter; capture everything and let OUR header parse
    // below decide what becomes a PacketRow (never the payload itself).
    linkType = c.open(device, '', bufSize, buffer);
    c.setMinBytes?.(0);
  } catch {
    // Npcap loaded fine (require succeeded above) but opening the device
    // failed — the spike's designated meaning for this failure mode is a
    // permissions restriction (some Npcap installs restrict capture to
    // admin), not re-diagnosed further here.
    send(port, { type: 'status', status: 'access-denied' });
    return;
  }

  const ring = new PacketRingBuffer(PACKET_RING_CAPACITY);
  const { PROTOCOL } = cap.decoders;

  c.on('packet', (nbytes) => {
    if (linkType !== 'ETHERNET') return;
    const eth = cap.decoders.Ethernet(buffer, 0);
    // Minimal parsing (plan scope): IPv4 only, matching the spike's own
    // demonstrated coverage. Other ethertypes (ARP, IPv6, VLAN, ...) are
    // skipped rather than guessed at.
    if (eth.info.type !== PROTOCOL.ETHERNET.IPV4) return;
    const ip = cap.decoders.IPV4(buffer, eth.offset);
    const row: PacketRow = {
      at: Date.now(),
      src: ip.info.srcaddr,
      dst: ip.info.dstaddr,
      proto: PROTOCOL.IP[ip.info.protocol] ?? String(ip.info.protocol),
      len: nbytes,
    };
    ring.push(row);
  });

  const flushTimer = setInterval(() => {
    const rows = ring.drain();
    if (rows.length > 0) send(port, { type: 'packets', rows });
  }, PACKET_FLUSH_INTERVAL_MS);

  send(port, { type: 'status', status: 'capturing' });

  const stop = (): void => {
    clearInterval(flushTimer);
    try {
      c.close();
    } catch {
      // Already closed / device gone — nothing more to do.
    }
  };
  port.on('close', stop);
});
