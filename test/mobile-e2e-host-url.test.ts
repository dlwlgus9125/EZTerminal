import { describe, expect, it } from 'vitest';

import { REMOTE_PORT, resolveAndroidHostUrl } from '../mobile/e2e/lib.ts';

describe('mobile E2E Android host URL', () => {
  it('defaults to the Android emulator host alias', () => {
    expect(resolveAndroidHostUrl(undefined)).toBe(`ws://10.0.2.2:${REMOTE_PORT}`);
  });

  it('accepts the adb-reversed loopback URL used by a physical Fold', () => {
    expect(resolveAndroidHostUrl(' ws://127.0.0.1:17420 ')).toBe('ws://127.0.0.1:17420');
  });

  it('rejects malformed and non-WebSocket overrides', () => {
    expect(() => resolveAndroidHostUrl('not-a-url')).toThrow(/valid URL/);
    expect(() => resolveAndroidHostUrl('http://127.0.0.1:17420')).toThrow(/ws:\/\//);
  });
});
