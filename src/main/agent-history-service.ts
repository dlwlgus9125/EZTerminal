import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  MAX_AGENT_HISTORY_PAGE_SIZE,
  MAX_AGENT_LAUNCH_DIRECTORY_LENGTH,
  type AgentHistoryProvider,
  type AgentHistorySessionPage,
  type AgentLaunchPreparation,
  type AgentLaunchTarget,
  type AgentProjectLaunchPreparation,
  type AgentProjectLauncherSummary,
  type AgentHistorySessionSummary,
  type AgentProjectInput,
  type AgentProjectMutationResult,
  type AgentProjectPage,
  type AgentProjectSummary,
  type AgentResumePreparation,
  type AgentResumeRootChoice,
  type AgentTranscriptPage,
} from '../shared/agent-history';
import type { GenericAgentProfile } from '../shared/agent';
import type {
  AgentHistoryProviderAdapter,
  ProviderHistorySession,
} from './agent-history-provider';
import {
  AgentProjectStore,
  canonicalAgentDirectory,
  type AgentProjectRecord,
} from './agent-project-store';

interface IndexedSession {
  readonly publicSession: AgentHistorySessionSummary;
  readonly privateSession: ProviderHistorySession;
  readonly adapter: AgentHistoryProviderAdapter;
}

const MAX_INDEXED_SESSIONS = 500;

/**
 * One provider's position inside a merged session page. `cursor` is the
 * provider's own opaque cursor for the page currently being consumed and `skip`
 * is how much of that page earlier pages already showed — so a merged page stays
 * stateless and survives a restart, even though providers page independently and
 * cannot be resumed mid-page.
 */
interface ProviderCursorState {
  readonly cursor?: string;
  readonly skip: number;
}

type SessionCursorState = Readonly<Record<string, ProviderCursorState>>;

interface ProviderBuffer {
  readonly adapter: AgentHistoryProviderAdapter;
  readonly items: readonly ProviderHistorySession[];
  readonly pageCursor: string | undefined;
  readonly nextCursor: string | null;
  readonly skip: number;
  taken: number;
}

function decodeSessionCursor(cursor: string | undefined): SessionCursorState | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const object = parsed as Record<string, unknown> | null;
    if (typeof object !== 'object' || object === null || Array.isArray(object)) return null;
    const state: Record<string, ProviderCursorState> = {};
    for (const [provider, value] of Object.entries(object)) {
      const entry = value as Partial<ProviderCursorState> | null;
      if (typeof entry !== 'object' || entry === null) return null;
      if (!Number.isSafeInteger(entry.skip) || (entry.skip ?? -1) < 0) return null;
      if (entry.cursor !== undefined && typeof entry.cursor !== 'string') return null;
      state[provider] = {
        ...(entry.cursor === undefined ? {} : { cursor: entry.cursor }),
        skip: entry.skip as number,
      };
    }
    return state;
  } catch {
    return null;
  }
}

function encodeSessionCursor(state: SessionCursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

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
    private readonly getGenericProfiles: () => readonly GenericAgentProfile[] = () => [],
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  async listProjects(
    _force = false,
    cursor?: string,
    limit = 100,
    query?: string,
  ): Promise<AgentProjectPage> {
    void _force;
    const needle = query?.trim().toLocaleLowerCase('en-US') ?? '';
    const summaries = this.projects.list()
      .map(projectSummary)
      .filter((project) => needle.length === 0 || [
        project.name,
        project.primaryRoot,
        ...project.additionalRoots,
      ].some((value) => value.toLocaleLowerCase('en-US').includes(needle)));
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

  /**
   * One page of the project's most recent work across every provider, merged by
   * recency. Providers are asked only for what this page can hold; nothing scans
   * a provider's whole history.
   */
  async listSessions(
    projectId: string,
    cursor?: string,
    limit = 10,
    _force = false,
  ): Promise<AgentHistorySessionPage> {
    void _force;
    const project = this.projectForId(projectId);
    if (!project) return { items: [], nextCursor: null };
    const roots = [project.primaryRoot, ...project.additionalRoots];
    const size = Math.max(1, Math.min(MAX_AGENT_HISTORY_PAGE_SIZE, Math.trunc(limit)));
    const state = decodeSessionCursor(cursor);

    const buffers = (await Promise.all([...this.adapters.values()].map(
      async (adapter): Promise<ProviderBuffer | null> => {
        // A provider missing from a continuation cursor ran out on an earlier page.
        const entry = state ? state[adapter.provider] : undefined;
        if (state && !entry) return null;
        const skip = entry?.skip ?? 0;
        try {
          const result = await adapter.listSessions({
            roots,
            ...(entry?.cursor ? { cursor: entry.cursor } : {}),
            limit: size,
          });
          return {
            adapter,
            items: result.items.slice(skip),
            pageCursor: entry?.cursor,
            nextCursor: result.nextCursor,
            skip,
            taken: 0,
          };
        } catch {
          return null;
        }
      },
    ))).filter((buffer): buffer is ProviderBuffer => buffer !== null);

    // A k-way merge rather than a global sort: each provider's page is already
    // newest-first, and taking a strict prefix of each is what makes `skip`
    // accounting — and therefore the continuation cursor — correct.
    const page: ProviderHistorySession[] = [];
    const owners: ProviderBuffer[] = [];
    while (page.length < size) {
      let best: ProviderBuffer | undefined;
      for (const buffer of buffers) {
        const candidate = buffer.items[buffer.taken];
        if (!candidate) continue;
        const incumbent = best?.items[best.taken];
        if (!incumbent || candidate.updatedAt > incumbent.updatedAt) best = buffer;
      }
      const session = best?.items[best.taken];
      if (!best || !session) break;
      best.taken += 1;
      page.push(session);
      owners.push(best);
    }

    const nextState: Record<string, ProviderCursorState> = {};
    for (const buffer of buffers) {
      if (buffer.taken < buffer.items.length) {
        nextState[buffer.adapter.provider] = {
          ...(buffer.pageCursor === undefined ? {} : { cursor: buffer.pageCursor }),
          skip: buffer.skip + buffer.taken,
        };
      } else if (buffer.nextCursor) {
        nextState[buffer.adapter.provider] = { cursor: buffer.nextCursor, skip: 0 };
      }
    }
    const items = page.map((session, index) =>
      this.indexSession(owners[index]!.adapter, session, projectId));
    return {
      items,
      nextCursor: Object.keys(nextState).length > 0 ? encodeSessionCursor(nextState) : null,
    };
  }

  async readTranscript(historyId: string, cursor?: string, limit = 20): Promise<AgentTranscriptPage | null> {
    const indexed = await this.findSession(historyId);
    if (!indexed) return null;
    const result = await indexed.adapter.readTranscript(indexed.privateSession.privateId, cursor, limit);
    return { ...result, historyId, provider: indexed.adapter.provider };
  }

  async prepareResume(historyId: string): Promise<AgentResumePreparation | null> {
    const indexed = await this.findSession(historyId);
    if (!indexed) return null;
    const recordedRoots = indexed.publicSession.roots;
    const project = this.projectForId(indexed.publicSession.projectId);
    const currentRoots = project
      ? [project.primaryRoot, ...project.additionalRoots]
      : [];
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
      canResume: (recordedRoots.length > 0 && missingRecordedRoots.length === 0)
        || (currentRoots.length > 0 && missingCurrentRoots.length === 0),
      revision,
    };
  }

  /**
   * Resolves a resume into a ready-to-dispatch launch line. The provider's own
   * session id never leaves this class: the adapter turns it into `commandText`,
   * and callers forward only that plus the redacted `displayCommandText`.
   */
  async resolveResume(
    historyId: string,
    revision: string,
    choice: AgentResumeRootChoice,
  ): Promise<
    | {
      readonly ok: true;
      readonly provider: AgentHistoryProvider;
      readonly roots: readonly string[];
      readonly commandText: string;
      readonly displayCommandText: string;
    }
    | { readonly ok: false; readonly reason: 'not-found' | 'stale' | 'missing-root' | 'unavailable' }
  > {
    const preparation = await this.prepareResume(historyId);
    const indexed = this.index.get(historyId);
    if (!preparation || !indexed) return { ok: false, reason: 'not-found' };
    if (preparation.revision !== revision) return { ok: false, reason: 'stale' };
    const roots = choice === 'recorded' ? preparation.recordedRoots : preparation.currentRoots;
    const missing = choice === 'recorded'
      ? preparation.missingRecordedRoots
      : preparation.missingCurrentRoots;
    if (roots.length === 0 || missing.length > 0) return { ok: false, reason: 'missing-root' };
    const command = indexed.adapter.buildResumeCommand(indexed.privateSession.privateId, roots);
    if (!command) return { ok: false, reason: 'unavailable' };
    return { ok: true, provider: indexed.adapter.provider, roots, ...command };
  }

  listLaunchers(): readonly AgentProjectLauncherSummary[] {
    return [
      ...(this.adapters.has('codex') ? [{
        launcherId: 'codex',
        provider: 'codex' as const,
        name: 'Codex',
        supportsAdditionalRoots: true,
      }] : []),
      ...(this.adapters.has('claude') ? [{
        launcherId: 'claude',
        provider: 'claude' as const,
        name: 'Claude Code',
        supportsAdditionalRoots: true,
      }] : []),
      ...this.getGenericProfiles()
        .filter((profile) => profile.enabled)
        .map((profile) => ({
          launcherId: opaqueId('launcher', profile.id),
          provider: 'generic' as const,
          name: profile.name,
          supportsAdditionalRoots: false,
        })),
    ];
  }

  async prepareLaunch(
    target: AgentLaunchTarget,
    launcherId: string,
  ): Promise<AgentLaunchPreparation> {
    if (!launcherId || typeof target !== 'object' || target === null) {
      return { ok: false, reason: 'invalid' };
    }
    const launcher = this.resolveLauncher(launcherId);
    if (!launcher) return { ok: false, reason: 'unavailable' };

    let canonicalTarget: AgentLaunchTarget;
    let configuredRoots: readonly string[];
    if (target.kind === 'project') {
      if (!target.projectId) return { ok: false, reason: 'invalid' };
      const project = this.projectForId(target.projectId);
      if (!project) return { ok: false, reason: 'not-found' };
      canonicalTarget = target;
      configuredRoots = [project.primaryRoot, ...project.additionalRoots];
    } else if (target.kind === 'directory') {
      if (
        !target.directory
        || target.directory.length > MAX_AGENT_LAUNCH_DIRECTORY_LENGTH
        || !path.isAbsolute(target.directory)
      ) {
        return { ok: false, reason: 'invalid' };
      }
      const directory = await canonicalAgentDirectory(target.directory);
      if (!directory) return { ok: false, reason: 'missing-root' };
      canonicalTarget = { kind: 'directory', directory };
      configuredRoots = [directory];
    } else {
      return { ok: false, reason: 'invalid' };
    }

    const roots = launcher.provider === 'generic'
      ? configuredRoots.slice(0, 1)
      : configuredRoots;
    if (roots.length === 0 || (await missingDirectories(roots)).length > 0) {
      return { ok: false, reason: 'missing-root' };
    }
    return {
      ok: true,
      target: canonicalTarget,
      launcherId,
      provider: launcher.provider,
      name: launcher.name,
      cwd: roots[0]!,
      roots,
      ignoredAdditionalRootCount: configuredRoots.length - roots.length,
      revision: this.launchRevision(canonicalTarget, launcherId, roots, launcher.executable),
    };
  }

  /** Protocol-v5 compatibility wrapper for project-only launch clients. */
  async prepareProjectLaunch(
    projectId: string,
    launcherId: string,
  ): Promise<AgentProjectLaunchPreparation> {
    const preparation = await this.prepareLaunch({ kind: 'project', projectId }, launcherId);
    if (!preparation.ok) return preparation;
    return {
      ok: true,
      projectId,
      launcherId: preparation.launcherId,
      provider: preparation.provider,
      name: preparation.name,
      cwd: preparation.cwd,
      roots: preparation.roots,
      revision: preparation.revision,
    };
  }

  async resolveLaunch(
    target: AgentLaunchTarget,
    launcherId: string,
    revision: string,
  ): Promise<
    | {
      readonly ok: true;
      readonly roots: readonly string[];
      readonly commandText: string;
      readonly displayCommandText: string;
    }
    | { readonly ok: false; readonly reason: 'not-found' | 'stale' | 'missing-root' | 'unavailable' }
  > {
    const preparation = await this.prepareLaunch(target, launcherId);
    if (!preparation.ok) {
      if (preparation.reason === 'invalid') return { ok: false, reason: 'not-found' };
      return { ok: false, reason: preparation.reason };
    }
    if (preparation.revision !== revision) return { ok: false, reason: 'stale' };
    const launcher = this.resolveLauncher(launcherId);
    if (!launcher) return { ok: false, reason: 'unavailable' };
    if (launcher.provider === 'generic') {
      if (!launcher.executable) return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        roots: preparation.roots,
        commandText: `!${launcher.executable}`,
        displayCommandText: launcher.name,
      };
    }
    const command = this.adapters.get(launcher.provider)?.buildNewCommand?.(preparation.roots);
    return command
      ? { ok: true, roots: preparation.roots, ...command }
      : { ok: false, reason: 'unavailable' };
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

  private resolveLauncher(launcherId: string): {
    readonly provider: AgentHistoryProvider | 'generic';
    readonly name: string;
    readonly executable: string;
  } | null {
    if (launcherId === 'codex' && this.adapters.has('codex')) {
      return { provider: 'codex', name: 'Codex', executable: 'codex' };
    }
    if (launcherId === 'claude' && this.adapters.has('claude')) {
      return { provider: 'claude', name: 'Claude Code', executable: 'claude' };
    }
    const profile = this.getGenericProfiles().find((candidate) =>
      candidate.enabled && opaqueId('launcher', candidate.id) === launcherId);
    return profile
      ? { provider: 'generic', name: profile.name, executable: profile.executable }
      : null;
  }

  private launchRevision(
    target: AgentLaunchTarget,
    launcherId: string,
    roots: readonly string[],
    executable: string,
  ): string {
    return createHash('sha256')
      .update(JSON.stringify(target))
      .update('\0')
      .update(launcherId)
      .update('\0')
      .update(JSON.stringify(roots))
      .update('\0')
      .update(executable)
      .digest('hex')
      .slice(0, 24);
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
