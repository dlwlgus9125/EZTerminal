import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MAX_AGENT_HISTORY_PAGE_SIZE,
  type AgentHistorySessionPage,
  type AgentHistorySessionSummary,
  type AgentProjectInput,
  type AgentProjectMutationResult,
  type AgentProjectPage,
  type AgentProjectSummary,
  type AgentResumePreparation,
  type AgentResumeRootChoice,
  type AgentTranscriptPage,
} from '../shared/agent-history';
import type {
  AgentHistoryProviderAdapter,
  ProviderHistorySession,
} from './agent-history-provider';
import { AgentProjectStore, type AgentProjectRecord } from './agent-project-store';

interface IndexedSession {
  readonly publicSession: AgentHistorySessionSummary;
  readonly privateSession: ProviderHistorySession;
  readonly adapter: AgentHistoryProviderAdapter;
}

const MAX_INDEXED_SESSIONS = 500;

function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function opaqueId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function projectIdForRoot(root: string): string {
  return opaqueId('project', pathKey(root)).slice('project_'.length);
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function page<T>(items: readonly T[], cursor: string | undefined, limit: number): {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
} {
  const offset = decodeOffset(cursor);
  const size = Math.max(1, Math.min(MAX_AGENT_HISTORY_PAGE_SIZE, Math.trunc(limit)));
  const selected = items.slice(offset, offset + size);
  const nextOffset = offset + selected.length;
  return {
    items: selected,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

async function missingDirectories(roots: readonly string[]): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const root of roots) {
    try {
      if (!(await fs.stat(root)).isDirectory()) missing.push(root);
    } catch {
      missing.push(root);
    }
  }
  return missing;
}

function rootsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((root, index) => pathKey(root) === pathKey(right[index]!));
}

function projectSummary(project: AgentProjectRecord): AgentProjectSummary {
  return {
    projectId: projectIdForRoot(project.primaryRoot),
    name: project.name,
    primaryRoot: project.primaryRoot,
    additionalRoots: project.additionalRoots,
    pinned: project.pinned,
    saved: project.origin === 'manual',
    // Counts and providers belong to the on-demand session page. Persisting
    // either would turn the local project index into a second history DB.
    sessionCount: 0,
    providers: [],
    lastActiveAt: project.lastActiveAt,
  };
}

export class AgentHistoryService {
  private readonly adapters: ReadonlyMap<string, AgentHistoryProviderAdapter>;
  private readonly index = new Map<string, IndexedSession>();

  constructor(
    private readonly projects: AgentProjectStore,
    adapters: readonly AgentHistoryProviderAdapter[],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  async listProjects(_force = false, cursor?: string, limit = 100): Promise<AgentProjectPage> {
    void _force;
    const summaries = this.projects.list().map(projectSummary);
    summaries.sort((a, b) =>
      Number(b.pinned) - Number(a.pinned)
      || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
      || a.name.localeCompare(b.name));
    return page(summaries, cursor, limit);
  }

  async recordTerminalWork(roots: readonly string[], lastActiveAt = Date.now()): Promise<void> {
    const [primaryRoot, ...additionalRoots] = roots;
    if (!primaryRoot) return;
    await this.projects.recordWork({
      primaryRoot,
      additionalRoots,
      lastActiveAt,
    });
  }

  async listSessions(
    projectId: string,
    cursor?: string,
    limit = 10,
    _force = false,
  ): Promise<AgentHistorySessionPage> {
    void _force;
    const project = this.projectForId(projectId);
    const adapter = this.adapters.get('codex');
    if (!project || !adapter) return { items: [], nextCursor: null };
    const roots = [project.primaryRoot, ...project.additionalRoots];
    const result = await adapter.listSessions({
      roots,
      ...(cursor ? { cursor } : {}),
      limit: Math.max(1, Math.min(MAX_AGENT_HISTORY_PAGE_SIZE, Math.trunc(limit))),
    });
    const items = result.items.map((session) => this.indexSession(adapter, session, projectId));
    return { items, nextCursor: result.nextCursor };
  }

  async readTranscript(historyId: string, cursor?: string, limit = 20): Promise<AgentTranscriptPage | null> {
    const indexed = await this.findSession(historyId);
    if (!indexed) return null;
    const result = await indexed.adapter.readTranscript(indexed.privateSession.privateId, cursor, limit);
    return { ...result, historyId };
  }

  async prepareResume(historyId: string): Promise<AgentResumePreparation | null> {
    const indexed = await this.findSession(historyId);
    if (!indexed) return null;
    const recordedRoots = indexed.publicSession.roots;
    const project = this.projectForId(indexed.publicSession.projectId);
    const currentRoots = project
      ? [
          recordedRoots[0] ?? project.primaryRoot,
          ...project.additionalRoots.filter((root) =>
            pathKey(root) !== pathKey(recordedRoots[0] ?? project.primaryRoot)),
        ]
      : recordedRoots;
    const [missingRecordedRoots, missingCurrentRoots] = await Promise.all([
      missingDirectories(recordedRoots),
      missingDirectories(currentRoots),
    ]);
    const revision = this.resumeRevision(indexed, recordedRoots, currentRoots);
    return {
      historyId,
      provider: indexed.publicSession.provider,
      recordedRoots,
      currentRoots,
      rootsMatch: rootsEqual(recordedRoots, currentRoots),
      missingRecordedRoots,
      missingCurrentRoots,
      canResume: indexed.publicSession.provider === 'codex'
        && ((recordedRoots.length > 0 && missingRecordedRoots.length === 0)
          || (currentRoots.length > 0 && missingCurrentRoots.length === 0)),
      revision,
    };
  }

  async resolveResume(
    historyId: string,
    revision: string,
    choice: AgentResumeRootChoice,
  ): Promise<
    | { readonly ok: true; readonly privateId: string; readonly roots: readonly string[] }
    | { readonly ok: false; readonly reason: 'not-found' | 'stale' | 'missing-root' | 'unavailable' }
  > {
    const preparation = await this.prepareResume(historyId);
    const indexed = this.index.get(historyId);
    if (!preparation || !indexed) return { ok: false, reason: 'not-found' };
    if (preparation.revision !== revision) return { ok: false, reason: 'stale' };
    if (preparation.provider !== 'codex') return { ok: false, reason: 'unavailable' };
    const roots = choice === 'recorded' ? preparation.recordedRoots : preparation.currentRoots;
    const missing = choice === 'recorded'
      ? preparation.missingRecordedRoots
      : preparation.missingCurrentRoots;
    if (roots.length === 0 || missing.length > 0) return { ok: false, reason: 'missing-root' };
    return { ok: true, privateId: indexed.privateSession.privateId, roots };
  }

  async saveProject(input: AgentProjectInput): Promise<AgentProjectMutationResult> {
    const inferred = !input.projectId
      ? this.projects.list().find((project) =>
          project.origin === 'terminal' && pathKey(project.primaryRoot) === pathKey(input.primaryRoot))
      : undefined;
    const result = await this.projects.upsert(inferred
      ? { ...input, projectId: inferred.projectId }
      : input);
    return result.ok
      ? { ok: true, project: projectSummary(result.project) }
      : result;
  }

  async removeProject(projectId: string): Promise<boolean> {
    const record = this.projectForId(projectId);
    return record ? this.projects.remove(record.projectId) : false;
  }

  async dispose(): Promise<void> {
    await Promise.all([
      this.projects.flush(),
      ...this.adapters.values().map((adapter) => adapter.dispose()),
    ]);
  }

  private indexSession(
    adapter: AgentHistoryProviderAdapter,
    session: ProviderHistorySession,
    projectId = projectIdForRoot(session.roots[0] ?? session.cwd),
  ): AgentHistorySessionSummary {
    const historyId = opaqueId(adapter.provider, session.privateId);
    const publicSession: AgentHistorySessionSummary = {
      historyId,
      projectId,
      provider: adapter.provider,
      title: session.title,
      preview: session.preview,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      roots: session.roots,
      source: session.source,
    };
    this.index.delete(historyId);
    this.index.set(historyId, {
      adapter,
      privateSession: session,
      publicSession,
    });
    while (this.index.size > MAX_INDEXED_SESSIONS) {
      const oldest = this.index.keys().next().value as string | undefined;
      if (!oldest) break;
      this.index.delete(oldest);
    }
    return publicSession;
  }

  /**
   * Normal opens are already indexed by listSessions. This fallback supports a
   * restored Dockview tab after restart without persisting provider thread ids.
   */
  private async findSession(historyId: string): Promise<IndexedSession | null> {
    const current = this.index.get(historyId);
    if (current) return current;
    for (const project of this.projects.list()) {
      const projectId = projectIdForRoot(project.primaryRoot);
      const roots = [project.primaryRoot, ...project.additionalRoots];
      for (const adapter of this.adapters.values()) {
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
          let result;
          try {
            result = await adapter.listSessions({ roots, ...(cursor ? { cursor } : {}), limit: 100 });
          } catch {
            break;
          }
          for (const session of result.items) {
            const summary = this.indexSession(adapter, session, projectId);
            if (summary.historyId === historyId) return this.index.get(historyId) ?? null;
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
      }
    }
    return null;
  }

  private projectForId(projectId: string): AgentProjectRecord | undefined {
    return this.projects.list().find((project) => projectIdForRoot(project.primaryRoot) === projectId);
  }

  private resumeRevision(
    indexed: IndexedSession,
    recordedRoots: readonly string[],
    currentRoots: readonly string[],
  ): string {
    return createHash('sha256')
      .update(indexed.publicSession.historyId)
      .update('\0')
      .update(String(indexed.publicSession.updatedAt))
      .update('\0')
      .update(JSON.stringify(recordedRoots))
      .update('\0')
      .update(JSON.stringify(currentRoots))
      .digest('hex')
      .slice(0, 24);
  }
}
