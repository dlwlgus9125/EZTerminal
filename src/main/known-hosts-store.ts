/**
 * KnownHostsStore — TOFU host-key persistence (E5 §3), main's fs-owned store.
 *
 * Composes a JsonFile for the atomic-write / .corrupt-quarantine / write-chain
 * protocol; this store keeps only the TOFU domain logic and the known_hosts
 * schema. A host-key write happens once per TOFU accept (not on every
 * keystroke), so each add() is its own atomic write, serialized on the file's
 * write chain so a concurrent check() during a write always either fully
 * precedes or fully follows it.
 */
import {
  emptyKnownHostsFile,
  hostRecordKey,
  validateKnownHostsFile,
  type KnownHostsFile,
} from '../shared/known-hosts-schema';
import { JsonFile } from './json-file';

const KNOWN_HOSTS_FILE = 'known_hosts.json';

export type KnownHostVerdict = 'match' | 'mismatch' | 'unknown';

export interface KnownHostCheckResult {
  readonly verdict: KnownHostVerdict;
  /** The PREVIOUSLY trusted fingerprint — present only on `mismatch` (key rotation recovery). */
  readonly existingFingerprint?: string;
}

export class KnownHostsStore {
  private readonly file: JsonFile;

  constructor(dir: string) {
    this.file = new JsonFile(dir, KNOWN_HOSTS_FILE);
  }

  /** Absolute path to known_hosts.json — surfaced in mismatch errors so the
   * user knows exactly which file to edit to recover from a key rotation. */
  get path(): string {
    return this.file.path;
  }

  /** Ensure the dir exists and clear a crash-stale `.tmp` remnant. */
  async init(): Promise<void> {
    await this.file.init();
  }

  /** TOFU lookup: `match` (identical fingerprint), `mismatch` (key rotated or
   * spoofed — hard fail upstream), or `unknown` (never seen this host:port). */
  async check(host: string, port: number, keyType: string, fingerprint: string): Promise<KnownHostCheckResult> {
    const data = await this.load();
    const entry = data.hosts[hostRecordKey(host, port)];
    if (!entry) return { verdict: 'unknown' };
    if (entry.keyType === keyType && entry.fingerprintSha256 === fingerprint) return { verdict: 'match' };
    return { verdict: 'mismatch', existingFingerprint: entry.fingerprintSha256 };
  }

  /** Persist a newly-accepted host key (TOFU accept). Serialized on the write chain. */
  async add(host: string, port: number, keyType: string, fingerprint: string): Promise<void> {
    await this.file.update(
      validateKnownHostsFile,
      emptyKnownHostsFile(),
      (data) => {
        data.hosts[hostRecordKey(host, port)] = { keyType, fingerprintSha256: fingerprint };
        return data;
      },
      'known-host add',
    );
  }

  private async load(): Promise<KnownHostsFile> {
    return this.file.readValidated(validateKnownHostsFile, emptyKnownHostsFile());
  }
}
