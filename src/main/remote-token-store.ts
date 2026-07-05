/**
 * RemoteTokenStore — persists the auth token gating the mobile remote-control
 * WS bridge (`remote-bridge.ts`). Same versioned-envelope + atomic-write +
 * quarantine pattern as `KnownHostsStore`/`LayoutStore`: `getToken()` mints a
 * random token on first call (no prior file) and persists it; every later
 * call (including across store instances / app restarts) returns the same
 * token until `rotateToken()` replaces it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const REMOTE_TOKEN_FILE = 'remote-token.json';
const REMOTE_TOKEN_SCHEMA_VERSION = 1 as const;

interface RemoteTokenFile {
  readonly schemaVersion: typeof REMOTE_TOKEN_SCHEMA_VERSION;
  readonly token: string;
}

function isValidTokenFile(data: unknown): data is RemoteTokenFile {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { schemaVersion?: unknown }).schemaVersion === REMOTE_TOKEN_SCHEMA_VERSION &&
    typeof (data as { token?: unknown }).token === 'string' &&
    (data as { token: string }).token.length > 0
  );
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export class RemoteTokenStore {
  private readonly dir: string;
  private writeChain: Promise<void> = Promise.resolve();
  private cached: string | null = null;
  /** Guards concurrent first-call getToken() races from minting two tokens. */
  private loadPromise: Promise<string> | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(): string {
    return path.join(this.dir, REMOTE_TOKEN_FILE);
  }

  /** Absolute path to remote-token.json. */
  get path(): string {
    return this.file();
  }

  /** Ensure the dir exists and clear a crash-stale `.tmp` remnant. */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.unlink(`${this.file()}.tmp`).catch(() => undefined);
  }

  /** Returns the persisted token, minting + persisting one on first call. */
  async getToken(): Promise<string> {
    if (this.cached) return this.cached;
    if (!this.loadPromise) {
      this.loadPromise = this.loadOrMint();
    }
    const token = await this.loadPromise;
    this.cached = token;
    return token;
  }

  /** Mint a fresh token and persist it, replacing any prior one. */
  async rotateToken(): Promise<string> {
    const token = await this.mintAndPersist();
    this.cached = token;
    this.loadPromise = Promise.resolve(token);
    return token;
  }

  private async loadOrMint(): Promise<string> {
    const existing = await this.load();
    if (existing) return existing;
    return this.mintAndPersist();
  }

  private async mintAndPersist(): Promise<string> {
    const token = generateToken();
    await this.enqueue(async () => {
      await this.atomicWrite(JSON.stringify({ schemaVersion: REMOTE_TOKEN_SCHEMA_VERSION, token }));
    });
    return token;
  }

  private async load(): Promise<string | null> {
    let text: string;
    try {
      text = await fs.readFile(this.file(), 'utf8');
    } catch {
      return null; // absent — first use
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await this.quarantine();
      return null;
    }
    if (!isValidTokenFile(raw)) {
      await this.quarantine();
      return null;
    }
    return raw.token;
  }

  private async quarantine(): Promise<void> {
    const target = this.file();
    try {
      await fs.rename(target, `${target}.corrupt`);
      console.error(`[remote-token-store] quarantined ${REMOTE_TOKEN_FILE} -> ${REMOTE_TOKEN_FILE}.corrupt`);
    } catch {
      // Already gone (double-quarantine race or ENOENT) — nothing to preserve.
    }
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(op);
    return this.writeChain;
  }

  private async atomicWrite(data: string): Promise<void> {
    const target = this.file();
    const tmp = `${target}.tmp`;
    try {
      await fs.writeFile(tmp, data, 'utf8');
      try {
        await fs.rename(tmp, target);
      } catch {
        await fs.rename(tmp, target); // one retry (transient Windows lock), then drop
      }
    } catch (err) {
      console.error('[remote-token-store] atomic write failed:', err);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }
}
