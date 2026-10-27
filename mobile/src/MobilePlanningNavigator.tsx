import { Glyph } from '../../src/renderer/ui';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PlanningWorkspacePanel } from '../../src/renderer/PlanningWorkspacePanel';
import { WorkflowWorkspacePanel } from '../../src/renderer/workflow/WorkflowWorkspacePanel';
import { ProjectConversationTree } from '../../src/renderer/ProjectConversationTree';
import { useProjectConversationNavigation } from '../../src/renderer/use-project-conversation-navigation';
import type { ConversationEntry } from '../../src/shared/conversation-history';
import { attachedChildSessionIds } from '../../src/shared/daemon-session-visibility';
import { useAppTranslation } from '../../src/renderer/i18n';
import { MobilePageHeader } from './MobilePageHeader';
import { useMobileNavigationHistory } from './MobileNavigationHistory';
import { mobilePlanningDraftStorage } from './mobile-planning-draft-store';
import { MobileChatStateStore } from './mobile-chat-state-store';
import { mobileAgentCreateAuthorityFingerprint } from './mobile-agent-create-recovery-store';
import { mobileWorkflowDraftAccess } from './mobile-workflow-draft-store';
import { saveDownloadToDevice } from './download-storage';
import { mobileProjectArchiveAccess } from './mobile-project-archive';
import type { MobileWorkspaceTerminalResult } from './workspace-terminal';
import type { DaemonRuntimeViewState, WsEzTerminalTransport } from './transport/ws-ezterminal';
import './mobile-v2.css';

export interface MobilePlanningNavigatorProps {
  readonly state: DaemonRuntimeViewState;
  readonly transport: Pick<WsEzTerminalTransport, 'getPlanningSnapshot' | 'executePlanningCommand' | 'getDaemonSnapshot' | 'getRemoteToken' | 'getPlanningExecutionSnapshot' | 'executePlanningRun' | 'listDaemonProviderModels' | 'executeProjectArchive' | 'executePlanningAsset' | 'uploadFile' | 'downloadFile' | 'planningAiRequest'> & Partial<Pick<WsEzTerminalTransport, 'getWorkflowSnapshot' | 'executeWorkflowCommand' | 'sendDaemonCommand' | 'agentCapabilitiesList' | 'agentCapabilitiesManage' | 'workflowPreview' | 'listConversations' | 'getWorkflowNavigation'>>;
  readonly connected: boolean;
  readonly mode: 'projects' | 'tasks';
  readonly projectId: string | null;
  readonly onSelectProject: (projectId: string | null) => void;
  readonly onOpenChat: (sessionId?: string) => void;
  readonly onOpenConversationHistory?: (entry: ConversationEntry) => void;
  readonly onOpenHistory?: (projectId: string) => void;
  readonly onOpenTerminal: (workspaceId?: string) => void | Promise<MobileWorkspaceTerminalResult>;
  readonly onOpenFiles: () => void;
  readonly onOpenPcControl: () => void;
  readonly active?: boolean;
  readonly navigationTarget?: { readonly subprojectId: string; readonly nodeId?: string; readonly key: string };
}

/** One project list, then the same project workspace used on Windows. */
export function MobilePlanningNavigator({ state, transport, connected, mode, projectId, onSelectProject, onOpenChat, onOpenConversationHistory, onOpenHistory, onOpenTerminal, onOpenFiles, onOpenPcControl, active = true, navigationTarget }: MobilePlanningNavigatorProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const ko = (i18n.resolvedLanguage ?? i18n.language).startsWith('ko');
  const projects = state.snapshot?.projects.filter(project => project.archivedAt === undefined) ?? [];
  const project = projects.find(entry => entry.id === projectId);
  const navigation = useMobileNavigationHistory();
  const layerId = useId();
  const [terminalError, setTerminalError] = useState(false);
  const [authorityScope, setAuthorityScope] = useState<string | null>(null);
  const [treeTarget, setTreeTarget] = useState<{ projectId: string; subprojectId: string; nodeId?: string; key: string }>();
  const projectListBody = useRef<HTMLDivElement>(null);
  const scrollRestore = useRef<{ key: string; target: number | null }>({ key: '', target: null });
  useEffect(() => {
    let alive = true;
    setAuthorityScope(null);
    if (typeof transport.getRemoteToken !== 'function') return;
    void transport.getRemoteToken().then(mobileAgentCreateAuthorityFingerprint).then(scope => { if (alive) setAuthorityScope(scope); }).catch(() => undefined);
    return () => { alive = false; };
  }, [transport]);
  useEffect(() => { setTreeTarget(undefined); }, [navigationTarget?.key]);
  const navigationProjects = useMemo(() => (state.snapshot?.projects ?? []).filter(item => !item.archivedAt).map(item => ({ id: item.id, title: item.name, rootPath: item.rootPath, updatedAt: Date.parse(item.updatedAt) })), [state.snapshot?.projects]);
  const navigationAccess = useMemo(() => ({ listConversations: transport.listConversations?.bind(transport), getWorkflowNavigation: transport.getWorkflowNavigation?.bind(transport) }), [transport]);
  const conversationNavigation = useProjectConversationNavigation({ projects: navigationProjects, snapshot: state.snapshot, access: navigationAccess, scope: authorityScope ?? 'mobile-unresolved', connected: connected && Boolean(authorityScope), active: active && !project });
  useLayoutEffect(() => {
    if (project || !authorityScope) { scrollRestore.current.key = ''; return; }
    const key = `ezterminal:mobile-project-list-scroll:${authorityScope}`;
    if (scrollRestore.current.key !== key) {
      let target = 0;
      try { target = Number(window.localStorage.getItem(key)) || 0; } catch { /* Local presentation state is optional. */ }
      scrollRestore.current = { key, target: Number.isFinite(target) ? Math.max(0, target) : 0 };
    }
    const body = projectListBody.current;
    const target = scrollRestore.current.target;
    if (body && target !== null) {
      body.scrollTop = target;
      if (body.scrollTop >= target) scrollRestore.current.target = null;
    }
  }, [project, authorityScope, conversationNavigation.nodes, active]);
  const draftStores = useMemo(() => ({ projectId, transport, stores: new Map<string, ReturnType<typeof mobilePlanningDraftStorage>>() }), [projectId, transport]).stores;
  const workflowAccess = useMemo(() => ({ workflowPreview: transport.workflowPreview?.bind(transport), getWorkflowSnapshot: (id: string) => transport.getWorkflowSnapshot?.(id) ?? Promise.resolve({ ok: false as const, error: 'unsupported', message: ko ? '소프로젝트를 사용하려면 PC를 업데이트하세요.' : 'Update the PC to use subprojects.' }), executeWorkflowCommand: (command: Parameters<WsEzTerminalTransport['executeWorkflowCommand']>[0]) => transport.executeWorkflowCommand?.(command) ?? Promise.resolve({ ok: false as const, error: 'unsupported', message: ko ? '호스트가 흐름 편집을 지원하지 않습니다.' : 'This host does not support workflow editing.' }) }), [transport, ko]);
  const daemonAccess = useMemo(() => transport.sendDaemonCommand ? { getDaemonSnapshot: () => transport.getDaemonSnapshot(), listDaemonProviderModels: (providerId: string) => transport.listDaemonProviderModels(providerId), sendDaemonCommand: (command: Parameters<NonNullable<typeof transport.sendDaemonCommand>>[0]) => transport.sendDaemonCommand!(command) } : undefined, [transport]);
  const capabilityClient = useMemo(() => transport.agentCapabilitiesList && transport.agentCapabilitiesManage ? { list: transport.agentCapabilitiesList.bind(transport), manage: transport.agentCapabilitiesManage.bind(transport) } : undefined, [transport]);
  const recoveryAccess = useMemo(() => mobileWorkflowDraftAccess(() => transport.getRemoteToken()), [transport]);
  const archiveAccess = useMemo(() => mobileProjectArchiveAccess(transport), [transport]);
  const hasProject = Boolean(project);
  useEffect(() => {
    if (!hasProject || !active) return;
    return navigation.pushLayer({ id: layerId, kind: 'page', onBack: () => onSelectProject(null) });
  }, [hasProject, active, layerId, navigation, onSelectProject]);
  const workspace = state.snapshot?.workspaces.find(entry => entry.projectId === projectId && entry.archivedAt === undefined && entry.kind === 'local');
  const offlineReason = ko ? '오프라인 · 마지막으로 받은 내용을 표시합니다. PC에 다시 연결해야 기획을 저장할 수 있습니다.' : 'Offline · Showing the last received state. Reconnect to the PC to save planning changes.';
  const openProjectTerminal = async (): Promise<void> => {
    if (!workspace || !connected) return;
    setTerminalError(false);
    try { const result = await onOpenTerminal(workspace.id); if (result && !result.ok) setTerminalError(true); }
    catch { setTerminalError(true); }
  };
  if (project) return <main className="mob-page mobile-v2" data-testid={`mobile-${mode}-workspace`}>
    {terminalError && <p role="alert">{ko ? '프로젝트의 터미널을 열지 못했습니다. PC의 프로젝트 상태를 확인하고 다시 시도하세요.' : 'Could not open the project terminal. Check the project on the PC and retry.'}</p>}
    <WorkflowWorkspacePanel projectId={project.id} projectName={project.name} access={workflowAccess} daemonAccess={daemonAccess} mobile active={active}
      navigationTarget={treeTarget?.projectId === project.id ? treeTarget : navigationTarget}
      capabilityClient={capabilityClient}
      recoveryAccess={recoveryAccess}
      onSeedConversationDraft={async (sessionId, draft) => {
        const store = new MobileChatStateStore();
        const scope = { projectId: project.id, sessionId, authorityFingerprint: await mobileAgentCreateAuthorityFingerprint(await transport.getRemoteToken()) };
        const saved = await store.load(scope);
        if (saved?.draft.text && saved.draft.text !== draft.text) throw new Error('A draft already exists in this conversation. It was preserved.');
        await store.save({ schemaVersion: 1, scope, ...saved, draft });
      }}
      disabled={!connected} disabledReason={offlineReason}
      onBack={() => navigation.closeLayer(layerId, 'ui')}
      onNewConversation={() => onOpenChat()}
      onNewTerminal={connected && workspace ? () => void openProjectTerminal() : undefined}
      onOpenConversation={onOpenChat}
      onOpenHistory={onOpenHistory ? () => onOpenHistory(project.id) : undefined}
      conversations={(state.snapshot?.sessions ?? []).filter(session => session.projectId === project.id && session.kind === 'agent' && session.source === 'structured' && session.archivedAt === undefined && !attachedChildSessionIds(state.snapshot?.agentRelations ?? []).has(session.id)).map(session => ({ id: session.id, title: session.title, status: state.snapshot?.agents.find(agent => agent.sessionId === session.id)?.state, workspaceLabel: state.snapshot?.workspaces.find(entry => entry.id === session.workspaceId)?.name }))}
      renderPlanning={(subproject, section, runId) => {
        const key = subproject?.id ?? '';
        if (!draftStores.has(key)) draftStores.set(key, mobilePlanningDraftStorage(project.id, () => transport.getRemoteToken(), undefined, subproject?.id));
        return <PlanningWorkspacePanel projectId={project.id} projectName={subproject?.title ?? project.name} subprojectId={subproject?.id} access={transport} mobile
      executionAccess={transport}
      archiveAccess={archiveAccess} assetApi={transport} aiAccess={transport}
      disabled={!connected} disabledReason={offlineReason}
      draftStorage={draftStores.get(key)}
      onExportScene={(name, content) => saveDownloadToDevice(name, new TextEncoder().encode(content)).then(() => undefined)}
      initialSection={section ?? (mode === 'tasks' ? 'tasks' : 'overview')}
      initialRunId={runId}
      onBack={() => navigation.closeLayer(layerId, 'ui')}
      onNewConversation={() => onOpenChat()}
      conversations={(state.snapshot?.sessions ?? []).filter(session => session.projectId === project.id && session.kind === 'agent' && session.source === 'structured' && session.archivedAt === undefined && !attachedChildSessionIds(state.snapshot?.agentRelations ?? []).has(session.id)).map(session => ({
        id: session.id, title: session.title,
        status: state.snapshot?.agents.find(agent => agent.sessionId === session.id)?.state,
        workspaceLabel: state.snapshot?.workspaces.find(entry => entry.id === session.workspaceId)?.name,
      }))}
      onOpenConversation={onOpenChat}
      onOpenTerminal={connected && workspace ? () => void openProjectTerminal() : undefined}
      onOpenFiles={connected ? onOpenFiles : undefined}
    />;
      }}
    />
  </main>;
  return <main className="mob-page mobile-v2" data-testid={`mobile-${mode}-navigator`}>
    <MobilePageHeader title={mode === 'tasks' ? (ko ? '작업' : 'Tasks') : t('agentHub.projects.title')} backLabel={t('common.back')} onBack={() => onOpenTerminal()}
      actions={<button type="button" className="mob-icon-btn" aria-label={t('common.retry')} disabled={!connected} onClick={() => { void transport.getDaemonSnapshot(); }}><Glyph name="refresh" /></button>} />
    <div className="mob-page__body mobile-v2__body" ref={projectListBody}
      onWheel={() => { scrollRestore.current.target = null; }} onTouchMove={() => { scrollRestore.current.target = null; }}
      onScroll={event => { if (authorityScope && scrollRestore.current.target === null) try { window.localStorage.setItem(`ezterminal:mobile-project-list-scroll:${authorityScope}`, String(event.currentTarget.scrollTop)); } catch { /* Navigation is usable without persistence. */ } }}>
      {!connected && <p className="mobile-v2__notice" role="status">{offlineReason}</p>}
      {terminalError && <p role="alert">{ko ? '프로젝트의 터미널을 열지 못했습니다. 다시 시도하세요.' : 'Could not open the project terminal. Try again.'}</p>}
      <div className="mobile-v2__actions"><button type="button" className="mob-btn-ghost" data-testid="mobile-project-pc-control" onClick={onOpenPcControl}><Glyph name="pc" />{t('mobile.tabs.pc')}</button><button type="button" className="mob-btn-ghost" onClick={() => onOpenTerminal()}><Glyph name="term" />{t('mobile.terminal')}</button></div>
      {authorityScope ? <ProjectConversationTree nodes={conversationNavigation.nodes} persistenceScope={`mobile:${authorityScope}`} mobile offline={!connected} loading={state.status === 'loading'}
        renderProjectActions={targetProjectId => <>
          <button type="button" className="mob-btn-ghost" disabled={!connected} aria-label={`${ko ? '새 대화' : 'New conversation'}: ${projects.find(item => item.id === targetProjectId)?.name ?? ''}`}
            onClick={() => { onSelectProject(targetProjectId); onOpenChat(); }}>{ko ? '새 대화' : 'New chat'}</button>
          <button type="button" className="mob-btn-ghost" disabled={!connected || !state.snapshot?.workspaces.some(item => item.projectId === targetProjectId && !item.archivedAt)}
            aria-label={`${ko ? '새 터미널' : 'New terminal'}: ${projects.find(item => item.id === targetProjectId)?.name ?? ''}`}
            onClick={() => {
              setTerminalError(false);
              const target = state.snapshot?.workspaces.find(item => item.projectId === targetProjectId && !item.archivedAt);
              if (target) void Promise.resolve(onOpenTerminal(target.id)).then(result => { if (result && !result.ok) setTerminalError(true); }).catch(() => setTerminalError(true));
            }}>{ko ? '새 터미널' : 'Terminal'}</button>
        </>}
        projectStatus={conversationNavigation.projectStatus} searchStatus={conversationNavigation.searchStatus}
        onInspectProject={conversationNavigation.inspectProject} onCollapseProject={conversationNavigation.collapseProject} onSearchAll={conversationNavigation.searchAll}
        onLoadMore={conversationNavigation.loadMore} onLoadMoreSearch={conversationNavigation.loadMoreSearch}
        onOpen={target => {
          if (target.kind === 'conversation') {
            if (target.sessionId) onOpenChat(target.sessionId);
            else { const entry = conversationNavigation.entries.get(target.conversationId); if (entry) onOpenConversationHistory?.(entry); }
          } else if (target.kind === 'project') { setTreeTarget(undefined); onSelectProject(target.projectId); }
          else if (target.kind === 'subproject' || target.kind === 'stage') {
            setTreeTarget({ projectId: target.projectId, subprojectId: target.subprojectId, nodeId: target.kind === 'stage' ? target.nodeId : undefined, key: crypto.randomUUID() });
            onSelectProject(target.projectId);
          }
        }} /> : <ul className="mob-daemon-nav__list">{projects.map(entry => <li key={entry.id}><button type="button" className="mob-daemon-nav__row" data-testid="mobile-planning-project" onClick={() => onSelectProject(entry.id)}><Glyph name="proj" /><span><strong>{entry.name}</strong><small>{entry.rootPath}</small></span><Glyph name="next" /></button></li>)}</ul>}
      {projects.length === 0 && <p role="status">{state.status === 'loading' ? t('common.loading') : ko ? '프로젝트가 없습니다. PC에서 프로젝트를 추가하세요.' : 'No projects yet. Add a project on your PC.'}</p>}
    </div>
  </main>;
}
