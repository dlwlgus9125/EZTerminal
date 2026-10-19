import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentTranscriptPage } from '../shared/agent-history';
import type { ConversationEntry } from '../shared/conversation-history';
import type { ChatStateScope, ChatStateSnapshot } from '../shared/chat-state';
import { hasConversationDraft, importConversationDraft } from './conversation-draft-migration';
import type { ConversationSettings } from '../shared/conversation-start';
import type { DaemonSnapshot, DaemonTranscriptItem, PermissionPreset } from '../shared/daemon-protocol';
import { ChatRecoveryController, type ChatStateAccess } from './chat-recovery';
import { ChatRecoveryNotice } from './ChatRecoveryNotice';
import { ConversationStartController, initialConversationSettings, type ConversationStartAccess } from './conversation-start';
import { StructuredAgentSessionPanel, type StructuredAgentUiResult } from './StructuredAgentSession';
import { structuredAgentProviderOptions, structuredAgentWorkspaceOptions } from './structured-agent-create';
import { movePlanAccess } from './agent-plan-access';
import { historyTranscriptItems } from './chat/model/history-items';
import { useAppTranslation } from './i18n';
import { Button, Field, Select } from './ui';
import { NewWorktreeDialog } from './WorktreeDialogs';
import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import type { AgentCapabilitiesClient } from '../shared/agent-capabilities';

const NEW_WORKTREE = '__new-worktree__';

export interface ConversationStartPanelProps {
  readonly identity: string;
  readonly viewStateScope?: string;
  readonly entry?: ConversationEntry;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly snapshot: DaemonSnapshot | null;
  readonly access: ConversationStartAccess;
  readonly storage: ChatStateAccess;
  readonly capabilityClient?: AgentCapabilitiesClient;
  readonly disconnected?: boolean;
  readonly variant?: 'desktop' | 'mobile';
  readonly onOpenHistory?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onContinueCli?: (entry: ConversationEntry) => Promise<void>;
  readonly onReviewChange?: (entry: ConversationEntry, turnId: string, path: string) => Promise<void>;
  readonly onStarted: (sessionId: string, entry?: ConversationEntry) => Promise<void> | void;
}

export function ConversationStartPanel({ identity, viewStateScope = 'desktop', entry: initialEntry, projectId, workspaceId, snapshot, access, storage,
  capabilityClient, disconnected, variant = 'desktop', onOpenHistory, onOpenSettings, onContinueCli, onReviewChange, onStarted }: ConversationStartPanelProps): JSX.Element {
  const { i18n } = useAppTranslation();
  const ko = i18n.language.startsWith('ko');
  const text = useCallback((k: string, e: string) => ko ? k : e, [ko]);
  const host = useRef<HTMLDivElement>(null);
  const hasHistory = !!initialEntry;
  const originalId = initialEntry?.conversationId;
  const scope = useMemo<ChatStateScope>(() => ({ projectId: initialEntry?.projectId ?? projectId ?? 'drafts', sessionId: identity, kind: hasHistory ? 'conversation' : 'draft' }), [identity, initialEntry?.projectId, projectId, hasHistory]);
  const recovery = useMemo(() => new ChatRecoveryController(scope, storage), [scope, storage]);
  const view = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);
  const controller = useMemo(() => new ConversationStartController(recovery, access), [access, recovery]);
  useEffect(() => { void recovery.load(); }, [recovery]);
  const [entry, setEntry] = useState(initialEntry);
  const [page, setPage] = useState<AgentTranscriptPage>();
  const [loading, setLoading] = useState(!!initialEntry);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [earlier, setEarlier] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftLoading, setDraftLoading] = useState(!!initialEntry?.linkedSessionId);
  const [draftLoadFailed, setDraftLoadFailed] = useState(false);
  const [inheritedPending, setInheritedPending] = useState<ChatStateSnapshot>();
  const [draftRevision, setDraftRevision] = useState(0);
  const acceptedRestore = useRef<string>();
  const [worktreeOpen, setWorktreeOpen] = useState(false);
  // Saved agent profiles (desktop): one pick fills AI, model, permission and effort.
  const [profiles, setProfiles] = useState<readonly ChatAgentProfile[]>([]);
  useEffect(() => {
    const access = variant === 'desktop' ? window.ezterminal?.chatAgentProfiles : undefined;
    if (!access || initialEntry) return undefined;
    let alive = true;
    void access.list().then(list => { if (alive) setProfiles(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [variant, initialEntry]);
  const worktreeAccess = variant === 'desktop' ? window.ezterminal?.workspaceWorktrees : undefined;
  const worktreeProject = snapshot?.projects.find(project => project.id === (entry?.projectId ?? projectId));
  const providers = useMemo(() => structuredAgentProviderOptions(snapshot), [snapshot]);
  const workspaces = useMemo(() => structuredAgentWorkspaceOptions(snapshot, entry?.projectId ?? projectId), [snapshot, entry?.projectId, projectId]);
  const recent = snapshot?.agents.filter(agent => entry?.linkedSessionId ? agent.sessionId === entry.linkedSessionId : snapshot.sessions.some(session => session.id === agent.sessionId && (!projectId || session.projectId === projectId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  // A previous conversation continues with what it last ran with; the host reads that from its own
  // record or the provider's transcript. Until it answers, sending would use the wrong settings.
  const [source, setSource] = useState<{ model?: string; permissionPreset: PermissionPreset } | null | undefined>(initialEntry ? undefined : null);
  useEffect(() => {
    if (!originalId || disconnected) return;
    let alive = true;
    void access.history.prepareHistoryResume({ conversationId: originalId })
      .then(prepared => { if (alive) setSource(prepared.ok ? { ...(prepared.model ? { model: prepared.model } : {}), permissionPreset: prepared.permissionPreset } : null); })
      .catch(() => { if (alive) setSource(null); });
    return () => { alive = false; };
  }, [access, originalId, disconnected]);
  const initial: ConversationSettings = initialConversationSettings({
    ...(entry ? { entry: { providerId: entry.providerId, ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}) } } : {}),
    ...(recent ? { recent } : {}), source,
    fallbackProviderId: providers.find(item => !item.disabled)?.id ?? '',
    fallbackWorkspaceId: workspaceId ?? workspaces[0]?.id ?? '',
  });
  const settings = view.settings ?? initial;
  const selectedProvider = providers.find(item => item.id === settings.providerId);
  const selectedWorkspace = workspaces.find(item => item.id === settings.workspaceId);
  const activeProfile = profiles.find(profile => profile.providerId === settings.providerId && profile.model === settings.model
    && profile.permissionPreset === settings.permissionPreset && profile.reasoningEffort === settings.reasoningEffort);
  const canSend = !disconnected && view.status === 'ready' && !loading && !draftLoading && !draftLoadFailed && !inheritedPending && (!entry || (!!page && source !== undefined))
    && !!settings.providerId && (!!entry || !!selectedWorkspace) && !selectedProvider?.disabled;
  useEffect(() => {
    if (!initialEntry?.linkedSessionId) return;
    let alive = true;
    setDraftLoading(true); setDraftLoadFailed(false);
    void importConversationDraft(initialEntry, recovery, storage).then(pending => { if (alive) setInheritedPending(pending); })
      .catch(reason => { if (alive) { setError(String(reason)); setDraftLoadFailed(true); } }).finally(() => { if (alive) setDraftLoading(false); });
    return () => { alive = false; };
  }, [initialEntry, recovery, storage, draftRevision]);
  const checkInherited = async (): Promise<void> => {
    const pending = inheritedPending?.state.pendingSubmit;
    if (!inheritedPending || !pending) return;
    setBusy(true);
    try {
      const receipt = await access.sendCommand(pending.command);
      if (!receipt || !receipt.ok && receipt.error.code === 'delivery-uncertain') throw new Error(text('전송 상태를 확인하지 못했습니다. 연결 후 다시 확인하세요.', 'Delivery is still unconfirmed. Reconnect and check again.'));
      const draft = inheritedPending.state.draft;
      const { prompt, context } = pending.command.payload;
      const delivered = receipt.ok && draft.text.trim() === prompt && JSON.stringify(draft.attachments ?? []) === JSON.stringify(context?.attachments ?? [])
        && JSON.stringify(draft.replyTo) === JSON.stringify(context?.replyTo) && JSON.stringify(draft.skills ?? []) === JSON.stringify(context?.skills ?? []);
      const saved = await storage.chatStateWrite(inheritedPending.scope, { expectedRevision: inheritedPending.revision,
        state: { ...inheritedPending.state, pendingSubmit: undefined, draft: delivered ? { text: '' } : draft } });
      if (!saved.ok) throw new Error(saved.message);
      setInheritedPending(undefined); setDraftRevision(value => value + 1);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!page && view.history?.ok) { setEntry(view.history.entry); setPage(view.history.transcript); }
  }, [page, view.history]);
  useEffect(() => {
    if (!page || !entry || view.status !== 'ready' || disconnected) return;
    const history = { ok: true as const, entry, transcript: page };
    if (JSON.stringify(history).length < 500_000 && JSON.stringify(view.history) !== JSON.stringify(history)) void recovery.saveComposition({ history });
  }, [page, entry, view.status, view.history, disconnected, recovery]);
  useEffect(() => {
    if (!originalId || disconnected) { setLoading(false); return; }
    let alive = true;
    setLoading(true); setError(undefined);
    void access.history.readConversation(originalId).then(result => {
      if (!alive) return;
      if (result.ok) { setEntry(result.entry); setPage(result.transcript); }
      else setError(result.message);
    }).catch(() => { if (alive) setError(text('이전 대화를 읽을 수 없습니다. 다시 시도하세요.', 'Could not read this conversation. Retry.')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [access, originalId, disconnected, revision, text]);

  // Tool activity keeps its name and target so the chat can show it like a live session.
  const items = useMemo<DaemonTranscriptItem[]>(
    () => historyTranscriptItems(page, identity, new Date(entry?.createdAt ?? 0).toISOString()),
    [page, identity, entry?.createdAt],
  );
  const loadEarlier = async (): Promise<void> => {
    if (!entry || !page?.nextCursor || earlier) return;
    setEarlier(true);
    try {
      const result = await access.history.readConversation(entry.conversationId, page.nextCursor);
      if (result.ok) {
        // The chat viewport keeps the reader's place when rows are prepended.
        setPage(current => ({ ...result.transcript, turns: [...result.transcript.turns, ...(current?.turns ?? [])] }));
      } else setError(result.message);
    } catch { setError(text('이전 메시지를 불러오지 못했습니다. 다시 시도하세요.', 'Could not load earlier messages. Retry.')); }
    finally { setEarlier(false); }
  };
  const finish = useCallback(async (sessionId: string): Promise<void> => {
    const authority = await access.getSnapshot();
    const session = authority?.sessions.find(item => item.id === sessionId);
    if (!session) throw new Error(text('대화가 준비됐지만 연결을 확인하지 못했습니다. 다시 확인하세요.', 'The conversation is ready. Reconnect to open it.'));
    // Transfer any newer edits before replacing this view. Never overwrite an existing live draft.
    const liveScope = { projectId: session.projectId, sessionId };
    const live = await storage.chatStateRead(liveScope);
    if (!live.ok) throw new Error(live.message);
    const draft = recovery.getSnapshot().draft;
    const hasDraft = hasConversationDraft(draft);
    const hasLiveDraft = hasConversationDraft(live.snapshot.state.draft);
    if (hasDraft && hasLiveDraft && JSON.stringify(draft) !== JSON.stringify(live.snapshot.state.draft))
      throw new Error(text('열린 대화에도 초안이 있습니다. 지금 작성한 내용을 보관한 뒤 다시 확인하세요.', 'The open conversation also has a draft. Keep your current edits before checking again.'));
    if (!hasLiveDraft && !live.snapshot.state.pendingSubmit) {
      const saved = await storage.chatStateWrite(liveScope, { expectedRevision: live.snapshot.revision, state: { ...live.snapshot.state, draft: recovery.getSnapshot().draft } });
      if (!saved.ok) throw new Error(saved.message);
    }
    // A plan started here runs, once approved, with the access level chosen here.
    movePlanAccess(identity, sessionId);
    const resolved = await access.history.resolveConversation?.({ kind: 'session', id: sessionId });
    await onStarted(sessionId, resolved?.ok ? resolved.entry : entry);
    recovery.updateDraft({ text: '' });
    await recovery.saveComposition({ start: undefined });
  }, [access, storage, recovery, entry, text, onStarted, identity]);
  const send: StructuredAgentSessionPanelPropsSend = async (prompt, context) => {
    setBusy(true); setError(undefined);
    try {
      const result = await controller.send(settings, prompt, context, entry?.conversationId);
      if (result.ok) { await finish(result.sessionId); return { ok: true }; }
      setError(result.message); return result;
    } catch (reason) { const message = String(reason); setError(message); return { ok: false, message, deliveryUncertain: true }; }
    finally { setBusy(false); }
  };
  const retry = () => { const pending = view.start; return send(pending?.prompt ?? view.draft.text, pending?.context); };
  useEffect(() => {
    const pending = view.start;
    if (!pending?.accepted || !pending.sessionId || acceptedRestore.current === pending.id || disconnected || busy) return;
    acceptedRestore.current = pending.id;
    if (view.draft.text.trim() === pending.prompt && JSON.stringify(view.draft.attachments ?? []) === JSON.stringify(pending.context?.attachments ?? [])
      && JSON.stringify(view.draft.replyTo) === JSON.stringify(pending.context?.replyTo) && JSON.stringify(view.draft.skills ?? []) === JSON.stringify(pending.context?.skills ?? [])) recovery.updateDraft({ text: '' });
    void finish(pending.sessionId).catch(reason => setError(String(reason)));
  }, [view.start, view.draft, disconnected, busy, recovery, finish]);
  const settingsControls = <div className="conversation-start__settings">
    {!entry && profiles.length > 0 && <Field label={text('프로필', 'Profile')} description={activeProfile?.whenToUse}>
      <Select aria-label={text('에이전트 프로필', 'Agent profile')} value={activeProfile?.id ?? ''} disabled={busy || !!view.start} data-testid="conversation-start-profile"
        onChange={event => {
          const profile = profiles.find(entry => entry.id === event.target.value);
          if (profile) void recovery.saveComposition({ settings: { ...settings, providerId: profile.providerId, model: profile.model,
            permissionPreset: profile.permissionPreset, reasoningEffort: profile.reasoningEffort } });
        }}>
        <option value="">{text('직접 고르기', 'Choose yourself')}</option>
        {profiles.map(profile => <option key={profile.id} value={profile.id} disabled={!providers.some(provider => provider.id === profile.providerId && !provider.disabled)}>{profile.name}</option>)}
      </Select></Field>}
    {!entry && <><Field label={text('AI', 'AI')}><Select aria-label={text('대화 AI', 'Conversation AI')} value={settings.providerId} disabled={busy || !!view.start}
      onChange={event => void recovery.saveComposition({ settings: { ...settings, providerId: event.target.value, model: undefined, reasoningEffort: undefined } })}>
      {!settings.providerId && <option value="">{text('AI 선택', 'Choose AI')}</option>}{providers.map(provider => <option key={provider.id} value={provider.id} disabled={provider.disabled}>{provider.label}</option>)}
    </Select></Field><Field label={text('작업 위치', 'Working folder')}><Select aria-label={text('대화 작업 위치', 'Conversation workspace')} value={settings.workspaceId} disabled={busy || !!view.start}
      onChange={event => {
        if (event.target.value === NEW_WORKTREE) { setWorktreeOpen(true); return; }
        void recovery.saveComposition({ settings: { ...settings, workspaceId: event.target.value } });
      }}>
      {!settings.workspaceId && <option value="">{text('프로젝트 선택', 'Choose project')}</option>}{workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
      {worktreeAccess && worktreeProject && !disconnected && <option value={NEW_WORKTREE}>{text('새 워크트리…', 'New worktree…')}</option>}
    </Select></Field></>}
    {worktreeAccess && worktreeProject && <NewWorktreeDialog open={worktreeOpen} onOpenChange={setWorktreeOpen} projectName={worktreeProject.name}
      createLabel={text('만들기', 'Create')}
      onCreate={async branch => {
        const created = await worktreeAccess.create(worktreeProject.id, branch);
        if (created.ok) void recovery.saveComposition({ settings: { ...settings, workspaceId: created.value.workspaceId } });
        return created;
      }} />}
    {(!providers.length || selectedProvider?.disabled) && onOpenSettings && <Button variant="ghost" onClick={onOpenSettings}>{text('AI 설정 열기', 'Open AI settings')}</Button>}
    {error && <p role="alert">{error}</p>}
    {draftLoadFailed && <Button variant="ghost" onClick={() => setDraftRevision(value => value + 1)}>{text('이전 초안 다시 확인', 'Retry previous draft recovery')}</Button>}
    {inheritedPending && <Button variant="ghost" disabled={busy || disconnected} onClick={() => void checkInherited()}>{text('이전 전송 상태 확인', 'Check previous message delivery')}</Button>}
    {!!view.start && !busy && <Button variant="ghost" onClick={() => void retry()} disabled={disconnected}>{text('전송 상태 확인 · 다시 시도', 'Check delivery / retry')}</Button>}
    {!!view.start && !view.start.create && !view.start.resume && !view.start.sessionId && !view.start.submit && !busy && <Button variant="ghost" onClick={() => void recovery.saveComposition({ start: undefined })}>{text('메시지와 설정 수정', 'Edit message and settings')}</Button>}
  </div>;
  return <div ref={host} className="conversation-start" data-testid="conversation-start" aria-busy={busy || undefined}>
    <StructuredAgentSessionPanel sessionId={identity} viewStateKey={`${viewStateScope}:conversation:${identity}`} title={entry?.title ?? text('새 대화', 'New conversation')}
      providerId={settings.providerId} providerLabel={selectedProvider?.label ?? entry?.providerId ?? 'AI'}
      workspace={selectedWorkspace ?? { id: settings.workspaceId, label: entry?.projectTitle ?? text('프로젝트', 'Project'), kind: 'local', path: entry?.roots[0] }}
      model={settings.model} modelOptions={selectedProvider?.models} permissionPreset={settings.permissionPreset} state="idle" items={items}
      statusLabel={busy ? text('메시지 준비 중…', 'Preparing message…') : entry ? text('기록 · 전송하면 이어집니다', 'History · send to continue') : text('첫 메시지를 입력하세요', 'Write your first message')}
      awaitingFirstMessage={!entry} transcriptLoading={loading} transcriptError={page ? null : error} onRetryTranscript={() => setRevision(value => value + 1)}
      disabled={busy} allowDraftWhenDisabled draftState={view.draft} onDraftChange={recovery.updateDraft}
      sendDisabled={!canSend || !!view.start} sendDisabledReason={!canSend ? disconnected ? text('오프라인 · 초안은 보존됩니다', 'Offline · draft retained')
        : selectedProvider?.disabled ? text('PC의 AI 설정을 준비하면 이 대화에서 이어갈 수 있습니다.', 'Prepare this provider in PC settings to continue here.')
        : entry && source === undefined ? text('이 대화의 이전 설정을 확인하는 중…', 'Checking this conversation’s settings…')
        : text('AI와 작업 위치를 확인하세요', 'Check AI and working folder') : undefined}
      onSend={send} supportsMessageContext capabilityClient={capabilityClient} capabilitySessionId={null} variant={variant} onOpenHistory={onOpenHistory}
      onChangeSettings={async next => recovery.saveComposition({ settings: { ...settings, ...next } })}
      workflowContext={settingsControls} recoveryControl={<ChatRecoveryNotice controller={recovery} view={view} />}
      hasEarlier={!!page?.nextCursor && !disconnected} loadingEarlier={earlier} onLoadEarlier={() => void loadEarlier()}
      beforeMessages={<>
        {entry?.historyId && onReviewChange && page?.turns.some(turn => turn.entries.some(item => item.type === 'activity' && item.changedPaths?.length)) &&
          <details className="conversation-history__changes"><summary>{text('기록의 변경 파일 검토', 'Review recorded file changes')}</summary>
            {page.turns.flatMap(turn => turn.entries.flatMap(item => item.type === 'activity' ? (item.changedPaths ?? []).map(path =>
              <Button key={`${turn.id}:${item.id}:${path}`} variant="ghost" size="sm" disabled={disconnected}
                onClick={() => void onReviewChange(entry, turn.id, path).catch(reason => setError(String(reason)))}>{path}</Button>) : []))}
          </details>}
      </>}
      headerActions={entry?.historyId && onContinueCli ? <details className="conversation-start__menu"><summary aria-label={text('대화 메뉴', 'Conversation menu')}>···</summary><Button variant="ghost" disabled={busy || disconnected} onClick={() => void onContinueCli(entry).catch(reason => setError(String(reason)))}>{text('터미널에서 이어가기', 'Continue in terminal')}</Button></details> : undefined}
    />
  </div>;
}

type StructuredAgentSessionPanelPropsSend = (prompt: string, context?: import('../shared/chat-message').ChatMessageContext) => Promise<StructuredAgentUiResult>;
