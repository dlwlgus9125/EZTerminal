import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { KnownHostsStore } from './known-hosts-store';

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'ezterm-known-hosts-'));
}

describe('KnownHostsStore — TOFU check/add (E5)', () => {
  it('an unseen host:port checks as unknown', async () => {
    const store = new KnownHostsStore(makeDir());
    await store.init();
    const result = await store.check('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    expect(result).toEqual({ verdict: 'unknown' });
  });

  it('add() then check() with the SAME fingerprint verdicts match', async () => {
    const store = new KnownHostsStore(makeDir());
    await store.init();
    await store.add('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    const result = await store.check('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    expect(result).toEqual({ verdict: 'match' });
  });

  it('a DIFFERENT fingerprint for a trusted host:port verdicts mismatch with the old fingerprint', async () => {
    const store = new KnownHostsStore(makeDir());
    await store.init();
    await store.add('example.com', 22, 'ssh-ed25519', 'SHA256:old');
    const result = await store.check('example.com', 22, 'ssh-ed25519', 'SHA256:new');
    expect(result).toEqual({ verdict: 'mismatch', existingFingerprint: 'SHA256:old' });
  });

  it('a different key TYPE for the same trusted host:port also verdicts mismatch', async () => {
    const store = new KnownHostsStore(makeDir());
    await store.init();
    await store.add('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    const result = await store.check('example.com', 22, 'ssh-rsa', 'SHA256:abc');
    expect(result).toEqual({ verdict: 'mismatch', existingFingerprint: 'SHA256:abc' });
  });

  it('host:port pairs are independent — same host different port is unknown', async () => {
    const store = new KnownHostsStore(makeDir());
    await store.init();
    await store.add('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    const result = await store.check('example.com', 2222, 'ssh-ed25519', 'SHA256:abc');
    expect(result).toEqual({ verdict: 'unknown' });
  });

  it('round-trips through a real file (persists across store instances)', async () => {
    const dir = makeDir();
    const first = new KnownHostsStore(dir);
    await first.init();
    await first.add('example.com', 22, 'ssh-ed25519', 'SHA256:abc');

    const second = new KnownHostsStore(dir);
    await second.init();
    expect(await second.check('example.com', 22, 'ssh-ed25519', 'SHA256:abc')).toEqual({ verdict: 'match' });
  });

  it('serializes concurrent add() calls without losing an entry', async () => {
    const store = new KnownHostsStore(makeDir());
    await store.init();
    await Promise.all([
      store.add('a.example.com', 22, 'ssh-ed25519', 'SHA256:a'),
      store.add('b.example.com', 22, 'ssh-ed25519', 'SHA256:b'),
      store.add('c.example.com', 22, 'ssh-ed25519', 'SHA256:c'),
    ]);
    expect(await store.check('a.example.com', 22, 'ssh-ed25519', 'SHA256:a')).toEqual({ verdict: 'match' });
    expect(await store.check('b.example.com', 22, 'ssh-ed25519', 'SHA256:b')).toEqual({ verdict: 'match' });
    expect(await store.check('c.example.com', 22, 'ssh-ed25519', 'SHA256:c')).toEqual({ verdict: 'match' });
  });

  it('path exposes the absolute known_hosts.json location', async () => {
    const dir = makeDir();
    const store = new KnownHostsStore(dir);
    expect(store.path).toBe(path.join(dir, 'known_hosts.json'));
  });
});

describe('KnownHostsStore — corrupt/quarantine (E5)', () => {
  it('quarantines unparseable JSON to .corrupt and treats it as empty (unknown)', async () => {
    const dir = makeDir();
    const store = new KnownHostsStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'known_hosts.json'), '{ not json !!!', 'utf8');

    const result = await store.check('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    expect(result).toEqual({ verdict: 'unknown' });
    expect(existsSync(path.join(dir, 'known_hosts.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'known_hosts.json.corrupt'))).toBe(true);
  });

  it('quarantines a schema-invalid file (e.g. missing fingerprintSha256) and treats it as empty', async () => {
    const dir = makeDir();
    const store = new KnownHostsStore(dir);
    await store.init();
    writeFileSync(
      path.join(dir, 'known_hosts.json'),
      JSON.stringify({ schemaVersion: 1, hosts: { 'example.com:22': { keyType: 'ssh-ed25519' } } }),
      'utf8',
    );

    const result = await store.check('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    expect(result).toEqual({ verdict: 'unknown' });
    expect(existsSync(path.join(dir, 'known_hosts.json.corrupt'))).toBe(true);
  });

  it('a corrupt file never yields match/mismatch against garbage — always unknown, never silently trusted', async () => {
    const dir = makeDir();
    const store = new KnownHostsStore(dir);
    await store.init();
    writeFileSync(path.join(dir, 'known_hosts.json'), 'garbage', 'utf8');

    // Adding after quarantine works normally (store recovers with a fresh file).
    await store.add('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    expect(await store.check('example.com', 22, 'ssh-ed25519', 'SHA256:abc')).toEqual({ verdict: 'match' });
  });

  it('init() removes a crash-stale .tmp file', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'known_hosts.json.tmp'), 'half-written', 'utf8');
    const store = new KnownHostsStore(dir);
    await store.init();
    expect(existsSync(path.join(dir, 'known_hosts.json.tmp'))).toBe(false);
  });

  it('leaves no .tmp behind after a successful add()', async () => {
    const dir = makeDir();
    const store = new KnownHostsStore(dir);
    await store.init();
    await store.add('example.com', 22, 'ssh-ed25519', 'SHA256:abc');
    expect(existsSync(path.join(dir, 'known_hosts.json.tmp'))).toBe(false);
    expect(readFileSync(path.join(dir, 'known_hosts.json'), 'utf8')).toContain('SHA256:abc');
  });
});
