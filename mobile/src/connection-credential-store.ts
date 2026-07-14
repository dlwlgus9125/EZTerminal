import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const SECURE_KEY = 'ezterminal-mobile-connection-v1';
export const LEGACY_CONNECTION_KEY = 'ezterminal-mobile-connection';
const SCHEMA_VERSION = 1 as const;
export const CONNECTION_CREDENTIAL_MAX_BYTES = 4 * 1024;

const utf8Encoder = new TextEncoder();

export interface StoredConnection {
  readonly url: string;
  readonly token: string;
}

interface SecureConnectionRecord extends StoredConnection {
  readonly schemaVersion: typeof SCHEMA_VERSION;
}

export interface CredentialLoadResult {
  readonly connection: StoredConnection | null;
  readonly warning: string | null;
}

export interface SecureStorageLike {
  get(options: { key: string }): Promise<{ value: string }>;
  set(options: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(options: { key: string }): Promise<{ value: boolean }>;
  keys(): Promise<{ value: string[] }>;
  getPlatform(): Promise<{ value: string }>;
}

export interface LegacyStorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function parseConnection(value: unknown, requireSchema: boolean): StoredConnection | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { schemaVersion?: unknown; url?: unknown; token?: unknown };
  if (requireSchema && record.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof record.url !== 'string' || record.url.trim() === '') return null;
  if (typeof record.token !== 'string' || record.token.trim() === '') return null;
  return { url: record.url, token: record.token };
}

function parseJsonConnection(text: string, requireSchema: boolean): StoredConnection | null {
  // Secure-storage values cross a native/plugin boundary. Bound the bytes
  // before JSON.parse so a corrupt or hostile record cannot force an
  // unbounded secret allocation/parse. Apply the same rule to legacy migration.
  if (utf8Encoder.encode(text).byteLength > CONNECTION_CREDENTIAL_MAX_BYTES) return null;
  try {
    return parseConnection(JSON.parse(text) as unknown, requireSchema);
  } catch {
    return null;
  }
}

export class ConnectionCredentialStore {
  constructor(
    private readonly secure: SecureStorageLike = SecureStoragePlugin,
    private readonly legacy: LegacyStorageLike = localStorage,
  ) {}

  /** Load secure credentials and migrate the old plaintext record on Android. */
  async load(): Promise<CredentialLoadResult> {
    if (!(await this.isAndroid())) {
      return {
        connection: null,
        warning: 'Secure credential storage is available only in the Android app. Credentials will not be saved here.',
      };
    }

    let keys: string[];
    try {
      keys = (await this.secure.keys()).value;
    } catch {
      return { connection: null, warning: 'Android secure credential storage is unavailable.' };
    }

    let secureWarning: string | null = null;
    if (keys.includes(SECURE_KEY)) {
      const connection = await this.readSecure();
      if (!connection) {
        secureWarning = 'Stored connection credentials are invalid or unavailable.';
      } else if (!this.removeAndVerifyLegacy()) {
        // Retry on every future load. Do not return a value that could silently
        // auto-fill while a plaintext copy is still present.
        return { connection: null, warning: 'Plaintext credential cleanup is pending; enter the connection again.' };
      } else {
        return { connection, warning: null };
      }
    }

    const legacy = this.readLegacy();
    if (!legacy.connection) {
      if (legacy.warning && !this.removeAndVerifyLegacy()) {
        return { connection: null, warning: 'Plaintext credential cleanup is pending; enter the connection again.' };
      }
      return { connection: null, warning: legacy.warning ?? secureWarning };
    }

    try {
      await this.writeAndVerify(legacy.connection);
    } catch {
      return { connection: null, warning: 'Existing credentials could not be migrated to Android secure storage.' };
    }
    if (!this.removeAndVerifyLegacy()) {
      return { connection: null, warning: 'Plaintext credential cleanup is pending; enter the connection again.' };
    }
    return { connection: legacy.connection, warning: null };
  }

  /** Persist only in Android Keystore-backed storage; there is no web fallback. */
  async save(connection: StoredConnection): Promise<void> {
    if (!(await this.isAndroid())) throw new Error('Android secure storage is unavailable.');
    const validated = parseConnection(connection, false);
    if (!validated) throw new Error('Invalid connection credentials.');
    await this.writeAndVerify(validated);
    if (!this.removeAndVerifyLegacy()) throw new Error('Plaintext credential cleanup is pending.');
  }

  private async isAndroid(): Promise<boolean> {
    try {
      return (await this.secure.getPlatform()).value === 'android';
    } catch {
      return false;
    }
  }

  private async readSecure(): Promise<StoredConnection | null> {
    try {
      const result = await this.secure.get({ key: SECURE_KEY });
      return parseJsonConnection(result.value, true);
    } catch {
      return null;
    }
  }

  private readLegacy(): CredentialLoadResult {
    try {
      const raw = this.legacy.getItem(LEGACY_CONNECTION_KEY);
      if (!raw) return { connection: null, warning: null };
      const connection = parseJsonConnection(raw, false);
      return connection
        ? { connection, warning: null }
        : { connection: null, warning: 'The old plaintext connection record is invalid and was not used.' };
    } catch {
      return { connection: null, warning: 'Plaintext credential cleanup could not be verified.' };
    }
  }

  private async writeAndVerify(connection: StoredConnection): Promise<void> {
    const record: SecureConnectionRecord = { schemaVersion: SCHEMA_VERSION, ...connection };
    const serialized = JSON.stringify(record);
    if (utf8Encoder.encode(serialized).byteLength > CONNECTION_CREDENTIAL_MAX_BYTES) {
      throw new Error('Connection credentials are too large.');
    }
    const written = await this.secure.set({ key: SECURE_KEY, value: serialized });
    if (!written.value) throw new Error('Secure storage rejected the write.');
    const readBack = await this.secure.get({ key: SECURE_KEY });
    if (readBack.value !== serialized || !parseJsonConnection(readBack.value, true)) {
      throw new Error('Secure storage read-back verification failed.');
    }
  }

  private removeAndVerifyLegacy(): boolean {
    try {
      this.legacy.removeItem(LEGACY_CONNECTION_KEY);
      return this.legacy.getItem(LEGACY_CONNECTION_KEY) === null;
    } catch {
      return false;
    }
  }
}
