import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MAX_PROJECT_MAP_ROOTS,
  type ProjectMapDiagnostic,
  type ProjectMapDocument,
  type ProjectMapProvenance,
  type ProjectMapVerification,
  validateProjectMapSpec,
} from '../shared/project-map';
import { layoutProjectMap } from '../shared/project-map-layout';
import { JsonFile } from './json-file';

const SCHEMA_VERSION = 2 as const;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 256;
const MAX_CACHE_DIAGNOSTICS = 256;

interface CacheEntry {
  readonly key: string;
  readonly blob: string;
  readonly bytes: number;
  readonly lastAccess: string;
}

interface CacheIndex {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly entries: readonly CacheEntry[];
}

interface CacheBlob {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly document: ProjectMapDocument;
}

const EMPTY: CacheIndex = { schemaVersion: SCHEMA_VERSION, entries: [] };
const BLOB_RE = /^[a-f0-9]{64}\.json$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const PORTABLE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const GIT_HEAD_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CHECK_NAMES = [
  'schema',
  'semantics',
  'evidence',
  'inputs',
  'layout',
  'routes',
  'labels',
  'containment',
  'accessibility',
  'provenance',
] as const satisfies readonly ProjectMapVerification['checks'][number]['name'][];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return required.every((key) => actual.includes(key))
    && actual.every((key) => required.includes(key) || optional.includes(key));
}

function isPortablePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
    || value !== value.trim() || hasControlCharacters(value) || value.startsWith('/') || value.startsWith('\\')
    || /^[a-zA-Z]:/.test(value) || value.includes('\\')) return false;
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validCacheKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 768;
}

function validateIndex(value: unknown): CacheIndex | null {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'entries'])) return null;
  const index = value as unknown as Partial<CacheIndex>;
  if (index.schemaVersion !== SCHEMA_VERSION
    || !Array.isArray(index.entries)
    || index.entries.length > CACHE_MAX_ENTRIES) return null;
  const keys = new Set<string>();
  const blobBytes = new Map<string, number>();
  for (const entry of index.entries) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['key', 'blob', 'bytes', 'lastAccess'])) return null;
    if (!validCacheKey(entry.key) || keys.has(entry.key)) return null;
    if (typeof entry.blob !== 'string' || !BLOB_RE.test(entry.blob)) return null;
    if (typeof entry.bytes !== 'number'
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 1
      || entry.bytes > CACHE_MAX_BYTES) return null;
    if (typeof entry.lastAccess !== 'string' || !Number.isFinite(Date.parse(entry.lastAccess))) return null;
    const knownBytes = blobBytes.get(entry.blob);
    if (knownBytes !== undefined && knownBytes !== entry.bytes) return null;
    keys.add(entry.key);
    blobBytes.set(entry.blob, entry.bytes);
  }
  return { schemaVersion: SCHEMA_VERSION, entries: [...index.entries] };
}

function validateDiagnostic(value: unknown): ProjectMapDiagnostic | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['severity', 'code', 'subject', 'message'])) return undefined;
  if ((value.severity !== 'error' && value.severity !== 'warning')
    || typeof value.code !== 'string' || value.code.length < 1 || value.code.length > 128
    || typeof value.subject !== 'string' || value.subject.length < 1 || value.subject.length > 768
    || typeof value.message !== 'string' || value.message.length < 1 || value.message.length > 1_024
    || hasControlCharacters(value.code)
    || hasControlCharacters(value.subject)
    || hasControlCharacters(value.message)) return undefined;
  return {
    severity: value.severity,
    code: value.code,
    subject: value.subject,
    message: value.message,
  };
}

function validateProvenance(value: unknown): ProjectMapProvenance | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'roots'])
    || (value.kind !== 'commit-pinned' && value.kind !== 'worktree-snapshot')
    || !Array.isArray(value.roots)
    || value.roots.length < 1
    || value.roots.length > MAX_PROJECT_MAP_ROOTS) return undefined;
  const aliases = new Set<string>();
  const roots: ProjectMapProvenance['roots'][number][] = [];
  for (const candidate of value.roots) {
    if (!isRecord(candidate)
      || !hasRequiredAndOptionalKeys(candidate, ['rootAlias', 'head', 'dirty'], ['snapshotHash'])
      || typeof candidate.rootAlias !== 'string'
      || !PORTABLE_ID_RE.test(candidate.rootAlias)
      || aliases.has(candidate.rootAlias)
      || typeof candidate.head !== 'string'
      || !GIT_HEAD_RE.test(candidate.head)
      || typeof candidate.dirty !== 'boolean'
      || (candidate.dirty && (typeof candidate.snapshotHash !== 'string' || !SHA256_RE.test(candidate.snapshotHash)))
      || (!candidate.dirty && candidate.snapshotHash !== undefined)) return undefined;
    aliases.add(candidate.rootAlias);
    roots.push({
      rootAlias: candidate.rootAlias,
      head: candidate.head,
      dirty: candidate.dirty,
      ...(typeof candidate.snapshotHash === 'string' ? { snapshotHash: candidate.snapshotHash } : {}),
    });
  }
  const anyDirty = roots.some((root) => root.dirty);
  if ((value.kind === 'worktree-snapshot') !== anyDirty) return undefined;
  return { kind: value.kind, roots };
}

function validateVerification(value: unknown): ProjectMapVerification | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    'quality', 'fingerprint', 'verifiedAt', 'manifestHash', 'specHash', 'inputHash', 'layoutHash', 'checks', 'diagnostics',
  ])
    || value.quality !== 'production'
    || typeof value.fingerprint !== 'string' || !SHA256_RE.test(value.fingerprint)
    || typeof value.verifiedAt !== 'string'
    || !Number.isFinite(Date.parse(value.verifiedAt))
    || typeof value.manifestHash !== 'string' || !SHA256_RE.test(value.manifestHash)
    || typeof value.specHash !== 'string' || !SHA256_RE.test(value.specHash)
    || typeof value.inputHash !== 'string' || !SHA256_RE.test(value.inputHash)
    || typeof value.layoutHash !== 'string' || !SHA256_RE.test(value.layoutHash)
    || !Array.isArray(value.checks) || value.checks.length !== CHECK_NAMES.length
    || !Array.isArray(value.diagnostics) || value.diagnostics.length > MAX_CACHE_DIAGNOSTICS) return undefined;

  const names = new Set<string>();
  const checks: ProjectMapVerification['checks'][number][] = [];
  for (const candidate of value.checks) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['name', 'status'])
      || typeof candidate.name !== 'string'
      || !CHECK_NAMES.includes(candidate.name as (typeof CHECK_NAMES)[number])
      || names.has(candidate.name)
      || (candidate.status !== 'passed' && candidate.status !== 'warning')) return undefined;
    names.add(candidate.name);
    checks.push({
      name: candidate.name as ProjectMapVerification['checks'][number]['name'],
      status: candidate.status,
    });
  }
  if (CHECK_NAMES.some((name) => !names.has(name))) return undefined;
  if (checks.some((check) => check.status !== 'passed')) return undefined;
  const diagnostics = value.diagnostics.map(validateDiagnostic);
  if (diagnostics.some((item) => !item) || diagnostics.some((item) => item?.severity === 'error')) return undefined;
  return {
    quality: 'production',
    fingerprint: value.fingerprint,
    verifiedAt: value.verifiedAt,
    manifestHash: value.manifestHash,
    specHash: value.specHash,
    inputHash: value.inputHash,
    layoutHash: value.layoutHash,
    checks,
    diagnostics: diagnostics as ProjectMapDiagnostic[],
  };
}

function validateBlob(value: unknown): ProjectMapDocument | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'document'])
    || value.schemaVersion !== SCHEMA_VERSION || !isRecord(value.document)) return undefined;
  const document = value.document;
  if (!hasExactKeys(document, [
    'collectionId', 'mapId', 'mapPath', 'state', 'spec', 'layout', 'provenance', 'verification', 'fromLastGood',
  ])) return undefined;
  const spec = validateProjectMapSpec(document.spec);
  const provenance = validateProvenance(document.provenance);
  const verification = validateVerification(document.verification);
  if (!spec.value || !provenance || !verification
    || typeof document.collectionId !== 'string' || !PORTABLE_ID_RE.test(document.collectionId)
    || typeof document.mapId !== 'string' || document.mapId !== spec.value.id
    || !isPortablePath(document.mapPath)
    || document.fromLastGood !== false
    || document.state !== 'valid') return undefined;
  const expectedLayout = layoutProjectMap(spec.value).layout;
  const serializedLayout = JSON.stringify(expectedLayout);
  if (JSON.stringify(document.layout) !== serializedLayout
    || verification.layoutHash !== `sha256:${contentHash(serializedLayout)}`
    || !document.mapPath.startsWith('.ezterminal/project-map/maps/')) return undefined;
  return {
    collectionId: document.collectionId,
    mapId: document.mapId,
    mapPath: document.mapPath,
    state: 'valid',
    spec: spec.value,
    layout: expectedLayout,
    provenance,
    verification,
    fromLastGood: false,
  };
}

function contentHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function referencedBytes(entries: readonly CacheEntry[]): number {
  const blobs = new Map<string, number>();
  for (const entry of entries) blobs.set(entry.blob, entry.bytes);
  return [...blobs.values()].reduce((total, bytes) => total + bytes, 0);
}

export class ProjectMapCacheStore {
  private readonly directory: string;
  private readonly blobsDirectory: string;
  private readonly index: JsonFile;
  private operationChain: Promise<void> = Promise.resolve();
  private loadedIndex: CacheIndex = EMPTY;
  private readonly documents = new Map<string, ProjectMapDocument>();

  constructor(userDataDir: string) {
    this.directory = path.join(userDataDir, 'project-map-cache');
    this.blobsDirectory = path.join(this.directory, 'blobs');
    this.index = new JsonFile(this.directory, 'index.json');
  }

  init(): Promise<void> {
    return this.enqueue(async () => {
      await fs.mkdir(this.blobsDirectory, { recursive: true });
      await this.index.init();
      this.loadedIndex = await this.index.readValidated(validateIndex, EMPTY);
      await this.removeOrphanedBlobs(new Set(this.loadedIndex.entries.map((entry) => entry.blob)));
    });
  }

  get(key: string): Promise<ProjectMapDocument | undefined> {
    return (async () => {
      if (!validCacheKey(key)) return undefined;
      const memory = this.documents.get(key);
      if (memory) {
        this.scheduleTouch(key);
        return { ...memory, state: 'invalid-with-last-good', fromLastGood: true };
      }
      const entry = this.loadedIndex.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        return undefined;
      }
      let payload: string;
      let parsed: unknown;
      try {
        payload = await fs.readFile(path.join(this.blobsDirectory, entry.blob), 'utf8');
        if (Buffer.byteLength(payload, 'utf8') !== entry.bytes
          || `${contentHash(payload)}.json` !== entry.blob) throw new Error('Cache blob integrity mismatch.');
        parsed = JSON.parse(payload) as unknown;
      } catch {
        void this.enqueue(() => this.removeEntry(key));
        return undefined;
      }
      const document = validateBlob(parsed);
      if (!document) {
        void this.enqueue(() => this.removeEntry(key));
        return undefined;
      }
      this.documents.set(key, document);
      this.scheduleTouch(key);
      return {
        ...document,
        state: 'invalid-with-last-good',
        fromLastGood: true,
      };
    })();
  }

  put(key: string, document: ProjectMapDocument): Promise<void> {
    return this.enqueue(async () => {
      if (!validCacheKey(key)) throw new Error('Invalid Project Map cache key.');
      if (document.state !== 'valid' || document.fromLastGood) {
        throw new Error('Refusing to cache a non-current Project Map document.');
      }
      const cacheDocument: ProjectMapDocument = { ...document, state: 'valid', fromLastGood: false };
      const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, document: cacheDocument } satisfies CacheBlob);
      if (!validateBlob(JSON.parse(payload) as unknown)) {
        throw new Error('Refusing to cache an unverified Project Map document.');
      }
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (bytes > CACHE_MAX_BYTES) return;
      const blob = `${contentHash(payload)}.json`;
      const target = path.join(this.blobsDirectory, blob);
      const temporary = path.join(this.blobsDirectory, `${blob}.${process.pid}.tmp`);
      try {
        await fs.access(target);
      } catch {
        try {
          await fs.writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx' });
          await fs.rename(temporary, target);
        } catch (error) {
          await fs.unlink(temporary).catch(() => undefined);
          try {
            await fs.access(target);
          } catch {
            throw error;
          }
        }
      }
      const now = new Date().toISOString();
      const updated = await this.index.update(
        validateIndex,
        EMPTY,
        (current) => ({
          schemaVersion: SCHEMA_VERSION,
          entries: [
            ...current.entries
              .filter((entry) => entry.key !== key)
              .sort((left, right) => Date.parse(right.lastAccess) - Date.parse(left.lastAccess)
                || compareText(left.key, right.key))
              .slice(0, CACHE_MAX_ENTRIES - 1),
            { key, blob, bytes, lastAccess: now },
          ],
        }),
        'cache verified project map',
      );
      if (updated) {
        this.loadedIndex = updated;
        this.documents.set(key, cacheDocument);
        await this.prune(updated);
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationChain.then(operation);
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async touch(key: string): Promise<void> {
    const updated = await this.index.update(
      validateIndex,
      EMPTY,
      (current) => ({
        ...current,
        entries: current.entries.map((entry) => entry.key === key
          ? { ...entry, lastAccess: new Date().toISOString() }
          : entry),
      }),
      'touch project map cache',
    );
    if (updated) this.loadedIndex = updated;
  }

  private scheduleTouch(key: string): void {
    void this.enqueue(() => this.touch(key));
  }

  private async prune(index: CacheIndex): Promise<void> {
    let kept = [...index.entries];
    if (referencedBytes(kept) > CACHE_MAX_BYTES) {
      const oldest = [...kept].sort((left, right) =>
        Date.parse(left.lastAccess) - Date.parse(right.lastAccess) || compareText(left.key, right.key));
      for (const entry of oldest) {
        if (referencedBytes(kept) <= CACHE_MAX_BYTES) break;
        kept = kept.filter((candidate) => candidate.key !== entry.key);
      }
      const removedKeys = new Set(index.entries
        .filter((entry) => !kept.some((candidate) => candidate.key === entry.key))
        .map((entry) => entry.key));
      const updated = await this.index.update(
        validateIndex,
        EMPTY,
        (current) => ({ ...current, entries: current.entries.filter((entry) => !removedKeys.has(entry.key)) }),
        'prune project map cache',
      );
      if (!updated) return;
      this.loadedIndex = updated;
      kept = [...updated.entries];
    }
    await this.removeOrphanedBlobs(new Set(kept.map((entry) => entry.blob)));
  }

  private async removeEntry(key: string): Promise<void> {
    const updated = await this.index.update(
      validateIndex,
      EMPTY,
      (current) => ({ ...current, entries: current.entries.filter((entry) => entry.key !== key) }),
      'remove invalid project map cache entry',
    );
    if (updated) {
      this.loadedIndex = updated;
      this.documents.delete(key);
      await this.removeOrphanedBlobs(new Set(updated.entries.map((entry) => entry.blob)));
    }
  }

  private async removeOrphanedBlobs(referenced: ReadonlySet<string>): Promise<void> {
    const names = await fs.readdir(this.blobsDirectory).catch(() => []);
    await Promise.all(names
      .filter((name) => !referenced.has(name))
      .map((name) => fs.unlink(path.join(this.blobsDirectory, name)).catch(() => undefined)));
  }

  async flush(): Promise<void> {
    let chain: Promise<void>;
    do {
      chain = this.operationChain;
      await chain;
    } while (chain !== this.operationChain);
    await this.index.flush();
  }
}
