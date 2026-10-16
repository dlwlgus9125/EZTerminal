import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ConversationQuerySchema, HistoryResumePreparationRequestSchema, HistoryResumeRequestSchema,
  ConversationRefSchema, type ConversationRef, type ConversationResolveResult,
  type ConversationEntry, type ConversationHistoryClient, type ConversationHistoryFailure,
  type ConversationPage, type ConversationQuery, type ConversationReadResult,
  type HistoryResumePreparation, type HistoryResumePreparationRequest, type HistoryResumeRequest, type HistoryResumeResult,
} from '../shared/conversation-history';
import { createDaemonCommand, type DaemonAgent, type DaemonPrincipal, type DaemonSession, type DaemonSnapshot, type DaemonTranscriptItem } from '../shared/daemon-protocol';
import type { AgentHistorySessionSummary, AgentProjectSummary, AgentTranscriptPage } from '../shared/agent-history';
import type { WorkflowNavigationResult, WorkflowNavigationSnapshot } from '../shared/workflow';
import type { AgentHistoryService } from './agent-history-service';
import type { DaemonCommandRouter } from './daemon-command-router';
import type { DaemonAgentRuntime } from './daemon-agent-runtime';
import type { DaemonMigrationReceipt, DaemonStore, DaemonTranscriptItemInput } from './daemon-store';
import { AsyncMutationGate } from './async-mutation-gate';

const digest = (...parts: readonly string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');
const appId = (sessionId: string) => `conversation_${digest('app', sessionId).slice(0, 32)}`;
const nativeId = (historyId: string) => `conversation_native_${historyId}`;
const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const stoppedSessions = new Set(['completed', 'interrupted', 'failed', 'archived']);
const stoppedAgents = new Set(['done', 'interrupted', 'error', 'archived']);
const failed = (reason: ConversationHistoryFailure['reason'], message: string): ConversationHistoryFailure => ({ ok: false, reason, message });
type NativeSource = NonNullable<Awaited<ReturnType<AgentHistoryService['resolveHistorySource']>>>;
type CursorState = { signature: string; app: number; native: Record<string, { cursor?: string; skip: number }>; exhausted: string[] };
type Located = { entry: ConversationEntry; session?: DaemonSession; agent?: DaemonAgent; native?: NativeSource };

export interface ConversationHistoryServiceOptions {
  readonly terminalHistory?: (sessionId: string) => Promise<string | null>;
  readonly history: Pick<AgentHistoryService, 'listProjects' | 'listSessions' | 'readTranscript' | 'readTranscriptForAdoption' | 'resolveHistorySource' | 'readResumeSettings' | 'findProviderHistory'>;
  readonly daemon: Pick<DaemonCommandRouter, 'getSnapshot' | 'getTranscript' | 'execute' | 'applySystemTransition'>;
  readonly store: Pick<DaemonStore, 'getMigrationReceipt' | 'listMigrationReceipts' | 'findCommand' | 'getConversationPreview' | 'getConversationTranscript' | 'pendingConversationSource'>;
  readonly runtime: Pick<DaemonAgentRuntime, 'adoptNativeHistory'>;
  readonly workflow?: (projectId: string) => Promise<WorkflowNavigationResult>;
  readonly continueWorkflow?: (projectId: string, sourceSessionId: string, sessionId: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly now?: () => Date;
}

/** Lists are metadata-only. Native content is read only for preview or an explicit adoption. */
export class ConversationHistoryService implements ConversationHistoryClient {
  private readonly resumeGate = new AsyncMutationGate();
  private provenanceCache?: { revision: number; bySession: Map<string, DaemonMigrationReceipt>; byProvider: Map<string, DaemonMigrationReceipt> };
  private identityCache?: { revision: number; values: Map<string, { id: string; sessions: string[]; aliases: string[]; current?: DaemonSession }> };
  constructor(private readonly options: ConversationHistoryServiceOptions) {}

  async resolveConversation(value: ConversationRef): Promise<ConversationResolveResult> {
    const parsed = ConversationRefSchema.safeParse(value);
    if (!parsed.success) return failed('invalid', 'Invalid conversation reference.');
    const { kind, id } = parsed.data;
    try {
      const terminal = kind === 'terminal' ? await this.options.terminalHistory?.(id) : undefined;
      const located = await this.locate(kind === 'terminal' ? terminal ? nativeId(terminal) : '' : kind === 'session' ? appId(id) : kind === 'history' ? nativeId(id) : id);
      if (!located) return failed('not-found', 'The conversation is no longer available.');
      const [entry] = await this.withLineage([located.entry]);
      return { ok: true, entry };
    } catch { return failed('unavailable', 'The conversation could not be resolved.'); }
  }

  /** Continuation receipts outlive runtime sessions; titles and timestamps are never identity evidence. */
  private identity(sessionId: string, snapshot: DaemonSnapshot): { id: string; sessions: string[]; aliases: string[] } {
    return this.identities(snapshot).get(sessionId) ?? { id: appId(sessionId), sessions: [sessionId], aliases: [appId(sessionId)] };
  }

  private identities(snapshot: DaemonSnapshot) {
    if (this.identityCache?.revision === snapshot.revision) return this.identityCache.values;
    const parents = new Map<string, string>();
    for (const receipt of this.options.store.listMigrationReceipts('history-continuation')) {
      if (typeof receipt.detail?.sessionId === 'string' && typeof receipt.detail.sourceSessionId === 'string')
        parents.set(receipt.detail.sessionId, receipt.detail.sourceSessionId);
    }
    const root = (id: string): string => {
      const seen = new Set<string>();
      while (parents.has(id) && !seen.has(id)) { seen.add(id); id = parents.get(id)!; }
      return id;
    };
    const adoptions = new Map(this.options.store.listMigrationReceipts('native-history-adoption')
      .filter(item => typeof item.detail?.sessionId === 'string' && typeof item.detail?.historyId === 'string')
      .map(item => [item.detail!.sessionId as string, item.detail!.historyId as string]));
    const groups = new Map<string, DaemonSession[]>();
    for (const session of snapshot.sessions) if (session.kind === 'agent') {
      const origin = root(session.id);
      const group = groups.get(origin) ?? []; group.push(session); groups.set(origin, group);
    }
    const values = new Map<string, { id: string; sessions: string[]; aliases: string[]; current?: DaemonSession }>();
    for (const [origin, group] of groups) {
      group.sort((a, b) => Number(stoppedSessions.has(a.state)) - Number(stoppedSessions.has(b.state)) || b.revision - a.revision || a.id.localeCompare(b.id));
      const sessions = group.map(item => item.id);
      const id = adoptions.has(origin) ? nativeId(adoptions.get(origin)!) : appId(origin);
      const value = { id, sessions, aliases: [...new Set([id, ...sessions.map(appId)])], current: group[0] };
      for (const session of sessions) values.set(session, value);
    }
    this.identityCache = { revision: snapshot.revision, values };
    return values;
  }

  private currentSession(sessionId: string, snapshot: DaemonSnapshot): DaemonSession | undefined {
    return this.identities(snapshot).get(sessionId)?.current;
  }

  async listConversations(value: ConversationQuery = {}): Promise<ConversationPage> {
    const parsed = ConversationQuerySchema.safeParse(value);
    if (!parsed.success) return failed('invalid', 'Invalid conversation history query.');
    try {
      const query = parsed.data;
      const snapshot = this.options.daemon.getSnapshot();
      const limit = query.limit ?? 30;
      const signature = digest(JSON.stringify({ ...query, cursor: undefined, force: undefined, limit: undefined }));
      const cursor = this.cursor(query.cursor, signature);
      if (!cursor) return failed('invalid', 'The history cursor does not match this filter.');
      const projects = await this.nativeProjects();
      const scoped = projects.filter(project => !query.projectId || this.projectIdentity(project, snapshot).id === query.projectId);
      const candidates: { entry: ConversationEntry; stream: string }[] = [];
      const app = query.source === 'native' ? [] : snapshot.sessions.filter(session => session.kind === 'agent' && this.currentSession(session.id, snapshot)?.id === session.id)
        .map(session => this.appEntry(session, snapshot)).filter((entry): entry is ConversationEntry => !!entry)
        .filter(entry => this.matches(entry, query)).sort(this.sort);
      candidates.push(...app.slice(cursor.app, cursor.app + limit).map(entry => ({ entry, stream: 'app' })));
      const buffers = new Map<string, { entries: ConversationEntry[]; cursor?: string; nextCursor: string | null; skip: number; consumed: number }>();
      if (query.source !== 'app') {
        // Four concurrent metadata reads keep large project catalogs from saturating native providers.
        for (let start = 0; start < scoped.length; start += 4) await Promise.all(scoped.slice(start, start + 4).map(async project => {
          if (cursor.exhausted.includes(project.projectId)) return;
          const position = cursor.native[project.projectId] ?? { skip: 0 };
          const page = await this.options.history.listSessions(project.projectId, position.cursor, 100, query.force);
          const entries: ConversationEntry[] = [];
          for (const summary of page.items) {
            const source = await this.options.history.resolveHistorySource(summary.historyId);
            if (!source || source.parentProviderSessionId) continue;
            const owner = this.owner(source, snapshot);
            if (owner) {
              // Native and structured indexes describe one conversation. Its app row owns the result.
              if (query.source === 'native') {
                const session = snapshot.sessions.find(item => item.id === owner.sessionId);
                const entry = session && this.appEntry(session, snapshot, summary.historyId);
                if (entry && this.matches({ ...entry, source: 'native' }, query)) entries.push({ ...entry, source: 'native' });
              }
              continue;
            }
            const entry = this.nativeEntry(summary, project, snapshot);
            if (this.matches(entry, query)) entries.push(entry);
          }
          const buffer = { entries, cursor: position.cursor, nextCursor: page.nextCursor, skip: position.skip, consumed: 0 };
          buffers.set(project.projectId, buffer);
          candidates.push(...entries.slice(position.skip).map(entry => ({ entry, stream: project.projectId })));
        }));
      }
      candidates.sort((a, b) => this.sort(a.entry, b.entry));
      const selected: ConversationEntry[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        if (selected.length >= limit) break;
        if (candidate.stream === 'app') cursor.app += 1;
        else buffers.get(candidate.stream)!.consumed += 1;
        if (!seen.has(candidate.entry.conversationId)) { seen.add(candidate.entry.conversationId); selected.push(candidate.entry); }
      }
      for (const [key, buffer] of buffers) {
        const skip = buffer.skip + buffer.consumed;
        if (skip < buffer.entries.length) cursor.native[key] = { ...(buffer.cursor ? { cursor: buffer.cursor } : {}), skip };
        else if (buffer.nextCursor) cursor.native[key] = { cursor: buffer.nextCursor, skip: 0 };
        else { delete cursor.native[key]; if (!cursor.exhausted.includes(key)) cursor.exhausted.push(key); }
      }
      const more = cursor.app < app.length || (query.source !== 'app'
        && scoped.some(project => !cursor.exhausted.includes(project.projectId)));
      const items = await this.withLineage(selected);
      return { ok: true, items, nextCursor: more ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null };
    } catch { return failed('unavailable', 'Conversation history could not be loaded. Try again.'); }
  }

  async readConversation(conversationId: string, cursor?: string, limit = 20): Promise<ConversationReadResult> {
    if (!this.validId(conversationId) || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 65_536))
      || !Number.isInteger(limit) || limit < 1 || limit > 100) return failed('invalid', 'Invalid conversation read request.');
    try {
      const located = await this.locate(conversationId);
      if (!located) return failed('not-found', 'The conversation is no longer available.');
      let transcript: AgentTranscriptPage;
      if (located.session) {
        const before = cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(cursor);
        if (!Number.isSafeInteger(before) || before < 1) return failed('invalid', 'Invalid transcript cursor.');
        const page = this.options.store.getConversationTranscript(located.session.id, before, limit);
        transcript = { historyId: conversationId, provider: located.entry.providerId === 'claude' ? 'claude' : 'codex',
          turns: [{ id: `page-${before}`, status: located.entry.state, entries: page.items.map(item => this.previewItem(item)) }],
          nextCursor: page.nextCursor };
      } else {
        const page = await this.options.history.readTranscript(located.entry.historyId!, cursor, Math.min(20, limit));
        if (!page) return failed('transcript-unavailable', 'The provider could not load this conversation.');
        const importedSession = `history-imported-${digest(located.native!.summary.provider, located.native!.providerSessionId).slice(0, 32)}`;
        transcript = { ...page, historyId: conversationId, turns: page.turns.map(turn => ({ ...turn, entries: turn.entries.map(item => ({
          ...item, id: `history-item-${digest(importedSession, turn.id, item.id).slice(0, 40)}`,
        })) })) };
      }
      const [entry] = await this.withLineage([located.entry]);
      return { ok: true, entry: entry!, transcript };
    } catch { return failed('transcript-unavailable', 'The conversation could not be read. Its source has been preserved.'); }
  }

  async prepareHistoryResume(value: HistoryResumePreparationRequest): Promise<HistoryResumePreparation> {
    const parsed = HistoryResumePreparationRequestSchema.safeParse(value);
    if (!parsed.success) return failed('invalid', 'Invalid history resume request.');
    try {
      const located = await this.locate(parsed.data.conversationId, true);
      if (!located) return failed('not-found', 'The source conversation no longer exists.');
      // Effort stays host-side: the preparation schema is shared with older clients.
      const { reasoningEffort, ...preparation } = await this.prepare(located, parsed.data) as HistoryResumePreparation & { reasoningEffort?: string };
      void reasoningEffort;
      return preparation;
    } catch { return failed('unavailable', 'The source conversation could not be checked.'); }
  }

  resumeHistory(value: HistoryResumeRequest, principal: DaemonPrincipal = { kind: 'desktop', id: 'history' }): Promise<HistoryResumeResult> {
    return this.resumeGate.runExclusive(async () => {
      const parsed = HistoryResumeRequestSchema.safeParse(value);
      if (!parsed.success) return failed('invalid', 'Invalid history resume request.');
      const request = parsed.data;
      const requestFingerprint = digest(JSON.stringify(request), principal.kind, principal.id);
      const receiptId = `history-request-${digest(principal.kind, principal.id, request.commandId).slice(0, 32)}`;
      const receipt = this.options.store.getMigrationReceipt(receiptId);
      if (receipt) return receipt.fingerprint === requestFingerprint && typeof receipt.detail?.sessionId === 'string'
        ? { ok: true, sessionId: receipt.detail.sessionId, alreadyLinked: true }
        : failed('conflict', 'This request identity was already used for different resume settings.');
      // The daemon outbox is the durable receipt if the app stopped between its resume commit
      // and our presentation receipt. Retrying must not transfer the provider a second time.
      const resumeCommandId = `history-resume-${digest(principal.kind, principal.id, request.commandId).slice(0, 32)}`;
      const priorCommand = this.options.store.findCommand(resumeCommandId);
      if (priorCommand) {
        if (priorCommand.idempotencyKey !== `${resumeCommandId}:${requestFingerprint}`) return failed('conflict', 'This request identity belongs to different resume settings.');
        if (priorCommand.receipt?.ok && priorCommand.command.type === 'agent.resume') {
          const payload = priorCommand.command.payload;
          const source = this.options.daemon.getSnapshot().sessions.find(item => item.id === payload.sourceSessionId);
          if (!source) return failed('not-found', 'The original conversation no longer exists.');
          const linked = await this.finishContinuation(source.projectId, source.id, payload.sessionId);
          return linked.ok ? { ok: true, sessionId: payload.sessionId, alreadyLinked: true } : linked;
        }
        return failed('stale', 'The previous resume did not complete. Refresh the conversation before trying again.');
      }
      try {
        const located = await this.locate(request.conversationId, true);
        if (!located) return failed('not-found', 'The source conversation no longer exists.');
        const preparation = await this.prepare(located, request);
        if (!preparation.ok) return preparation;
        if (preparation.action === 'open' && located.session) return { ok: true, sessionId: located.session.id, alreadyLinked: true };
        if (preparation.revision !== request.revision) return failed('stale', 'The conversation or target changed. Review it again before resuming.');
        if (!preparation.canResume || !preparation.workspaceId) return failed(preparation.blockedReason ?? 'unavailable', preparation.message ?? 'This conversation cannot currently be resumed.');
        let result: HistoryResumeResult;
        if (located.session && located.agent?.providerSessionId) {
          const sessionId = `history-continued-${digest(principal.kind, principal.id, request.commandId).slice(0, 32)}`;
          const commandId = `history-resume-${digest(principal.kind, principal.id, request.commandId).slice(0, 32)}`;
          const existing = this.options.store.findCommand(commandId);
          if (existing?.receipt?.ok) result = { ok: true, sessionId, alreadyLinked: true };
          else {
            const snapshot = this.options.daemon.getSnapshot();
            const command = createDaemonCommand({ commandId, idempotencyKey: `${commandId}:${requestFingerprint}`, expectedRevision: snapshot.revision,
              issuedAt: (this.options.now?.() ?? new Date()).toISOString(), principal, type: 'agent.resume', payload: {
                sessionId, sourceSessionId: located.session.id, workspaceId: preparation.workspaceId, providerId: located.agent.providerId,
                providerSessionId: located.agent.providerSessionId, title: located.entry.title,
                ...(preparation.model ? { model: preparation.model } : {}), permissionPreset: preparation.permissionPreset,
                ...(preparation.reasoningEffort ? { reasoningEffort: preparation.reasoningEffort } : {}),
              } });
            const applied = await this.options.daemon.execute(command);
            result = applied.ok ? { ok: true, sessionId, alreadyLinked: false }
              : failed(applied.error.code === 'revision-conflict' ? 'stale' : 'conflict', applied.error.message);
          }
        } else if (located.native) {
          const sessionId = `history-imported-${digest(located.native.summary.provider, located.native.providerSessionId).slice(0, 32)}`;
          const transcript = await this.importTranscript(located.native, sessionId);
          if (!transcript.length) return failed('transcript-unavailable', 'This source has no saved conversation messages to resume.');
          const checked = await this.options.history.resolveHistorySource(located.native.summary.historyId, true);
          if (!checked || checked.providerSessionId !== located.native.providerSessionId || checked.summary.updatedAt !== located.native.summary.updatedAt)
            return failed('stale', 'The provider conversation changed while its history was loading. Refresh before resuming.');
          result = await this.options.runtime.adoptNativeHistory({ sessionId, workspaceId: preparation.workspaceId,
            providerId: checked.summary.provider, providerSessionId: checked.providerSessionId, historyId: checked.summary.historyId,
            rootPath: checked.summary.roots[0]!, title: checked.summary.title, sourceUpdatedAt: checked.summary.updatedAt,
            ...(preparation.model ? { model: preparation.model } : {}), permissionPreset: preparation.permissionPreset,
            ...(preparation.reasoningEffort ? { reasoningEffort: preparation.reasoningEffort } : {}), transcript,
            requestReceipt: { id: receiptId, fingerprint: requestFingerprint } });
        } else return failed('unavailable', 'This conversation no longer owns a provider session.');
        if (result.ok && located.session && result.sessionId !== located.session.id) {
          const linked = await this.finishContinuation(located.session.projectId, located.session.id, result.sessionId);
          if (!linked.ok) return linked;
        }
        if (result.ok) await this.options.daemon.applySystemTransition(() => ({ value: undefined, commit: { mutations: [{ kind: 'migration-receipt.record',
          value: { id: receiptId, source: 'history-resume-request', fingerprint: requestFingerprint, detail: { sessionId: result.sessionId } } }] } }));
        return result;
      } catch { return failed('unavailable', 'The conversation could not be resumed. Its original history has been preserved.'); }
    });
  }

  private async prepare(located: Located, request: HistoryResumePreparationRequest): Promise<HistoryResumePreparation & { reasoningEffort?: string }> {
    const snapshot = this.options.daemon.getSnapshot();
    const { session, agent } = located;
    const navigation = this.options.workflow ? await this.options.workflow(located.entry.projectId) : undefined;
    const entry = navigation?.ok ? this.lineage(located.entry, navigation.snapshot) : located.entry;
    const workspace = request.workspaceId ? snapshot.workspaces.find(item => item.id === request.workspaceId)
      : session ? snapshot.workspaces.find(item => item.id === session.workspaceId)
        : snapshot.workspaces.find(item => !item.archivedAt && item.projectId === entry.projectId && entry.roots[0] && pathKey(item.rootPath) === pathKey(entry.roots[0]));
    const project = snapshot.projects.find(item => item.id === (workspace?.projectId ?? entry.projectId));
    // A conversation continues with what it last ran with unless the user chose otherwise. A linked
    // conversation imported from a CLI may never have recorded its model or effort; read only then.
    const needsSource = !(request.model ?? agent?.model) || !agent?.reasoningEffort || !agent?.permissionPreset;
    const nativeHistoryId = !needsSource ? null : located.native?.summary.historyId
      ?? (agent?.providerSessionId && (agent.providerId === 'codex' || agent.providerId === 'claude')
        ? await this.options.history.findProviderHistory(agent.providerId, agent.providerSessionId) : null);
    const source = nativeHistoryId ? await this.options.history.readResumeSettings(nativeHistoryId) : null;
    const model = request.model ?? agent?.model ?? source?.model;
    const permissionPreset = request.permissionPreset ?? agent?.permissionPreset ?? source?.permissionPreset ?? 'standard';
    const reasoningEffort = agent?.reasoningEffort ?? source?.reasoningEffort;
    const provider = snapshot.providers.find(item => item.id === entry.providerId);
    let reason: ConversationHistoryFailure['reason'] | undefined;
    let message: string | undefined;
    const block = (value: ConversationHistoryFailure['reason'], text: string) => { reason = value; message = text; };
    if (!project) block('missing-root', 'Open the recorded folder as an EZTerminal project before continuing this conversation.');
    else if (project.archivedAt) block('archived-project', 'Restore the project before continuing this conversation.');
    else if (!workspace || workspace.archivedAt) block('missing-root', 'Open the recorded project folder and its workspace before resuming.');
    else if (workspace.projectId !== entry.projectId || !entry.roots[0] || pathKey(workspace.rootPath) !== pathKey(entry.roots[0]))
      block('root-mismatch', 'The selected workspace differs from the conversation’s recorded folder. Select the recorded workspace.');
    else {
      try { if (!(await fs.stat(workspace.rootPath)).isDirectory()) block('missing-root', 'The recorded workspace folder is unavailable.'); }
      catch { block('missing-root', 'The recorded workspace folder is unavailable.'); }
    }
    if (!reason && navigation && !navigation.ok) block('unavailable', 'The saved workflow could not be verified. Restore its project record before continuing.');
    if (!reason && entry.subprojectId && navigation?.ok) {
      const owner = navigation.snapshot.subprojects.find(item => item.id === entry.subprojectId);
      if (!owner || owner.status === 'archived' || (entry.nodeId && !owner.stages.some(node => node.id === entry.nodeId && !node.archived)))
        block('archived-project', 'Restore the conversation’s original subproject and stage before continuing.');
    }
    const action = session && !stoppedSessions.has(session.state) && agent && !stoppedAgents.has(agent.state) ? 'open' : 'resume';
    if (action === 'resume' && !reason) {
      if (!provider?.enabled || provider.health !== 'ready' || !provider.capabilities.includes('resume')) block('provider-unavailable', 'Enable and verify this Agent provider before resuming.');
      else if (session && (!agent?.providerSessionId || snapshot.agentRelations.some(item => item.childSessionId === session.id && item.owner === 'provider-native')))
        block('unavailable', 'This conversation does not own an independently resumable provider session.');
      else if (located.native?.parentProviderSessionId) block('unavailable', 'A provider-owned child conversation cannot be resumed independently.');
    }
    const revision = digest(entry.conversationId, String(entry.updatedAt), String(session?.revision ?? 0), String(agent?.revision ?? 0),
      String(provider?.revision ?? 0), String(workspace?.revision ?? 0), String(project?.revision ?? 0),
      navigation?.ok ? JSON.stringify(navigation.snapshot) : '', workspace?.id ?? '', workspace?.rootPath ?? '', model ?? '', permissionPreset);
    return { ok: true, entry, revision, ...(workspace ? { workspaceId: workspace.id } : {}), canResume: !reason,
      ...(reason ? { blockedReason: reason, message } : {}), ...(session ? { linkedSessionId: session.id } : {}),
      action: reason ? 'unavailable' : action, ...(model ? { model } : {}), permissionPreset,
      ...(reasoningEffort ? { reasoningEffort } : {}) };
  }

  private async locate(conversationId: string, refresh = false): Promise<Located | null> {
    if (!this.validId(conversationId)) return null;
    const snapshot = this.options.daemon.getSnapshot();
    const matched = snapshot.sessions.find(item => item.kind === 'agent' && (appId(item.id) === conversationId || this.identity(item.id, snapshot).id === conversationId));
    const session = matched && this.currentSession(matched.id, snapshot);
    if (session) { const entry = this.appEntry(session, snapshot); return entry ? { entry, session, agent: snapshot.agents.find(item => item.sessionId === session.id) } : null; }
    if (!conversationId.startsWith('conversation_native_')) return null;
    const native = await this.options.history.resolveHistorySource(conversationId.slice('conversation_native_'.length), refresh);
    if (!native) return null;
    const owner = this.owner(native, snapshot);
    if (owner) {
      const linked = this.currentSession(owner.sessionId, snapshot);
      const entry = linked && this.appEntry(linked, snapshot, native.summary.historyId);
      return linked && entry ? { entry, session: linked, agent: snapshot.agents.find(item => item.sessionId === linked.id), native } : null;
    }
    const project = (await this.nativeProjects()).find(item => item.projectId === native.summary.projectId);
    if (!project) return null;
    return { entry: this.nativeEntry(native.summary, project, snapshot), native };
  }

  private async importTranscript(source: NativeSource, sessionId: string): Promise<DaemonTranscriptItemInput[]> {
    const pages: DaemonTranscriptItemInput[][] = [];
    const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    for (;;) {
      const page = await this.options.history.readTranscriptForAdoption(source.summary.historyId, cursor, 20);
      if (!page) throw new Error('Transcript source disappeared.');
      const imported: DaemonTranscriptItemInput[] = [];
      for (const turn of page.turns) for (const item of turn.entries) {
        const id = `history-item-${digest(sessionId, turn.id, item.id).slice(0, 40)}`;
        if (seen.has(id)) continue; seen.add(id);
        imported.push({ id, messageId: id, sessionId, kind: item.type === 'message' ? item.role === 'user' ? 'user-message' : 'assistant-message'
          : item.kind === 'reasoning' ? 'reasoning' : 'tool-result', text: item.type === 'message' ? item.markdown : item.summary,
          isDelta: false, isSensitive: false, createdAt: new Date(source.summary.createdAt).toISOString() });
      }
      pages.unshift(imported);
      if (!page.nextCursor) break;
      if (cursors.has(page.nextCursor)) throw new Error('Provider transcript cursor did not advance.');
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    // Both native adapters page backwards while each page is chronological.
    return pages.flat();
  }

  private appEntry(session: DaemonSession, snapshot: DaemonSnapshot, historyId?: string): ConversationEntry | undefined {
    const agent = snapshot.agents.find(item => item.sessionId === session.id); if (!agent) return undefined;
    const project = snapshot.projects.find(item => item.id === session.projectId);
    const workspace = snapshot.workspaces.find(item => item.id === session.workspaceId);
    if (this.provenanceCache?.revision !== snapshot.revision) {
      const bySession = new Map<string, DaemonMigrationReceipt>(); const byProvider = new Map<string, DaemonMigrationReceipt>();
      for (const receipt of this.options.store.listMigrationReceipts('native-history-adoption')) {
        if (typeof receipt.detail?.sessionId === 'string') bySession.set(receipt.detail.sessionId, receipt);
        if (typeof receipt.detail?.providerId === 'string' && typeof receipt.detail.providerSessionId === 'string')
          byProvider.set(`${receipt.detail.providerId}:${receipt.detail.providerSessionId}`, receipt);
      }
      this.provenanceCache = { revision: snapshot.revision, bySession, byProvider };
    }
    const provenance = this.provenanceCache.bySession.get(session.id)
      ?? (agent.providerSessionId ? this.provenanceCache.byProvider.get(`${agent.providerId}:${agent.providerSessionId}`) : undefined);
    const nativeHistoryId = historyId ?? (typeof provenance?.detail?.historyId === 'string' ? provenance.detail.historyId : undefined);
    const stopped = stoppedSessions.has(session.state) || stoppedAgents.has(agent.state);
    const identity = this.identity(session.id, snapshot);
    return { conversationId: identity.id, aliases: [...new Set([...identity.aliases, ...(nativeHistoryId ? [nativeId(nativeHistoryId)] : [])])], sessionAliases: identity.sessions,
      source: 'app', providerId: agent.providerId, projectId: session.projectId,
      projectTitle: project?.name ?? session.projectId, title: session.title, preview: this.options.store.getConversationPreview(session.id), createdAt: Date.parse(session.createdAt), updatedAt: Date.parse(session.updatedAt),
      roots: workspace ? [workspace.rootPath] : [], workspaceId: session.workspaceId, linkedSessionId: session.id,
      ...(nativeHistoryId ? { historyId: nativeHistoryId } : {}), archived: !!session.archivedAt || session.state === 'archived', state: session.state,
      action: stopped ? agent.providerSessionId ? 'resume' : 'unavailable' : 'open' };
  }
  private nativeEntry(summary: AgentHistorySessionSummary, project: AgentProjectSummary, snapshot: DaemonSnapshot): ConversationEntry {
    const identity = this.projectIdentity(project, snapshot);
    return { conversationId: nativeId(summary.historyId), source: 'native', historyId: summary.historyId, providerId: summary.provider,
      projectId: identity.id, projectTitle: identity.title, title: summary.title, preview: summary.preview, createdAt: summary.createdAt, updatedAt: summary.updatedAt,
      roots: summary.roots, archived: false, state: 'recorded', action: 'resume' };
  }
  private projectIdentity(project: AgentProjectSummary, snapshot: DaemonSnapshot) {
    const daemon = snapshot.projects.find(item => item.rootPath && pathKey(item.rootPath) === pathKey(project.primaryRoot));
    return { id: daemon?.id ?? project.projectId, title: daemon?.name ?? project.name };
  }
  private owner(source: NativeSource, snapshot: DaemonSnapshot) { return snapshot.agents.filter(item => item.providerId === source.summary.provider && item.providerSessionId === source.providerSessionId).sort((a, b) => b.revision - a.revision)[0]; }
  private async nativeProjects(): Promise<AgentProjectSummary[]> {
    const result: AgentProjectSummary[] = []; let cursor: string | undefined;
    do { const page = await this.options.history.listProjects(false, cursor, 100); result.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
    return result;
  }
  private matches(entry: ConversationEntry, query: ConversationQuery): boolean {
    const archive = query.archived ?? 'exclude'; const needle = query.query?.trim().toLowerCase();
    return (!query.projectId || entry.projectId === query.projectId) && (!query.providerId || entry.providerId === query.providerId)
      && (!query.source || entry.source === query.source) && (archive === 'include' || (archive === 'only' ? entry.archived : !entry.archived))
      && (!needle || [entry.title, entry.preview, entry.projectTitle, ...entry.roots].some(item => item.toLowerCase().includes(needle)));
  }
  private sort(a: ConversationEntry, b: ConversationEntry): number { return b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId); }
  private cursor(encoded: string | undefined, signature: string): CursorState | null {
    if (!encoded) return { signature, app: 0, native: {}, exhausted: [] };
    try {
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CursorState;
      if (value.signature !== signature || !Number.isSafeInteger(value.app) || value.app < 0 || !value.native || typeof value.native !== 'object'
        || !Array.isArray(value.exhausted) || !value.exhausted.every(item => typeof item === 'string')
        || Object.values(value.native).some(item => !item || !Number.isSafeInteger(item.skip) || item.skip < 0 || (item.cursor !== undefined && typeof item.cursor !== 'string'))) return null;
      return value;
    } catch { return null; }
  }
  private async finishContinuation(projectId: string, sourceSessionId: string, sessionId: string): Promise<{ ok: true } | ConversationHistoryFailure> {
    try {
    const result = await this.options.continueWorkflow?.(projectId, sourceSessionId, sessionId);
    if (result && !result.ok) return failed('conflict', `The Agent was restored, but its original stage could not be linked: ${result.message} Retry this same request after resolving it.`);
    await this.options.daemon.applySystemTransition(() => ({ value: undefined, commit: { mutations: [{ kind: 'migration-receipt.record',
      value: { id: `history-linked-${sessionId}`, source: 'history-continuation-linked', fingerprint: sessionId, detail: { sourceSessionId, sessionId } } }] } }));
    return { ok: true };
    } catch { return failed('unavailable', 'The Agent was restored but its saved stage could not be confirmed. Retry this same request after reconnecting.'); }
  }
  private async withLineage(entries: readonly ConversationEntry[]): Promise<ConversationEntry[]> {
    if (!this.options.workflow) return [...entries];
    const projects = [...new Set(entries.filter(entry => entry.linkedSessionId).map(entry => entry.projectId))];
    const summaries = new Map<string, WorkflowNavigationSnapshot>();
    for (let index = 0; index < projects.length; index += 4) await Promise.all(projects.slice(index, index + 4).map(async projectId => {
      const result = await this.options.workflow!(projectId); if (result.ok) summaries.set(projectId, result.snapshot);
    }));
    return entries.map(entry => summaries.has(entry.projectId) ? this.lineage(entry, summaries.get(entry.projectId)!) : entry);
  }
  private lineage(entry: ConversationEntry, snapshot: WorkflowNavigationSnapshot): ConversationEntry {
    const seen = new Set<string>(); let sessionId = entry.linkedSessionId;
    let link: WorkflowNavigationSnapshot['sessionLinks'][number] | undefined;
    while (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId); link = snapshot.sessionLinks.find(item => item.sessionId === sessionId);
      if (link) break; sessionId = this.options.store.pendingConversationSource(sessionId);
    }
    if (!link) return entry;
    const subproject = snapshot.subprojects.find(item => item.id === link.subprojectId);
    const node = subproject?.stages.find(item => item.id === link.nodeId);
    return { ...entry, subprojectId: link.subprojectId, ...(subproject ? { subprojectTitle: subproject.title } : {}),
      ...(link.nodeId ? { nodeId: link.nodeId, ...(node ? { nodeTitle: node.title } : {}) } : {}) };
  }
  private previewItem(item: DaemonTranscriptItem): AgentTranscriptPage['turns'][number]['entries'][number] {
    return item.kind === 'user-message' || item.kind === 'assistant-message'
      ? { type: 'message', id: item.messageId ?? item.id, role: item.kind === 'user-message' ? 'user' : 'assistant', markdown: item.text }
      : { type: 'activity', id: item.id, kind: item.kind === 'reasoning' ? 'reasoning' : 'tool', summary: item.text };
  }
  private validId(value: string): boolean { return typeof value === 'string' && /^conversation_[a-zA-Z0-9_-]{1,140}$/u.test(value); }
}
