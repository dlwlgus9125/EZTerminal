import { describe, expect, it } from 'vitest';

import {
  NATIVE_DESKTOP_PROTOCOL_VERSION,
  parseRemoteDesktopServiceProbe,
} from './native-desktop-protocol';

describe('native desktop service probe protocol', () => {
  it('accepts the v2 ready response emitted by the installed remote host', () => {
    expect(NATIVE_DESKTOP_PROTOCOL_VERSION).toBe(2);
    expect(parseRemoteDesktopServiceProbe(JSON.stringify({
      protocolVersion: 2,
      service: 'ready',
      serviceName: 'EZTerminalRemoteHost',
    }))).toBe('ready');
  });

  it.each(['missing', 'stopped', 'denied'] as const)(
    'preserves the supported v2 %s service result',
    (service) => {
      expect(parseRemoteDesktopServiceProbe(JSON.stringify({
        protocolVersion: 2,
        service,
      }))).toBe(service);
    },
  );

  it.each([
    ['stale version', JSON.stringify({ protocolVersion: 1, service: 'ready' })],
    ['future version', JSON.stringify({ protocolVersion: 3, service: 'ready' })],
    ['unknown service', JSON.stringify({ protocolVersion: 2, service: 'starting' })],
    ['missing version', JSON.stringify({ service: 'ready' })],
    ['malformed JSON', '{'],
  ])('fails closed for %s', (_label, stdout) => {
    expect(parseRemoteDesktopServiceProbe(stdout)).toBe('unknown');
  });
});
