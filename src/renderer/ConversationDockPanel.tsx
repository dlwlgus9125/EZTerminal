import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ConversationEntry } from '../shared/conversation-history';
import type { ConversationFolders } from '../shared/conversation-folders';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { ConversationStartPanel } from './ConversationStartPanel';
import { rendererCapabilities } from './capability-access';
import { structuredAgentSessionId, structuredAgentSessionHistoryId, STRUCTURED_AGENT_DRAFT_PREFIX } from './StructuredAgentDockPanel';
import type { ConversationStartAccess } from './conversation-start';
import { Button } from './ui';
import { useAppTranslation } from './i18n';

export function ConversationDockPanel({ props, renderLive, onOpenHistory, onOpenSettings, onContinueCli, onReviewChange, onEditProject }: {
  props: IDockviewPanelProps;
  renderLive: (sessionId: string, conversationId?: string) => ReactNode;
  onOpenHistory?: (projectId?: string) => void;
  onOpenSettings?: () => void;
  onContinueCli?: (entry: ConversationEntry) => Promise<void>;
  onReviewChange?: (entry: ConversationEntry, turnId: string, path: string) => Promise<void>;
  onEditProject?: (projectId: string) => void;
}): JSX.Element {
  const id = String(props.params?.historyId ?? '');
  const params = useRef(props.params); params.current = props.params;
  const isDraft = id.startsWith(STRUCTURED_AGENT_DRAFT_PREFIX);
  const [entry, setEntry] = useState<ConversationEntry>();
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const { i18n } = useAppTranslation();
  const access = useMemo<ConversationStartAccess>(() => ({ history: window.ezterminal,
    getSnapshot: () => window.ezterminal.getDaemonSnapshot(), sendCommand: command => window.ezterminal.sendDaemonCommand(command), principal: { kind: 'desktop', id: 'renderer-agent-ui' } }), []);
  const storage = useMemo(() => ({ chatStateRead: window.ezterminal.chatStateRead, chatStateWrite: window.ezterminal.chatStateWrite }), []);
  const capabilityClient = useMemo(() => ({ list: window.ezterminal.agentCapabilitiesList, manage: window.ezterminal.agentCapabilitiesManage }), []);
  useEffect(() => {
    let alive = true;
    setReady(false); setError(undefined);
    void (async () => {
      const next = await access.getSnapshot();
      if (!alive) return;
      setSnapshot(next);
      if (!isDraft) {
        const sessionId = structuredAgentSessionId(id);
        const result = await access.history.resolveConversation?.(sessionId ? { kind: 'session', id: sessionId }
          : { kind: id.startsWith('conversation_') ? 'conversation' : 'history', id });
        if (!alive) return;
        if (!result?.ok) { setError(result?.message ?? 'The conversation could not be resolved.'); return; }
        setEntry(result.entry);
        props.api.updateParameters({ ...params.current, conversationId: result.entry.conversationId });
        props.api.setTitle(result.entry.title);
        window.dispatchEvent(new Event('ez:conversation-navigation'));
      }
      setReady(true);
    })().catch(reason => { if (alive) setError(String(reason)); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = rendererCapabilities.daemon.observeEvents((event) => {
      // Streamed transcript appends do not change session state; only entity/approval events do.
      if (event.kind === 'transcript.appended' || timer) return;
      timer = setTimeout(() => { timer = undefined; void access.getSnapshot().then(next => { if (alive) setSnapshot(next); }).catch(() => undefined); }, 200);
    });
    return () => { alive = false; if (timer) clearTimeout(timer); unsubscribe(); };
  }, [id, isDraft, access, revision, props.api]);
  const liveState = snapshot?.sessions.find(session => session.id === entry?.linkedSessionId)?.state;
  // The folders each workspace of the project would bring, for the start form's folder setting.
  // Asked again whenever the project's workspaces change (folders added, removed or moved).
  const readFolders = window.ezterminalDesktop?.getConversationFolders;
  const folderProjectId = entry?.projectId ?? props.params?.projectId;
  const folderTargetsKey = useMemo(() => JSON.stringify((snapshot?.workspaces ?? [])
    .filter(workspace => !workspace.archivedAt && (!folderProjectId || workspace.projectId === folderProjectId))
    .map(workspace => [workspace.projectId, workspace.id, workspace.rootPath])), [snapshot, folderProjectId]);
  const [folders, setFolders] = useState<Readonly<Record<string, ConversationFolders>>>({});
  useEffect(() => {
    const targets = JSON.parse(folderTargetsKey) as readonly (readonly [string, string, string])[];
    if (!readFolders || targets.length === 0) return undefined;
    let alive = true;
    void Promise.all(targets.map(async ([targetProjectId, workspaceId]) => (
      [workspaceId, await readFolders({ projectId: targetProjectId, workspaceId }).catch(() => null)] as const
    ))).then(found => {
      if (alive) setFolders(Object.fromEntries(found.filter((pair): pair is readonly [string, ConversationFolders] => pair[1] !== null)));
    });
    return () => { alive = false; };
  }, [readFolders, folderTargetsKey]);
  useEffect(() => {
    if (entry?.action === 'open' && liveState && ['completed', 'interrupted', 'failed', 'archived'].includes(liveState)) setRevision(value => value + 1);
  }, [entry?.action, liveState]);
  if (error || !ready) return <div className="structured-agent__banner" role="status"><p>{error ?? (i18n.language.startsWith('ko') ? '대화를 여는 중…' : 'Opening conversation…')}</p>{error && <Button onClick={() => setRevision(value => value + 1)}>{i18n.language.startsWith('ko') ? '다시 시도' : 'Retry'}</Button>}</div>;
  if (!isDraft && entry?.action === 'open' && entry.linkedSessionId) return <>{renderLive(entry.linkedSessionId, entry.conversationId)}</>;
  return <ConversationStartPanel key={id} identity={entry?.conversationId ?? id} entry={isDraft ? undefined : entry}
    projectId={props.params?.projectId} workspaceId={props.params?.workspaceId} {...(isDraft && props.params?.conversationSeed ? { seed: props.params.conversationSeed } : {})}
    {...(isDraft && typeof props.params?.conversationDraftText === 'string' ? {
      seedDraftText: props.params.conversationDraftText,
      // One-shot: once the draft holds it, a restored layout must not put it back.
      onSeedDraftApplied: () => props.api.updateParameters({ ...params.current, conversationDraftText: undefined }),
    } : {})}
    snapshot={snapshot} access={access} storage={storage} capabilityClient={capabilityClient}
    {...(readFolders ? { workspaceFolders: (workspaceId: string) => folders[workspaceId] } : {})} onEditProject={onEditProject}
    onOpenHistory={() => onOpenHistory?.(entry?.projectId ?? props.params?.projectId)} onOpenSettings={onOpenSettings} onContinueCli={onContinueCli} onReviewChange={onReviewChange}
    onStarted={(sessionId, resolved) => {
      props.api.updateParameters({ ...props.params, historyId: structuredAgentSessionHistoryId(sessionId), ...(resolved ? { conversationId: resolved.conversationId } : {}) });
      if (resolved) { setEntry(resolved); props.api.setTitle(resolved.title); }
      window.dispatchEvent(new Event('ez:conversation-navigation'));
    }} />;
}
