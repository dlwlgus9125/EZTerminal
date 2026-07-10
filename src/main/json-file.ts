/**
 * JsonFile — the main process's atomic, self-quarantining JSON file primitive.
 *
 * One instance per physical file. Owns the fs write protocol that used to be
 * copy-pasted across LayoutStore / KnownHostsStore / RemoteTokenStore:
 *  - atomic write = `<file>.tmp` then rename (same-volume atomic on NTFS;
 *    rename replaces an existing target). One immediate retry on a transient
 *    Windows lock, then log + drop (the caller's next write retries naturally).
 *  - stale `<file>.tmp` from a crash mid-write is deleted on init().
 *  - writes are serialized on a per-file chain so a read-modify-write never
 *    interleaves with another write to the same file.
 *  - a corrupt/unreadable file is renamed to `<file>.corrupt` (overwriting the
 *    previous quarantine — keep ONE latest evidence file) and treated as absent.
 *
 * Electron-free (fs/path only); the base dir is injected so unit tests run
 * against real temp dirs. Schema validation stays in the owning store: read()
 * quarantines only UNPARSEABLE text and returns raw `unknown`; the store
 * validates and calls quarantine() itself on a schema miss (each store has a
 * different schema + "empty" default).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export class JsonFile {
  private readonly target: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string, name: string) {
    this.target = path.join(dir, name);
  }

  /** Absolute path to the file. */
  get path(): string {
    return this.target;
  }

  /** Ensure the containing dir exists and clear a crash-stale `.tmp` remnant. */
  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.target), { recursive: true });
    await fs.unlink(`${this.target}.tmp`).catch(() => undefined);
  }

  /**
   * Parsed JSON, or `undefined` when the file is absent. Unparseable text is
   * quarantined (rename -> `.corrupt`) and treated as absent. Schema validation
   * is the caller's job.
   */
  async read(): Promise<unknown | undefined> {
    let text: string;
    try {
      text = await fs.readFile(this.target, 'utf8');
    } catch {
      return undefined; // ENOENT and friends — treat as absent
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      await this.quarantine();
      return undefined;
    }
  }

  /** Serialize a read-modify-write on this file's chain and return its result.
   *  A rejecting op does not wedge the chain (subsequent ops still run). */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read + validate on the caller's terms: absent OR schema-miss → `empty`
   *  (a schema miss also quarantines). read() already quarantined unparseable text. */
  async readValidated<T>(validate: (raw: unknown) => T | null, empty: T): Promise<T> {
    const raw = await this.read();
    if (raw === undefined) return empty;
    const parsed = validate(raw);
    if (parsed === null) {
      await this.quarantine();
      return empty;
    }
    return parsed;
  }

  /** Atomic read-modify-write, entirely INSIDE the write chain, so two concurrent
   *  updates can never lose each other. The mutation result is re-validated; an
   *  invalid result is logged and dropped (no write). */
  async update<T>(
    validate: (raw: unknown) => T | null,
    empty: T,
    mutate: (current: T) => T,
    label: string,
  ): Promise<void> {
    await this.enqueue(async () => {
      const next = mutate(await this.readValidated(validate, empty));
      if (validate(next) === null) {
        console.error(`[json-file] dropped invalid update of ${path.basename(this.target)} (${label})`);
        return;
      }
      await this.writeAtomic(JSON.stringify(next));
    });
  }

  /** Atomic write: `<file>.tmp` then rename, one retry on a transient Windows
   *  lock, then log + drop. Call inside an enqueued op. */
  async writeAtomic(data: string): Promise<void> {
    const tmp = `${this.target}.tmp`;
    try {
      await fs.writeFile(tmp, data, 'utf8');
      try {
        await fs.rename(tmp, this.target);
      } catch {
        await fs.rename(tmp, this.target); // one retry (transient Windows lock), then drop
      }
    } catch (err) {
      console.error(`[json-file] atomic write of ${path.basename(this.target)} failed:`, err);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }

  /** Rename the file to `<file>.corrupt` (overwriting prior evidence). Awaitable
   *  so callers can suppress writes until quarantine lands. */
  async quarantine(): Promise<void> {
    try {
      await fs.rename(this.target, `${this.target}.corrupt`);
      console.error(
        `[json-file] quarantined ${path.basename(this.target)} -> ${path.basename(this.target)}.corrupt`,
      );
    } catch {
      // Already gone (double-quarantine race or ENOENT) — nothing to preserve.
    }
  }

  /** Await every queued write (flush seam + quit path). */
  async flush(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.writeChain;
      await chain;
    } while (chain !== this.writeChain);
  }
}
