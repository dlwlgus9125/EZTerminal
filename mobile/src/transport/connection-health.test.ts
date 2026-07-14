import { describe, expect, it } from 'vitest';

import {
  classifyConnectionHealth,
  classifyEndpoint,
  type ConnectionHealthSnapshot,
} from './connection-health';

const snapshot = (overrides: Partial<ConnectionHealthSnapshot> = {}): ConnectionHealthSnapshot => ({
  state: 'reconnecting',
  attempt: 1,
  nextRetryAt: 1_000,
  lastConnectedAt: 0,
  endpointKind: 'other',
  ...overrides,
});

describe('classifyConnectionHealth', () => {
  it('keeps the first two reconnect attempts neutral', () => {
    expect(classifyConnectionHealth(snapshot({ attempt: 2 }), 10_000).kind).toBe('reconnecting');
  });

  it('escalates at three attempts and at twelve stale attempts', () => {
    expect(classifyConnectionHealth(snapshot({ attempt: 3 }), 10_000).kind).toBe('warning');
    expect(classifyConnectionHealth(snapshot({ attempt: 12, lastConnectedAt: 59_001 }), 60_000).kind).toBe('warning');
    expect(classifyConnectionHealth(snapshot({ attempt: 12, lastConnectedAt: 0 }), 60_000).kind).toBe('unreachable');
    expect(classifyConnectionHealth(snapshot({ attempt: 12, lastConnectedAt: null }), 1).kind).toBe('unreachable');
  });

  it('classifies auth rejection independently of attempt count', () => {
    expect(classifyConnectionHealth(snapshot({ state: 'auth-rejected', attempt: 0 })).kind).toBe('auth-rejected');
  });
});

describe('classifyEndpoint', () => {
  it('recognizes Tailscale IP and DNS endpoints without retaining the endpoint text', () => {
    expect(classifyEndpoint('wss://100.64.0.3:8443')).toBe('tailscale');
    expect(classifyEndpoint('wss://desktop.example.ts.net')).toBe('tailscale');
    expect(classifyEndpoint('ws://192.168.1.4:8080')).toBe('other');
  });
});
