/**
 * RemoteTokenStore — persists the auth token gating the mobile remote-control
 * WS bridge (`remote-bridge.ts`). Composes a JsonFile for the atomic-write /
 * .corrupt-quarantine / write-chain protocol; this store keeps only the mint /
 * cache / rotate semantics: `getToken()` mints a random token on first call (no
 * prior file) and persists it; every later call (including across store
 * instances / app restarts) returns the same token until `rotateToken()`
 * replaces it.
 */
import { randomBytes } from 'node:crypto';

import { JsonFile } from './json-file';

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
  private readonly file: JsonFile;
  private cached: string | null = null;
  /** Guards concurrent first-call getToken() races from minting two tokens. */
  private loadPromise: Promise<string> | null = null;

  constructor(dir: string) {
    this.file = new JsonFile(dir, REMOTE_TOKEN_FILE);
  }

  /** Absolute path to remote-token.json. */
  get path(): string {
    return this.file.path;
  }

  /** Ensure the dir exists and clear a crash-stale `.tmp` remnant. */
  async init(): Promise<void> {
    await this.file.init();
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
    await this.file.enqueue(() =>
      this.file.writeAtomic(JSON.stringify({ schemaVersion: REMOTE_TOKEN_SCHEMA_VERSION, token })),
    );
    return token;
  }

  private async load(): Promise<string | null> {
    const raw = await this.file.read();
    if (raw === undefined) return null; // absent (or unparseable — already quarantined by read())
    if (!isValidTokenFile(raw)) {
      await this.file.quarantine();
      return null;
    }
    return raw.token;
  }
}
