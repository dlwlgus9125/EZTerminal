import { describe, expect, it } from 'vitest';

import { REMOTE_PORT, resolveAndroidHostUrl } from '../mobile/e2e/lib.ts';

describe('mobile E2E Android host URL', () => {
  it('defaults to the adb-reversed device loopback', () => {
    expect(resolveAndroidHostUrl(undefined)).toBe(`ws://127.0.0.1:${REMOTE_PORT}`);
  });

  it('accepts an explicit emulator host alias override', () => {
    expect(resolveAndroidHostUrl(' ws://10.0.2.2:17420 ')).toBe('ws://10.0.2.2:17420');
  });

  it('rejects malformed and non-WebSocket overrides', () => {
    expect(() => resolveAndroidHostUrl('not-a-url')).toThrow(/valid URL/);
    expect(() => resolveAndroidHostUrl('http://127.0.0.1:17420')).toThrow(/ws:\/\//);
  });
});
