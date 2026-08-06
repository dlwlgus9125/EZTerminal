import {
  hasProjectPathControlCharacters,
  type ProjectWorkspaceDescriptorResult,
  type ProjectReviewScope,
} from '../shared/project-workspace';
import type { AgentProjectPage } from '../shared/agent-history';

export interface ProjectDiffTarget {
  readonly projectId: string;
  readonly rootId: string;
  readonly repositoryRelativePath?: string;
  readonly scope: ProjectReviewScope;
  readonly historyId?: string;
  readonly reviewTurnId?: string;
}

export interface RegisteredProjectFileTarget {
  readonly projectId: string;
  readonly rootId: string;
  readonly relativePath: string;
}

export interface RegisteredProjectFileSource {
  readonly listProjects: () => Promise<AgentProjectPage>;
  readonly describeProject: (projectId: string) => Promise<ProjectWorkspaceDescriptorResult>;
}

interface PendingReveal {
  readonly relativePath: string;
  readonly createdAt: number;
}

const MAX_PENDING_REVEALS = 64;
const REVEAL_TTL_MS = 60_000;
const pending = new Map<string, PendingReveal>();
const listeners = new Map<string, Set<(relativePath: string) => void>>();

function targetKey(target: ProjectDiffTarget): string {
  return [
    target.projectId,
    target.rootId,
    target.repositoryRelativePath ?? '',
    target.scope,
    target.historyId ?? '',
    target.reviewTurnId ?? '',
  ].join('\0');
}

function boundedRelativePath(value: string): string | null {
  if (!value || value.length > 4096 || hasProjectPathControlCharacters(value)) return null;
  const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    return null;
  }
  return segments.join('/');
}

function normalizedAbsolute(value: string): string {
  const slashed = value.replace(/\\/gu, '/');
  if (slashed === '/' || /^[A-Za-z]:\/$/u.test(slashed)) return slashed;
  return slashed.replace(/\/+$/u, '');
}

/** Converts provider-recorded paths to a project-relative reveal hint.
 * Main still validates the actual review request; this is navigation only. */
export function projectRelativeReviewHint(pathHint: string, rootPath: string): string | null {
  if (!pathHint || !rootPath || pathHint.length > 8192 || rootPath.length > 8192) return null;
  const candidate = normalizedAbsolute(pathHint);
  const root = normalizedAbsolute(rootPath);
  const windowsCandidate = /^[A-Za-z]:\//u.test(candidate) || candidate.startsWith('//');
  const windowsRoot = /^[A-Za-z]:\//u.test(root) || root.startsWith('//');
  const absoluteCandidate = windowsCandidate || candidate.startsWith('/');
  if (!absoluteCandidate) return boundedRelativePath(candidate);
  if (windowsCandidate !== windowsRoot) return null;

  const comparisonCandidate = windowsCandidate ? candidate.toLocaleLowerCase('en-US') : candidate;
  const comparisonRoot = windowsCandidate ? root.toLocaleLowerCase('en-US') : root;
  const prefix = comparisonRoot.endsWith('/') ? comparisonRoot : `${comparisonRoot}/`;
  if (!comparisonCandidate.startsWith(prefix)) return null;
  return boundedRelativePath(candidate.slice(prefix.length));
}

/** Maps a main-validated absolute file path to the deepest registered project
 * root. UI callers gain one stable project descriptor without teaching the
 * generic terminal resolver about Dockview or Agent Project state. */
export async function findRegisteredProjectFileTarget(
  absolutePath: string,
  source: RegisteredProjectFileSource,
): Promise<RegisteredProjectFileTarget | null> {
  if (!absolutePath.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(absolutePath) && !/^[\\/]{2}/u.test(absolutePath)) {
    return null;
  }
  let page: AgentProjectPage;
  try {
    page = await source.listProjects();
  } catch {
    return null;
  }
  const candidates = page.items.flatMap((project) =>
    [project.primaryRoot, ...project.additionalRoots]
      .filter((rootPath) => projectRelativeReviewHint(absolutePath, rootPath) !== null)
      .map((rootPath) => ({ projectId: project.projectId, rootPath })))
    .sort((left, right) => normalizedAbsolute(right.rootPath).length - normalizedAbsolute(left.rootPath).length);
  const descriptors = new Map<string, ProjectWorkspaceDescriptorResult | null>();
  for (const candidate of candidates) {
    if (!descriptors.has(candidate.projectId)) {
      try {
        descriptors.set(candidate.projectId, await source.describeProject(candidate.projectId));
      } catch {
        descriptors.set(candidate.projectId, null);
      }
    }
    const descriptor = descriptors.get(candidate.projectId);
    if (!descriptor?.ok) continue;
    const roots = descriptor.project.roots
      .map((root) => ({ root, relativePath: projectRelativeReviewHint(absolutePath, root.displayPath) }))
      .filter((entry): entry is { root: typeof entry.root; relativePath: string } => entry.relativePath !== null)
      .sort((left, right) => normalizedAbsolute(right.root.displayPath).length - normalizedAbsolute(left.root.displayPath).length);
    const match = roots[0];
    if (match) {
      return {
        projectId: descriptor.project.projectId,
        rootId: match.root.rootId,
        relativePath: match.relativePath,
      };
    }
  }
  return null;
}

export function requestProjectDiffReveal(target: ProjectDiffTarget, relativePath: string): void {
  const bounded = boundedRelativePath(relativePath);
  if (!bounded) return;
  const key = targetKey(target);
  const subscribers = listeners.get(key);
  if (subscribers?.size) {
    for (const listener of subscribers) listener(bounded);
    return;
  }
  pending.delete(key);
  pending.set(key, { relativePath: bounded, createdAt: Date.now() });
  while (pending.size > MAX_PENDING_REVEALS) {
    const oldest = pending.keys().next().value as string | undefined;
    if (!oldest) break;
    pending.delete(oldest);
  }
}

export function subscribeProjectDiffReveal(
  target: ProjectDiffTarget,
  listener: (relativePath: string) => void,
): () => void {
  const key = targetKey(target);
  const group = listeners.get(key) ?? new Set<(relativePath: string) => void>();
  group.add(listener);
  listeners.set(key, group);
  const queued = pending.get(key);
  pending.delete(key);
  if (queued && Date.now() - queued.createdAt <= REVEAL_TTL_MS) listener(queued.relativePath);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(key);
  };
}
