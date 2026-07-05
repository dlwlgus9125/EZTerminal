import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RemoteTokenStore } from './remote-token-store';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-remote-token-'));
}

describe('RemoteTokenStore — mint/persist/rotate', () => {
  it('mints and persists a token on first getToken() call', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
    await store.init();
    const token = await store.getToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, 'remote-token.json'))).toBe(true);
  });

  it('repeated getToken() calls on the same instance return the same token', async () => {
    const store = new RemoteTokenStore(makeDir());
    await store.init();
    const first = await store.getToken();
    const second = await store.getToken();
    expect(second).toBe(first);
  });

  it('a fresh store instance over the same dir loads the SAME persisted token', async () => {
    const dir = makeDir();
    const first = new RemoteTokenStore(dir);
    await first.init();
    const token = await first.getToken();

    const second = new RemoteTokenStore(dir);
    await second.init();
    expect(await second.getToken()).toBe(token);
  });

  it('rotateToken() replaces the persisted token', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
    await store.init();
    const original = await store.getToken();
    const rotated = await store.rotateToken();
    expect(rotated).not.toBe(original);
    expect(await store.getToken()).toBe(rotated);

    const reloaded = new RemoteTokenStore(dir);
    await reloaded.init();
    expect(await reloaded.getToken()).toBe(rotated);
  });

  it('concurrent first-call getToken()s do not mint two different tokens', async () => {
    const store = new RemoteTokenStore(makeDir());
    await store.init();
    const [a, b, c] = await Promise.all([store.getToken(), store.getToken(), store.getToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('leaves no .tmp file behind after minting', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
    await store.init();
    await store.getToken();
    expect(existsSync(path.join(dir, 'remote-token.json.tmp'))).toBe(false);
  });

  it('path exposes the absolute remote-token.json location', () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
    expect(store.path).toBe(path.join(dir, 'remote-token.json'));
  });
});

describe('RemoteTokenStore — corrupt/quarantine', () => {
  it('quarantines unparseable JSON and mints a fresh token instead', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'remote-token.json'), '{ not json !!!', 'utf8');

    const token = await store.getToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, 'remote-token.json.corrupt'))).toBe(true);
  });

  it('quarantines a schema-invalid file (e.g. wrong schemaVersion)', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
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

  it('init() removes a crash-stale .tmp file', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'remote-token.json.tmp'), 'half-written', 'utf8');
    const store = new RemoteTokenStore(dir);
    await store.init();
    expect(existsSync(path.join(dir, 'remote-token.json.tmp'))).toBe(false);
  });

  it('the persisted file actually contains the returned token', async () => {
    const dir = makeDir();
    const store = new RemoteTokenStore(dir);
    await store.init();
    const token = await store.getToken();
    const raw = JSON.parse(readFileSync(path.join(dir, 'remote-token.json'), 'utf8'));
    expect(raw.token).toBe(token);
  });
});
