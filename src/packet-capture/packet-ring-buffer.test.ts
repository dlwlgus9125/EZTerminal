/**
 * PacketRingBuffer unit tests (status-panel-v2 Phase 2B, B5). Pure logic, no
 * `cap`/Electron involved — see packet-ring-buffer.ts's own header for why
 * this is the one file in src/packet-capture/ safe to import directly here.
 */
import { describe, expect, it } from 'vitest';

import type { PacketRow } from '../shared/ipc';
import { PACKET_FLUSH_INTERVAL_MS, PACKET_RING_CAPACITY, PacketRingBuffer } from './packet-ring-buffer';

function row(at: number): PacketRow {
  return { at, src: '10.0.0.1:1234', dst: '10.0.0.2:80', proto: 'TCP', len: 60 };
}

describe('PacketRingBuffer', () => {
  it('drops the OLDEST row once past capacity (bounded memory under the spike-observed 150-195pps burst)', () => {
    const buf = new PacketRingBuffer(3);
    buf.push(row(1));
    buf.push(row(2));
    buf.push(row(3));
    buf.push(row(4));

    expect(buf.drain().map((r) => r.at)).toEqual([2, 3, 4]);
  });

  it('drain() empties the buffer and returns rows in insertion order', () => {
    const buf = new PacketRingBuffer(10);
    buf.push(row(1));
    buf.push(row(2));
    buf.push(row(3));

    expect(buf.size).toBe(3);
    expect(buf.drain()).toEqual([row(1), row(2), row(3)]);
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it('matches the plan capacity/throttle budget: 500-row ring, 10Hz flush (<=10 msg/s)', () => {
    expect(PACKET_RING_CAPACITY).toBe(500);
    expect(PACKET_FLUSH_INTERVAL_MS).toBe(100);
    expect(1000 / PACKET_FLUSH_INTERVAL_MS).toBeLessThanOrEqual(10);
  });
});
