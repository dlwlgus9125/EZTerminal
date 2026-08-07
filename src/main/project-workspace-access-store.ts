import path from 'node:path';

import { JsonFile } from './json-file';

interface ProjectWorkspaceAccessEntry {
  readonly projectId: string;
  readonly rootId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly canonicalPath: string;
  readonly approvedAt: number;
}

interface ProjectWorkspaceAccessFile {
  readonly version: 1;
  readonly entries: readonly ProjectWorkspaceAccessEntry[];
}

const EMPTY: ProjectWorkspaceAccessFile = { version: 1, entries: [] };

function isEntry(value: unknown): value is ProjectWorkspaceAccessEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Partial<ProjectWorkspaceAccessEntry>;
  return typeof entry.projectId === 'string'
    && entry.projectId.length > 0
    && entry.projectId.length <= 128
    && typeof entry.rootId === 'string'
    && entry.rootId.length > 0
    && entry.rootId.length <= 128
    && typeof entry.workspaceId === 'string'
    && entry.workspaceId.length > 0
    && entry.workspaceId.length <= 128
    && typeof entry.repositoryId === 'string'
    && entry.repositoryId.length > 0
    && entry.repositoryId.length <= 256
    && typeof entry.canonicalPath === 'string'
    && path.isAbsolute(entry.canonicalPath)
    && typeof entry.approvedAt === 'number'
    && Number.isFinite(entry.approvedAt);
}

function validate(value: unknown): ProjectWorkspaceAccessFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<ProjectWorkspaceAccessFile>;
  if (candidate.version !== 1
    || !Array.isArray(candidate.entries)
    || candidate.entries.length > 10_000
    || !candidate.entries.every(isEntry)) {
    return null;
  }
  return { version: 1, entries: candidate.entries };
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function identityKey(entry: Pick<ProjectWorkspaceAccessEntry, 'projectId' | 'rootId' | 'workspaceId'>): string {
  return `${entry.projectId}\0${entry.rootId}\0${entry.workspaceId}`;
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
    this.snapshot = await this.file.readValidated(validate, EMPTY);
  }

  isApproved(identity: {
    readonly projectId: string;
    readonly rootId: string;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly canonicalPath: string;
  }): boolean {
    const expected = identityKey(identity);
    return this.snapshot.entries.some((entry) => identityKey(entry) === expected
      && entry.repositoryId === identity.repositoryId
      && pathKey(entry.canonicalPath) === pathKey(identity.canonicalPath));
  }

  approve(identity: Omit<ProjectWorkspaceAccessEntry, 'approvedAt'>): Promise<void> {
    return this.file.enqueue(async () => {
      const key = identityKey(identity);
      const entry: ProjectWorkspaceAccessEntry = { ...identity, approvedAt: Date.now() };
      const next: ProjectWorkspaceAccessFile = {
        version: 1,
        entries: [...this.snapshot.entries.filter((candidate) => identityKey(candidate) !== key), entry],
      };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
    });
  }

  revoke(projectId: string, rootId?: string, workspaceId?: string): Promise<void> {
    return this.file.enqueue(async () => {
      const entries = this.snapshot.entries.filter((entry) => !(
        entry.projectId === projectId
        && (rootId === undefined || entry.rootId === rootId)
        && (workspaceId === undefined || entry.workspaceId === workspaceId)
      ));
      if (entries.length === this.snapshot.entries.length) return;
      const next: ProjectWorkspaceAccessFile = { version: 1, entries };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
    });
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
