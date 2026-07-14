import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RemoteTokenStore, type RemoteTokenProtector } from './remote-token-store';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-remote-token-'));
}

const testProtector: RemoteTokenProtector = {
  encrypt: (plaintext) => Buffer.from(`test-protected:${plaintext}`, 'utf8'),
  decrypt: (ciphertext) => {
    const value = ciphertext.toString('utf8');
    if (!value.startsWith('test-protected:')) throw new Error('wrong test key');
    return value.slice('test-protected:'.length);
  },
};

/** Keep unit tests fast on Windows; secure-atomic-file.test.ts exercises the
 * real shell:false ACL command separately. */
function makeStore(dir: string): RemoteTokenStore {
  return new RemoteTokenStore(dir, {
    ...(process.platform === 'win32' ? { windowsAcl: async () => undefined } : {}),
    protector: testProtector,
    requireProtector: true,
  });
}

describe('RemoteTokenStore — mint/persist/rotate', () => {
  it('mints and persists a token on first getToken() call', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    const token = await store.getToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(dir, 'remote-token.json'))).toBe(true);
  });

  it('repeated getToken() calls on the same instance return the same token', async () => {
    const store = makeStore(makeDir());
    await store.init();
    const first = await store.getToken();
    const second = await store.getToken();
    expect(second).toBe(first);
  });

  it('a fresh store instance over the same dir loads the SAME persisted token', async () => {
    const dir = makeDir();
    const first = makeStore(dir);
    await first.init();
    const token = await first.getToken();

    const second = makeStore(dir);
    await second.init();
    expect(await second.getToken()).toBe(token);
  });

  it('rotateToken() replaces the persisted token', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    const original = await store.getToken();
    const rotated = await store.rotateToken();
    expect(rotated).not.toBe(original);
    expect(await store.getToken()).toBe(rotated);

    const reloaded = makeStore(dir);
    await reloaded.init();
    expect(await reloaded.getToken()).toBe(rotated);
  });

  it('concurrent first-call getToken()s do not mint two different tokens', async () => {
    const store = makeStore(makeDir());
    await store.init();
    const [a, b, c] = await Promise.all([store.getToken(), store.getToken(), store.getToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('leaves no .tmp file behind after minting', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    await store.getToken();
    expect(existsSync(path.join(dir, 'remote-token.json.tmp'))).toBe(false);
  });

  it('path exposes the absolute remote-token.json location', () => {
    const dir = makeDir();
    const store = makeStore(dir);
    expect(store.path).toBe(path.join(dir, 'remote-token.json'));
  });
});

describe('RemoteTokenStore — corrupt/quarantine', () => {
  it('quarantines unparseable JSON and mints a fresh token instead', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'remote-token.json'), '{ not json !!!', 'utf8');

    const token = await store.getToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, 'remote-token.json.corrupt'))).toBe(true);
  });

  it('quarantines a schema-invalid file (e.g. wrong schemaVersion)', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    writeFileSync(
      path.join(dir, 'remote-token.json'),
      JSON.stringify({ schemaVersion: 999, token: 'whatever' }),
      'utf8',
    );

    const token = await store.getToken();
    expect(token).not.toBe('whatever');
    expect(existsSync(path.join(dir, 'remote-token.json.corrupt'))).toBe(true);
  });

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['uppercase hex', 'A'.repeat(64)],
    ['non-hex', 'g'.repeat(64)],
  ])('quarantines and rotates a token with invalid %s format', async (_label, invalidToken) => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    writeFileSync(
      path.join(dir, 'remote-token.json'),
      JSON.stringify({ schemaVersion: 1, token: invalidToken }),
      'utf8',
    );

    const token = await store.getToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(invalidToken);
    expect(existsSync(path.join(dir, 'remote-token.json.corrupt'))).toBe(true);
  });

  it('accepts an exact 64-character lowercase hex token without rotation', async () => {
    const dir = makeDir();
    const expected = 'a'.repeat(64);
    const store = makeStore(dir);
    await store.init();
    writeFileSync(
      path.join(dir, 'remote-token.json'),
      JSON.stringify({ schemaVersion: 1, token: expected }),
      'utf8',
    );

    expect(await store.getToken()).toBe(expected);
    expect(existsSync(path.join(dir, 'remote-token.json.corrupt'))).toBe(false);
    const migrated = JSON.parse(readFileSync(path.join(dir, 'remote-token.json'), 'utf8')) as Record<string, unknown>;
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated).not.toHaveProperty('token');
  });

  it('init() removes a crash-stale .tmp file', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'remote-token.json.tmp'), 'half-written', 'utf8');
    const store = makeStore(dir);
    await store.init();
    expect(existsSync(path.join(dir, 'remote-token.json.tmp'))).toBe(false);
  });

  it('persists only protected schema-v2 content, not the returned bearer token', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    const token = await store.getToken();
    const text = readFileSync(path.join(dir, 'remote-token.json'), 'utf8');
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(2);
    expect(raw).not.toHaveProperty('token');
    expect(raw.protectedToken).toEqual(expect.any(String));
    expect(text).not.toContain(token);
  });

  it('fails closed without writing plaintext when protection is required but unavailable', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir, { requireProtector: true });

    await expect(store.init()).rejects.toThrow(/encryption is unavailable/);
    await expect(store.getToken()).rejects.toThrow(/encryption is unavailable/);
    expect(existsSync(store.path)).toBe(false);
  });

  it('does not land or cache a token when OS encryption fails', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir, {
      protector: {
        encrypt: () => { throw new Error('keyring locked'); },
        decrypt: testProtector.decrypt,
      },
      requireProtector: true,
      ...(process.platform === 'win32' ? { windowsAcl: async () => undefined } : {}),
    });
    await store.init();

    await expect(store.getToken()).rejects.toThrow(/Unable to encrypt/);
    await expect(store.rotateToken()).rejects.toThrow(/Unable to encrypt/);
    expect(existsSync(store.path)).toBe(false);
  });

  it('invalidates the old cache when a final target ACL check fails after replacement', async () => {
    const dir = makeDir();
    let failTargetAcl = false;
    const store = new RemoteTokenStore(dir, {
      platform: 'win32',
      windowsAcl: async (filePath) => {
        if (failTargetAcl && filePath.endsWith('remote-token.json')) throw new Error('target ACL denied');
      },
      protector: testProtector,
      requireProtector: true,
    });
    await store.init();
    const original = await store.getToken();

    failTargetAcl = true;
    await expect(store.rotateToken()).rejects.toThrow('target ACL denied');
    await expect(store.getToken()).rejects.toThrow('target ACL denied');

    failTargetAcl = false;
    const recovered = await store.getToken();
    expect(recovered).toMatch(/^[0-9a-f]{64}$/);
    expect(recovered).not.toBe(original);
  });

  it('preserves protected content and fails closed when decryption fails', async () => {
    const dir = makeDir();
    const first = makeStore(dir);
    await first.init();
    await first.getToken();
    const before = readFileSync(first.path, 'utf8');

    const wrongKey = new RemoteTokenStore(dir, {
      protector: {
        encrypt: testProtector.encrypt,
        decrypt: () => { throw new Error('DPAPI unavailable'); },
      },
      requireProtector: true,
      ...(process.platform === 'win32' ? { windowsAcl: async () => undefined } : {}),
    });
    await wrongKey.init();

    await expect(wrongKey.getToken()).rejects.toThrow(/Unable to decrypt/);
    expect(readFileSync(wrongKey.path, 'utf8')).toBe(before);
    expect(existsSync(`${wrongKey.path}.corrupt`)).toBe(false);
  });

  it('rejects non-canonical protected-token base64 without rotating it', async () => {
    const dir = makeDir();
    const store = makeStore(dir);
    await store.init();
    const malformed = JSON.stringify({ schemaVersion: 2, protectedToken: 'not base64' });
    writeFileSync(store.path, malformed, 'utf8');

    await expect(store.getToken()).rejects.toThrow(/Unable to decrypt/);
    expect(readFileSync(store.path, 'utf8')).toBe(malformed);
  });
});
