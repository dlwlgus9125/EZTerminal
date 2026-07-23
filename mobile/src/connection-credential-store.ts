import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const SECURE_KEY = 'ezterminal-mobile-connection-v1';
export const LEGACY_CONNECTION_KEY = 'ezterminal-mobile-connection';
const SCHEMA_VERSION = 2 as const;
export const CONNECTION_CREDENTIAL_MAX_BYTES = 4 * 1024;

const utf8Encoder = new TextEncoder();

export interface StoredConnection {
  readonly url: string;
  readonly token: string;
  readonly clientId: string;
  readonly clientName: string;
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

type LegacyConnection = Pick<StoredConnection, 'url' | 'token'>;

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseConnection(value: unknown): StoredConnection | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as {
    schemaVersion?: unknown;
    url?: unknown;
    token?: unknown;
    clientId?: unknown;
    clientName?: unknown;
  };
  if (record.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof record.url !== 'string' || record.url.trim() === '') return null;
  if (typeof record.token !== 'string' || record.token.trim() === '') return null;
  if (!isUuid(record.clientId)) return null;
  if (typeof record.clientName !== 'string' || record.clientName.trim() === '' || record.clientName.length > 80) return null;
  return {
    url: record.url,
    token: record.token,
    clientId: record.clientId,
    clientName: record.clientName,
  };
}

function parseLegacyConnection(value: unknown): LegacyConnection | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { schemaVersion?: unknown; url?: unknown; token?: unknown };
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) return null;
  if (typeof record.url !== 'string' || record.url.trim() === '') return null;
  if (typeof record.token !== 'string' || record.token.trim() === '') return null;
  return { url: record.url, token: record.token };
}

function parseBoundedJson(text: string): unknown | null {
  // Secure-storage values cross a native/plugin boundary. Bound the bytes
  // before JSON.parse so a corrupt or hostile record cannot force an
  // unbounded secret allocation/parse. Apply the same rule to legacy migration.
  if (utf8Encoder.encode(text).byteLength > CONNECTION_CREDENTIAL_MAX_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class ConnectionCredentialStore {
  constructor(
    private readonly secure: SecureStorageLike = SecureStoragePlugin,
    private readonly legacy: LegacyStorageLike = localStorage,
    private readonly createIdentity: () => Pick<StoredConnection, 'clientId' | 'clientName'> = () => ({
      clientId: crypto.randomUUID(),
      clientName: 'Android device',
    }),
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
      const stored = await this.readSecureValue();
      let connection = stored === null ? null : parseConnection(stored);
      if (!connection) {
        const legacySecure = parseLegacyConnection(stored);
        if (legacySecure) {
          connection = { ...legacySecure, ...this.createIdentity() };
          try {
            await this.writeAndVerify(connection);
          } catch {
            return { connection: null, warning: 'Existing credentials could not be migrated to Android secure storage.' };
          }
        }
      }
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
  async save(connection: StoredConnection | LegacyConnection): Promise<void> {
    if (!(await this.isAndroid())) throw new Error('Android secure storage is unavailable.');
    const candidate = 'clientId' in connection && 'clientName' in connection
      ? connection
      : { ...connection, ...this.createIdentity() };
    const validated = parseConnection({ schemaVersion: SCHEMA_VERSION, ...candidate });
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

  private async readSecureValue(): Promise<unknown | null> {
    try {
      const result = await this.secure.get({ key: SECURE_KEY });
      return parseBoundedJson(result.value);
    } catch {
      return null;
    }
  }

  private readLegacy(): CredentialLoadResult {
    try {
      const raw = this.legacy.getItem(LEGACY_CONNECTION_KEY);
      if (!raw) return { connection: null, warning: null };
      const connection = parseLegacyConnection(parseBoundedJson(raw));
      return connection
        ? { connection: { ...connection, ...this.createIdentity() }, warning: null }
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
    if (readBack.value !== serialized || !parseConnection(parseBoundedJson(readBack.value))) {
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
