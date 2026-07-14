import { beforeEach, describe, expect, it } from 'vitest';

import {
  ConnectionCredentialStore,
  LEGACY_CONNECTION_KEY,
  type LegacyStorageLike,
  type SecureStorageLike,
} from './connection-credential-store';

const EXPECTED_CREDENTIAL_MAX_BYTES = 4 * 1024;

class FakeSecureStorage implements SecureStorageLike {
  readonly values = new Map<string, string>();
  platform = 'android';
  failSet = false;
  corruptReadBack = false;

  async get({ key }: { key: string }): Promise<{ value: string }> {
    const value = this.values.get(key);
    if (value === undefined) throw new Error('missing');
    return { value: this.corruptReadBack ? `${value}!` : value };
  }
  async set({ key, value }: { key: string; value: string }): Promise<{ value: boolean }> {
    if (this.failSet) throw new Error('keystore unavailable');
    this.values.set(key, value);
    return { value: true };
  }
  async remove({ key }: { key: string }): Promise<{ value: boolean }> {
    return { value: this.values.delete(key) };
  }
  async keys(): Promise<{ value: string[] }> {
    return { value: [...this.values.keys()] };
  }
  async getPlatform(): Promise<{ value: string }> {
    return { value: this.platform };
  }
}

class FakeLegacyStorage implements LegacyStorageLike {
  readonly values = new Map<string, string>();
  failRemove = false;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string): void {
    if (this.failRemove) throw new Error('remove failed');
    this.values.delete(key);
  }
}

describe('ConnectionCredentialStore', () => {
  let secure: FakeSecureStorage;
  let legacy: FakeLegacyStorage;

  beforeEach(() => {
    secure = new FakeSecureStorage();
    legacy = new FakeLegacyStorage();
  });

  it('migrates legacy plaintext only after secure write and exact read-back', async () => {
    legacy.values.set(LEGACY_CONNECTION_KEY, JSON.stringify({ url: 'ws://host:7420', token: 'secret' }));
    const result = await new ConnectionCredentialStore(secure, legacy).load();

    expect(result).toEqual({ connection: { url: 'ws://host:7420', token: 'secret' }, warning: null });
    expect(legacy.values.has(LEGACY_CONNECTION_KEY)).toBe(false);
    expect([...secure.values.values()][0]).toBe(
      JSON.stringify({ schemaVersion: 1, url: 'ws://host:7420', token: 'secret' }),
    );
  });

  it('retains legacy plaintext when secure write or read-back verification fails', async () => {
    legacy.values.set(LEGACY_CONNECTION_KEY, JSON.stringify({ url: 'ws://host', token: 'secret' }));
    secure.corruptReadBack = true;
    const store = new ConnectionCredentialStore(secure, legacy);
    const result = await store.load();

    expect(result.connection).toBeNull();
    expect(result.warning).toMatch(/migrated/);
    expect(legacy.values.has(LEGACY_CONNECTION_KEY)).toBe(true);

    secure.corruptReadBack = false;
    await expect(store.load()).resolves.toEqual({
      connection: { url: 'ws://host', token: 'secret' },
      warning: null,
    });
    expect(legacy.values.has(LEGACY_CONNECTION_KEY)).toBe(false);
  });

  it('retries legacy cleanup and blocks saved autofill until deletion succeeds', async () => {
    const store = new ConnectionCredentialStore(secure, legacy);
    await store.save({ url: 'ws://host', token: 'secret' });
    legacy.values.set(LEGACY_CONNECTION_KEY, JSON.stringify({ url: 'ws://host', token: 'secret' }));
    legacy.failRemove = true;

    const blocked = await store.load();
    expect(blocked.connection).toBeNull();
    expect(blocked.warning).toMatch(/cleanup is pending/);

    legacy.failRemove = false;
    await expect(store.load()).resolves.toEqual({
      connection: { url: 'ws://host', token: 'secret' },
      warning: null,
    });
  });

  it('never reads or writes credentials through the web localStorage fallback', async () => {
    secure.platform = 'web';
    legacy.values.set(LEGACY_CONNECTION_KEY, JSON.stringify({ url: 'ws://host', token: 'plaintext' }));
    const store = new ConnectionCredentialStore(secure, legacy);

    const loaded = await store.load();
    expect(loaded.connection).toBeNull();
    expect(legacy.values.has(LEGACY_CONNECTION_KEY)).toBe(true);
    await expect(store.save({ url: 'ws://host', token: 'new' })).rejects.toThrow(/Android/);
    expect(secure.values.size).toBe(0);
  });

  it('removes an invalid legacy plaintext record instead of leaving possible token bytes behind', async () => {
    legacy.values.set(LEGACY_CONNECTION_KEY, '{"url":"ws://host","token":');
    const result = await new ConnectionCredentialStore(secure, legacy).load();
    expect(result.connection).toBeNull();
    expect(result.warning).toMatch(/invalid/);
    expect(legacy.values.has(LEGACY_CONNECTION_KEY)).toBe(false);
  });

  it('does not delete the secure credential on explicit load/save cycles', async () => {
    const store = new ConnectionCredentialStore(secure, legacy);
    await store.save({ url: 'ws://host', token: 'secret' });
    await expect(store.load()).resolves.toEqual({
      connection: { url: 'ws://host', token: 'secret' },
      warning: null,
    });
    expect(secure.values.size).toBe(1);
  });

  it('rejects a secure-storage value larger than the 4 KiB secret-read cap', async () => {
    secure.values.set(
      'ezterminal-mobile-connection-v1',
      JSON.stringify({
        schemaVersion: 1,
        url: 'ws://host',
        token: 'x'.repeat(EXPECTED_CREDENTIAL_MAX_BYTES),
      }),
    );

    const result = await new ConnectionCredentialStore(secure, legacy).load();
    expect(result.connection).toBeNull();
    expect(result.warning).toMatch(/invalid or unavailable/);
  });

  it('enforces the 4 KiB cap in UTF-8 bytes before writing a secret', async () => {
    const store = new ConnectionCredentialStore(secure, legacy);
    await expect(
      store.save({ url: 'ws://host', token: '한'.repeat(EXPECTED_CREDENTIAL_MAX_BYTES / 2) }),
    ).rejects.toThrow(/large/);
    expect(secure.values.size).toBe(0);
  });
});
