import path from 'node:path';

import { JsonFile } from './json-file';

export interface ProjectWorkspaceAccessIdentity {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly canonicalPath: string;
}

interface ProjectWorkspaceAccessEntry extends ProjectWorkspaceAccessIdentity {
  readonly approvedAt: number;
}

export type ProjectWorkspaceAccessIntent =
  | {
      readonly kind: 'approve';
      readonly identity: ProjectWorkspaceAccessIdentity;
      readonly createdAt: number;
    }
  | {
      readonly kind: 'revoke';
      readonly identity: ProjectWorkspaceAccessIdentity;
      readonly createdAt: number;
    };

export type ProjectWorkspaceApprovalIntent = Extract<
  ProjectWorkspaceAccessIntent,
  { readonly kind: 'approve' }
>;

export type ProjectWorkspaceRevocationIntent = Extract<
  ProjectWorkspaceAccessIntent,
  { readonly kind: 'revoke' }
>;

interface ProjectWorkspaceAccessFile {
  readonly version: 2;
  readonly entries: readonly ProjectWorkspaceAccessEntry[];
  readonly pending: readonly ProjectWorkspaceAccessIntent[];
}

interface ValidatedAccessFile {
  readonly file: ProjectWorkspaceAccessFile;
  readonly migrated: boolean;
}

const MAX_ACCESS_RECORDS = 10_000;
const MAX_ID_LENGTH = 128;
const MAX_REPOSITORY_ID_LENGTH = 256;
const MAX_CANONICAL_PATH_LENGTH = 32_768;
const EMPTY: ProjectWorkspaceAccessFile = { version: 2, entries: [], pending: [] };

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !hasControlCharacters(value);
}

function isIdentity(value: unknown): value is ProjectWorkspaceAccessIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Partial<ProjectWorkspaceAccessIdentity> & Readonly<Record<string, unknown>>;
  return hasOnlyKeys(identity, ['projectId', 'rootId', 'workspaceId', 'repositoryId', 'canonicalPath'])
    && isBoundedId(identity.projectId)
    && isBoundedId(identity.rootId)
    && isBoundedId(identity.workspaceId)
    && typeof identity.repositoryId === 'string'
    && identity.repositoryId.length > 0
    && identity.repositoryId.length <= MAX_REPOSITORY_ID_LENGTH
    && !hasControlCharacters(identity.repositoryId)
    && typeof identity.canonicalPath === 'string'
    && identity.canonicalPath.length > 0
    && identity.canonicalPath.length <= MAX_CANONICAL_PATH_LENGTH
    && !hasControlCharacters(identity.canonicalPath)
    && path.isAbsolute(identity.canonicalPath);
}

function isEntry(value: unknown): value is ProjectWorkspaceAccessEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<ProjectWorkspaceAccessEntry> & Readonly<Record<string, unknown>>;
  return hasOnlyKeys(entry, [
    'projectId',
    'rootId',
    'workspaceId',
    'repositoryId',
    'canonicalPath',
    'approvedAt',
  ])
    && isIdentity({
      projectId: entry.projectId,
      rootId: entry.rootId,
      workspaceId: entry.workspaceId,
      repositoryId: entry.repositoryId,
      canonicalPath: entry.canonicalPath,
    })
    && typeof entry.approvedAt === 'number'
    && Number.isSafeInteger(entry.approvedAt)
    && entry.approvedAt >= 0;
}

function isIntent(value: unknown): value is ProjectWorkspaceAccessIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const intent = value as Partial<ProjectWorkspaceAccessIntent> & Readonly<Record<string, unknown>>;
  return hasOnlyKeys(intent, ['kind', 'identity', 'createdAt'])
    && (intent.kind === 'approve' || intent.kind === 'revoke')
    && isIdentity(intent.identity)
    && typeof intent.createdAt === 'number'
    && Number.isSafeInteger(intent.createdAt)
    && intent.createdAt >= 0;
}

function uniqueByIdentity(values: readonly ProjectWorkspaceAccessIdentity[]): boolean {
  const keys = new Set<string>();
  for (const value of values) {
    const key = identityKey(value);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function validate(value: unknown): ValidatedAccessFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Readonly<Record<string, unknown>> & {
    readonly version?: unknown;
    readonly entries?: unknown;
    readonly pending?: unknown;
  };
  if (!Array.isArray(candidate.entries)
    || candidate.entries.length > MAX_ACCESS_RECORDS
    || !candidate.entries.every(isEntry)
    || !uniqueByIdentity(candidate.entries)) {
    return null;
  }
  if (candidate.version === 1) {
    if (!hasOnlyKeys(candidate, ['version', 'entries'])) return null;
    return {
      file: { version: 2, entries: candidate.entries, pending: [] },
      migrated: true,
    };
  }
  if (candidate.version !== 2
    || !hasOnlyKeys(candidate, ['version', 'entries', 'pending'])
    || !Array.isArray(candidate.pending)
    || candidate.entries.length + candidate.pending.length > MAX_ACCESS_RECORDS
    || !candidate.pending.every(isIntent)
    || !uniqueByIdentity(candidate.pending.map((intent) => intent.identity))) {
    return null;
  }
  const entries = candidate.entries as readonly ProjectWorkspaceAccessEntry[];
  const pending = candidate.pending as readonly ProjectWorkspaceAccessIntent[];
  if (pending.some((intent) => intent.kind === 'revoke'
    && !entries.some((entry) => sameIdentity(entry, intent.identity)))) {
    return null;
  }
  return {
    file: { version: 2, entries, pending },
    migrated: false,
  };
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function identityKey(entry: Pick<ProjectWorkspaceAccessEntry, 'projectId' | 'rootId' | 'workspaceId'>): string {
  return `${entry.projectId}\0${entry.rootId}\0${entry.workspaceId}`;
}

function sameIdentity(left: ProjectWorkspaceAccessIdentity, right: ProjectWorkspaceAccessIdentity): boolean {
  return identityKey(left) === identityKey(right)
    && left.repositoryId === right.repositoryId
    && pathKey(left.canonicalPath) === pathKey(right.canonicalPath);
}

function sameIntent(left: ProjectWorkspaceAccessIntent, right: ProjectWorkspaceAccessIntent): boolean {
  return left.kind === right.kind
    && left.createdAt === right.createdAt
    && sameIdentity(left.identity, right.identity);
}

function copyIdentity(identity: ProjectWorkspaceAccessIdentity): ProjectWorkspaceAccessIdentity {
  return {
    projectId: identity.projectId,
    rootId: identity.rootId,
    workspaceId: identity.workspaceId,
    repositoryId: identity.repositoryId,
    canonicalPath: identity.canonicalPath,
  };
}

function copyIntent<T extends ProjectWorkspaceAccessIntent>(intent: T): T {
  return { ...intent, identity: copyIdentity(intent.identity) };
}

/** Persisted consent only. Git registration and canonical paths are rechecked
 * by ProjectWorkspaceService before this record can authorize a read. */
export class ProjectWorkspaceAccessStore {
  private readonly file: JsonFile;
  private snapshot: ProjectWorkspaceAccessFile = EMPTY;

  constructor(userDataDirectory: string) {
    this.file = new JsonFile(userDataDirectory, 'project-workspace-access.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    const raw = await this.file.read();
    if (raw === undefined) {
      this.snapshot = EMPTY;
      return;
    }
    const validated = validate(raw);
    if (!validated) {
      await this.file.quarantine();
      this.snapshot = EMPTY;
      return;
    }
    this.snapshot = validated.file;
    if (validated.migrated) {
      await this.file.enqueue(() => this.file.writeAtomic(JSON.stringify(validated.file)));
    }
  }

  isApproved(identity: {
    readonly projectId: string;
    readonly rootId: string;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly canonicalPath: string;
  }): boolean {
    if (!isIdentity(identity)) return false;
    const expected = identityKey(identity);
    if (this.snapshot.pending.some((intent) => identityKey(intent.identity) === expected)) return false;
    return this.snapshot.entries.some((entry) => sameIdentity(entry, identity));
  }

  /** Exact persisted-consent lookup for fail-safe revocation. Unlike
   * isApproved, this remains usable when Git discovery is temporarily down.
   */
  hasApproval(identity: Pick<ProjectWorkspaceAccessEntry, 'projectId' | 'rootId' | 'workspaceId'>): boolean {
    if (!isBoundedId(identity.projectId)
      || !isBoundedId(identity.rootId)
      || !isBoundedId(identity.workspaceId)) return false;
    const expected = identityKey(identity);
    return this.snapshot.entries.some((entry) => identityKey(entry) === expected);
  }

  listPendingIntents(): readonly ProjectWorkspaceAccessIntent[] {
    return this.snapshot.pending.map(copyIntent);
  }

  beginApproval(
    identity: ProjectWorkspaceAccessIdentity,
  ): Promise<ProjectWorkspaceApprovalIntent> {
    if (!isIdentity(identity)) return Promise.reject(new Error('Invalid Project Workspace approval identity.'));
    return this.file.enqueue(async () => {
      const key = identityKey(identity);
      const current = this.snapshot.pending.find((intent): intent is ProjectWorkspaceApprovalIntent => (
        intent.kind === 'approve' && sameIdentity(intent.identity, identity)
      ));
      if (current) return copyIntent(current);
      const intent: ProjectWorkspaceApprovalIntent = {
        kind: 'approve',
        identity: copyIdentity(identity),
        createdAt: Date.now(),
      };
      const next: ProjectWorkspaceAccessFile = {
        version: 2,
        entries: this.snapshot.entries,
        pending: [...this.snapshot.pending.filter((candidate) => (
          identityKey(candidate.identity) !== key
        )), intent],
      };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return copyIntent(intent);
    });
  }

  beginRevocation(
    identity: Pick<ProjectWorkspaceAccessIdentity, 'projectId' | 'rootId' | 'workspaceId'>
      & Partial<Pick<ProjectWorkspaceAccessIdentity, 'repositoryId' | 'canonicalPath'>>,
  ): Promise<ProjectWorkspaceRevocationIntent | undefined> {
    if (!isBoundedId(identity.projectId)
      || !isBoundedId(identity.rootId)
      || !isBoundedId(identity.workspaceId)) return Promise.resolve(undefined);
    return this.file.enqueue(async () => {
      const key = identityKey(identity);
      const current = this.snapshot.pending.find((intent): intent is ProjectWorkspaceRevocationIntent => (
        intent.kind === 'revoke' && identityKey(intent.identity) === key
      ));
      if (current) return copyIntent(current);
      const approved = this.snapshot.entries.find((entry) => identityKey(entry) === key);
      if (!approved
        || (identity.repositoryId !== undefined && identity.repositoryId !== approved.repositoryId)
        || (identity.canonicalPath !== undefined
          && pathKey(identity.canonicalPath) !== pathKey(approved.canonicalPath))) {
        return undefined;
      }
      const intent: ProjectWorkspaceRevocationIntent = {
        kind: 'revoke',
        identity: copyIdentity(approved),
        createdAt: Date.now(),
      };
      const next: ProjectWorkspaceAccessFile = {
        version: 2,
        entries: this.snapshot.entries,
        pending: [...this.snapshot.pending.filter((candidate) => (
          identityKey(candidate.identity) !== key
        )), intent],
      };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return copyIntent(intent);
    });
  }

  commitApproval(intent: ProjectWorkspaceAccessIntent): Promise<boolean> {
    if (!isIntent(intent) || intent.kind !== 'approve') return Promise.resolve(false);
    return this.file.enqueue(async () => {
      if (!this.snapshot.pending.some((candidate) => sameIntent(candidate, intent))) return false;
      const key = identityKey(intent.identity);
      const entry: ProjectWorkspaceAccessEntry = {
        ...copyIdentity(intent.identity),
        approvedAt: Date.now(),
      };
      const next: ProjectWorkspaceAccessFile = {
        version: 2,
        entries: [...this.snapshot.entries.filter((candidate) => identityKey(candidate) !== key), entry],
        pending: this.snapshot.pending.filter((candidate) => !sameIntent(candidate, intent)),
      };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  /** Drop one exact stale approval transaction without ever granting access.
   * Any older entry for the same opaque Workspace key is removed as well so
   * clearing a failed re-approval cannot accidentally reveal an old grant.
   * Revoke intents deliberately cannot be discarded through this seam.
   */
  discardApproval(intent: ProjectWorkspaceAccessIntent): Promise<boolean> {
    if (!isIntent(intent) || intent.kind !== 'approve') return Promise.resolve(false);
    return this.file.enqueue(async () => {
      if (!this.snapshot.pending.some((candidate) => sameIntent(candidate, intent))) return false;
      const key = identityKey(intent.identity);
      const next: ProjectWorkspaceAccessFile = {
        version: 2,
        entries: this.snapshot.entries.filter((entry) => identityKey(entry) !== key),
        pending: this.snapshot.pending.filter((candidate) => !sameIntent(candidate, intent)),
      };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  commitRevocation(intent: ProjectWorkspaceAccessIntent): Promise<boolean> {
    if (!isIntent(intent) || intent.kind !== 'revoke') return Promise.resolve(false);
    return this.file.enqueue(async () => {
      if (!this.snapshot.pending.some((candidate) => sameIntent(candidate, intent))) return false;
      const approved = this.snapshot.entries.find((entry) => sameIdentity(entry, intent.identity));
      if (!approved) return false;
      const next: ProjectWorkspaceAccessFile = {
        version: 2,
        entries: this.snapshot.entries.filter((entry) => !sameIdentity(entry, intent.identity)),
        pending: this.snapshot.pending.filter((candidate) => !sameIntent(candidate, intent)),
      };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  async approve(identity: ProjectWorkspaceAccessIdentity): Promise<void> {
    const intent = await this.beginApproval(identity);
    if (!await this.commitApproval(intent)) throw new Error('Project Workspace approval intent was lost.');
  }

  revoke(projectId: string, rootId?: string, workspaceId?: string): Promise<void> {
    return this.file.enqueue(async () => {
      const entries = this.snapshot.entries.filter((entry) => !(
        entry.projectId === projectId
        && (rootId === undefined || entry.rootId === rootId)
        && (workspaceId === undefined || entry.workspaceId === workspaceId)
      ));
      const pending = this.snapshot.pending.filter((intent) => !(
        intent.identity.projectId === projectId
        && (rootId === undefined || intent.identity.rootId === rootId)
        && (workspaceId === undefined || intent.identity.workspaceId === workspaceId)
      ));
      if (entries.length === this.snapshot.entries.length
        && pending.length === this.snapshot.pending.length) return;
      const next: ProjectWorkspaceAccessFile = { version: 2, entries, pending };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
    });
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
