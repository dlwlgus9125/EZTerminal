import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * A host record file (the repeat schedule's, the work-folder cleanup's): one writer (this queue), each version written to
 * a temporary file, flushed, then renamed over the record, so a crash leaves the old or the new one whole. Plain text in
 * the user data folder, like the host's other settings (not a secret, so no per-file ACL).
 */
export class RecordFile {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Creates the folder and clears temporary files a crash left behind. */
  async init(): Promise<void> {
    const directory = path.dirname(this.path);
    await fs.mkdir(directory, { recursive: true });
    const prefix = `${path.basename(this.path)}.`;
    for (const name of await fs.readdir(directory)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) await fs.rm(path.join(directory, name), { force: true });
    }
  }

  async read(): Promise<string | undefined> {
    try { return await fs.readFile(this.path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async write(text: string): Promise<void> {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try {
      // One retry: a scanner or indexer can hold the record for a moment on Windows.
      await fs.rename(temporary, this.path).catch(async () => { await new Promise(resolve => setTimeout(resolve, 50)); await fs.rename(temporary, this.path); });
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}
