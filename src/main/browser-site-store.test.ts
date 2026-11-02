import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowserLastPages, BrowserSiteStore } from './browser-site-store';

const SITE = 'https://staging.cart-kit.example';
let directory: string;

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'ez-browser-sites-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

/** Stands in for safeStorage: authenticated, so a changed byte fails to open, as AES-GCM does. */
const KEY = 'test-key';
const seal = (plaintext: string): Buffer => {
  const body = Buffer.from(plaintext, 'utf8');
  return Buffer.concat([createHmac('sha256', KEY).update(body).digest(), body.map((byte) => byte ^ 0x5a)]);
};
const PROTECTOR = {
  available: () => true,
  encrypt: seal,
  decrypt: (ciphertext: Buffer): string => {
    const body = Buffer.from(ciphertext.subarray(32).map((byte) => byte ^ 0x5a));
    if (!createHmac('sha256', KEY).update(body).digest().equals(ciphertext.subarray(0, 32))) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    return body.toString('utf8');
  },
};
const file = (): string => path.join(directory, 'browser-sites.json');
const sealed = (value: unknown): string => JSON.stringify({ version: 2, protectedSites: seal(JSON.stringify(value)).toString('base64') });
const tampered = (text: string): string => {
  const envelope = JSON.parse(text) as { protectedSites: string };
  const bytes = Buffer.from(envelope.protectedSites, 'base64');
  bytes[bytes.length - 1] ^= 1;
  return JSON.stringify({ ...envelope, protectedSites: bytes.toString('base64') });
};

const fresh = async (): Promise<BrowserSiteStore> => {
  const store = new BrowserSiteStore(directory, PROTECTOR);
  await store.load();
  return store;
};

describe('BrowserSiteStore', () => {
  it('starts empty', async () => {
    expect((await fresh()).origins('project')).toEqual([]);
  });

  it('allows one origin for one project, and survives a restart', async () => {
    const store = await fresh();
    await store.allow('project', SITE);
    expect(store.origins('project')).toEqual([SITE]);
    expect(store.origins('another-project')).toEqual([]);
    expect((await fresh()).origins('project')).toEqual([SITE]);
  });

  it('answers a revoke at once, and on disk', async () => {
    const store = await fresh();
    await store.allow('project', SITE);
    await store.revoke('project', SITE);
    expect(store.origins('project')).toEqual([]);
    expect((await fresh()).origins('project')).toEqual([]);
  });

  it('keeps one entry for one origin, and other projects\' sites apart', async () => {
    const store = await fresh();
    await store.allow('project', SITE);
    await store.allow('project', SITE);
    await store.allow('another-project', 'https://other.example');
    await store.revoke('project', SITE);
    expect(store.origins('another-project')).toEqual(['https://other.example']);
  });

  it('loses neither of two changes at once', async () => {
    const store = await fresh();
    await Promise.all([store.allow('project', SITE), store.allow('project', 'https://other.example')]);
    expect((await fresh()).origins('project').slice().sort()).toEqual(['https://other.example', SITE].sort());
  });

  it('drops an entry that is no exact origin, even one the app could read', async () => {
    writeFileSync(file(), sealed({ version: 1, projects: { project: [SITE, 'https://*.example', 'http://localhost:5173', 'https://a.example/path', 'javascript:alert(1)', 7] } }));
    expect((await fresh()).origins('project')).toEqual([SITE]);
  });

  it('keeps the list at rest as ciphertext: no origin stands in the file', async () => {
    const store = await fresh();
    await store.allow('project', SITE);
    await store.addSuspect('https://suspect.example');
    const text = readFileSync(file(), 'utf8');
    expect(text).not.toContain('cart-kit');
    expect(text).not.toContain('suspect.example');
  });

  it('answers from memory: an edit on disk is never read back while it runs, not even one in its own ciphertext', async () => {
    const store = await fresh();
    await store.allow('project', SITE);
    writeFileSync(file(), sealed({ version: 1, projects: { project: [SITE, 'https://injected.example'] }, suspects: [] }));
    await store.allow('project', 'https://other.example');
    await store.revoke('another-project', 'https://nothing.example');
    expect(store.origins('project')).toEqual([SITE, 'https://other.example']);
    expect((await fresh()).origins('project')).toEqual([SITE, 'https://other.example']);
  });

  it.each([
    ['the plain list an edit leaves', JSON.stringify({ version: 1, projects: { project: [SITE] } })],
    ['ciphertext with a byte changed', 'TAMPER'],
    ['not json', 'not json'],
    ['an envelope with more in it', JSON.stringify({ version: 2, protectedSites: 'AAAA', projects: { project: [SITE] } })],
    ['a sealed list of the wrong shape', JSON.stringify({ version: 2, protectedSites: Buffer.from(seal('{"version":1,"projects":[]}')).toString('base64') })],
  ])('sets aside %s, allows nothing, and says why', async (_name, text) => {
    const store = await fresh();
    await store.allow('project', SITE);
    await store.addSuspect('https://suspect.example');
    writeFileSync(file(), text === 'TAMPER' ? tampered(readFileSync(file(), 'utf8')) : text);
    const again = await fresh();
    expect(again.origins('project')).toEqual([]);
    expect(again.suspects()).toEqual([]);
    expect(again.notice()).toBe('discarded');
    expect(existsSync(`${file()}.corrupt`)).toBe(true);
    expect((await fresh()).notice(), 'set aside once, then a fresh start').toBeUndefined();
  });

  it('without secure storage keeps the list for this run only, writes nothing, and says so', async () => {
    const store = new BrowserSiteStore(directory, { ...PROTECTOR, available: () => false });
    await store.load();
    await store.allow('project', SITE);
    expect(store.origins('project')).toEqual([SITE]);
    expect(existsSync(file())).toBe(false);
    expect(store.notice()).toBe('unprotected');
  });

  it('lists every project with a site, for the settings screen', async () => {
    const store = await fresh();
    await store.allow('project', SITE);
    await store.allow('another-project', 'https://other.example');
    await store.revoke('another-project', 'https://other.example');
    expect(store.projects()).toEqual([{ projectId: 'project', origins: [SITE] }]);
  });

  it('answers nothing before it has read the file', () => {
    expect(new BrowserSiteStore(directory, PROTECTOR).origins('project')).toEqual([]);
  });

  describe('sites that answered from where they must not', () => {
    it('remembers one for every project, across a restart', async () => {
      const store = await fresh();
      await store.addSuspect(SITE);
      expect((await fresh()).suspects()).toEqual([SITE]);
    });

    it('forgets one only when told', async () => {
      const store = await fresh();
      await store.addSuspect(SITE);
      await store.addSuspect('https://other.example');
      await store.clearSuspect(SITE);
      expect((await fresh()).suspects()).toEqual(['https://other.example']);
    });

    it('keeps the list and the suspects from overwriting each other', async () => {
      const store = await fresh();
      await Promise.all([store.allow('project', SITE), store.addSuspect(SITE)]);
      await store.revoke('project', 'https://other.example');
      const again = await fresh();
      expect(again.origins('project')).toEqual([SITE]);
      expect(again.suspects()).toEqual([SITE]);
    });

    it('reads a list written before there were any', async () => {
      writeFileSync(file(), sealed({ version: 1, projects: { project: [SITE] } }));
      const store = await fresh();
      expect(store.origins('project')).toEqual([SITE]);
      expect(store.suspects()).toEqual([]);
    });

    it('fails closed when the entry is no list: nothing is allowed', async () => {
      writeFileSync(file(), sealed({ version: 1, projects: { project: [SITE] }, suspects: SITE }));
      expect((await fresh()).origins('project')).toEqual([]);
    });

    it('keeps the latest ones: a page must not grow this file for ever', async () => {
      const store = await fresh();
      for (let index = 0; index < 505; index += 1) void store.addSuspect(`https://site-${String(index)}.example`);
      await store.addSuspect(SITE);
      const kept = (await fresh()).suspects();
      expect(kept).toHaveLength(500);
      expect(kept).toContain(SITE);
      expect(kept).not.toContain('https://site-0.example');
    });
  });
});

describe('BrowserLastPages', () => {
  const settled = async (pages: BrowserLastPages): Promise<void> => { await (pages as unknown as { file: { enqueue(op: () => Promise<void>): Promise<void> } }).file.enqueue(async () => undefined); };

  it('remembers a page across a restart', async () => {
    const pages = new BrowserLastPages(directory);
    await pages.load();
    pages.remember('chat', 'http://localhost:5173/cart');
    await settled(pages);
    const again = new BrowserLastPages(directory);
    await again.load();
    expect(again.get('chat')).toBe('http://localhost:5173/cart');
  });

  it('keeps the latest hundred', async () => {
    const pages = new BrowserLastPages(directory);
    await pages.load();
    for (let index = 0; index < 105; index += 1) pages.remember(`chat-${String(index)}`, 'http://localhost:1/');
    await settled(pages);
    expect(Object.keys(JSON.parse(readFileSync(path.join(directory, 'browser-pages.json'), 'utf8')) as object)).toHaveLength(100);
    expect(pages.get('chat-0')).toBeUndefined();
    expect(pages.get('chat-104')).toBeDefined();
  });

  it('forgets a conversation that went', async () => {
    const pages = new BrowserLastPages(directory);
    await pages.load();
    pages.remember('chat', 'http://localhost:5173/');
    pages.forget('chat');
    await settled(pages);
    expect(pages.get('chat')).toBeUndefined();
  });

  it('reads a damaged file as nothing', async () => {
    writeFileSync(path.join(directory, 'browser-pages.json'), '[1,2]');
    const pages = new BrowserLastPages(directory);
    await pages.load();
    expect(pages.get('chat')).toBeUndefined();
  });
});
