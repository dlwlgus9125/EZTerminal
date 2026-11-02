import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowserLastPages, BrowserSiteStore } from './browser-site-store';

const SITE = 'https://staging.cart-kit.example';
let directory: string;

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'ez-browser-sites-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const fresh = async (): Promise<BrowserSiteStore> => {
  const store = new BrowserSiteStore(directory);
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

  it('drops an entry that is no exact origin: a hand edit allows nothing', async () => {
    writeFileSync(path.join(directory, 'browser-sites.json'), JSON.stringify({ version: 1, projects: { project: [SITE, 'https://*.example', 'http://localhost:5173', 'https://a.example/path', 'javascript:alert(1)', 7] } }));
    expect((await fresh()).origins('project')).toEqual([SITE]);
  });

  it.each(['not json', '{"version":2,"projects":{}}', '{"version":1,"projects":[]}', '{"version":1,"projects":{"project":"https://a.example"}}', 'null'])('fails closed on %s', async (text) => {
    writeFileSync(path.join(directory, 'browser-sites.json'), text);
    expect((await fresh()).origins('project')).toEqual([]);
  });

  it('answers nothing before it has read the file', () => {
    expect(new BrowserSiteStore(directory).origins('project')).toEqual([]);
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
