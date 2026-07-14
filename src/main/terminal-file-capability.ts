import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { TerminalFileLocationResult } from '../shared/terminal-file-location';

export const TERMINAL_FILE_CAPABILITY_TTL_MS = 15_000;
export const TERMINAL_FILE_CAPABILITY_CAP = 64;

type ResolveFailureReason = Extract<TerminalFileLocationResult, { readonly ok: false }>['reason'];

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

interface CapabilityRecord {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly expiresAt: number;
}

export interface TerminalFileCapabilityIssuer {
  issue(
    expectedCanonicalPath: string,
    expectedCanonicalRoot: string,
  ): Promise<
    | { readonly ok: true; readonly capability: string }
    | { readonly ok: false; readonly reason: ResolveFailureReason }
  >;
}

export type TerminalFileCapabilityConsumeResult =
  | { readonly ok: true; readonly handle: FileHandle }
  | {
      readonly ok: false;
      readonly error: 'invalid-capability' | 'expired' | 'path-mismatch' | 'file-changed' | 'unreadable';
    };

export interface TerminalFileCapabilityStoreOptions {
  readonly ttlMs?: number;
  readonly cap?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

function identityOf(stats: BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs };
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === '';
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function fsFailureReason(error: unknown): ResolveFailureReason {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  return 'unreadable';
}

/**
 * Main-owned, opaque one-shot authorization for the terminal-link preview
 * flow. Records never cross IPC/WS; only an unpredictable id does. Issuance
 * and consumption both operate on an opened handle and compare its fstat
 * identity with the pathname's realpath/stat view, closing path-swap and
 * symlink-replacement races before any bytes are read.
 */
export class TerminalFileCapabilityStore implements TerminalFileCapabilityIssuer {
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly records = new Map<string, CapabilityRecord>();

  constructor(options: TerminalFileCapabilityStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? TERMINAL_FILE_CAPABILITY_TTL_MS;
    this.cap = options.cap ?? TERMINAL_FILE_CAPABILITY_CAP;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error('terminal capability ttl must be positive');
    if (!Number.isSafeInteger(this.cap) || this.cap <= 0) throw new Error('terminal capability cap must be positive');
  }

  async issue(
    expectedCanonicalPath: string,
    expectedCanonicalRoot: string,
  ): Promise<
    | { readonly ok: true; readonly capability: string }
    | { readonly ok: false; readonly reason: ResolveFailureReason }
  > {
    let handle: FileHandle;
    try {
      handle = await fs.open(expectedCanonicalPath, 'r');
    } catch (error) {
      return { ok: false, reason: fsFailureReason(error) };
    }

    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile()) return { ok: false, reason: 'not-file' };

      const [currentRoot, currentTarget] = await Promise.all([
        fs.realpath(expectedCanonicalRoot),
        fs.realpath(expectedCanonicalPath),
      ]);
      if (!samePath(currentRoot, expectedCanonicalRoot)) return { ok: false, reason: 'unreadable' };
      if (!containedBy(currentRoot, currentTarget)) return { ok: false, reason: 'outside-workspace' };
      if (!samePath(currentTarget, expectedCanonicalPath)) return { ok: false, reason: 'unreadable' };

      const pathnameStats = await fs.stat(currentTarget, { bigint: true });
      const identity = identityOf(opened);
      if (!pathnameStats.isFile() || !sameIdentity(identity, identityOf(pathnameStats))) {
        return { ok: false, reason: pathnameStats.isFile() ? 'unreadable' : 'not-file' };
      }

      this.pruneExpired();
      while (this.records.size >= this.cap) {
        const oldest = this.records.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.records.delete(oldest);
      }
      let capability: string | undefined;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = this.newId();
        if (typeof candidate === 'string' && candidate.length > 0 && !this.records.has(candidate)) {
          capability = candidate;
          break;
        }
      }
      if (!capability) return { ok: false, reason: 'unreadable' };
      this.records.set(capability, {
        path: currentTarget,
        identity,
        expiresAt: this.now() + this.ttlMs,
      });
      return { ok: true, capability };
    } catch (error) {
      return { ok: false, reason: fsFailureReason(error) };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async consumeAndOpen(capability: unknown, requestedPath: unknown): Promise<TerminalFileCapabilityConsumeResult> {
    if (typeof capability !== 'string') return { ok: false, error: 'invalid-capability' };
    const record = this.records.get(capability);
    if (!record) return { ok: false, error: 'invalid-capability' };
    // One-shot before every async operation: concurrent/replayed consumes can
    // never observe the same record, including a wrong-path first attempt.
    this.records.delete(capability);
    if (this.now() > record.expiresAt) return { ok: false, error: 'expired' };
    if (typeof requestedPath !== 'string' || !samePath(path.resolve(requestedPath), record.path)) {
      return { ok: false, error: 'path-mismatch' };
    }

    let handle: FileHandle;
    try {
      handle = await fs.open(record.path, 'r');
    } catch {
      return { ok: false, error: 'file-changed' };
    }
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameIdentity(identityOf(opened), record.identity)) {
        await handle.close();
        return { ok: false, error: 'file-changed' };
      }
      const currentTarget = await fs.realpath(record.path);
      if (!samePath(currentTarget, record.path)) {
        await handle.close();
        return { ok: false, error: 'file-changed' };
      }
      const pathnameStats = await fs.stat(currentTarget, { bigint: true });
      if (!pathnameStats.isFile() || !sameIdentity(identityOf(pathnameStats), record.identity)) {
        await handle.close();
        return { ok: false, error: 'file-changed' };
      }
      return { ok: true, handle };
    } catch {
      await handle.close().catch(() => undefined);
      return { ok: false, error: 'unreadable' };
    }
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    return this.records.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [capability, record] of this.records) {
      if (now > record.expiresAt) this.records.delete(capability);
    }
  }
}
