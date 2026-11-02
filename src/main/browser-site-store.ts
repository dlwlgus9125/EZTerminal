import { promises as fs } from 'node:fs';

import { allowableOrigin, type BrowserSitesNotice } from '../shared/browser';
import { JsonFile } from './json-file';

const SITES_FILE = 'browser-sites.json';
const PAGES_FILE = 'browser-pages.json';
const REMEMBERED_PAGES = 100;
/** A page can raise these, so the file has an end. */
const REMEMBERED_SUSPECTS = 500;

interface BrowserSitesFile {
  readonly version: 1;
  readonly projects: Readonly<Record<string, readonly string[]>>;
  /** Sites that answered from where they must not: one list for the one partition, whichever project saw it. */
  readonly suspects?: readonly string[];
}

function validSites(raw: unknown): BrowserSitesFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { version, projects, suspects } = raw as { version?: unknown; projects?: unknown; suspects?: unknown };
  if (version !== 1 || typeof projects !== 'object' || projects === null || Array.isArray(projects)) return null;
  if (suspects !== undefined && !Array.isArray(suspects)) return null;
  const clean: Record<string, readonly string[]> = {};
  for (const [projectId, origins] of Object.entries(projects)) {
    if (!Array.isArray(origins)) return null;
    // A hand-edited entry that is no exact origin allows nothing.
    clean[projectId] = [...new Set(origins.flatMap((origin) => (typeof origin === 'string' ? allowableOrigin(origin) ?? [] : [])))];
  }
  // A suspect only ever refuses, so an odd entry costs nothing.
  return { version: 1, projects: clean, ...(suspects ? { suspects: suspects.filter((origin): origin is string => typeof origin === 'string') } : {}) };
}

/** OS-backed encryption: Electron's `safeStorage` in the app. */
export interface BrowserSitesProtector {
  readonly available: () => boolean;
  readonly encrypt: (plaintext: string) => Buffer | Promise<Buffer>;
  readonly decrypt: (ciphertext: Buffer) => string | Promise<string>;
}

/** The file at rest: the list as ciphertext, so an edit of it is noticed rather than trusted. */
interface ProtectedSites {
  readonly version: 2;
  readonly protectedSites: string;
}

/**
 * Which sites a person allowed, by exact origin and by project. Only `browser.site` writes here, and only a person at the
 * desktop sends that: no tool, model or page reaches it. Read on every navigation and request, so it answers from memory,
 * and a revoke applies at once.
 *
 * Memory is the record: the file is read once, at load, and every change is computed from memory and written whole. On disk
 * the list is ciphertext, so a file the app did not write (a model with full access edits it, say) is set aside at the next
 * start, with a reason the settings screen shows, and allows nothing. What remains (design risk 3): something running as
 * this user can reach the same OS key, or put back an older file of the app's own.
 */
export class BrowserSiteStore {
  private readonly file: JsonFile;
  private projectSites: BrowserSitesFile['projects'] = {};
  private suspected: readonly string[] = [];
  private noticeValue: BrowserSitesNotice | undefined;

  constructor(dir: string, private readonly protector?: BrowserSitesProtector) {
    this.file = new JsonFile(dir, SITES_FILE);
  }

  async load(): Promise<void> {
    await this.file.init();
    if (!this.protector?.available()) {
      // Nothing it could read is trusted, and nothing is written in the clear: the list lasts until the app closes.
      this.noticeValue = 'unprotected';
      return;
    }
    let text: string;
    try {
      text = await fs.readFile(this.file.path, 'utf8');
    } catch {
      return; // None yet.
    }
    const saved = await this.unprotect(text);
    if (!saved) {
      this.noticeValue = 'discarded';
      await this.file.quarantine();
      return;
    }
    this.projectSites = saved.projects;
    this.suspected = saved.suspects ?? [];
  }

  /** Why the list is not what was saved, for the settings screen. */
  notice(): BrowserSitesNotice | undefined {
    return this.noticeValue;
  }

  private async unprotect(text: string): Promise<BrowserSitesFile | null> {
    try {
      const envelope = JSON.parse(text) as Partial<ProtectedSites>;
      if (envelope.version !== 2 || typeof envelope.protectedSites !== 'string' || Object.keys(envelope).length !== 2) return null;
      const ciphertext = Buffer.from(envelope.protectedSites, 'base64');
      if (ciphertext.length === 0 || ciphertext.toString('base64') !== envelope.protectedSites) return null;
      return validSites(JSON.parse(await this.protector!.decrypt(ciphertext)));
    } catch {
      return null;
    }
  }

  /** The whole list as memory holds it now, written in place of what was there. */
  private save(): Promise<void> {
    const protector = this.protector;
    if (!protector?.available()) return Promise.resolve();
    return this.file.enqueue(async () => {
      const body: BrowserSitesFile = { version: 1, projects: this.projectSites, ...(this.suspected.length ? { suspects: this.suspected } : {}) };
      const envelope: ProtectedSites = { version: 2, protectedSites: Buffer.from(await protector.encrypt(JSON.stringify(body))).toString('base64') };
      await this.file.writeAtomic(JSON.stringify(envelope));
    });
  }

  origins(projectId: string): readonly string[] {
    return this.projectSites[projectId] ?? [];
  }

  suspects(): readonly string[] {
    return this.suspected;
  }

  /** Every project with a site. */
  projects(): readonly { readonly projectId: string; readonly origins: readonly string[] }[] {
    return Object.entries(this.projectSites).map(([projectId, origins]) => ({ projectId, origins }));
  }

  /** On disk behind the view manager, which holds the set that decides: a failed write costs the next restart, not this run. */
  async addSuspect(origin: string): Promise<void> {
    this.suspected = [...this.suspected.filter((entry) => entry !== origin), origin].slice(-REMEMBERED_SUSPECTS);
    await this.save().catch(() => undefined);
  }

  async clearSuspect(origin: string): Promise<void> {
    this.suspected = this.suspected.filter((entry) => entry !== origin);
    await this.save().catch(() => undefined);
  }

  async allow(projectId: string, origin: string): Promise<void> {
    await this.change(projectId, (origins) => [...new Set([...origins, origin])]);
  }

  async revoke(projectId: string, origin: string): Promise<void> {
    await this.change(projectId, (origins) => origins.filter((entry) => entry !== origin));
  }

  /** A change applies in memory at once; a write that fails is reported, and the next change writes the whole list again. */
  private async change(projectId: string, mutate: (origins: readonly string[]) => readonly string[]): Promise<void> {
    const origins = mutate(this.projectSites[projectId] ?? []);
    const others = Object.entries(this.projectSites).filter(([id]) => id !== projectId);
    this.projectSites = Object.fromEntries(origins.length ? [...others, [projectId, origins]] : others);
    await this.save().catch((error: unknown) => { throw new Error('The site list could not be saved.', { cause: error }); });
  }
}

/** The last page of each conversation, for the pane after a restart. Nothing loads from here by itself. */
export class BrowserLastPages {
  private readonly file: JsonFile;
  private readonly pages = new Map<string, string>();

  constructor(dir: string) {
    this.file = new JsonFile(dir, PAGES_FILE);
  }

  async load(): Promise<void> {
    await this.file.init();
    const raw = await this.file.read();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
    for (const [conversationId, url] of Object.entries(raw)) if (typeof url === 'string') this.pages.set(conversationId, url);
  }

  get(conversationId: string): string | undefined {
    return this.pages.get(conversationId);
  }

  remember(conversationId: string, url: string): void {
    this.pages.delete(conversationId);
    this.pages.set(conversationId, url);
    for (const oldest of this.pages.keys()) {
      if (this.pages.size <= REMEMBERED_PAGES) break;
      this.pages.delete(oldest);
    }
    const body = JSON.stringify(Object.fromEntries(this.pages));
    void this.file.enqueue(() => this.file.writeAtomic(body)).catch(() => undefined);
  }

  forget(conversationId: string): void {
    if (!this.pages.delete(conversationId)) return;
    const body = JSON.stringify(Object.fromEntries(this.pages));
    void this.file.enqueue(() => this.file.writeAtomic(body)).catch(() => undefined);
  }
}
