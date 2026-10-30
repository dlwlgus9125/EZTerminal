import { JsonFile } from './json-file';
import type { CodexToldThreads } from './codex-provider-adapter';

export const TURN_WRAP_UP_TOLD_THREADS_FILE = 'turn-wrap-up-told-threads.json';
const MAX_THREADS = 5_000;

interface ToldThreadsFile {
  readonly version: 1;
  readonly threads: readonly string[];
}

const EMPTY: ToldThreadsFile = { version: 1, threads: [] };

function validate(raw: unknown): ToldThreadsFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { version, threads } = raw as { readonly version?: unknown; readonly threads?: unknown };
  return version === 1 && Array.isArray(threads) && threads.every((thread) => typeof thread === 'string') ? { version: 1, threads } : null;
}

/**
 * The Codex threads that already heard the turn wrap-up instructions. In a file, not the daemon database,
 * which a new column would close to older builds. A thread lost from it (a bad file, past the bound) is
 * only told once more.
 */
export class TurnWrapUpToldThreads implements CodexToldThreads {
  private readonly file: JsonFile;
  private readonly maxThreads: number;
  private readonly told = new Set<string>();
  private loaded = false;

  constructor(dir: string, options: { readonly maxThreads?: number } = {}) {
    this.file = new JsonFile(dir, TURN_WRAP_UP_TOLD_THREADS_FILE);
    this.maxThreads = options.maxThreads ?? MAX_THREADS;
  }

  async init(): Promise<void> {
    await this.file.init();
    const stored = await this.file.readValidated(validate, EMPTY);
    const early = [...this.told];
    this.told.clear();
    for (const thread of [...stored.threads, ...early]) this.told.add(thread);
    this.loaded = true;
    this.persist(early);
  }

  /** Until the file has loaded every thread counts as told: better a turn late than told twice. */
  has(threadId: string): boolean {
    return !this.loaded || this.told.has(threadId);
  }

  add(threadId: string): void {
    this.told.add(threadId);
    if (this.loaded) this.persist([threadId]);
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  private persist(threads: readonly string[]): void {
    if (!threads.length) return;
    void this.file.update(validate, EMPTY, (current) => ({
      version: 1 as const,
      threads: [...new Set([...current.threads, ...threads])].slice(-this.maxThreads),
    }), 'record told threads').catch(() => undefined);
  }
}
