import { describe, expect, it } from 'vitest';

import {
  base64ToUint8Array,
  decodeFrame,
  encodeFrame,
  uint8ArrayToBase64,
  type ClientToServerMessage,
  type ServerToClientMessage,
  type WireInterpreterFrame,
} from './remote-protocol';
import type { InterpreterFrame } from './ipc';

describe('remote-protocol — base64 Uint8Array round-trip', () => {
  it('round-trips an empty array', () => {
    const bytes = new Uint8Array(0);
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips arbitrary bytes (including 0x00 and 0xff)', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 42]);
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips a chunk-boundary-crossing payload (> 0x8000 bytes)', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 137);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const roundTripped = base64ToUint8Array(uint8ArrayToBase64(bytes));
    expect(roundTripped).toEqual(bytes);
  });

  it('round-trips text-decodable PTY-like output byte-for-byte', () => {
    const text = 'hello \x1b[31mworld\x1b[0m\n';
    const bytes = new TextEncoder().encode(text);
    const roundTripped = base64ToUint8Array(uint8ArrayToBase64(bytes));
    expect(new TextDecoder().decode(roundTripped)).toBe(text);
  });
});

describe('remote-protocol - guarded session destroy', () => {
  it('keeps the correlated request and result JSON-safe', () => {
    const request = {
      kind: 'destroy-session-guarded',
      requestId: 'close-1',
      sessionId: 'session-1',
      expectedActiveRunIds: ['run-1', 'run-2'],
    } satisfies ClientToServerMessage;
    const reply = {
      kind: 'session-destroy-result',
      requestId: 'close-1',
      result: { ok: false, reason: 'state-changed' },
    } satisfies ServerToClientMessage;

    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
  });
});

describe('remote-protocol - Quick Commands capability', () => {
  it('keeps the capability and bounded read-only reply JSON-safe', () => {
    const auth = {
      kind: 'auth-ok',
      capabilities: ['quick-commands-read'],
    } satisfies ServerToClientMessage;
    const request = {
      kind: 'quick-commands-list',
      requestId: 'quick-1',
    } satisfies ClientToServerMessage;
    const reply = {
      kind: 'quick-commands-list-reply',
      requestId: 'quick-1',
      ok: true,
      commands: [{
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Status',
        command: 'git status',
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      }],
    } satisfies ServerToClientMessage;

    expect(JSON.parse(JSON.stringify(auth))).toEqual(auth);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
  });
});

describe('remote-protocol — encodeFrame/decodeFrame', () => {
  it('encodes a pty-data frame\'s Uint8Array as base64 text', () => {
    const frame: InterpreterFrame = { type: 'pty-data', data: new Uint8Array([1, 2, 3]) };
    const wire = encodeFrame(frame);
    expect(wire.type).toBe('pty-data');
    expect(typeof (wire as { data: unknown }).data).toBe('string');
  });

  it('decodeFrame(encodeFrame(x)) round-trips a pty-data frame losslessly', () => {
    const original: InterpreterFrame = {
      type: 'pty-data',
      data: new Uint8Array([0, 10, 20, 255, 7]),
    };
    const decoded = decodeFrame(encodeFrame(original));
    expect(decoded).toEqual(original);
  });

  it('preserves replay side-effect suppression through the base64 wire codec', () => {
    const replay: InterpreterFrame = {
      type: 'pty-data',
      data: new Uint8Array([27, 93, 53, 50]),
      suppressSideEffects: true,
    };

    const wire = encodeFrame(replay);
    expect(wire).toMatchObject({ type: 'pty-data', suppressSideEffects: true });
    expect(decodeFrame(wire)).toEqual(replay);
  });

  it('passes non-pty-data frames through encodeFrame/decodeFrame unchanged', () => {
    const frames: InterpreterFrame[] = [
      { type: 'start', commandText: 'ls', cwd: '/home' },
      { type: 'schema', columns: [{ name: 'a', type: 'string' }], shape: 'table' },
      { type: 'chunk', start: 0, rows: [{ a: 'x' }] },
      { type: 'progress', count: 1, done: true },
      { type: 'end', cwd: '/home', exitCode: 17 },
      { type: 'error', message: 'boom' },
      { type: 'cancelled' },
      { type: 'pty-render-upgrade' },
      {
        type: 'pty-restore-warning',
        reason: 'serializer-failed',
        fallback: 'raw-ring',
        snapshotEpoch: 2,
        streamEpoch: 4,
      },
    ];
    for (const frame of frames) {
      const wire: WireInterpreterFrame = encodeFrame(frame);
      expect(wire).toEqual(frame);
      expect(decodeFrame(wire)).toEqual(frame);
    }
  });
});
