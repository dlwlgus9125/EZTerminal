import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  MAX_AGENT_PROJECT_NAME_LENGTH,
  MAX_AGENT_PROJECT_ROOTS,
  MAX_AGENT_PROJECTS,
  type AgentProjectInput,
} from '../shared/agent-history';
import { JsonFile } from './json-file';

interface StoredAgentProject {
  readonly projectId: string;
  readonly name: string;
  readonly primaryRoot: string;
  readonly additionalRoots: readonly string[];
  readonly pinned: boolean;
  readonly origin: 'manual' | 'terminal';
  readonly lastActiveAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AgentProjectFile {
  readonly version: 3;
  readonly projects: readonly StoredAgentProject[];
}

interface LegacyAgentProjectFileV2 {
  readonly version: 2;
  readonly projects: readonly (Omit<StoredAgentProject, 'origin'> & {
    readonly explicit: boolean;
  })[];
}

interface LegacyAgentProjectFileV1 {
  readonly version: 1;
  readonly projects: readonly Omit<StoredAgentProject, 'origin' | 'lastActiveAt'>[];
}

const EMPTY_FILE: AgentProjectFile = { version: 3, projects: [] };

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function validateStoredProject(value: unknown): value is StoredAgentProject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const project = value as Partial<StoredAgentProject>;
  return (
    typeof project.projectId === 'string'
    && project.projectId.length > 0
    && typeof project.name === 'string'
    && project.name.length > 0
    && project.name.length <= MAX_AGENT_PROJECT_NAME_LENGTH
    && typeof project.primaryRoot === 'string'
    && path.isAbsolute(project.primaryRoot)
    && isStringArray(project.additionalRoots)
    && project.additionalRoots.length < MAX_AGENT_PROJECT_ROOTS
    && project.additionalRoots.every(path.isAbsolute)
    && typeof project.pinned === 'boolean'
    && (project.origin === 'manual' || project.origin === 'terminal')
    && (project.lastActiveAt === null
      || (typeof project.lastActiveAt === 'number' && Number.isFinite(project.lastActiveAt)))
    && typeof project.createdAt === 'number'
    && Number.isFinite(project.createdAt)
    && typeof project.updatedAt === 'number'
    && Number.isFinite(project.updatedAt)
  );
}

function validateFile(value: unknown): AgentProjectFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const file = value as { readonly version?: unknown; readonly projects?: unknown };
  if (!Array.isArray(file.projects)
    || file.projects.length > MAX_AGENT_PROJECTS
  ) {
    return null;
  }
  if (file.version === 3 && file.projects.every(validateStoredProject)) {
    return { version: 3, projects: file.projects as readonly StoredAgentProject[] };
  }
  if (file.version === 2) {
    const legacy = value as Partial<LegacyAgentProjectFileV2>;
    // v2 `explicit:false` entries came exclusively from provider-wide
    // discovery. They are deliberately dropped: only manual projects and
    // work observed inside EZTerminal belong in the local index.
    const migrated = legacy.projects
      ?.filter((project) => project.explicit)
      .map((project) => ({
        projectId: project.projectId,
        name: project.name,
        primaryRoot: project.primaryRoot,
        additionalRoots: project.additionalRoots,
        pinned: project.pinned,
        origin: 'manual' as const,
        lastActiveAt: project.lastActiveAt,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }));
    if (migrated?.every(validateStoredProject)) {
      return { version: 3, projects: migrated };
    }
  }
  if (file.version === 1) {
    const legacy = value as Partial<LegacyAgentProjectFileV1>;
    const migrated = legacy.projects?.map((project) => ({
      ...project,
      origin: 'manual' as const,
      lastActiveAt: null,
    }));
    if (migrated?.every(validateStoredProject)) {
      return { version: 3, projects: migrated };
    }
  }
  return null;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export async function canonicalAgentDirectory(value: string): Promise<string | null> {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    const resolved = await fs.realpath(value);
    if (!(await fs.stat(resolved)).isDirectory()) return null;
    return path.normalize(resolved);
  } catch {
    return null;
  }
}

function projectIdForRoot(primaryRoot: string): string {
  return createHash('sha256').update(pathKey(primaryRoot)).digest('hex').slice(0, 24);
}

function projectSnapshotFingerprint(snapshot: AgentProjectFile): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export interface AgentProjectUpsertPreparation {
  readonly project: StoredAgentProject;
  readonly previousProject?: StoredAgentProject;
  readonly expectedSnapshotFingerprint: string;
  readonly existingIndex: number;
}

export type AgentProjectUpsertPreparationResult =
  | { readonly ok: true; readonly preparation: AgentProjectUpsertPreparation }
  | { readonly ok: false; readonly reason: 'invalid' | 'not-found' | 'duplicate' };

export class AgentProjectStore {
  private readonly file: JsonFile;
  private snapshot: AgentProjectFile = EMPTY_FILE;

  constructor(userDataDirectory: string) {
    this.file = new JsonFile(userDataDirectory, 'agent-projects.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    const raw = await this.file.read();
    if (raw === undefined) {
      this.snapshot = EMPTY_FILE;
      return;
    }
    const parsed = validateFile(raw);
    if (!parsed) {
      await this.file.quarantine();
      this.snapshot = EMPTY_FILE;
      return;
    }
    this.snapshot = parsed;
    if ((raw as { readonly version?: unknown }).version !== 3) {
      await this.file.enqueue(async () => this.file.writeAtomic(JSON.stringify(parsed)));
    }
  }

  list(): readonly StoredAgentProject[] {
    return this.snapshot.projects;
  }

  async upsert(input: AgentProjectInput): Promise<
    | {
        readonly ok: true;
        readonly project: StoredAgentProject;
        readonly previousProject?: StoredAgentProject;
      }
    | { readonly ok: false; readonly reason: 'invalid' | 'not-found' | 'duplicate' }
  > {
    const prepared = await this.prepareUpsert(input);
    if (!prepared.ok) return prepared;
    const committed = await this.commitPreparedUpsert(prepared.preparation);
    return committed.ok
      ? {
          ok: true,
          project: committed.project,
          ...(committed.previousProject ? { previousProject: committed.previousProject } : {}),
        }
      : { ok: false, reason: 'invalid' };
  }

  async prepareUpsert(input: AgentProjectInput): Promise<AgentProjectUpsertPreparationResult> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (
      name.length === 0
      || name.length > MAX_AGENT_PROJECT_NAME_LENGTH
      || !Array.isArray(input.additionalRoots)
      || input.additionalRoots.length >= MAX_AGENT_PROJECT_ROOTS
      || typeof input.pinned !== 'boolean'
    ) {
      return { ok: false, reason: 'invalid' };
    }
    const primaryRoot = await canonicalAgentDirectory(input.primaryRoot);
    if (!primaryRoot) return { ok: false, reason: 'invalid' };
    const additionalRoots: string[] = [];
    const seen = new Set([pathKey(primaryRoot)]);
    for (const root of input.additionalRoots) {
      const canonical = await canonicalAgentDirectory(root);
      if (!canonical) return { ok: false, reason: 'invalid' };
      const key = pathKey(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      additionalRoots.push(canonical);
    }

    return this.file.enqueue(async () => {
      const current = this.snapshot.projects;
      let existingIndex = input.projectId
        ? current.findIndex((project) => project.projectId === input.projectId)
        : -1;
      if (input.projectId && existingIndex < 0) return { ok: false, reason: 'not-found' };
      const duplicateIndex = current.findIndex((project, index) =>
        index !== existingIndex && pathKey(project.primaryRoot) === pathKey(primaryRoot));
      if (duplicateIndex >= 0) {
        if (existingIndex < 0 && current[duplicateIndex]!.origin === 'terminal') {
          existingIndex = duplicateIndex;
        } else {
          return { ok: false, reason: 'duplicate' };
        }
      }

      const now = Date.now();
      const project: StoredAgentProject = {
        projectId: projectIdForRoot(primaryRoot),
        name,
        primaryRoot,
        additionalRoots,
        pinned: input.pinned,
        origin: 'manual',
        lastActiveAt: existingIndex >= 0 ? current[existingIndex]!.lastActiveAt : null,
        createdAt: existingIndex >= 0 ? current[existingIndex]!.createdAt : now,
        updatedAt: now,
      };
      if (existingIndex < 0 && current.length >= MAX_AGENT_PROJECTS) {
        return { ok: false, reason: 'invalid' };
      }
      const previousProject = existingIndex >= 0 ? current[existingIndex] : undefined;
      return {
        ok: true,
        preparation: {
          project,
          ...(previousProject ? { previousProject } : {}),
          expectedSnapshotFingerprint: projectSnapshotFingerprint(this.snapshot),
          existingIndex,
        },
      };
    });
  }

  commitPreparedUpsert(preparation: AgentProjectUpsertPreparation): Promise<
    | {
        readonly ok: true;
        readonly project: StoredAgentProject;
        readonly previousProject?: StoredAgentProject;
      }
    | { readonly ok: false; readonly reason: 'stale' }
  > {
    return this.file.enqueue(async () => {
      if (projectSnapshotFingerprint(this.snapshot) !== preparation.expectedSnapshotFingerprint) {
        return { ok: false, reason: 'stale' } as const;
      }
      const projects = [...this.snapshot.projects];
      if (preparation.existingIndex >= 0) {
        projects.splice(preparation.existingIndex, 1, preparation.project);
      } else {
        projects.push(preparation.project);
      }
      const next: AgentProjectFile = { version: 3, projects };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return {
        ok: true,
        project: preparation.project,
        ...(preparation.previousProject ? { previousProject: preparation.previousProject } : {}),
      } as const;
    });
  }

  remove(projectId: string): Promise<boolean> {
    return this.file.enqueue(async () => {
      const projects = this.snapshot.projects.filter((project) => project.projectId !== projectId);
      if (projects.length === this.snapshot.projects.length) return false;
      const next: AgentProjectFile = { version: 3, projects };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  /** Record a project only after EZTerminal itself observed Agent work there. */
  async recordWork(input: {
    readonly primaryRoot: string;
    readonly additionalRoots: readonly string[];
    readonly lastActiveAt: number;
  }): Promise<boolean> {
    if (!Number.isFinite(input.lastActiveAt)) return false;
    const primaryRoot = await canonicalAgentDirectory(input.primaryRoot);
    if (!primaryRoot) return false;
    const observedRoots: string[] = [];
    const observedKeys = new Set([pathKey(primaryRoot)]);
    for (const root of input.additionalRoots) {
      if (observedRoots.length >= MAX_AGENT_PROJECT_ROOTS - 1) break;
      const canonical = await canonicalAgentDirectory(root);
      if (!canonical) continue;
      const key = pathKey(canonical);
      if (observedKeys.has(key)) continue;
      observedKeys.add(key);
      observedRoots.push(canonical);
    }

    return this.file.enqueue(async () => {
      const projects = [...this.snapshot.projects];
      const now = Date.now();
      const index = projects.findIndex((project) =>
        pathKey(project.primaryRoot) === pathKey(primaryRoot));
      if (index >= 0) {
        const current = projects[index]!;
        const additionalRoots = [...current.additionalRoots];
        const keys = new Set([pathKey(primaryRoot), ...additionalRoots.map(pathKey)]);
        for (const root of observedRoots) {
          if (additionalRoots.length >= MAX_AGENT_PROJECT_ROOTS - 1) break;
          const key = pathKey(root);
          if (keys.has(key)) continue;
          keys.add(key);
          additionalRoots.push(root);
        }
        const lastActiveAt = Math.max(current.lastActiveAt ?? 0, input.lastActiveAt);
        const changed = lastActiveAt !== current.lastActiveAt
          || additionalRoots.length !== current.additionalRoots.length;
        if (!changed) return true;
        projects[index] = {
          ...current,
          additionalRoots,
          lastActiveAt,
          updatedAt: now,
        };
      } else {
        if (projects.length >= MAX_AGENT_PROJECTS) return false;
        projects.push({
          projectId: projectIdForRoot(primaryRoot),
          name: path.basename(primaryRoot) || primaryRoot,
          primaryRoot,
          additionalRoots: observedRoots,
          pinned: false,
          origin: 'terminal',
          lastActiveAt: input.lastActiveAt,
          createdAt: now,
          updatedAt: now,
        });
      }
      const next: AgentProjectFile = { version: 3, projects };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  /** Update recency for an already-registered project without re-indexing a worktree as a project. */
  touch(projectId: string, lastActiveAt: number): Promise<boolean> {
    if (!Number.isFinite(lastActiveAt)) return Promise.resolve(false);
    return this.file.enqueue(async () => {
      const projects = [...this.snapshot.projects];
      const index = projects.findIndex((project) => project.projectId === projectId);
      if (index < 0) return false;
      const current = projects[index]!;
      const nextLastActiveAt = Math.max(current.lastActiveAt ?? 0, lastActiveAt);
      if (nextLastActiveAt === current.lastActiveAt) return true;
      projects[index] = {
        ...current,
        lastActiveAt: nextLastActiveAt,
        updatedAt: Date.now(),
      };
      const next: AgentProjectFile = { version: 3, projects };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }
}

export type AgentProjectRecord = ReturnType<AgentProjectStore['list']>[number];
