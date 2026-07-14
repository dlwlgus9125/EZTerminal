import { describe, expect, it } from 'vitest';

import {
  acceptOsc52ClipboardWrite,
  decodeOsc52Payload,
  OSC52_MAX_BYTES,
  Osc52WriteGate,
  TerminalSideEffectSuppression,
} from './osc52';

function encode(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

describe('OSC 52 clipboard policy', () => {
  it('accepts one strict UTF-8 clipboard write', () => {
    expect(decodeOsc52Payload(`c;${encode('hello 한글')}`)).toBe('hello 한글');
  });

  it('rejects queries, other selections, malformed data, invalid UTF-8 and oversize payloads', () => {
    expect(decodeOsc52Payload('c;?')).toBeNull();
    expect(decodeOsc52Payload(`p;${encode('no')}`)).toBeNull();
    expect(decodeOsc52Payload('c;%%%')).toBeNull();
    expect(decodeOsc52Payload('c;ww==')).toBeNull();
    expect(decodeOsc52Payload(`c;${btoa('x'.repeat(OSC52_MAX_BYTES + 1))}`)).toBeNull();
  });

  it('rate-limits repeated terminal writes', () => {
    let now = 10_000;
    const gate = new Osc52WriteGate(1_000, () => now);
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    now += 999;
    expect(gate.take()).toBe(false);
    now += 1;
    expect(gate.take()).toBe(true);
  });

  it('consumes the rate slot only after payload decoding succeeds', () => {
    let now = 10_000;
    const gate = new Osc52WriteGate(1_000, () => now);

    expect(acceptOsc52ClipboardWrite('c;%%%', gate)).toBeNull();
    expect(acceptOsc52ClipboardWrite(`c;${encode('first')}`, gate)).toBe('first');
    expect(acceptOsc52ClipboardWrite(`c;${encode('blocked')}`, gate)).toBeNull();
    now += 1_000;
    expect(acceptOsc52ClipboardWrite(`c;${encode('next')}`, gate)).toBe('next');
  });

  it('suppresses replayed clipboard writes without consuming the live rate slot', () => {
    const gate = new Osc52WriteGate();
    const payload = `c;${encode('historical secret')}`;

    expect(acceptOsc52ClipboardWrite(payload, gate, true)).toBeNull();
    expect(acceptOsc52ClipboardWrite(payload, gate)).toBe('historical secret');
  });

  it('keeps replay suppression active until every asynchronous write callback releases it', () => {
    const suppression = new TerminalSideEffectSuppression();
    const finishFirst = suppression.enter();
    const finishSecond = suppression.enter();

    expect(suppression.active).toBe(true);
    finishFirst();
    expect(suppression.active).toBe(true);
    finishFirst(); // idempotent callback/teardown safety
    expect(suppression.active).toBe(true);
    finishSecond();
    expect(suppression.active).toBe(false);
  });
});
