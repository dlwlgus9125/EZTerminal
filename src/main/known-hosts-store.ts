/**
 * KnownHostsStore — TOFU host-key persistence (E5 §3), main's fs-owned store.
 *
 * Mirrors `layout-store.ts`'s write protocol exactly: atomic `<file>.tmp` ->
 * rename (one retry on a transient Windows lock, then drop), quarantine any
 * corrupt/invalid file to `<file>.corrupt` (overwriting prior evidence),
 * stale-`.tmp` cleanup on `init()`. Simpler than LayoutStore — one record
 * type, no debounced/latest-wins burst (a host-key write happens once per TOFU
 * accept, not on every keystroke), so each `add()` is its own atomic write,
 * serialized on a write chain so a concurrent check() during a write always
 * either fully precedes or fully follows it.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  emptyKnownHostsFile,
  hostRecordKey,
  validateKnownHostsFile,
  type KnownHostsFile,
} from '../shared/known-hosts-schema';

const KNOWN_HOSTS_FILE = 'known_hosts.json';

export type KnownHostVerdict = 'match' | 'mismatch' | 'unknown';

export interface KnownHostCheckResult {
  readonly verdict: KnownHostVerdict;
  /** The PREVIOUSLY trusted fingerprint — present only on `mismatch` (key rotation recovery). */
  readonly existingFingerprint?: string;
}

export class KnownHostsStore {
  private readonly dir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(): string {
    return path.join(this.dir, KNOWN_HOSTS_FILE);
  }

  /** Absolute path to known_hosts.json — surfaced in mismatch errors so the
   * user knows exactly which file to edit to recover from a key rotation. */
  get path(): string {
    return this.file();
  }

  /** Ensure the dir exists and clear a crash-stale `.tmp` remnant. */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.unlink(`${this.file()}.tmp`).catch(() => undefined);
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
    await this.enqueue(async () => {
      const data = await this.load();
      data.hosts[hostRecordKey(host, port)] = { keyType, fingerprintSha256: fingerprint };
      await this.atomicWrite(JSON.stringify(data));
    });
  }

  private async load(): Promise<KnownHostsFile> {
    let text: string;
    try {
      text = await fs.readFile(this.file(), 'utf8');
    } catch {
      return emptyKnownHostsFile(); // absent — first use
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      await this.quarantine();
      return emptyKnownHostsFile();
    }
    const parsed = validateKnownHostsFile(raw);
    if (parsed === null) {
      await this.quarantine();
      return emptyKnownHostsFile();
    }
    return parsed;
  }

  private async quarantine(): Promise<void> {
    const target = this.file();
    try {
      await fs.rename(target, `${target}.corrupt`);
      console.error(`[known-hosts-store] quarantined ${KNOWN_HOSTS_FILE} -> ${KNOWN_HOSTS_FILE}.corrupt`);
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
      console.error('[known-hosts-store] atomic write failed:', err);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }
}
