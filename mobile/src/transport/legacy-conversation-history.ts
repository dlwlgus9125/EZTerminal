import type { EzTerminalApi } from '../../../src/shared/ipc';
import type { ConversationEntry, ConversationHistoryClient, ConversationQuery, ConversationPage, ConversationReadResult, HistoryResumePreparationRequest, HistoryResumePreparation, HistoryResumeResult } from '../../../src/shared/conversation-history';
import type { AgentTranscriptEntry, AgentProjectSummary } from '../../../src/shared/agent-history';

type LegacyApi = Pick<EzTerminalApi, 'getDaemonSnapshot' | 'getDaemonTranscript' | 'listAgentProjects' | 'listAgentHistorySessions' | 'readAgentHistory'>;
const unsupported = { ok: false, reason: 'unsupported', message: 'Update the connected PC to continue this history in Agent. CLI history can still be read and resumed in Terminal.' } as const;
type Cursor = { app: number; native: Record<string, { cursor?: string; skip: number }>; exhausted: string[]; filter: string };
const key = (root: string) => {
  const normalized = root.replace(/\\/gu, '/').replace(/\/$/u, '');
  return /^[A-Za-z]:|^\/\//u.test(normalized) ? normalized.toLowerCase() : normalized;
};

/** Read compatibility for v12–v14. Native adoption is deliberately never emulated in the client. */
export class LegacyConversationHistory implements ConversationHistoryClient {
  private readonly entries = new Map<string, ConversationEntry>();
  constructor(private readonly api: LegacyApi) {}

  async listConversations(query: ConversationQuery = {}): Promise<ConversationPage> {
    try {
      const snapshot = await this.api.getDaemonSnapshot();
      if (!snapshot) return { ok: false, reason: 'unavailable', message: 'The connected PC conversation snapshot is unavailable.' };
      const filter = JSON.stringify({ ...query, cursor: undefined, limit: undefined, force: undefined });
      const cursor: Cursor = query.cursor ? JSON.parse(query.cursor) as Cursor : { app: 0, native: {}, exhausted: [], filter };
      if (cursor.filter !== filter || !Number.isSafeInteger(cursor.app) || cursor.app < 0 || !cursor.native || !Array.isArray(cursor.exhausted))
        return { ok: false, reason: 'invalid', message: 'Refresh this conversation filter.' };
      const matches = (entry: ConversationEntry) => (!query.projectId || entry.projectId === query.projectId) && (!query.providerId || entry.providerId === query.providerId)
        && (!query.source || query.source === entry.source) && (query.archived === 'include' || (query.archived === 'only' ? entry.archived : !entry.archived))
        && (!query.query?.trim() || [entry.title, entry.preview, entry.projectTitle].some(text => text.toLowerCase().includes(query.query!.trim().toLowerCase())));
      const sort = (a: ConversationEntry, b: ConversationEntry) => b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId);
      const app: ConversationEntry[] = snapshot.sessions.filter(session => session.kind === 'agent').flatMap(session => {
        const agent = snapshot.agents.find(item => item.sessionId === session.id); if (!agent) return [];
        const workspace = snapshot.workspaces.find(item => item.id === session.workspaceId);
        const entry: ConversationEntry = { conversationId: `conversation_legacy_app_${session.id}`, source: 'app', providerId: agent.providerId,
          projectId: session.projectId, projectTitle: snapshot.projects.find(item => item.id === session.projectId)?.name ?? session.projectId,
          title: session.title, preview: '', createdAt: Date.parse(session.createdAt), updatedAt: Date.parse(session.updatedAt), roots: workspace ? [workspace.rootPath] : [],
          workspaceId: session.workspaceId, linkedSessionId: session.id, archived: !!session.archivedAt || session.state === 'archived', state: session.state,
          action: ['completed', 'interrupted', 'failed', 'archived'].includes(session.state) || ['done', 'interrupted', 'error', 'archived'].includes(agent.state) ? 'unavailable' : 'open' };
        return matches(entry) ? [entry] : [];
      }).sort(sort);
      const projects: AgentProjectSummary[] = []; const projectCursors = new Set<string>(); let projectCursor: string | undefined;
      if (query.source !== 'app') for (;;) {
        const page = await this.api.listAgentProjects(query.force, projectCursor, 100); projects.push(...page.items);
        if (!page.nextCursor || projectCursors.has(page.nextCursor)) break;
        projectCursors.add(page.nextCursor); projectCursor = page.nextCursor;
      }
      const candidates = app.slice(cursor.app, cursor.app + (query.limit ?? 30)).map(entry => ({ entry, stream: 'app' }));
      const buffers = new Map<string, { entries: ConversationEntry[]; cursor?: string; nextCursor: string | null; skip: number; consumed: number }>();
      for (const project of projects) {
        const daemonProject = snapshot.projects.find(item => item.rootPath && key(item.rootPath) === key(project.primaryRoot));
        const projectId = daemonProject?.id ?? project.projectId;
        if ((query.projectId && query.projectId !== projectId) || cursor.exhausted.includes(project.projectId)) continue;
        const position = cursor.native[project.projectId] ?? { skip: 0 };
        const page = await this.api.listAgentHistorySessions(project.projectId, position.cursor, 100, query.force);
        const entries: ConversationEntry[] = page.items.map(item => ({ conversationId: `conversation_legacy_native_${item.historyId}`, source: 'native', historyId: item.historyId,
          providerId: item.provider, projectId, projectTitle: daemonProject?.name ?? project.name, title: item.title, preview: item.preview,
          createdAt: item.createdAt, updatedAt: item.updatedAt, roots: item.roots, archived: false, state: 'recorded', action: 'unavailable' }));
        const filtered = entries.filter(matches); buffers.set(project.projectId, { entries: filtered, ...position, nextCursor: page.nextCursor, consumed: 0 });
        candidates.push(...filtered.slice(position.skip).map(entry => ({ entry, stream: project.projectId })));
      }
      const items = candidates.sort((a, b) => sort(a.entry, b.entry)).slice(0, query.limit ?? 30).map(candidate => {
        if (candidate.stream === 'app') cursor.app += 1; else buffers.get(candidate.stream)!.consumed += 1;
        this.entries.set(candidate.entry.conversationId, candidate.entry); return candidate.entry;
      });
      for (const [projectId, buffer] of buffers) {
        const skip = buffer.skip + buffer.consumed;
        if (skip < buffer.entries.length) cursor.native[projectId] = { ...(buffer.cursor ? { cursor: buffer.cursor } : {}), skip };
        else if (buffer.nextCursor) cursor.native[projectId] = { cursor: buffer.nextCursor, skip: 0 };
        else { cursor.exhausted.push(projectId); delete cursor.native[projectId]; }
      }
      const more = cursor.app < app.length || projects.some(project => {
        const id = snapshot.projects.find(item => item.rootPath && key(item.rootPath) === key(project.primaryRoot))?.id ?? project.projectId;
        return (!query.projectId || query.projectId === id) && !cursor.exhausted.includes(project.projectId);
      });
      return { ok: true, items, nextCursor: more ? JSON.stringify(cursor) : null };
    } catch { return { ok: false, reason: 'unavailable', message: 'The older PC history could not be read.' }; }
  }

  async readConversation(conversationId: string, cursor?: string, limit = 20): Promise<ConversationReadResult> {
    const entry = this.entries.get(conversationId);
    if (!entry) return { ok: false, reason: 'not-found', message: 'Refresh the list before reading this conversation.' };
    if (entry.historyId) {
      const transcript = await this.api.readAgentHistory(entry.historyId, cursor, limit);
      return transcript ? { ok: true, entry, transcript: { ...transcript, historyId: conversationId } } : { ok: false, reason: 'transcript-unavailable', message: 'This CLI history could not be read.' };
    }
    // Older hosts expose forward fragments only. Fetch on selection, then page complete groups backwards.
    const groups = new Map<string, AgentTranscriptEntry>(); let after = 0;
    for (;;) {
      const items = await this.api.getDaemonTranscript(entry.linkedSessionId!, after, 500); if (!items.length) break;
      for (const item of items) {
        if (item.isSensitive) continue;
        const id = `${item.turnId ?? ''}:${item.kind}:${item.messageId ?? item.id}`;
        const previous = groups.get(id); const old = previous?.type === 'message' ? previous.markdown : previous?.summary ?? '';
        const text = item.isDelta ? old + item.text : item.text;
        groups.set(id, item.kind === 'user-message' || item.kind === 'assistant-message'
          ? { type: 'message', id: item.id, role: item.kind === 'user-message' ? 'user' : 'assistant', markdown: text }
          : { type: 'activity', id: item.id, kind: item.kind === 'reasoning' ? 'reasoning' : 'tool', summary: text });
      }
      const next = items.at(-1)!.sequence; if (next <= after) break; after = next;
    }
    const all = [...groups.values()]; const before = cursor ? Number(cursor) : all.length;
    if (!Number.isSafeInteger(before) || before < 0 || before > all.length) return { ok: false, reason: 'invalid', message: 'Refresh the transcript.' };
    const start = Math.max(0, before - limit);
    return { ok: true, entry, transcript: { historyId: conversationId, provider: entry.providerId === 'claude' ? 'claude' : 'codex',
      turns: [{ id: `page-${before}`, status: entry.state, entries: all.slice(start, before) }], nextCursor: start > 0 ? String(start) : null } };
  }

  async prepareHistoryResume(request: HistoryResumePreparationRequest): Promise<HistoryResumePreparation> {
    const entry = this.entries.get(request.conversationId);
    return entry?.action === 'open' ? { ok: true, entry, revision: 'legacy-open', canResume: true, action: 'open', linkedSessionId: entry.linkedSessionId, permissionPreset: 'standard' } : unsupported;
  }
  async resumeHistory(): Promise<HistoryResumeResult> { return unsupported; }
}
