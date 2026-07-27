import { describe, expect, it, vi } from 'vitest';

import { PairingCodeService } from './pairing-code-service';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS,
  buildPairingUri,
  isPairingCode,
  parsePairingUri,
} from '../shared/pairing';

function makeService(startAt = 1_000): { service: PairingCodeService; advance: (ms: number) => void } {
  let clock = startAt;
  return {
    service: new PairingCodeService(() => clock),
    advance: (ms) => { clock += ms; },
  };
}

describe('PairingCodeService', () => {
  it('issues a readable code from an unambiguous alphabet', () => {
    const { service } = makeService();
    const issued = service.issue();
    expect(issued.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/u);
    expect(isPairingCode(issued.code)).toBe(true);
    // I, L, O and U are excluded so a code read off a screen cannot be typed
    // as a different valid one.
    for (const character of issued.code.replace('-', '')) {
      expect(PAIRING_CODE_ALPHABET).toContain(character);
    }
  });

  it('accepts the code however a human retypes it, once', () => {
    const { service } = makeService();
    const issued = service.issue();
    const spaced = issued.code.replace('-', ' ').toLowerCase();
    expect(service.consume(spaced)).toBe(true);
    // One-time means one time: a photographed QR is worthless a moment later.
    expect(service.consume(issued.code)).toBe(false);
    expect(service.current()).toBeNull();
  });

  it('rejects the wrong code and keeps the right one usable', () => {
    const { service } = makeService();
    const issued = service.issue();
    expect(service.consume('ZZZZ-ZZZZ')).toBe(false);
    expect(service.consume('')).toBe(false);
    expect(service.consume(`${issued.code}EXTRA`)).toBe(false);
    expect(service.consume(issued.code)).toBe(true);
  });

  it('expires on the clock, not on a promise to expire', () => {
    const { service, advance } = makeService();
    const issued = service.issue();
    advance(PAIRING_CODE_TTL_MS + 1);
    expect(service.current()).toBeNull();
    expect(service.consume(issued.code)).toBe(false);
  });

  it('replaces a previous code rather than leaving two live', () => {
    const { service } = makeService();
    const first = service.issue();
    const second = service.issue();
    expect(second.code).not.toBe(first.code);
    expect(service.consume(first.code)).toBe(false);
    expect(service.consume(second.code)).toBe(true);
  });

  it('tells listeners when a code appears and when it stops existing', () => {
    const { service } = makeService();
    const seen: (string | null)[] = [];
    service.onChange((code) => seen.push(code?.code ?? null));
    const issued = service.issue();
    service.revoke();
    expect(seen).toEqual([issued.code, null]);
  });

  it('does not keep the process alive waiting to expire a code', () => {
    const service = new PairingCodeService();
    const unref = vi.fn();
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>);
    service.issue();
    expect(unref).toHaveBeenCalled();
    vi.restoreAllMocks();
    service.dispose();
  });
});

describe('pairing URIs', () => {
  it('round-trips an endpoint and a code', () => {
    const uri = buildPairingUri('ws://100.84.12.7:7420', '7C2F-91KD');
    expect(parsePairingUri(uri)).toEqual({ endpoint: 'ws://100.84.12.7:7420', code: '7C2F-91KD' });
  });

  it('refuses anything that is not one of ours, or is only half of one', () => {
    expect(parsePairingUri('https://example.com')).toBeNull();
    expect(parsePairingUri('ezterminal://pair?endpoint=ws://host:1')).toBeNull();
    expect(parsePairingUri('ezterminal://pair?code=7C2F-91KD')).toBeNull();
    // An endpoint that is not a WebSocket URL is not something to connect to.
    expect(parsePairingUri('ezterminal://pair?endpoint=http://host&code=7C2F-91KD')).toBeNull();
    expect(parsePairingUri('ezterminal://pair?endpoint=ws://host:1&code=SHORT')).toBeNull();
  });
});
