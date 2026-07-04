/**
 * Bounded ring buffer feeding the packet-capture host's throttled flush
 * (Phase 2B, off-by-default packet preview). Pure logic — deliberately has NO
 * import of `cap`, so it is directly unit-testable in vitest without touching
 * the native module. packet-capture-host.ts (which DOES `require('cap')`) is
 * excluded from vitest's plain-Node run for exactly that reason — see its own
 * header comment.
 *
 * Spike numbers (.omc/artifacts/packet-spike/results-rerun.md §4): ordinary
 * LAN traffic already bursts to 150-195 packets/sec, ~15-20x the plan's
 * ≤10 msg/s renderer throttle budget. A naive one-message-per-packet (or
 * unbounded-queue) design would flood the renderer or grow memory unbounded.
 * This buffer caps at `capacity` rows and drops the OLDEST once full; the
 * host drains it on a fixed `PACKET_FLUSH_INTERVAL_MS` timer (10 times/sec —
 * the ≤10 msg/s budget), so under sustained overload the renderer sees a gap
 * in the preview rather than an ever-growing backlog or unbounded memory.
 */

import type { PacketRow } from '../shared/ipc';

/** Max rows held between flushes; oldest rows drop once exceeded. */
export const PACKET_RING_CAPACITY = 500;

/** Flush cadence — 10/sec, matching the plan's ≤10 msg/s renderer throttle. */
export const PACKET_FLUSH_INTERVAL_MS = 100;

export class PacketRingBuffer {
  private readonly rows: PacketRow[] = [];

  constructor(private readonly capacity: number) {}

  /** Append one row, dropping the oldest if already at capacity. */
  push(row: PacketRow): void {
    this.rows.push(row);
    if (this.rows.length > this.capacity) this.rows.shift();
  }

  /** Return and clear everything buffered since the last drain. */
  drain(): PacketRow[] {
    return this.rows.splice(0, this.rows.length);
  }

  get size(): number {
    return this.rows.length;
  }
}
