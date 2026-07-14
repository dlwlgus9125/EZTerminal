/**
 * Persists the auth token gating the mobile remote-control WebSocket bridge.
 *
 * SecureAtomicFile provides bounded atomic replacement and platform file
 * permissions. On Windows, production also supplies a safeStorage-backed
 * protector so the file and every temporary replacement contain ciphertext,
 * not the bearer token. Legacy schema-v1 plaintext is upgraded before it is
 * returned to the caller.
 */
import { randomBytes } from 'node:crypto';

import { SecureAtomicFile, type SecureAtomicFileOptions } from './secure-atomic-file';

const REMOTE_TOKEN_FILE = 'remote-token.json';
const LEGACY_REMOTE_TOKEN_SCHEMA_VERSION = 1 as const;
const REMOTE_TOKEN_SCHEMA_VERSION = 2 as const;
const REMOTE_TOKEN_RE = /^[0-9a-f]{64}$/u;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface LegacyRemoteTokenFile {
  readonly schemaVersion: typeof LEGACY_REMOTE_TOKEN_SCHEMA_VERSION;
  readonly token: string;
}

interface ProtectedRemoteTokenFile {
  readonly schemaVersion: typeof REMOTE_TOKEN_SCHEMA_VERSION;
  readonly protectedToken: string;
}

export interface RemoteTokenProtector {
  readonly encrypt: (plaintext: string) => Buffer | Promise<Buffer>;
  readonly decrypt: (ciphertext: Buffer) => string | Promise<string>;
}

export interface RemoteTokenStoreOptions extends SecureAtomicFileOptions {
  /** OS-backed content protection. Required by the production Windows path. */
  readonly protector?: RemoteTokenProtector;
  /** Fail closed instead of ever serializing schema-v1 plaintext. */
  readonly requireProtector?: boolean;
}

function isLegacyTokenFile(data: unknown): data is LegacyRemoteTokenFile {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { schemaVersion?: unknown }).schemaVersion === LEGACY_REMOTE_TOKEN_SCHEMA_VERSION &&
    typeof (data as { token?: unknown }).token === 'string' &&
    REMOTE_TOKEN_RE.test((data as { token: string }).token)
  );
}

function isProtectedTokenFile(data: unknown): data is ProtectedRemoteTokenFile {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { schemaVersion?: unknown }).schemaVersion === REMOTE_TOKEN_SCHEMA_VERSION &&
    typeof (data as { protectedToken?: unknown }).protectedToken === 'string'
  );
}

function decodeProtectedToken(value: string): Buffer {
  if (value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    throw new Error('The protected remote token is not valid base64.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new Error('The protected remote token is not canonical base64.');
  }
  return decoded;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export class RemoteTokenStore {
  private readonly file: SecureAtomicFile;
  private readonly protector: RemoteTokenProtector | undefined;
  private readonly requireProtector: boolean;
  private cached: string | null = null;
  /** Guards concurrent first-call getToken() races from minting two tokens. */
  private loadPromise: Promise<string> | null = null;

  constructor(dir: string, options: RemoteTokenStoreOptions = {}) {
    const { protector, requireProtector = false, ...fileOptions } = options;
    this.file = new SecureAtomicFile(dir, REMOTE_TOKEN_FILE, fileOptions);
    this.protector = protector;
    this.requireProtector = requireProtector;
  }

  /** Absolute path to remote-token.json. */
  get path(): string {
    return this.file.path;
  }

  /** Ensure the dir exists and clear a crash-stale `.tmp` remnant. */
  async init(): Promise<void> {
    if (this.requireProtector && !this.protector) {
      throw new Error('OS-backed remote-token encryption is unavailable.');
    }
    await this.file.init();
  }

  /** Returns the persisted token, minting + persisting one on first call. */
  async getToken(): Promise<string> {
    if (this.cached) return this.cached;
    if (!this.loadPromise) {
      this.loadPromise = this.loadOrMint();
    }
    try {
      const token = await this.loadPromise;
      this.cached = token;
      return token;
    } catch (error) {
      this.loadPromise = null;
      throw error;
    }
  }

  /** Mint a fresh token and persist it, replacing any prior one. */
  async rotateToken(): Promise<string> {
    try {
      const token = await this.mintAndPersist();
      this.cached = token;
      this.loadPromise = Promise.resolve(token);
      return token;
    } catch (error) {
      // Atomic replacement can land before a final permission/identity check
      // fails. The persisted generation is then uncertain, so an old cached
      // bearer token must never be reused without a fresh protected read.
      this.cached = null;
      this.loadPromise = null;
      throw error;
    }
  }

  private async loadOrMint(): Promise<string> {
    const existing = await this.load();
    if (existing) return existing;
    return this.mintAndPersist();
  }

  private async mintAndPersist(): Promise<string> {
    const token = generateToken();
    await this.persistToken(token);
    return token;
  }

  private async persistToken(token: string): Promise<void> {
    const serialized = await this.serializeToken(token);
    await this.file.enqueue(() => this.file.writeAtomic(serialized));
  }

  private async serializeToken(token: string): Promise<string> {
    if (this.protector) {
      let ciphertext: Buffer;
      try {
        ciphertext = Buffer.from(await this.protector.encrypt(token));
      } catch (error) {
        throw new Error('Unable to encrypt the remote pairing token with OS-backed storage.', { cause: error });
      }
      if (ciphertext.length === 0) throw new Error('OS-backed remote-token encryption returned no data.');
      return JSON.stringify({
        schemaVersion: REMOTE_TOKEN_SCHEMA_VERSION,
        protectedToken: ciphertext.toString('base64'),
      } satisfies ProtectedRemoteTokenFile);
    }
    if (this.requireProtector) throw new Error('OS-backed remote-token encryption is unavailable.');
    return JSON.stringify({
      schemaVersion: LEGACY_REMOTE_TOKEN_SCHEMA_VERSION,
      token,
    } satisfies LegacyRemoteTokenFile);
  }

  private async load(): Promise<string | null> {
    const text = await this.file.readText();
    if (text === undefined) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      await this.file.quarantine();
      return null;
    }

    if (isProtectedTokenFile(raw)) return this.decryptToken(raw.protectedToken);

    if (isLegacyTokenFile(raw)) {
      if (this.protector) {
        // Preserve the pairing token, but do not expose it to the bridge until
        // its ciphertext replacement has durably landed.
        await this.persistToken(raw.token);
      } else if (this.requireProtector) {
        throw new Error('A plaintext remote token cannot be loaded without OS-backed encryption.');
      }
      return raw.token;
    }

    await this.file.quarantine();
    return null;
  }

  private async decryptToken(protectedToken: string): Promise<string> {
    if (!this.protector) {
      throw new Error('The protected remote token cannot be loaded without OS-backed encryption.');
    }
    let token: string;
    try {
      token = await this.protector.decrypt(decodeProtectedToken(protectedToken));
    } catch (error) {
      // Do not quarantine or rotate here: a keyring/DPAPI outage may be
      // transient, and replacing the only recoverable pairing token would be
      // destructive. The remote listener remains disabled instead.
      throw new Error('Unable to decrypt the remote pairing token with OS-backed storage.', { cause: error });
    }
    if (!REMOTE_TOKEN_RE.test(token)) {
      throw new Error('OS-backed storage returned an invalid remote pairing token.');
    }
    return token;
  }
}
