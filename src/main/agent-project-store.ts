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
  readonly explicit: boolean;
  readonly lastActiveAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface AgentProjectFile {
  readonly version: 2;
  readonly projects: readonly StoredAgentProject[];
}

interface LegacyAgentProjectFile {
  readonly version: 1;
  readonly projects: readonly Omit<StoredAgentProject, 'explicit' | 'lastActiveAt'>[];
}

const EMPTY_FILE: AgentProjectFile = { version: 2, projects: [] };

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
    && typeof project.explicit === 'boolean'
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
  if (file.version === 2 && file.projects.every(validateStoredProject)) {
    return { version: 2, projects: file.projects as readonly StoredAgentProject[] };
  }
  if (file.version === 1) {
    const legacy = value as Partial<LegacyAgentProjectFile>;
    const migrated = legacy.projects?.map((project) => ({
      ...project,
      explicit: true,
      lastActiveAt: null,
    }));
    if (migrated?.every(validateStoredProject)) {
      return { version: 2, projects: migrated };
    }
  }
  return null;
}

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

async function canonicalDirectory(value: string): Promise<string | null> {
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

export class AgentProjectStore {
  private readonly file: JsonFile;
  private snapshot: AgentProjectFile = EMPTY_FILE;

  constructor(userDataDirectory: string) {
    this.file = new JsonFile(userDataDirectory, 'agent-projects.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    this.snapshot = await this.file.readValidated(validateFile, EMPTY_FILE);
  }

  list(): readonly StoredAgentProject[] {
    return this.snapshot.projects;
  }

  async upsert(input: AgentProjectInput): Promise<
    | { readonly ok: true; readonly project: StoredAgentProject }
    | { readonly ok: false; readonly reason: 'invalid' | 'not-found' | 'duplicate' }
  > {
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
    const primaryRoot = await canonicalDirectory(input.primaryRoot);
    if (!primaryRoot) return { ok: false, reason: 'invalid' };
    const additionalRoots: string[] = [];
    const seen = new Set([pathKey(primaryRoot)]);
    for (const root of input.additionalRoots) {
      const canonical = await canonicalDirectory(root);
      if (!canonical) return { ok: false, reason: 'invalid' };
      const key = pathKey(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      additionalRoots.push(canonical);
    }

    const current = this.snapshot.projects;
    const existingIndex = input.projectId
      ? current.findIndex((project) => project.projectId === input.projectId)
      : -1;
    if (input.projectId && existingIndex < 0) return { ok: false, reason: 'not-found' };
    const duplicate = current.find((project, index) =>
      index !== existingIndex && pathKey(project.primaryRoot) === pathKey(primaryRoot));
    if (duplicate) return { ok: false, reason: 'duplicate' };

    const now = Date.now();
    const project: StoredAgentProject = {
      projectId: projectIdForRoot(primaryRoot),
      name,
      primaryRoot,
      additionalRoots,
      pinned: input.pinned,
      explicit: true,
      lastActiveAt: existingIndex >= 0 ? current[existingIndex]!.lastActiveAt : null,
      createdAt: existingIndex >= 0 ? current[existingIndex]!.createdAt : now,
      updatedAt: now,
    };
    if (existingIndex < 0 && current.length >= MAX_AGENT_PROJECTS) {
      return { ok: false, reason: 'invalid' };
    }
    const projects = [...current];
    if (existingIndex >= 0) projects.splice(existingIndex, 1, project);
    else projects.push(project);
    const next: AgentProjectFile = { version: 2, projects };
    await this.file.enqueue(async () => this.file.writeAtomic(JSON.stringify(next)));
    this.snapshot = next;
    return { ok: true, project };
  }

  async remove(projectId: string): Promise<boolean> {
    const projects = this.snapshot.projects.filter((project) => project.projectId !== projectId);
    if (projects.length === this.snapshot.projects.length) return false;
    const next: AgentProjectFile = { version: 2, projects };
    await this.file.enqueue(async () => this.file.writeAtomic(JSON.stringify(next)));
    this.snapshot = next;
    return true;
  }

  /**
   * Merge lightweight provider state into the local project index. Session ids,
   * previews, and transcript content never enter this file.
   */
  async discover(
    hints: readonly { readonly primaryRoot: string; readonly lastActiveAt: number }[],
  ): Promise<void> {
    if (hints.length === 0) return;
    const projects = [...this.snapshot.projects];
    let changed = false;
    const now = Date.now();
    for (const hint of hints) {
      if (
        typeof hint.primaryRoot !== 'string'
        || !path.isAbsolute(hint.primaryRoot)
        || !Number.isFinite(hint.lastActiveAt)
      ) {
        continue;
      }
      const primaryRoot = path.normalize(hint.primaryRoot);
      const key = pathKey(primaryRoot);
      const index = projects.findIndex((project) => pathKey(project.primaryRoot) === key);
      if (index >= 0) {
        const current = projects[index]!;
        if ((current.lastActiveAt ?? 0) < hint.lastActiveAt) {
          projects[index] = { ...current, lastActiveAt: hint.lastActiveAt };
          changed = true;
        }
        continue;
      }
      if (projects.length >= MAX_AGENT_PROJECTS) break;
      projects.push({
        projectId: projectIdForRoot(primaryRoot),
        name: path.basename(primaryRoot) || primaryRoot,
        primaryRoot,
        additionalRoots: [],
        pinned: false,
        explicit: false,
        lastActiveAt: hint.lastActiveAt,
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
    }
    if (!changed) return;
    const next: AgentProjectFile = { version: 2, projects };
    await this.file.enqueue(async () => this.file.writeAtomic(JSON.stringify(next)));
    this.snapshot = next;
  }

  async flush(): Promise<void> {
    await this.file.flush();
  }
}

export type AgentProjectRecord = ReturnType<AgentProjectStore['list']>[number];
