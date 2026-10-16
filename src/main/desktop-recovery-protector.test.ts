import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDesktopRecoveryProtector } from './desktop-recovery-protector';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ez-recovery-key-')); roots.push(directory);
  const legacy = { available: () => true, encrypt: vi.fn(() => Buffer.from('legacy')), decrypt: vi.fn(() => 'legacy draft') };
  // The OS boundary is modeled separately; actual DPAPI is exercised by EXE restart E2E.
  const protectKey = vi.fn(async (operation: 'protect' | 'unprotect', value: Buffer) => operation === 'protect'
    ? Buffer.concat([Buffer.from('protected:'), value]) : value.subarray(10));
  const options = { platform: 'win32' as const, windowsAcl: async () => undefined, protectKey };
  return { directory, legacy, protectKey, options, protector: createDesktopRecoveryProtector(directory, legacy, options) };
}

describe('durable Windows recovery encryption', () => {
  it('persists the wrapped key before returning ciphertext and restores it in a new process instance', async () => {
    const h = await fixture();
    const encrypted = await h.protector.encrypt('full draft with attachments');
    expect((await readFile(path.join(h.directory, 'recovery-key-v1.bin'), 'utf8')).length).toBeGreaterThan(0);
    expect(encrypted.toString()).not.toContain('full draft');
    const restarted = createDesktopRecoveryProtector(h.directory, h.legacy, h.options);
    expect(await restarted.decrypt(encrypted)).toBe('full draft with attachments');
    expect(h.legacy.decrypt).not.toHaveBeenCalled();
    expect(h.protectKey.mock.calls.map(([operation]) => operation)).toEqual(['protect', 'unprotect']);
  });
  it('loads the key ahead of the first draft, and a failed load is tried again on use', async () => {
    const h = await fixture();
    h.protectKey.mockRejectedValueOnce(new Error('OS busy'));
    await expect(h.protector.prepare()).rejects.toThrow(/OS busy/);
    await expect(h.protector.prepare()).resolves.toBeUndefined();
    const calls = h.protectKey.mock.calls.length;
    expect(await h.protector.decrypt(await h.protector.encrypt('ready'))).toBe('ready');
    expect(h.protectKey).toHaveBeenCalledTimes(calls);
  });
  it('shares one wrapped key across simultaneous saves while giving each ciphertext a fresh nonce', async () => {
    const h = await fixture();
    const [one, two] = await Promise.all([h.protector.encrypt('same'), h.protector.encrypt('same')]);
    expect(one.equals(two)).toBe(false);
    expect(await h.protector.decrypt(one)).toBe('same'); expect(await h.protector.decrypt(two)).toBe('same');
    expect(h.protectKey).toHaveBeenCalledTimes(1);
  });
  it('rejects tampered data and refuses to replace an unreadable key', async () => {
    const h = await fixture(); const ciphertext = Buffer.from(await h.protector.encrypt('private'));
    ciphertext[ciphertext.length - 1] ^= 1;
    await expect(h.protector.decrypt(ciphertext)).rejects.toThrow();
    await writeFile(path.join(h.directory, 'recovery-key-v1.bin'), 'invalid key');
    const restarted = createDesktopRecoveryProtector(h.directory, h.legacy, h.options);
    await expect(restarted.encrypt('retain this draft')).rejects.toThrow();
    expect(await readFile(path.join(h.directory, 'recovery-key-v1.bin'), 'utf8')).toBe('invalid key');
  });
  it('preserves old Electron ciphertext and fails closed if Windows cannot protect a new key', async () => {
    const h = await fixture();
    expect(await h.protector.decrypt(Buffer.from('v10-old-ciphertext'))).toBe('legacy draft');
    h.protectKey.mockRejectedValueOnce(new Error('OS unavailable'));
    await expect(h.protector.encrypt('retain')).rejects.toThrow('OS unavailable');
    expect(h.legacy.encrypt).not.toHaveBeenCalled();
  });
});
