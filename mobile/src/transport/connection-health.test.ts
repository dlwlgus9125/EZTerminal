import { describe, expect, it } from 'vitest';

import { createAppI18n } from '../../../src/renderer/i18n';
import {
  classifyConnectionHealth,
  classifyEndpoint,
  smoothRoundTrip,
  type ConnectionHealthSnapshot,
} from './connection-health';

const english = createAppI18n('en', []).t;
const korean = createAppI18n('ko', []).t;

const snapshot = (overrides: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot => ({
  state: 'reconnecting',
  attempt: 1,
  nextRetryAt: 1_000,
  lastConnectedAt: 0,
  endpointKind: 'other',
  roundTripMs: null,
  ...overrides,
});

describe('classifyConnectionHealth', () => {
  it('keeps the first two reconnect attempts neutral', () => {
    expect(classifyConnectionHealth(snapshot({ attempt: 2 }), english, 10_000).kind).toBe('reconnecting');
  });

  it('escalates at three attempts and at twelve stale attempts', () => {
    expect(classifyConnectionHealth(snapshot({ attempt: 3 }), english, 10_000).kind).toBe('warning');
    expect(classifyConnectionHealth(
      snapshot({ attempt: 12, lastConnectedAt: 59_001 }),
      english,
      60_000,
    ).kind).toBe('warning');
    expect(classifyConnectionHealth(
      snapshot({ attempt: 12, lastConnectedAt: 0 }),
      english,
      60_000,
    ).kind).toBe('unreachable');
    expect(classifyConnectionHealth(
      snapshot({ attempt: 12, lastConnectedAt: null }),
      english,
      1,
    ).kind).toBe('unreachable');
  });

  it('classifies auth rejection independently of attempt count', () => {
    expect(classifyConnectionHealth(
      snapshot({ state: 'auth-rejected', attempt: 0 }),
      english,
    ).kind).toBe('auth-rejected');
  });

  it('classifies protocol incompatibility as a distinct update action', () => {
    expect(classifyConnectionHealth(
      snapshot({ state: 'protocol-incompatible', attempt: 0 }),
      english,
    )).toEqual({
      kind: 'protocol-incompatible',
      label: 'Update required',
      detail: 'This phone and desktop use incompatible remote protocols. Update both EZTerminal apps, then pair again.',
    });
  });

  it('returns localized English and Korean banner copy through the typed translator', () => {
    expect(classifyConnectionHealth(
      snapshot({ state: 'connected' }),
      english,
    )).toEqual({
      kind: 'connected',
      label: 'Connected',
      detail: 'The desktop connection is ready.',
    });

    expect(classifyConnectionHealth(
      snapshot({ attempt: 3, endpointKind: 'tailscale' }),
      korean,
      10_000,
    )).toEqual({
      kind: 'warning',
      label: '아직 연결할 수 없음',
      detail: '3번째 연결 시도가 실패했습니다. 자동으로 다시 시도합니다.',
      hint: '이 기기에서 Tailscale이 연결되어 있는지 확인해 주세요.',
    });
  });

  it('only adds the endpoint hint to warning and unreachable Tailscale verdicts', () => {
    expect(classifyConnectionHealth(
      snapshot({ attempt: 3, endpointKind: 'other' }),
      english,
      10_000,
    ).hint).toBeUndefined();
    expect(classifyConnectionHealth(
      snapshot({ attempt: 2, endpointKind: 'tailscale' }),
      english,
      10_000,
    ).hint).toBeUndefined();
    expect(classifyConnectionHealth(
      snapshot({ attempt: 12, endpointKind: 'tailscale' }),
      english,
      60_000,
    ).hint).toBe('Check that Tailscale is connected on this device.');
  });
});

describe('classifyEndpoint', () => {
  it('recognizes Tailscale IP and DNS endpoints without retaining the endpoint text', () => {
    expect(classifyEndpoint('wss://100.64.0.3:8443')).toBe('tailscale');
    expect(classifyEndpoint('wss://desktop.example.ts.net')).toBe('tailscale');
    expect(classifyEndpoint('ws://192.168.1.4:8080')).toBe('other');
  });
});

describe('smoothRoundTrip', () => {
  it('takes the first sample whole, then follows changes without chasing them', () => {
    // Nothing to smooth against yet, so the first probe is the answer.
    expect(smoothRoundTrip(null, 42.4)).toBe(42);
    // A single slow probe on a mobile radio moves the number, but not to it.
    const afterSpike = smoothRoundTrip(40, 200);
    expect(afterSpike).toBeGreaterThan(40);
    expect(afterSpike).toBeLessThan(100);
    // A sustained change is followed rather than resisted.
    let value = 40;
    for (let i = 0; i < 20; i += 1) value = smoothRoundTrip(value, 200);
    expect(value).toBeGreaterThan(190);
  });
});
