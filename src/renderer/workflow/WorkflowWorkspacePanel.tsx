import { ArrowLeft, Archive, CheckCheck, ClipboardList, Copy, FolderKanban, History, MessageSquare, MessageSquarePlus, MoreHorizontal, Play, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { WORKFLOW_LAUNCH_CAPABILITY, WorkflowCommandSchema, createWorkflowGraph, validateWorkflowGraph, workflowPresets, type WorkflowAccess, type WorkflowCommand, type WorkflowGraph, type WorkflowPresetId, type WorkflowSnapshot, type WorkflowSubproject } from '../../shared/workflow';
import type { DaemonCommandReceipt, DaemonSnapshot } from '../../shared/daemon-protocol';
import type { DaemonProviderManagementResult, ProviderModel } from '../../shared/daemon-provider';
import type { AgentCapabilitiesClient } from '../../shared/agent-capabilities';
import type { ChatComposerDraft } from '../../shared/chat-message';
import { ChatComposerDraftSchema } from '../../shared/chat-state';
import { WorkflowDraftResultSchema, type WorkflowDraftAccess, type WorkflowDraftState } from '../../shared/workflow-draft';
import { blockingRunOf } from '../../shared/planning-execution';
import { WorkflowRecovery } from './workflow-recovery';
import type { PlanningConversation, PlanningWorkspaceSection } from '../PlanningWorkspacePanel';
import { StructuredAgentDraftPanel, type StructuredAgentDraftFormState, type StructuredAgentDraftInput, type StructuredAgentUiResult } from '../StructuredAgentSession';
import { createStructuredAgentSession, structuredAgentProviderOptions, structuredAgentWorkspaceOptions, type StructuredAgentCreateCommand } from '../structured-agent-create';
import { Badge, Button, Dialog, Field, IconButton, Input, LoadingState, Menu, MenuItem, MenuSeparator, Select, Switch } from '../ui';
import { useWorkflowCopy, workflowOperationLabel, workflowOutcomeLabel, workflowPermissionLabel } from './workflow-copy';
import { WorkflowFlowSurface } from './WorkflowFlowSurface';
import { pageFromSection, sectionFromPage, workflowLayoutOnlyChange } from './workflow-canvas-model';
import type { WorkflowCanvasRendererProps } from './workflow-canvas-types';
import { PlanningResultDetails, type PlanningResultReader, type PlanningResultSelection } from '../PlanningResultDetails';
import { useAgentStateLabel } from '../agent-state-label';
import './workflow.css';

type CommandInput<C = WorkflowCommand> = C extends WorkflowCommand ? Pick<C, 'type' | 'payload'> : never;
type EditDraft = { graph: WorkflowGraph; baseRevision: number };
export interface WorkflowDaemonAccess {
  getDaemonSnapshot(): Promise<DaemonSnapshot | null>;
  sendDaemonCommand(command: StructuredAgentCreateCommand): Promise<DaemonCommandReceipt>;
  listDaemonProviderModels?(providerId: string): Promise<DaemonProviderManagementResult<readonly ProviderModel[]>>;
}
export interface WorkflowWorkspacePanelProps {
  readonly onOpenHistory?: () => void;
  readonly projectId: string;
  readonly projectName: string;
  readonly access: WorkflowAccess;
  readonly daemonAccess?: WorkflowDaemonAccess;
  readonly capabilityClient?: AgentCapabilitiesClient;
  readonly recoveryAccess?: WorkflowDraftAccess;
  readonly onSeedConversationDraft?: (sessionId: string, draft: ChatComposerDraft) => Promise<void>;
  readonly conversations: readonly PlanningConversation[];
  readonly onOpenConversation?: (id: string) => void;
  readonly onNewConversation?: () => void;
  readonly onNewTerminal?: () => void;
  readonly onBack?: () => void;
  /** From a subproject's flow back to the project board (desktop); without it, back to the project items. */
  readonly onBoard?: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly mobile?: boolean;
  readonly active?: boolean;
  /** `launch`: run the flow again (다시 실행) once it is open and can run, once per key. */
  readonly navigationTarget?: { readonly subprojectId: string; readonly nodeId?: string; readonly key: string; readonly launch?: boolean };
  readonly renderPlanning?: (subproject: WorkflowSubproject | null, section?: PlanningWorkspaceSection, runId?: string) => ReactNode;
  /** Desktop injects the React Flow canvas (a lazy chunk); Android and tests draw the static graph. */
  readonly canvasRenderer?: ComponentType<WorkflowCanvasRendererProps>;
  /** Resets the lazy canvas loader after a failed import, so reloading can succeed. */
  readonly onReloadCanvas?: () => void;
  /** Opens attempt results from a stage's run status (desktop reads them from the host). */
  readonly readPlanningResult?: PlanningResultReader;
}

function cleanGraph(graph: WorkflowGraph): WorkflowGraph {
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, acceptance: node.acceptance.map(line => line.trim()).filter(Boolean), allowedPaths: node.allowedPaths.map(line => line.trim()).filter(Boolean) })) };
}
function rebaseUnchangedGraphs(drafts: Record<string, EditDraft>, previous: WorkflowSnapshot | undefined, next: WorkflowSnapshot): Record<string, EditDraft> {
  if (!previous || previous.hostId !== next.hostId || previous.projectId !== next.projectId) return drafts;
  let result = drafts;
  for (const [id, draft] of Object.entries(drafts)) {
    const before = previous.subprojects.find(item => item.id === id);
    const after = next.subprojects.find(item => item.id === id);
    if (before && after && draft.baseRevision === before.revision && before.revision !== after.revision && JSON.stringify(before.graph) === JSON.stringify(after.graph)) {
      if (result === drafts) result = { ...drafts };
      result[id] = { ...draft, baseRevision: after.revision };
    }
  }
  return result;
}
function localizedPreset(id: WorkflowPresetId, text: (ko: string, en: string) => string): string {
  return { feature: text('기능 개발', 'Feature development'), fix: text('문제 수정', 'Issue repair'), research: text('조사', 'Research'), parallel: text('병렬 구현', 'Parallel implementation'), custom: text('직접 구성', 'Custom') }[id];
}
function graphForPreset(id: WorkflowPresetId, prefix: string, text: (ko: string, en: string) => string): WorkflowGraph {
  const graph = createWorkflowGraph(id, prefix);
  const names: Record<string, [string, string]> = { '기획': ['기획', 'Planning'], '문제 분석': ['문제 분석', 'Diagnosis'], '디자인': ['디자인', 'Design'], '구현': ['구현', 'Implementation'], '검토': ['검토', 'Review'], '승인': ['승인', 'Approval'], '완료': ['완료', 'Complete'], '조사': ['조사', 'Research'], '결과 확인': ['결과 확인', 'Review findings'], '병렬 시작': ['병렬 시작', 'Parallel start'], '결과 합류': ['결과 합류', 'Join results'], '화면 구현': ['화면 구현', 'UI implementation'], 'API 구현': ['API 구현', 'API implementation'], '검토 결과': ['검토 결과', 'Review outcome'] };
  return { ...graph, nodes: graph.nodes.map(node => ({ ...node, title: names[node.title] ? text(...names[node.title]) : node.title })) };
}

/** Project items are peers. This surface never infers a general conversation's ownership from selection. */
export function WorkflowWorkspacePanel(props: WorkflowWorkspacePanelProps): JSX.Element {
  return <WorkflowWorkspace key={props.projectId} {...props} />;
}
function WorkflowWorkspace({ projectId, projectName, access, daemonAccess, capabilityClient, recoveryAccess, onSeedConversationDraft, conversations, onOpenConversation, onOpenHistory, onNewConversation, onNewTerminal, onBack, onBoard, disabled = false, disabledReason, mobile = false, active = true, navigationTarget, renderPlanning, canvasRenderer, onReloadCanvas, readPlanningResult }: WorkflowWorkspacePanelProps): JSX.Element {
  const text = useWorkflowCopy();
  const stateLabel = useAgentStateLabel();
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot | null>(null);
  const [authorityReady, setAuthorityReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<WorkflowCommand | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const targetSubproject = navigationTarget?.subprojectId;
  const targetNode = navigationTarget?.nodeId;
  const targetKey = navigationTarget?.key;
  const targetRef = useRef(targetSubproject); targetRef.current = targetSubproject;
  const [view, setView] = useState<'flow' | 'stage' | 'history' | 'run' | 'planning'>('flow');
  const [advancedRunId, setAdvancedRunId] = useState<string>();
  // The one canvas: a connection can be selected besides a stage (nodeId); the run view and
  // graph/list choice live in memory. 'flow' | 'stage' | 'run' pages are its panel sections.
  const [edgeId, setEdgeId] = useState<string | null>(null);
  // Canvas cameras per subproject and view, kept while this project is open (never stored).
  const canvasCameras = useRef<Record<string, Record<string, { x: number; y: number; zoom: number }>>>({});
  const camerasFor = (subprojectId: string) => { if (!canvasCameras.current[subprojectId]) canvasCameras.current[subprojectId] = {}; return canvasCameras.current[subprojectId]; };
  const [runView, setRunView] = useState(false);
  const [layout, setLayout] = useState<'graph' | 'list'>(mobile ? 'list' : 'graph');
  const [panelOpen, setPanelOpen] = useState(true);
  // "흐름 편집": add, move and connect stages. In memory only, closed when another subproject opens.
  const [structure, setStructure] = useState(false);
  useEffect(() => { setStructure(false); }, [selectedId]);
  const [resultSelection, setResultSelection] = useState<PlanningResultSelection | null>(null);
  const flowPage = view === 'flow' || view === 'stage' || view === 'run';
  const lastFlowPage = useRef<'flow' | 'stage' | 'run'>('flow');
  if (flowPage) lastFlowPage.current = view;
  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [query, setQuery] = useState('');
  const [create, setCreate] = useState<{ id: string; title: string; goal: string; preset: WorkflowPresetId; mode: 'preset' | 'conversation'; graph: WorkflowGraph; previewSessionId?: string; previewRevision?: number; linkSessionId?: string } | null>(null);
  const [creationVisible, setCreationVisible] = useState(false);
  const [previewExpired, setPreviewExpired] = useState(false);
  const scrollElement = useRef<HTMLElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const restoreScroll = useRef<number>();
  const [copyTitle, setCopyTitle] = useState<string | null>(null);
  const [rename, setRename] = useState<{ title: string; goal: string } | null>(null);
  const [linkSessionId, setLinkSessionId] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState({ subprojectId: '', nodeId: '' });
  const [chatTarget, setChatTarget] = useState<{ subprojectId?: string; nodeId?: string; scope?: 'stage' | 'flow-edit'; prompt?: string; previewId?: string } | null>(null);
  // A hidden project pane must not leave its portaled dialog above another tab.
  // Keep the whole form here so returning from history restores the same draft.
  const chatDraftForm = useRef<StructuredAgentDraftFormState>();
  const [daemon, setDaemon] = useState<DaemonSnapshot | null>(null);
  const [models, setModels] = useState<Record<string, readonly ProviderModel[]>>({});
  const [chatPending, setChatPending] = useState<StructuredAgentCreateCommand | null>(null);
  const [conversationRecovery, setConversationRecovery] = useState<WorkflowDraftState['pendingConversation']>();
  const conversationRecoveryRef = useRef(conversationRecovery);
  conversationRecoveryRef.current = conversationRecovery;
  const [unlinkedSession, setUnlinkedSession] = useState<string | null>(null);
  const [preparedRunId, setPreparedRunId] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState({ providerId: 'codex', model: '' });
  const [prepareOpen, setPrepareOpen] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(!recoveryAccess);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [storedComparison, setStoredComparison] = useState<{ state: WorkflowDraftState | null } | null>(null);
  const [compareGraph, setCompareGraph] = useState(false);
  const hostId = snapshot?.hostId;
  const recovery = useMemo(() => recoveryAccess && hostId ? new WorkflowRecovery(projectId, hostId, recoveryAccess) : null, [projectId, hostId, recoveryAccess]);
  const recoveryExtras = useRef<Pick<WorkflowDraftState, 'creation' | 'view' | 'snapshot'>>({});
  recoveryExtras.current = { snapshot: snapshot ?? undefined, creation: create ?? undefined, view: { subprojectId: selectedId ?? undefined, nodeId: nodeId ?? undefined, page: view, scrollTop } };
  const cachedRevision = snapshot ? `${snapshot.hostId}:${snapshot.registryRevision}:${snapshot.subprojects.map(item => `${item.id}:${item.revision}`).join(',')}:${snapshot.runs.map(run => `${run.runId}:${run.revision}`).join(',')}` : '';
  const persist = useCallback(async (state: WorkflowDraftState): Promise<void> => {
    if (!recovery) return;
    try { await recovery.write({ ...recoveryExtras.current, ...state, ...(!('pendingConversation' in state) && conversationRecoveryRef.current ? { pendingConversation: conversationRecoveryRef.current } : {}) }); setRecoveryError(null); }
    catch (reason) { setRecoveryError(String(reason)); throw reason; }
  }, [recovery]);
  useEffect(() => {
    if (!recovery) return;
    let current = true; setRecoveryReady(false);
    void recovery.read().then(saved => { if (current) { if (saved) { setDrafts(saved.drafts); setPending(saved.pendingCommand); setCreate(saved.creation ?? null); if (saved.view && !targetRef.current) { setSelectedId(saved.view.subprojectId ?? null); setNodeId(saved.view.nodeId ?? null); setView(saved.view.page); setScrollTop(saved.view.scrollTop); restoreScroll.current = saved.view.scrollTop; } if (saved.pendingConversation) { setConversationRecovery(saved.pendingConversation); setChatPending(saved.pendingConversation.command); setChatTarget({ subprojectId: saved.pendingConversation.subprojectId, nodeId: saved.pendingConversation.nodeId, scope: saved.pendingConversation.scope, previewId: saved.pendingConversation.previewId }); } } setRecoveryReady(true); setRecoveryError(null); } }).catch(reason => { if (current) setRecoveryError(String(reason)); });
    return () => { current = false; };
  }, [recovery]);
  useEffect(() => {
    if (!recoveryReady || !hostId || recoveryError) return;
    const timer = window.setTimeout(() => { void persist({ projectId, hostId, drafts, pendingCommand: pending }).catch(() => undefined); }, 180);
    return () => window.clearTimeout(timer);
  }, [drafts, pending, conversationRecovery, create, selectedId, nodeId, view, scrollTop, recoveryReady, persist, projectId, hostId, cachedRevision, recoveryError]);
  useEffect(() => { if (recoveryReady && restoreScroll.current !== undefined && scrollElement.current) { scrollElement.current.scrollTop = restoreScroll.current; restoreScroll.current = undefined; } }, [recoveryReady, selectedId, view]);
  const mutating = useRef(false);
  const refreshGeneration = useRef(0);
  const currentScope = useRef(projectId);
  const currentHost = useRef<string>();
  currentScope.current = projectId;
  useEffect(() => {
    if (!disabled || hostId || !recoveryAccess) return;
    let current = true;
    void recoveryAccess.workflowDraftRead(projectId).then(value => {
      const result = WorkflowDraftResultSchema.parse(value);
      if (!current || currentHost.current || !result.ok || result.snapshot.projectId !== projectId) return;
      const cached = result.snapshot.state?.snapshot;
      if (cached && cached.projectId === projectId && cached.hostId === result.snapshot.state?.hostId) { setSnapshot(cached); setLoading(false); }
    }).catch(reason => { if (current) setRecoveryError(String(reason)); });
    return () => { current = false; };
  }, [disabled, hostId, projectId, recoveryAccess]);
  useEffect(() => { if (disabled) setAuthorityReady(false); }, [disabled]);
  const selected = snapshot?.subprojects.find(item => item.id === selectedId);
  const local = selected ? drafts[selected.id] : undefined;
  const graph = local?.graph ?? selected?.graph;
  const chatNode = chatTarget?.nodeId ? snapshot?.subprojects.find(item => item.id === chatTarget.subprojectId)?.graph.nodes.find(item => item.id === chatTarget.nodeId) : undefined;
  const editLocked = busy || !!pending || !recoveryReady || !!recoveryError || selected?.status === 'archived';
  const hostLocked = disabled || !authorityReady || busy || !!pending || !recoveryReady || !!recoveryError;
  const readOnly = hostLocked || editLocked;
  const creatingConversation = !!chatTarget;
  const issues = graph ? validateWorkflowGraph(cleanGraph(graph), true) : [];
  const linkedIds = new Set(snapshot?.sessionLinks.map(link => link.sessionId));
  const managedIds = new Set([...(snapshot?.managedSessionIds ?? []), ...(snapshot?.runs.flatMap(run => [...run.attempts.map(attempt => attempt.sessionId), ...run.reviews.map(review => review.reviewerSessionId)]) ?? [])]);
  const general = conversations.filter(conversation => !linkedIds.has(conversation.id) && !managedIds.has(conversation.id));
  const stageLinksFor = (stageId: string) => {
    const archived = !!selected?.archivedNodes.some(item => item.id === stageId) && !graph?.nodes.some(item => item.id === stageId);
    return [...(snapshot?.sessionLinks ?? []), ...(archived ? snapshot?.historicalSessionLinks ?? [] : [])].filter(link => link.subprojectId === selectedId && link.scope === 'stage' && link.nodeId === stageId)
      .map(link => ({ sessionId: link.sessionId, title: conversations.find(item => item.id === link.sessionId)?.title ?? link.sessionId, graphRevision: link.graphRevision }));
  };
  const flowLinks = snapshot?.sessionLinks.filter(link => link.subprojectId === selectedId && link.scope === 'flow-edit') ?? [];
  const refresh = useCallback(async (): Promise<void> => {
    if (disabled) { setAuthorityReady(false); setLoading(false); return; }
    if (mutating.current) return;
    const generation = ++refreshGeneration.current;
    try {
      const result = await access.getWorkflowSnapshot(projectId);
      if (generation !== refreshGeneration.current || currentScope.current !== projectId) return;
      if (result.ok) {
        const previousHost = currentHost.current ?? recoveryExtras.current.snapshot?.hostId;
        if (previousHost && previousHost !== result.snapshot.hostId) {
          chatDraftForm.current = undefined;
          setDrafts({}); setPending(null); setSelectedId(null); setNodeId(null); setCreate(null); setCreationVisible(false); setChatTarget(null); setChatPending(null); setConversationRecovery(undefined); setUnlinkedSession(null); setRecoveryReady(!recoveryAccess);
        }
        const previousSnapshot = recoveryExtras.current.snapshot;
        setDrafts(current => rebaseUnchangedGraphs(current, previousSnapshot, result.snapshot));
        currentHost.current = result.snapshot.hostId; setAuthorityReady(true); setSnapshot(result.snapshot); setError(null);
      }
      else { setAuthorityReady(false); setError(result.message); }
    } catch (reason) { if (generation === refreshGeneration.current) { setAuthorityReady(false); setError(String(reason)); } }
    finally { if (generation === refreshGeneration.current) setLoading(false); }
  }, [access, projectId, recoveryAccess, disabled]);
  useEffect(() => { void refresh(); return () => { refreshGeneration.current += 1; }; }, [refresh]);
  // A run moves through its stages without a flow revision: read again when the host says this project's runs changed.
  useEffect(() => {
    if (!access.onWorkflowRunsChanged || disabled) return undefined;
    let timer: number | undefined;
    const stop = access.onWorkflowRunsChanged(changed => {
      if (changed !== projectId || timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; if (!mutating.current) void refresh(); }, 300);
    });
    return () => { stop(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [access, projectId, refresh, disabled]);
  const [revealRequest, setRevealRequest] = useState<{ nodeId: string; key: string } | undefined>();
  // 다시 실행 asked from elsewhere (a board card): kept until this flow is ready, then sent once.
  // Bound to the navigation that asked for it: any other navigation drops it.
  const launchRequest = useRef<{ readonly key: string; readonly subprojectId: string } | undefined>();
  useEffect(() => {
    launchRequest.current = navigationTarget?.launch && targetKey && targetSubproject ? { key: targetKey, subprojectId: targetSubproject } : undefined;
  }, [navigationTarget?.launch, targetKey, targetSubproject]);
  useEffect(() => { if (targetSubproject) { setSelectedId(targetSubproject); setNodeId(targetNode ?? null); setView(targetNode ? 'stage' : 'flow'); setEdgeId(null); setRunView(false); setRevealRequest(targetNode && targetKey ? { nodeId: targetNode, key: targetKey } : undefined); } }, [targetKey, targetSubproject, targetNode]);
  useEffect(() => {
    if (!create?.previewSessionId || !access.workflowPreview || disabled) return;
    let current = true;
    const previewId = create.id;
    const read = async (): Promise<void> => {
      try { const result = await access.workflowPreview!({ action: 'read', projectId, previewId });
        if (!current) return;
        if (!result.ok) { setError(result.message); return; }
        setPreviewExpired(!result.preview);
        if (result.preview) setCreate(previous => previous?.id === previewId && previous.previewRevision !== result.preview!.revision ? { ...previous, graph: result.preview!.graph, preset: 'custom', previewRevision: result.preview!.revision } : previous);
      } catch (reason) { if (current) setError(String(reason)); }
    };
    void read(); const timer = window.setInterval(() => void read(), 2000);
    return () => { current = false; window.clearInterval(timer); };
  }, [create?.previewSessionId, create?.id, access, disabled, projectId]);
  useEffect(() => {
    if (!active || disabled) return;
    const timer = window.setInterval(() => { if (!pending) void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, [active, disabled, pending, refresh]);
  useEffect(() => {
    if (!daemonAccess || disabled || !active) return;
    let current = true;
    void daemonAccess.getDaemonSnapshot().then(async result => {
      if (!current) return; setDaemon(result);
      if (daemonAccess.listDaemonProviderModels && result) await Promise.allSettled(result.providers.filter(provider => provider.enabled).map(async provider => {
        const catalog = await daemonAccess.listDaemonProviderModels!(provider.id);
        if (current && catalog.ok) setModels(previous => ({ ...previous, [provider.id]: catalog.value }));
      }));
    }).catch(reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
    // Opening a flow reads the providers and their models again (one enabled since is listed).
  }, [daemonAccess, disabled, active, creatingConversation, prepareOpen, selectedId]);

  const execute = async (input: CommandInput, target = selected, exact?: WorkflowCommand): Promise<boolean> => {
    if (!snapshot || disabled || !authorityReady || !recoveryReady || recoveryError || mutating.current || pending && !exact) return false;
    let command: WorkflowCommand;
    try { command = exact ?? WorkflowCommandSchema.parse({ ...input, commandId: `workflow-${crypto.randomUUID()}`, projectId, hostId: snapshot.hostId, expectedRevision: input.type === 'subproject.create' ? snapshot.registryRevision : target?.revision ?? snapshot.registryRevision, ...(target ? { subprojectId: target.id } : {}) }); }
    catch (reason) { setError(String(reason)); return false; }
    mutating.current = true; refreshGeneration.current += 1; setBusy(true); setError(null);
    try {
      await persist({ projectId, hostId: snapshot.hostId, drafts, pendingCommand: command });
      setPending(command);
      const result = await access.executeWorkflowCommand(command);
      if (!result.ok) { setError([result.message, ...(result.issues?.map(issue => issue.message) ?? [])].join('\n')); if (!['unavailable', 'delivery-uncertain', 'execution-unavailable'].includes(result.error)) setPending(null); return false; }
      setSnapshot(result.snapshot); setPending(null);
      const nextDrafts = { ...rebaseUnchangedGraphs(drafts, snapshot, result.snapshot) };
      if ((command.type === 'workflow.patch' || command.type === 'workflow.undo') && command.subprojectId) delete nextDrafts[command.subprojectId];
      setDrafts(nextDrafts);
      await persist({ projectId, hostId: snapshot.hostId, snapshot: result.snapshot, drafts: nextDrafts, pendingCommand: null });
      return true;
    } catch (reason) { setError(`${text('응답을 확인하지 못했습니다. 같은 요청으로 확인하세요.', 'No confirmed receipt. Reconcile the same request.')} ${String(reason)}`); return false; }
    finally { mutating.current = false; setBusy(false); }
  };
  const updateGraph = (value: WorkflowGraph): void => { if (selected && !editLocked) setDrafts(current => ({ ...current, [selected.id]: { graph: value, baseRevision: current[selected.id]?.baseRevision ?? selected.revision } })); };
  const saveGraph = async (): Promise<void> => {
    if (!selected || !local) return;
    const next = cleanGraph(local.graph);
    // A save that only moved stages reads as a layout change in the history.
    const summary = workflowLayoutOnlyChange(selected.graph, next) ? text('배치 변경', 'Layout change') : text('흐름과 단계 문서 편집', 'Edit workflow and stage documents');
    await execute({ type: 'workflow.patch', payload: { graph: next, summary } }, { ...selected, revision: local.baseRevision });
  };
  // 다시 실행: one request on a host that has it; an older host prepares from the dialog, then starts.
  const canLaunch = !!daemon?.capabilities?.includes(WORKFLOW_LAUNCH_CAPABILITY);
  const openPrepare = (): void => { setReviewer(selected?.runSettings?.reviewer ? { ...selected.runSettings.reviewer } : { providerId: 'codex', model: '' }); setPrepareOpen(true); };
  const launch = async (): Promise<void> => {
    if (!canLaunch) { openPrepare(); return; }
    const runId = `run-${crypto.randomUUID()}`;
    if (await execute({ type: 'run.launch', payload: { runId } })) { setPreparedRunId(runId); setRunView(false); }
  };
  useEffect(() => {
    const request = launchRequest.current;
    if (!request || request.key !== targetKey || request.subprojectId !== selected?.id || !selected || !daemon || hostLocked || selected.status === 'archived') return;
    launchRequest.current = undefined;
    // What the run bar would refuse is not sent: the flow shows why instead.
    if (blockingRunOf(snapshot?.runs ?? [], selected.id) || local || issues.length || (canLaunch && !selected.runSettings)) return;
    void launch();
  });
  const selectSubproject = (id: string): void => { launchRequest.current = undefined; setSelectedId(id); setNodeId(snapshot?.subprojects.find(item => item.id === id)?.graph.entryNodeId ?? null); setView('flow'); setEdgeId(null); setRunView(false); };
  const beginCreate = (sourceSessionId?: string): void => { const id = `subproject-${crypto.randomUUID()}`; setCreate({ id, title: '', goal: '', preset: 'feature', mode: 'preset', graph: graphForPreset('feature', id, text), ...(sourceSessionId ? { linkSessionId: sourceSessionId } : {}) }); setPreviewExpired(false); setCreationVisible(true); };
  const switchPreset = async (preset = create?.preset): Promise<void> => {
    if (!create || !preset) return;
    if (create.previewSessionId && access.workflowPreview) { const result = await access.workflowPreview({ action: 'discard', projectId, previewId: create.id }); if (!result.ok) { setError(result.message); return; } }
    setCreate({ ...create, preset, mode: 'preset', graph: graphForPreset(preset, create.id, text), previewSessionId: undefined, previewRevision: undefined }); setPreviewExpired(false);
  };
  const reconnectPreview = async (): Promise<void> => {
    if (!create?.previewSessionId || !access.workflowPreview) return;
    const result = await access.workflowPreview({ action: 'open', projectId, sessionId: create.previewSessionId, previewId: create.id, graph: cleanGraph(create.graph) });
    if (!result.ok || !result.preview) { setError(result.ok ? text('생성 초안을 다시 연결하지 못했습니다.', 'The creation draft could not be reconnected.') : result.message); return; }
    setCreate({ ...create, graph: result.preview.graph, previewRevision: result.preview.revision }); setPreviewExpired(false);
  };
  const discardCreate = async (): Promise<void> => {
    if (create?.previewSessionId && access.workflowPreview) { const result = await access.workflowPreview({ action: 'discard', projectId, previewId: create.id }); if (!result.ok) { setError(result.message); return; } }
    setCreationVisible(false); setCreate(null);
  };
  const openStage = (id: string): void => { setNodeId(id); setEdgeId(null); setRunView(false); setView('stage'); };
  const startChat = (target: NonNullable<typeof chatTarget>): void => {
    if (!target.subprojectId && !target.previewId && onNewConversation) { onNewConversation(); return; }
    if (daemonAccess) { chatDraftForm.current = undefined; setChatTarget(target); }
    else if (!target.subprojectId) onNewConversation?.();
  };
  const linkTo = async (sessionId: string, subprojectId: string, stageId?: string, scope: 'stage' | 'flow-edit' = 'stage'): Promise<boolean> => {
    const target = snapshot?.subprojects.find(item => item.id === subprojectId);
    if (!target) return false;
    return execute({ type: 'session.link', payload: { sessionId, scope, ...(stageId ? { nodeId: stageId } : {}) } }, target);
  };
  const createConversation = async (input: StructuredAgentDraftInput): Promise<StructuredAgentUiResult> => {
    if (!daemonAccess || !chatTarget || !authorityReady || disabled) return { ok: false, message: text('호스트 연결이 필요합니다.', 'Connect to the host first.') };
    let sessionId: string;
    if (unlinkedSession) sessionId = unlinkedSession;
    else {
      if (chatPending) {
        const receipt = await daemonAccess.sendDaemonCommand(chatPending).catch(() => null);
        if (!receipt?.ok) return { ok: false, message: receipt && !receipt.ok ? receipt.error.message : text('응답 미확정', 'Receipt unconfirmed'), deliveryUncertain: true };
        sessionId = chatPending.payload.sessionId; setChatPending(null);
      } else {
        const result = await createStructuredAgentSession(input, { access: { getSnapshot: () => daemonAccess.getDaemonSnapshot(), sendCommand: command => daemonAccess.sendDaemonCommand(command) }, principal: { kind: mobile ? 'android' : 'desktop', id: 'workflow-conversation-ui' }, onCommandPrepared: async command => {
          if (!snapshot || !recoveryReady || recoveryError) throw new Error('Secure workflow recovery is not ready.');
          const record = { command, subprojectId: chatTarget.subprojectId, nodeId: chatTarget.nodeId, scope: chatTarget.scope, previewId: chatTarget.previewId, draft: ChatComposerDraftSchema.parse({ text: input.draftText ?? chatTarget.prompt ?? '', ...(input.draftSkills ? { skills: input.draftSkills } : {}) }) };
          await persist({ projectId, hostId: snapshot.hostId, drafts, pendingCommand: pending, pendingConversation: record });
          setConversationRecovery(record); setChatPending(command);
        } });
        if (result.kind !== 'created') { if (result.kind === 'rejected') { setChatPending(null); if (snapshot && result.reason !== 'recovery-unavailable') { await persist({ projectId, hostId: snapshot.hostId, drafts, pendingCommand: pending, pendingConversation: undefined }); setConversationRecovery(undefined); } } return { ok: false, message: result.message, deliveryUncertain: result.kind === 'delivery-uncertain' }; }
        sessionId = result.sessionId; setChatPending(null);
      }
      setUnlinkedSession(sessionId);
    }
    const linkingConfirmed = pending?.type === 'session.link' && pending.payload.sessionId === sessionId
      ? await execute(pending, undefined, pending)
      : !chatTarget.subprojectId || await linkTo(sessionId, chatTarget.subprojectId, chatTarget.nodeId, chatTarget.scope);
    if (!linkingConfirmed) return { ok: false, message: text('대화는 생성되었습니다. 연결을 확인한 뒤 같은 대화로 다시 연결하세요.', 'The conversation was created. Reconcile its link, then reconnect the same conversation.') };
    if (chatTarget.previewId && create?.id === chatTarget.previewId) {
      if (!access.workflowPreview) return { ok: false, message: text('호스트가 대화형 구성을 지원하지 않습니다.', 'The host does not support conversational setup.') };
      const result = await access.workflowPreview({ action: 'open', projectId, sessionId, previewId: create.id, graph: create.graph });
      if (!result.ok) return { ok: false, message: result.message };
      setCreate(previous => previous ? { ...previous, previewSessionId: sessionId, previewRevision: result.preview?.revision } : null);
      setCreationVisible(false);
    }
    const draftText = conversationRecovery?.draft?.text ?? input.draftText ?? chatTarget.prompt ?? '';
    if (draftText && onSeedConversationDraft) {
      try { await onSeedConversationDraft(sessionId, conversationRecovery?.draft ?? { text: draftText, ...(input.draftSkills ? { skills: input.draftSkills } : {}) }); }
      catch (reason) { return { ok: false, message: String(reason) }; }
    }
    if (snapshot) await persist({ projectId, hostId: snapshot.hostId, drafts, pendingCommand: null, pendingConversation: undefined });
    setConversationRecovery(undefined); setUnlinkedSession(null); setChatTarget(null); onOpenConversation?.(sessionId); return { ok: true };
  };
  const shownSubprojects = snapshot?.subprojects.filter(item => (filter === 'all' || (filter === 'archived') === (item.status === 'archived')) && `${item.title} ${item.goal}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const shownGeneral = filter === 'archived' ? [] : general.filter(item => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const runs = snapshot?.runs.filter(run => run.preparation.workflow?.subprojectId === selectedId) ?? [];
  return <section ref={scrollElement} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} className="workflow-workspace" data-mobile={mobile || undefined} data-view={view === 'planning' ? 'planning' : selected && flowPage && !mobile ? 'flow' : undefined} data-testid="workflow-workspace">
    <header className="workflow-header"><IconButton icon={ArrowLeft} aria-label={selected && view !== 'flow' && view !== 'stage' && view !== 'run' ? text('흐름으로', 'Back to the flow') : selected && onBoard ? text('판으로', 'Back to the board') : selected || view === 'planning' ? text('프로젝트 항목으로', 'Back to project items') : text('프로젝트 목록으로', 'Back to projects')}
      onClick={() => { launchRequest.current = undefined; if (selected && !flowPage) setView(lastFlowPage.current); else if (selectedId && onBoard) { setSelectedId(null); setView('flow'); onBoard(); } else if (selectedId) { setSelectedId(null); setView('flow'); } else if (view === 'planning') setView('flow'); else onBack?.(); }} data-testid="workflow-back" /><div className="workflow-header__title"><small>{selected ? projectName : text('프로젝트', 'Project')}</small><h2>{selected?.title ?? projectName}</h2></div><div className="workflow-header__actions">{!selected && <IconButton icon={RefreshCw} aria-label={text('다시 불러오기', 'Refresh')} disabled={busy || disabled} onClick={() => void refresh()} />}{selected && <Button disabled={readOnly} onClick={() => setRename({ title: selected.title, goal: selected.goal })}>{text('이름·목표', 'Name and goal')}</Button>}{selected && <Button leadingIcon={<MessageSquarePlus />} disabled={readOnly || !daemonAccess} onClick={() => startChat({ subprojectId: selected.id, scope: 'flow-edit' })}>{text('AI와 흐름 편집', 'Edit flow with AI')}</Button>}{selected && <Button leadingIcon={<History />} aria-pressed={view === 'history'} onClick={() => setView(view === 'history' ? lastFlowPage.current : 'history')}>{text('변경 기록', 'History')}</Button>}{selected && <Menu label={text('소프로젝트 작업', 'Subproject actions')} placement="bottom-end" trigger={<IconButton icon={MoreHorizontal} aria-label={text('소프로젝트 작업', 'Subproject actions')} />}><MenuItem icon={RefreshCw} disabled={busy || disabled} onSelect={() => void refresh()}>{text('다시 불러오기', 'Refresh')}</MenuItem><MenuItem icon={Play} disabled={hostLocked || !!local || issues.length > 0 || selected.status === 'archived'} onSelect={openPrepare}>{text('실행 준비만', 'Prepare a run only')}</MenuItem>{renderPlanning && <MenuItem icon={ClipboardList} onSelect={() => setView('planning')}>{text('기획·설계·검토', 'Planning, design and review')}</MenuItem>}<MenuSeparator />{flowLinks.map(link => <MenuItem key={link.sessionId} icon={MessageSquare} onSelect={() => onOpenConversation?.(link.sessionId)}>{conversations.find(item => item.id === link.sessionId)?.title ?? text('흐름 편집 대화', 'Flow editing conversation')}</MenuItem>)}{flowLinks.length > 0 && <MenuSeparator />}<MenuItem icon={CheckCheck} disabled={readOnly || !!local} onSelect={() => void execute({ type: 'subproject.update', payload: { status: selected.status === 'completed' ? 'active' : 'completed' } })}>{selected.status === 'completed' ? text('다시 진행', 'Reopen') : text('완료로 표시', 'Mark complete')}</MenuItem><MenuItem icon={Copy} disabled={hostLocked || !!local} onSelect={() => setCopyTitle(`${selected.title} ${text('복사본', 'copy')}`)}>{text('소프로젝트 복사', 'Copy subproject')}</MenuItem><MenuItem icon={Archive} disabled={hostLocked || !!local} onSelect={() => void execute({ type: 'subproject.update', payload: { status: selected.status === 'archived' ? 'active' : 'archived' } })}>{selected.status === 'archived' ? text('복원', 'Restore') : text('보관', 'Archive')}</MenuItem></Menu>}</div></header>
    {snapshot && !authorityReady ? <p role="status" className="workflow-notice">{text('기기에 보관된 화면입니다. 초안 편집은 복구되며, 다시 연결해 호스트의 권한·버전을 확인한 뒤에만 직접 저장하거나 실행할 수 있습니다.', 'Showing the copy stored on this device. Draft edits are recoverable; reconnect for a fresh host authority and version check before saving or running.')}</p> : disabled && <p role="status" className="workflow-notice">{disabledReason ?? text('호스트에 다시 연결하세요.', 'Reconnect to the host.')}</p>}
    {error && <p role="alert" className="workflow-error">{error}</p>}
    {busy && <p role="status">{text('호스트에 저장하고 결과를 확인하는 중입니다.', 'Saving to the host and confirming the result.')}</p>}
    {recoveryError && <div className="workflow-error" role="alert"><p>{text('초안 복구 저장을 확인해야 합니다. 현재 입력은 유지됩니다.', 'Secure draft recovery needs attention. Your current input is preserved.')} {recoveryError}</p><Button onClick={() => { void recovery?.read().then(state => setStoredComparison({ state })).catch(reason => setRecoveryError(String(reason))); }}>{text('저장된 초안 확인', 'Read stored draft')}</Button></div>}
    {storedComparison && <div className="workflow-notice"><p>{text('저장된 초안과 현재 입력 중 유지할 내용을 선택하세요. 저장된 미확정 명령은 어느 선택에서도 유지합니다.', 'Choose the stored draft or your current input. Pending stored commands are preserved in either case.')}</p><Button onClick={() => { setDrafts(storedComparison.state?.drafts ?? {}); setPending(storedComparison.state?.pendingCommand ?? null); setRecoveryReady(true); setRecoveryError(null); setStoredComparison(null); }}>{text('저장된 초안 사용', 'Use stored draft')}</Button><Button onClick={() => { setPending(storedComparison.state?.pendingCommand ?? pending); setRecoveryReady(true); setRecoveryError(null); setStoredComparison(null); }}>{text('현재 입력 유지', 'Keep current input')}</Button></div>}
    {pending && <div className="workflow-notice" role="status"><p>{text('아직 요청 결과를 확인하지 못했습니다. 확인 전에는 다른 변경을 보내지 않습니다.', 'The request is not yet confirmed. Reconcile it before sending another change.')}</p><Button disabled={busy || disabled} onClick={() => void execute(pending, undefined, pending)}>{text('같은 요청 확인', 'Reconcile request')}</Button>
      {pending.type.startsWith('run.') && <Button variant="ghost" disabled={busy} data-testid="workflow-pending-discard" onClick={() => { setPending(null); if (snapshot) void persist({ projectId, hostId: snapshot.hostId, drafts, pendingCommand: null }).catch(() => undefined); }}
        title={text('이미 처리된 부분(준비된 실행 등)은 그대로 남습니다. 실행 상태를 확인한 뒤 새로 요청하세요.', 'Anything it already did (a prepared run, say) stays as recorded. Check the run, then make a new request.')}>{text('이 요청 그만두기', 'Stop waiting for this request')}</Button>}</div>}
    {!selected && renderPlanning && <div className="workflow-toolbar workflow-switch" role="group" aria-label={text('프로젝트 보기', 'Project view')}><Button size="sm" aria-pressed={view !== 'planning'} onClick={() => setView('flow')}>{text('소프로젝트·대화', 'Subprojects and conversations')}</Button><Button size="sm" aria-pressed={view === 'planning'} onClick={() => setView('planning')}>{text('빠른 작업·기존 자료', 'Quick tasks and existing work')}</Button></div>}
    {!recoveryReady && !recoveryError && !disabled && <p role="status" className="workflow-notice">{text('기기에 저장된 초안을 확인하는 중입니다. 확인이 끝나면 편집할 수 있습니다.', 'Checking drafts saved on this device. Editing opens once that finishes.')}</p>}
    {loading && !snapshot ? <LoadingState label={text('프로젝트 불러오는 중', 'Loading project')} /> : !selected ? <div className="workflow-project-items" hidden={view === 'planning'}>
      <div className="workflow-toolbar"><Button leadingIcon={<Plus />} disabled={hostLocked || !snapshot} onClick={() => beginCreate()}>{text('새 소프로젝트', 'New subproject')}</Button><Button leadingIcon={<MessageSquarePlus />} disabled={disabled || !!snapshot && hostLocked} onClick={() => startChat({})}>{text('새 일반 대화', 'New conversation')}</Button>{onNewTerminal && <Button disabled={disabled} onClick={onNewTerminal}>{text('새 터미널', 'New terminal')}</Button>}</div>
      <div className="workflow-toolbar"><Input aria-label={text('소프로젝트와 대화 검색', 'Search subprojects and conversations')} value={query} onChange={event => setQuery(event.target.value)} placeholder={text('소프로젝트와 대화 검색', 'Search subprojects and conversations')} /><Select aria-label={text('표시할 항목', 'Items to display')} value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="active">{text('진행 중', 'Active')}</option><option value="archived">{text('보관됨', 'Archived')}</option><option value="all">{text('모두', 'All')}</option></Select></div>
      <ul className="workflow-items">{shownSubprojects.map(item => <li key={item.id}><button type="button" className="workflow-item" data-testid="workflow-subproject-item" onClick={() => selectSubproject(item.id)}><FolderKanban aria-hidden="true" /><span><strong>{item.title}</strong><small>{text('소프로젝트', 'Subproject')} · {item.graph.nodes.length} {text('단계', 'stages')} · v{item.revision}{item.status === 'archived' ? text(' · 보관됨', ' · Archived') : ''}</small><span>{item.goal}</span></span></button></li>)}{shownGeneral.map(item => <li key={item.id} className="workflow-conversation-row"><button type="button" className="workflow-item" onClick={() => onOpenConversation?.(item.id)}><MessageSquare aria-hidden="true" /><span><strong>{item.title}</strong><small>{text('일반 대화 · 계획 없음', 'Conversation · no plan')} · {item.providerLabel ?? (item.status && stateLabel(item.status))}</small></span></button><Button variant="ghost" size="sm" disabled={hostLocked || !snapshot} onClick={() => { setLinkSessionId(item.id); setLinkTarget({ subprojectId: '', nodeId: '' }); }}>{text('단계에 연결', 'Link to stage')}</Button></li>)}</ul>
      {!shownSubprojects.length && !shownGeneral.length && <p role="status">{query || filter === 'archived' ? text('해당하는 항목이 없습니다.', 'No matching items.') : text('소프로젝트로 흐름을 만들거나 계획 없이 대화를 시작하세요.', 'Create a workflow in a subproject, or start a conversation without a plan.')}</p>}
    </div> : <>
      {(selected.status !== 'active' || (local && selected.revision !== local.baseRevision)) && <div className="workflow-toolbar workflow-subproject-actions">{selected.status !== 'active' && <Badge>{selected.status === 'archived' ? text('보관됨', 'Archived') : text('완료됨', 'Completed')}</Badge>}{local && selected.revision !== local.baseRevision && <span role="alert">{text('다른 창 또는 AI가 수정했습니다. 현재 입력을 보존한 채 최신 변경을 비교하세요.', 'Another window or AI changed this workflow. Your input is preserved; compare the latest changes.')}</span>}</div>}
      {flowPage && <div className="workflow-flow-host"><WorkflowFlowSurface key={selected.id} text={text} mobile={mobile} savedGraph={selected.graph} draftGraph={local?.graph ?? null} revision={selected.revision} archivedNodes={selected.archivedNodes} runs={runs}
        subproject={selected} catalogs={models} structure={structure} onStructureChange={setStructure} savedRunSettings={canLaunch}
        onLaunch={() => void launch()} onSaveReviewer={reviewer => void execute({ type: 'subproject.update', payload: { runSettings: { reviewer } } })}
        onAutoApprove={on => { if (on !== (selected.autoApprove === true)) void execute({ type: 'subproject.update', payload: { autoApprove: on } }); }}
        editLocked={editLocked} commandsDisabled={hostLocked || selected.status === 'archived'} issues={issues} providers={structuredAgentProviderOptions(daemon, models)}
        selection={edgeId ? { kind: 'edge', id: edgeId } : nodeId ? { kind: 'node', id: nodeId } : null}
        onSelectionChange={next => { setEdgeId(next?.kind === 'edge' ? next.id : null); setNodeId(next?.kind === 'node' ? next.id : null); }}
        section={sectionFromPage(lastFlowPage.current)} onSectionChange={next => setView(pageFromSection(next))}
        pickedRunId={preparedRunId} onPickRun={setPreparedRunId} runView={runView} onRunViewChange={setRunView}
        layout={layout} onLayoutChange={setLayout} onGraphChange={updateGraph} onSaveDraft={() => void saveGraph()}
        onDiscardDraft={() => setDrafts(current => { const next = { ...current }; delete next[selected.id]; return next; })}
        onRunCommand={command => void execute(command)}
        stageLinks={stageLinksFor} canStartStageChat={!!daemonAccess} onStartStageChat={stageId => startChat({ subprojectId: selected.id, nodeId: stageId, scope: 'stage' })}
        onOpenConversation={onOpenConversation} onOpenResults={renderPlanning ? runId => { setAdvancedRunId(runId); setView('planning'); } : undefined}
        onOpenAttemptResult={readPlanningResult ? (_runId, attemptId) => setResultSelection({ kind: 'attempt', projectId, subprojectId: selected.id, attemptId }) : undefined}
        canvasRenderer={canvasRenderer} onReloadCanvas={onReloadCanvas} active={active} cameras={camerasFor(selected.id)}
        revealRequest={revealRequest} onRevealHandled={() => setRevealRequest(undefined)} panelOpen={panelOpen} onPanelOpenChange={setPanelOpen} /></div>}
      {view === 'history' && <div className="workflow-history"><h3><History aria-hidden="true" />{text('변경 기록', 'Change history')}</h3>{selected.history.length === 0 && <p>{text('저장된 변경이 없습니다.', 'No saved changes.')}</p>}<ol>{[...selected.history].reverse().map(change => <li key={change.id}><div><strong>v{change.revision} · {change.summary}</strong><p>{change.actor.kind === 'ai' ? 'AI' : text('사용자', 'User')} · {new Date(change.createdAt).toLocaleString()}</p><small>{change.before.nodes.length} → {change.after.nodes.length} {text('단계', 'stages')} · {change.before.edges.length} → {change.after.edges.length} {text('연결', 'connections')}{change.undoOf ? text(' · 되돌리기', ' · Undo') : ''}</small></div>{change.actor.sessionId && <Button onClick={() => onOpenConversation?.(change.actor.sessionId!)}>{text('원래 대화', 'Source conversation')}</Button>}<Button disabled={readOnly || !!local} leadingIcon={<Undo2 />} onClick={() => void execute({ type: 'workflow.undo', payload: { changeId: change.id } })}>{text('이 변경 되돌리기', 'Undo this change')}</Button></li>)}</ol>{selected.archivedNodes.length > 0 && <><h3>{text('보관된 단계', 'Archived stages')}</h3>{selected.archivedNodes.map(item => <Button key={item.id} onClick={() => openStage(item.id)}>{item.title}</Button>)}</>}</div>}
    </>}
    {view === 'planning' && renderPlanning && <div className="workflow-existing">{renderPlanning(selected ?? null, advancedRunId ? 'tasks' : undefined, advancedRunId)}</div>}
    {readPlanningResult && <PlanningResultDetails selection={active ? resultSelection : null} read={readPlanningResult} onClose={() => setResultSelection(null)} onOpenConversation={onOpenConversation} executionRuns={runs} disabled={hostLocked} />}
    {selected && local && selected.revision !== local.baseRevision && <Button onClick={() => setCompareGraph(true)}>{text('저장본과 현재 초안 비교', 'Compare saved graph and current draft')}</Button>}
    <Dialog open={active && compareGraph && !!selected && !!local} onOpenChange={setCompareGraph} title={text('흐름 변경 비교', 'Compare workflow changes')} size="lg" closeLabel={text('닫기', 'Close')} footer={<><Button onClick={() => { if (selected) setDrafts(current => { const next = { ...current }; delete next[selected.id]; return next; }); setCompareGraph(false); }}>{text('호스트 저장본 사용', 'Use host saved version')}</Button><Button onClick={() => { if (selected && local) setDrafts(current => ({ ...current, [selected.id]: { ...local, baseRevision: selected.revision } })); setCompareGraph(false); }}>{text('현재 초안을 다음 저장본으로 유지', 'Keep current draft for next save')}</Button></>}>
      {selected && local && <div className="workflow-create"><div><h3>{text('호스트 저장본', 'Host saved version')} · v{selected.revision}</h3>{selected.graph.nodes.map(node => <details key={node.id}><summary>{node.title}</summary><p>{node.instructions}</p><pre className="workflow-document-comparison">{node.document}</pre></details>)}</div><div><h3>{text('현재 미저장 초안', 'Current unsaved draft')} · v{local.baseRevision}</h3>{local.graph.nodes.map(node => <details key={node.id}><summary>{node.title}</summary><p>{node.instructions}</p><pre className="workflow-document-comparison">{node.document}</pre></details>)}</div></div>}
    </Dialog>
    {create && !creationVisible && <div className="workflow-notice"><p>{text('아직 만들지 않은 소프로젝트 구성이 있습니다. 대화에서 바뀐 흐름을 확인하세요.', 'A subproject setup is in progress. Review the workflow updated in your conversation.')}</p><Button onClick={() => setCreationVisible(true)}>{text('구성 이어가기', 'Continue setup')}</Button></div>}
    <Dialog open={active && !!create && creationVisible} onOpenChange={open => { if (!open && !busy) void discardCreate(); }} title={text('새 소프로젝트', 'New subproject')} size="lg" closeLabel={text('닫기', 'Close')} footer={<><Button disabled={busy} onClick={() => void discardCreate()}>{text('취소', 'Cancel')}</Button><Button variant="primary" disabled={hostLocked || previewExpired || !create?.title.trim()} onClick={() => { if (create) void execute({ type: 'subproject.create', payload: { id: create.id, title: create.title, goal: create.goal, presetId: create.preset, graph: cleanGraph(create.graph), ...(create.previewSessionId ? { previewId: create.id, previewRevision: create.previewRevision } : {}) } }, undefined).then(async ok => { if (ok) { setSelectedId(create.id); setNodeId(create.graph.entryNodeId); setView('flow'); if (create.previewSessionId) await access.workflowPreview?.({ action: 'discard', projectId, previewId: create.id }); if (create.linkSessionId) { setLinkSessionId(create.linkSessionId); setLinkTarget({ subprojectId: create.id, nodeId: create.graph.entryNodeId ?? '' }); } setCreate(null); setCreationVisible(false); } }); }}>{text('소프로젝트 만들기', 'Create subproject')}</Button></>}>
      {create && <div className="workflow-create">{error && <p className="workflow-error" role="alert">{error}</p>}{recoveryError && <p className="workflow-error" role="alert">{recoveryError}</p>}<div className="workflow-create__settings">
        <Field label={text('이름', 'Name')}><Input autoFocus value={create.title} maxLength={300} onChange={event => setCreate({ ...create, title: event.target.value })} /></Field>
        <label className="workflow-field">{text('목표', 'Goal')}<textarea rows={3} value={create.goal} onChange={event => setCreate({ ...create, goal: event.target.value })} /></label>
        <div className="workflow-toolbar" role="group" aria-label={text('구성 방법', 'Setup method')}><Button aria-pressed={create.mode === 'preset'} onClick={() => void switchPreset()}>{text('프리셋으로', 'From preset')}</Button><Button aria-pressed={create.mode === 'conversation'} onClick={() => setCreate({ ...create, mode: 'conversation' })}>{text('대화로 구성', 'Design in conversation')}</Button></div>
        {create.mode === 'preset' ? <Field label={text('시작 프리셋', 'Starting preset')}><Select value={create.preset} onChange={event => void switchPreset(event.target.value as WorkflowPresetId)}>{workflowPresets.map(preset => <option key={preset.id} value={preset.id}>{localizedPreset(preset.id, text)}</option>)}</Select></Field> : <>
          <p>{text('대화에서 AI에게 원하는 흐름을 설명하세요. AI가 수정한 생성 초안을 여기에서 확인한 뒤 만들기를 누릅니다.', 'Describe your workflow to AI in a conversation. Review its updated draft here, then create the subproject.')}</p>
          <Button disabled={hostLocked || previewExpired || !daemonAccess || !access.workflowPreview} onClick={() => {
            if (create.previewSessionId && !previewExpired) { setCreationVisible(false); onOpenConversation?.(create.previewSessionId); }
            else startChat({ previewId: create.id, prompt: `${text('목표에 맞는 작업 흐름을 함께 설계해줘. workflow_read로 내 생성 초안을 확인하고 preview_workflow 도구로 초안을 수정해줘. 소프로젝트 생성과 실행은 사용자가 별도로 결정합니다.', 'Help me design a workflow for this goal. Read my creation draft with workflow_read and edit it with preview_workflow. I will create the subproject and start execution separately.')}\n${create.goal}` });
          }}>{create.previewSessionId ? text('구성 대화 이어가기', 'Continue setup conversation') : text('구성 대화 열기', 'Open setup conversation')}</Button>
          {!access.workflowPreview && <p role="status">{text('대화형 구성을 사용하려면 호스트를 업데이트하세요.', 'Update the host to use conversational setup.')}</p>}
          {previewExpired && <div className="workflow-notice" role="status"><p>{text('호스트의 생성 초안이 만료되었습니다. 저장된 흐름을 다시 연결하거나 프리셋으로 전환하세요. 구성 대화는 유지됩니다.', 'The host creation draft expired. Reconnect the saved workflow or switch to a preset. Your conversation is retained.')}</p><Button disabled={hostLocked} onClick={() => void reconnectPreview()}>{text('저장된 초안 다시 연결', 'Reconnect saved draft')}</Button><Button onClick={() => void switchPreset('feature')}>{text('프리셋으로 전환', 'Switch to preset')}</Button></div>}{create.previewSessionId && <p role="status">{text('대화와 연결된 생성 초안', 'Draft linked to the setup conversation')} · v{create.previewRevision ?? 0}</p>}
        </>}
        </div><div className="workflow-create__preview"><h3>{text('흐름 미리보기', 'Workflow preview')}</h3><p className="workflow-hint">{text('생성 후에도 단계와 연결을 계속 편집할 수 있습니다.', 'Stages and connections remain editable after creation.')}</p><ol className="workflow-preview">{create.graph.nodes.map(item => <li key={item.id}><strong>{item.title}</strong><span>{workflowOperationLabel(item.operation, text)}</span><small>{create.graph.edges.filter(edge => edge.from === item.id).map(edge => `${workflowOutcomeLabel(edge.outcome, text)} → ${create.graph.nodes.find(node => node.id === edge.to)?.title ?? edge.to}`).join(' · ') || text('흐름 종료', 'End of flow')}</small></li>)}</ol></div>
      </div>}
    </Dialog>
    <Dialog open={active && copyTitle !== null} onOpenChange={open => { if (!open) setCopyTitle(null); }} title={text('소프로젝트 복사', 'Copy subproject')} description={text('저장된 흐름·문서·설정을 새 소프로젝트로 복사합니다. 대화·실행·승인 기록은 원본에 유지됩니다.', 'Copy the saved workflow, documents and settings into a new subproject. Conversations, runs and approval history remain with the original.')} closeLabel={text('닫기', 'Close')} footer={<><Button onClick={() => setCopyTitle(null)}>{text('취소', 'Cancel')}</Button><Button disabled={!copyTitle?.trim() || hostLocked} onClick={() => { if (copyTitle) { const id = `subproject-${crypto.randomUUID()}`; void execute({ type: 'subproject.copy', payload: { id, title: copyTitle } }).then(ok => { if (ok) { setCopyTitle(null); setSelectedId(id); setNodeId(null); setView('flow'); } }); } }}>{text('복사', 'Copy')}</Button></>}><Field label={text('복사본 이름', 'Copy name')}><Input value={copyTitle ?? ''} onChange={event => setCopyTitle(event.target.value)} /></Field></Dialog>
    <Dialog open={active && !!rename} onOpenChange={open => { if (!open) setRename(null); }} title={text('이름과 목표 편집', 'Edit name and goal')} closeLabel={text('닫기', 'Close')} footer={<><Button onClick={() => setRename(null)}>{text('취소', 'Cancel')}</Button><Button disabled={!rename?.title.trim() || readOnly} onClick={() => { if (rename) void execute({ type: 'subproject.update', payload: rename }).then(ok => { if (ok) setRename(null); }); }}>{text('저장', 'Save')}</Button></>}>{rename && <><Field label={text('이름', 'Name')}><Input value={rename.title} onChange={event => setRename({ ...rename, title: event.target.value })} /></Field><label className="workflow-field">{text('목표', 'Goal')}<textarea value={rename.goal} onChange={event => setRename({ ...rename, goal: event.target.value })} /></label></>}</Dialog>
    <Dialog open={active && !!linkSessionId} onOpenChange={open => { if (!open) setLinkSessionId(null); }} title={text('대화를 단계에 연결', 'Link conversation to a stage')} description={text('현재 메시지·입력·모델은 그대로 유지합니다. 문서나 실행은 바꾸지 않습니다.', 'Keep the same messages, draft and model. Documents and execution are unchanged.')} closeLabel={text('닫기', 'Close')} footer={<><Button onClick={() => setLinkSessionId(null)}>{text('취소', 'Cancel')}</Button><Button disabled={!linkTarget.subprojectId || !linkTarget.nodeId || hostLocked} onClick={() => { if (linkSessionId) void linkTo(linkSessionId, linkTarget.subprojectId, linkTarget.nodeId).then(ok => { if (ok) { setLinkSessionId(null); selectSubproject(linkTarget.subprojectId); setNodeId(linkTarget.nodeId); setView('stage'); } }); }}>{text('연결', 'Link')}</Button></>}><Button disabled={disabled || busy} onClick={() => { if (linkSessionId) { beginCreate(linkSessionId); setLinkSessionId(null); } }}>{text('\uc0c8 \uc18c\ud504\ub85c\uc81d\ud2b8\ub97c \ub9cc\ub4e4\uc5b4 \uc5f0\uacb0', 'Create a subproject to link')}</Button><Field label={text('소프로젝트', 'Subproject')}><Select value={linkTarget.subprojectId} onChange={event => setLinkTarget({ subprojectId: event.target.value, nodeId: '' })}><option value="">{text('선택하세요', 'Choose')}</option>{snapshot?.subprojects.filter(item => item.status !== 'archived').map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field><Field label={text('단계', 'Stage')}><Select value={linkTarget.nodeId} onChange={event => setLinkTarget({ ...linkTarget, nodeId: event.target.value })}><option value="">{text('선택하세요', 'Choose')}</option>{snapshot?.subprojects.find(item => item.id === linkTarget.subprojectId)?.graph.nodes.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</Select></Field></Dialog>
    <Dialog open={active && !!chatTarget} onOpenChange={open => { if (!open && !chatPending && !unlinkedSession) setChatTarget(null); }} dismissible={!chatPending && !unlinkedSession} title={chatTarget?.scope === 'flow-edit' ? text('흐름 편집 대화', 'Flow editing conversation') : chatTarget?.nodeId ? text('새 단계 대화', 'New stage conversation') : text('새 일반 대화', 'New conversation')} closeLabel={text('닫기', 'Close')} size="lg">{chatTarget && <StructuredAgentDraftPanel embedded initialFormState={chatDraftForm.current} onFormStateChange={state => { chatDraftForm.current = state; }} onOpenHistory={onOpenHistory} capabilityClient={capabilityClient} providers={structuredAgentProviderOptions(daemon, models)} workspaces={structuredAgentWorkspaceOptions(daemon, projectId)} initialProviderId={chatPending?.payload.providerId ?? chatNode?.providerId} initialModel={chatPending?.payload.model ?? chatNode?.model} initialWorkspaceId={chatPending?.payload.workspaceId} initialPermissionPreset={chatPending?.payload.permissionPreset ?? (chatTarget.scope === 'flow-edit' ? 'standard' : chatNode?.permissionPreset ?? 'standard')} initialDraftText={conversationRecovery?.draft?.text ?? chatTarget.prompt} initialDraftSkills={conversationRecovery?.draft?.skills} deliveryRecovery={!!chatPending || !!unlinkedSession} loading={!daemon} variant={mobile ? 'mobile' : 'desktop'} onCreate={createConversation} />}{unlinkedSession && <Button onClick={() => onOpenConversation?.(unlinkedSession)}>{text('생성된 대화 열기', 'Open created conversation')}</Button>}</Dialog>
    <Dialog open={active && prepareOpen} onOpenChange={setPrepareOpen} title={text('실행 준비', 'Prepare execution')} description={text('이 버전의 흐름·설정·참조를 고정합니다. 준비 후 실행 시작을 눌러야 작업합니다.', 'Freeze this graph, settings and references. Work begins only after you start the prepared run.')} closeLabel={text('닫기', 'Close')}
      footer={<><Button onClick={() => setPrepareOpen(false)}>{text('취소', 'Cancel')}</Button><Button disabled={readOnly || !!local || issues.length > 0 || !models[reviewer.providerId]?.some(model => model.id === reviewer.model) || !daemon?.providers.some(provider => provider.id === reviewer.providerId && provider.enabled && provider.health === 'ready')} onClick={() => { const runId = `run-${crypto.randomUUID()}`; void execute({ type: 'run.prepare', payload: { runId, reviewer } }).then(ok => { if (ok) { setPreparedRunId(runId); setPrepareOpen(false); setRunView(false); setView('run'); } }); }}>{text('이 버전 준비', 'Prepare this version')}</Button></>}>
      <p>{selected?.title} · v{selected?.revision}</p>
      {/* The person's switch; agents may run the flow but never turn this on. Frozen into each run at preparation. */}
      <Switch checked={selected?.autoApprove === true} disabled={readOnly || !!local}
        onChange={event => void execute({ type: 'subproject.update', payload: { autoApprove: event.target.checked } })}
        label={text('자동 승인', 'Auto-approve')}
        description={text('켜면 이 소프로젝트에서 준비하는 실행은 승인 단계와 결과 통합 허용을 사람 대신 처리하고 기록에 남깁니다. 이미 준비된 실행에는 적용되지 않습니다.',
          'When on, runs prepared from this subproject pass approval stages and allow result integration without you, and the run records it. Runs already prepared keep their setting.')}
        data-testid="workflow-auto-approve" />
      <Field label={text('독립 검토 AI', 'Independent reviewer')}><Select value={reviewer.providerId} onChange={event => setReviewer({ providerId: event.target.value, model: '' })}><option value="">{text('제공자 선택', 'Choose a provider')}</option>{daemon?.providers.filter(provider => provider.enabled).map(provider => <option key={provider.id} value={provider.id} disabled={provider.health !== 'ready'}>{provider.displayName}{provider.health !== 'ready' ? text(' · 사용 불가', ' · Unavailable') : ''}</option>)}</Select></Field>
      <Field label={text('검토 모델', 'Reviewer model')}><Select value={reviewer.model} onChange={event => setReviewer({ ...reviewer, model: event.target.value })}><option value="">{text('모델 선택', 'Choose a model')}</option>{models[reviewer.providerId]?.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</Select></Field>
      {!models[reviewer.providerId]?.length && <p role="status">{text('사용 가능한 검토 모델을 확인하지 못했습니다. 제공자 연결을 확인하고 다시 불러오세요.', 'No reviewer models are available. Check the provider connection and refresh.')}</p>}
      <ul>{graph?.nodes.filter(item => item.operation === 'agent').map(item => <li key={item.id}>{item.title} · {item.providerId} · {item.model} · {workflowPermissionLabel(item.permissionPreset, text)}</li>)}</ul>
    </Dialog>
  </section>;
}
