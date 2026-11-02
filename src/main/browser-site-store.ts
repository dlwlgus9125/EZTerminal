import { allowableOrigin } from '../shared/browser';
import { JsonFile } from './json-file';

const SITES_FILE = 'browser-sites.json';
const PAGES_FILE = 'browser-pages.json';
const REMEMBERED_PAGES = 100;

interface BrowserSitesFile {
  readonly version: 1;
  readonly projects: Readonly<Record<string, readonly string[]>>;
}

const EMPTY: BrowserSitesFile = { version: 1, projects: {} };

function validSites(raw: unknown): BrowserSitesFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { version, projects } = raw as { version?: unknown; projects?: unknown };
  if (version !== 1 || typeof projects !== 'object' || projects === null || Array.isArray(projects)) return null;
  const clean: Record<string, readonly string[]> = {};
  for (const [projectId, origins] of Object.entries(projects)) {
    if (!Array.isArray(origins)) return null;
    // A hand-edited entry that is no exact origin allows nothing.
    clean[projectId] = [...new Set(origins.flatMap((origin) => (typeof origin === 'string' ? allowableOrigin(origin) ?? [] : [])))];
  }
  return { version: 1, projects: clean };
}

/**
 * Which sites a person allowed, by exact origin and by project. Only `browser.site` writes here, and only a person at the
 * desktop sends that: no tool, model or page reaches it. Read on every navigation and request, so it answers from memory,
 * and a revoke applies at once. With full access an AI could still edit the file on disk: that is design risk 3, and the
 * running app does not reread it.
 */
export class BrowserSiteStore {
  private readonly file: JsonFile;
  private projects: BrowserSitesFile['projects'] = {};

  constructor(dir: string) {
    this.file = new JsonFile(dir, SITES_FILE);
  }

  async load(): Promise<void> {
    await this.file.init();
    this.projects = (await this.file.readValidated(validSites, EMPTY)).projects;
  }

  origins(projectId: string): readonly string[] {
    return this.projects[projectId] ?? [];
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
      return { version: 1 as const, projects: Object.fromEntries(origins.length ? [...others, [projectId, origins]] : others) };
    }, 'browser sites');
    if (!next) throw new Error('The site list could not be saved.');
    this.projects = next.projects;
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
