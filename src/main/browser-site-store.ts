import { allowableOrigin } from '../shared/browser';
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

const EMPTY: BrowserSitesFile = { version: 1, projects: {} };

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

/**
 * Which sites a person allowed, by exact origin and by project. Only `browser.site` writes here, and only a person at the
 * desktop sends that: no tool, model or page reaches it. Read on every navigation and request, so it answers from memory,
 * and a revoke applies at once. With full access an AI could still edit the file on disk: that is design risk 3, and the
 * running app does not reread it.
 */
export class BrowserSiteStore {
  private readonly file: JsonFile;
  private projectSites: BrowserSitesFile['projects'] = {};
  private suspected: readonly string[] = [];

  constructor(dir: string) {
    this.file = new JsonFile(dir, SITES_FILE);
  }

  async load(): Promise<void> {
    await this.file.init();
    const { projects, suspects } = await this.file.readValidated(validSites, EMPTY);
    this.projectSites = projects;
    this.suspected = suspects ?? [];
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
    await this.changeSuspects((suspects) => [...suspects.filter((entry) => entry !== origin), origin].slice(-REMEMBERED_SUSPECTS));
  }

  async clearSuspect(origin: string): Promise<void> {
    await this.changeSuspects((suspects) => suspects.filter((entry) => entry !== origin));
  }

  private async changeSuspects(mutate: (suspects: readonly string[]) => readonly string[]): Promise<void> {
    const next = await this.file.update(validSites, EMPTY, (current) => ({ ...current, suspects: mutate(current.suspects ?? []) }), 'browser suspects').catch(() => undefined);
    if (next) this.suspected = next.suspects ?? [];
  }

  async allow(projectId: string, origin: string): Promise<void> {
    await this.change(projectId, (origins) => [...new Set([...origins, origin])]);
  }

  async revoke(projectId: string, origin: string): Promise<void> {
    await this.change(projectId, (origins) => origins.filter((entry) => entry !== origin));
  }

  private async change(projectId: string, mutate: (origins: readonly string[]) => readonly string[]): Promise<void> {
    const next = await this.file.update(validSites, EMPTY, (current) => {
      const origins = mutate(current.projects[projectId] ?? []);
      const others = Object.entries(current.projects).filter(([id]) => id !== projectId);
      return { ...current, projects: Object.fromEntries(origins.length ? [...others, [projectId, origins]] : others) };
    }, 'browser sites');
    if (!next) throw new Error('The site list could not be saved.');
    this.projectSites = next.projects;
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
