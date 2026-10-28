import { Glyph } from '../ui/Glyph';
import { Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { ProviderModel } from '../../shared/daemon-provider';
import { blockingRunOf, stageEditScope, stageWorking, type ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowRepeat, WorkflowRepeatStatus, WorkflowSubproject } from '../../shared/workflow';
import type { WorkflowGraph, WorkflowIssue, WorkflowNode } from '../../shared/workflow-graph';
import { flowRunNumber } from '../../shared/workflow-run-view';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import { Button, Dialog, LoadingState, Status, VisuallyHidden } from '../ui';
import { layoutWorkflowGraph, resolveCanvasView, workflowLayoutOverlaps, workflowRunControls, type WorkflowPanelSection } from './workflow-canvas-model';
import type { CanvasSelection, WorkflowCanvasRendererProps, WorkflowEdgeDecoration, WorkflowNodeDecoration } from './workflow-canvas-types';
import { WorkflowCanvasHeader, type WorkflowRunCommandInput } from './WorkflowCanvasHeader';
import type { WorkflowStageLink } from './WorkflowNodeSections';
import { WorkflowEdgeInspector } from './WorkflowNodeSettings';
import { WorkflowRunBar } from './WorkflowRunBar';
import { useRunIntegration } from './use-run-integration';
import type { PlanningResultReader } from '../PlanningResultDetails';
import { WorkflowStagePanel } from './WorkflowStagePanel';
import { workflowRunStatusPresentation } from './WorkflowNodeCard';
import { WorkflowOutline } from './WorkflowOutline';
import { WorkflowCanvasBoundary, WorkflowStaticGraph } from './WorkflowStaticGraph';
import { workflowIssueLabel, workflowOperationLabel, workflowOutcomeLabel, workflowStateLabel, type WorkflowCopy } from './workflow-copy';
import { WORKFLOW_CARD_UNITS } from './use-workflow-scale';
import './workflow-canvas.css';

export interface WorkflowFlowSurfaceProps {
  readonly text: WorkflowCopy;
  readonly mobile?: boolean;
  readonly savedGraph: WorkflowGraph;
  readonly draftGraph: WorkflowGraph | null;
  readonly revision: number;
  readonly archivedNodes: readonly WorkflowNode[];
  readonly runs: readonly ExecutionRun[];
  /** What every run of this flow uses (승인, 검토 AI), saved on the subproject. */
  readonly subproject: Pick<WorkflowSubproject, 'id' | 'autoApprove' | 'runSettings' | 'status' | 'repeat'>;
  readonly repeatStatus?: WorkflowRepeatStatus;
  /** Folders this host removed (desktop; see 작업 폴더 정리). */
  readonly cleanedFolders?: readonly import('../../shared/run-retention').CleanedFolderEntry[];
  readonly onSaveRepeat?: (repeat: WorkflowRepeat) => void;
  readonly onOpenAutomationSettings?: () => void;
  /** Model catalogs per provider (the efforts each model offers). */
  readonly catalogs?: Readonly<Record<string, readonly ProviderModel[]>>;
  /** The host keeps run settings and has 다시 실행 as one request (see WorkflowRunBar). */
  readonly savedRunSettings?: boolean;
  /** "흐름 편집": stages and connections can be added, moved and joined. Kept in memory by the workspace. */
  readonly structure: boolean;
  readonly onStructureChange: (open: boolean) => void;
  /** Local editing is closed (archived subproject, pending command, recovery not ready). */
  readonly editLocked: boolean;
  /** Host writes are closed (offline, authority not ready); local edits stay possible. */
  readonly commandsDisabled: boolean;
  readonly commandsBusy?: boolean;
  readonly issues: readonly WorkflowIssue[];
  readonly providers: readonly StructuredAgentProviderOption[];
  readonly selection: CanvasSelection;
  readonly onSelectionChange: (selection: CanvasSelection) => void;
  readonly section: WorkflowPanelSection;
  readonly onSectionChange: (section: WorkflowPanelSection) => void;
  readonly pickedRunId: string | null;
  readonly onPickRun: (runId: string) => void;
  readonly runView: boolean;
  readonly onRunViewChange: (open: boolean) => void;
  readonly layout: 'graph' | 'list';
  readonly onLayoutChange: (layout: 'graph' | 'list') => void;
  readonly onGraphChange: (graph: WorkflowGraph) => void;
  readonly onSaveDraft: () => void;
  readonly onDiscardDraft: () => void;
  /** 다시 실행: the saved flow with its saved settings. */
  readonly onLaunch: () => void;
  readonly onSaveReviewer: (reviewer: { readonly providerId: string; readonly model: string }) => void;
  readonly onAutoApprove: (on: boolean) => void;
  readonly onRunCommand: (command: WorkflowRunCommandInput) => void;
  readonly stageLinks: (nodeId: string) => readonly WorkflowStageLink[];
  readonly canStartStageChat: boolean;
  readonly onStartStageChat: (nodeId: string) => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenResults?: (runId: string) => void;
  readonly onOpenAttemptResult?: (runId: string, attemptId: string) => void;
  /** Reads the host's result records (the run bar's integration lamp); with the project they belong to. */
  readonly readPlanningResult?: PlanningResultReader;
  readonly projectId?: string;
  /** Desktop injects the React Flow canvas (often lazy); without it (Android, tests) the static graph draws. */
  readonly canvasRenderer?: ComponentType<WorkflowCanvasRendererProps>;
  /** Resets a failed lazy canvas so "다시 불러오기" loads it again (the loader keeps a rejected import otherwise). */
  readonly onReloadCanvas?: () => void;
  /** False while the dock tab is hidden: no fit, no dialogs left on top of another tab. */
  readonly active?: boolean;
  readonly initialViewport?: WorkflowCanvasRendererProps['initialViewport'];
  /** Camera per view, owned by the workspace so it survives History and back (memory only). */
  readonly cameras?: Record<string, { x: number; y: number; zoom: number }>;
  /** A stage opened from elsewhere (a chat's "Return to this stage"): show it and bring its panel into view once. */
  readonly revealRequest?: { readonly nodeId: string; readonly key: string };
  readonly onRevealHandled?: () => void;
  /** The stage panel beside the canvas; the workspace keeps the choice. Always open on Android. */
  readonly panelOpen?: boolean;
  readonly onPanelOpenChange?: (open: boolean) => void;
  /** What each stage card shows beyond the stage (agent, chain, checks); see WorkflowNodeDecoration. */
  readonly decorations?: Readonly<Record<string, WorkflowNodeDecoration>>;
  readonly edgeDecorations?: Readonly<Record<string, WorkflowEdgeDecoration>>;
  /** What waiting stages ask for when they are not approvals (run bar), and a note under 반복. */
  readonly awaitingLabel?: (count: number) => string;
  readonly repeatNote?: ReactNode;
  /** Above whatever the side panel shows (the agent list). */
  readonly panelTop?: ReactNode;
  /** A stage's agent settings and what it waits for, in place of the AI · model · effort fields. */
  readonly stageSlots?: (node: WorkflowNode) => { readonly settings?: ReactNode; readonly top?: ReactNode; readonly kindLabel?: string; readonly instructionsLabel?: string; readonly conversationHint?: string; readonly statusLabel?: string } | undefined;
}

const NO_ISSUES: readonly WorkflowIssue[] = [];
const NO_CATALOGS: Readonly<Record<string, readonly ProviderModel[]>> = {};
const OPERATION_DEFAULTS: Partial<Record<WorkflowNode['operation'], Partial<WorkflowNode>>> = { join: { joinPolicy: 'all' } };

/**
 * The subproject flow as one canvas: build it, run it and act on its stages in one place.
 * Presentational: data and commands come from WorkflowWorkspacePanel. Cameras live here in memory.
 */
export function WorkflowFlowSurface(props: WorkflowFlowSurfaceProps): JSX.Element {
  const { text, selection, section, active = true } = props;
  const shownRun = useRef<string | null>(null);
  const view = resolveCanvasView({ savedGraph: props.savedGraph, draftGraph: props.draftGraph, runs: props.runs, pickedRunId: props.pickedRunId, runView: props.runView, shownRunId: shownRun.current });
  shownRun.current = view.run?.runId ?? null;
  const editable = view.editable && !props.editLocked;
  // Moving, adding and connecting stages on the canvas belong to "흐름 편집"; a stage's settings are edited in its panel.
  const shaping = editable && props.structure;
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ nodeId: string; key: number } | undefined>();
  const [announcement, setAnnouncement] = useState('');
  const [canvasFailed, setCanvasFailed] = useState(false);
  // Largest measured card in graph units; titles that wrap make cards taller than the 248x136 base.
  const [card, setCard] = useState<{ width: number; height: number }>(WORKFLOW_CARD_UNITS);
  const onCardSize = useCallback((size: { width: number; height: number }) => setCard(current => {
    const next = { width: Math.max(WORKFLOW_CARD_UNITS.width, Math.ceil(size.width)), height: Math.max(WORKFLOW_CARD_UNITS.height, Math.ceil(size.height)) };
    return next.width === current.width && next.height === current.height ? current : next;
  }), []);
  const onRevealed = useCallback(() => setReveal(undefined), []);
  const localCameras = useRef<Record<string, { x: number; y: number; zoom: number }>>({});
  const cameras = props.cameras ?? localCameras.current;
  const panel = useRef<HTMLElement>(null);
  const panelId = `workflow-panel-${useId().replace(/:/gu, '')}`;
  const panelOpen = props.mobile ? true : props.panelOpen ?? true;
  // Going to a stage on purpose (chip, summary, add, a chat's return) shows its panel; canvas clicks do not.
  const openPanel = () => { if (!panelOpen) props.onPanelOpenChange?.(true); };
  const openPanelRef = useRef(openPanel); openPanelRef.current = openPanel;
  const canvasCell = useRef<HTMLDivElement>(null);
  /** Beside the canvas the panel scrolls on its own; only a panel stacked under it (narrow dock, Android) is brought into view. */
  const showPanel = (block: ScrollLogicalPosition) => requestAnimationFrame(() => {
    const target = panel.current; const cell = canvasCell.current;
    if (!target || (cell && target.getBoundingClientRect().top < cell.getBoundingClientRect().bottom)) return;
    target.scrollIntoView?.({ block });
  });
  const cameraKey = `${view.mode === 'run-view' ? 'run' : 'edit'}:${view.mode === 'run-view' ? view.run?.runId : 'draft'}`;
  // Validation belongs to the draft; the read-only run view shows the frozen flow, which was valid when prepared.
  const issues = view.mode === 'run-view' ? NO_ISSUES : props.issues;
  const issueCounts = useMemo(() => issues.reduce<Record<string, number>>((counts, issue) => { if (issue.nodeId) counts[issue.nodeId] = (counts[issue.nodeId] ?? 0) + 1; return counts; }, {}), [issues]);
  const node = selection?.kind === 'node' ? view.graph.nodes.find(item => item.id === selection.id) ?? props.archivedNodes.find(item => item.id === selection.id) : undefined;
  const archived = !!node && !view.graph.nodes.some(item => item.id === node.id);
  const edge = selection?.kind === 'edge' ? view.graph.edges.find(item => item.id === selection.id) : undefined;
  const awaiting = (view.overlay?.awaitingApproval ?? []).map(entry => ({ nodeId: entry.nodeId, title: view.graph.nodes.find(item => item.id === entry.nodeId)?.title ?? entry.nodeId }));
  const controls = view.run ? workflowRunControls(view.run) : null;
  const runNumber = view.run ? flowRunNumber(props.runs, view.run) : 0;
  // Whether a stage change reaches the run still going: the host binds a stage's own settings before its
  // first send (a host with run settings, I2), while the flow keeps the stages and connections that run froze.
  // A working stage is locked whichever run is shown.
  const going = blockingRunOf(props.runs, props.subproject.id) ?? null;
  const scopeOf = (nodeId: string): ReturnType<typeof stageEditScope> | null => {
    if (!going || view.mode === 'run-view') return null;
    if (stageWorking(going, nodeId)) return 'locked';
    const reaches = props.savedRunSettings !== false && view.mode === 'edit-with-run' && view.run?.runId === going.runId;
    return reaches ? stageEditScope(going, nodeId) : 'next-run';
  };

  const integration = useRunIntegration(props.readPlanningResult, props.projectId, props.subproject.id, view.run);
  // One polite announcement per real change (run state, approvals), not per 4 s poll.
  const summary = view.run ? `${workflowStateLabel(view.run.state, text)}${awaiting.length ? ` · ${text(`승인 대기 ${awaiting.map(item => item.title).join(', ')}`, `awaiting approval: ${awaiting.map(item => item.title).join(', ')}`)}` : ''}` : '';
  const announced = useRef(summary);
  useEffect(() => { if (summary !== announced.current) { announced.current = summary; setAnnouncement(summary); } }, [summary]);
  useEffect(() => { if (!active) setRemoveId(null); }, [active]);
  const { revealRequest } = props;
  const revealHandled = useRef(props.onRevealHandled); revealHandled.current = props.onRevealHandled;
  useEffect(() => {
    if (!revealRequest) return;
    setReveal(current => ({ nodeId: revealRequest.nodeId, key: (current?.key ?? 0) + 1 }));
    openPanelRef.current();
    showPanel('start');
    revealHandled.current?.();
  }, [revealRequest]);

  const select = (next: CanvasSelection) => { props.onSelectionChange(next); if (next?.kind === 'node' && view.overlay?.nodes[next.id]?.status === 'awaiting-approval') props.onSectionChange('run'); };
  const jumpTo = (nodeId: string, nextSection: WorkflowPanelSection) => {
    props.onSelectionChange({ kind: 'node', id: nodeId }); props.onSectionChange(nextSection); openPanel();
    setReveal(current => ({ nodeId, key: (current?.key ?? 0) + 1 }));
    showPanel('nearest');
  };
  const change = (graph: WorkflowGraph) => { if (editable) props.onGraphChange(graph); };
  const addStage = (operation: WorkflowNode['operation']) => {
    const id = `node-${crypto.randomUUID()}`;
    const right = view.graph.nodes.length ? Math.max(...view.graph.nodes.map(item => item.position.x)) + card.width + 96 : 40;
    const anchor = selection?.kind === 'node' ? view.graph.nodes.find(item => item.id === selection.id) : undefined;
    const stage: WorkflowNode = { id, title: workflowOperationLabel(operation, text), operation, role: 'implementation', instructions: '', document: '', acceptance: [], allowedPaths: [], inputs: [], retryLimit: 2, permissionPreset: 'plan',
      position: anchor ? { x: anchor.position.x + card.width + 96, y: anchor.position.y + card.height + 48 } : { x: right, y: 40 }, ...OPERATION_DEFAULTS[operation] };
    change({ ...view.graph, entryNodeId: view.graph.entryNodeId ?? id, nodes: [...view.graph.nodes, stage] });
    jumpTo(id, 'settings');
  };
  const tidy = () => change(layoutWorkflowGraph(view.graph, card));
  const Renderer = props.layout === 'graph' ? props.canvasRenderer ?? WorkflowStaticGraph : null;
  const staticRenderer = Renderer === WorkflowStaticGraph;
  const rendererProps: WorkflowCanvasRendererProps = {
    graph: view.graph, overlay: view.overlay, editable: shaping, selection, onSelect: select, onGraphChange: change, text, issueCounts,
    label: text('흐름 캔버스', 'Flow canvas'), active, initialViewport: cameras[cameraKey] ?? props.initialViewport, onRevealed, onCardSize,
    onViewportChange: viewport => { cameras[cameraKey] = viewport; }, onRequestDeleteNode: shaping ? setRemoveId : undefined, reveal, onTidy: shaping ? tidy : undefined,
    decorations: props.decorations, edgeDecorations: props.edgeDecorations,
  };
  const slots = node ? props.stageSlots?.(node) : undefined;
  const removeNode = (id: string) => change({ ...view.graph, nodes: view.graph.nodes.filter(item => item.id !== id), edges: view.graph.edges.filter(item => item.from !== id && item.to !== id), entryNodeId: view.graph.entryNodeId === id ? null : view.graph.entryNodeId });
  const help = view.graph.nodes.length === 0
    ? text('아직 단계가 없습니다. 위에서 단계 종류를 고르고 "단계 추가"를 누르세요.', 'No stages yet. Pick a stage type above and choose "Add stage".')
    : !staticRenderer && !canvasFailed && props.layout === 'graph' && shaping
      ? text('단계를 누르면 설정·문서·실행 상태를 여기서 봅니다. 오른쪽 동그라미(출력)를 다른 단계의 왼쪽 동그라미로 끌면 연결됩니다.', 'Select a stage to see its settings, document and run status here. Drag from a right-side output circle to another stage\'s left circle to connect.')
      : text('단계를 누르면 그 단계의 대화·설정·실행 상태를 여기서 봅니다. 단계를 더하거나 잇으려면 "흐름 편집"을 누르세요.', 'Select a stage to see its conversation, settings and run status here. To add or connect stages, choose "Edit the flow".');

  return <div className="workflow-flow" data-mode={view.mode} data-mobile={props.mobile || undefined}>
    <VisuallyHidden role="status" aria-live="polite">{announcement}</VisuallyHidden>
    <WorkflowRunBar text={text} run={view.run} runs={props.runs} subproject={props.subproject} providers={props.providers} savedRunSettings={props.savedRunSettings ?? true} commandsDisabled={props.commandsDisabled} commandsBusy={props.commandsBusy}
      hasLocalDraft={!!props.draftGraph} issueCount={props.issues.length} awaiting={awaiting} onLaunch={props.onLaunch} onRunCommand={props.onRunCommand}
      onPickRun={props.onPickRun} onSaveReviewer={props.onSaveReviewer} onAutoApprove={props.onAutoApprove} onJumpToNode={id => jumpTo(id, 'run')}
      repeatStatus={props.repeatStatus} onSaveRepeat={props.onSaveRepeat} onOpenAutomationSettings={props.onOpenAutomationSettings}
      onOpenConversation={props.onOpenConversation} onOpenResults={props.onOpenResults} integration={integration} awaitingLabel={props.awaitingLabel} repeatNote={props.repeatNote} />
    <WorkflowCanvasHeader text={text} mode={view.mode} revision={props.revision} hasLocalDraft={!!props.draftGraph} diverged={view.diverged} run={view.run}
      editLocked={props.editLocked || view.mode === 'run-view'} commandsDisabled={props.commandsDisabled} structure={props.structure} onStructureChange={props.onStructureChange}
      overlapping={workflowLayoutOverlaps(view.graph, card)} layout={props.layout} onLayoutChange={props.onLayoutChange} onRunView={props.onRunViewChange}
      onAddStage={addStage} onSaveDraft={props.onSaveDraft} onDiscardDraft={props.onDiscardDraft} onAutoLayout={tidy}
      panelToggle={props.mobile || !props.onPanelOpenChange ? undefined : { open: panelOpen, controls: panelId, onToggle: () => props.onPanelOpenChange?.(!panelOpen) }} />
    <div className="workflow-flow__body" data-panel={panelOpen ? undefined : 'collapsed'}>
      <div ref={canvasCell} className="workflow-flow__canvas">
        {Renderer ? <WorkflowCanvasBoundary onRetry={props.onReloadCanvas} onFailedChange={setCanvasFailed} fallback={retry => <div className="workflow-flow__fallback">
          <p role="alert" className="workflow-notice">{text('캔버스를 불러오지 못해 간단한 그래프로 보여 줍니다. 편집은 오른쪽 패널과 목록에서 할 수 있습니다.', 'The canvas did not load, so a simple graph is shown. Edit in the panel and the list.')}</p>
          <Button size="sm" onClick={retry}>{text('캔버스 다시 불러오기', 'Reload the canvas')}</Button>
          <WorkflowStaticGraph {...rendererProps} />
        </div>}><Suspense fallback={<LoadingState label={text('캔버스 불러오는 중', 'Loading the canvas')} />}><Renderer key={cameraKey} {...rendererProps} /></Suspense></WorkflowCanvasBoundary>
          : <WorkflowOutline graph={view.graph} overlay={view.overlay} selection={selection} onSelect={select} text={text} decorations={props.decorations} />}
      </div>
      <aside ref={panel} id={panelId} hidden={!panelOpen} className="workflow-flow__panel" aria-label={node ? node.title : edge ? text('연결', 'Connection') : text('흐름 요약', 'Flow summary')}>
        {props.panelTop}
        {node ? <>
          <WorkflowStagePanel key={node.id} text={text} graph={view.graph} node={node} archived={archived} editable={editable} structure={props.structure && view.mode !== 'run-view'}
            run={view.overlay ? view.run : null} runNumber={runNumber} view={view.overlay?.nodes[node.id]} scope={scopeOf(node.id)} recordOpen={section === 'run'}
            runCleaned={!!view.run && !!props.cleanedFolders?.some(entry => entry.kind === 'attempt' && entry.runId === view.run!.runId
              && view.run!.attempts.some(attempt => attempt.attemptId === entry.attemptId && attempt.taskId === node.id))}
            providers={props.providers} catalogs={props.catalogs ?? NO_CATALOGS} commandsDisabled={props.commandsDisabled} links={props.stageLinks(node.id)} canStartChat={props.canStartStageChat}
            onChange={change} onRequestDelete={setRemoveId}
            onMove={(staticRenderer || canvasFailed) && shaping ? (id, dy) => change({ ...view.graph, nodes: view.graph.nodes.map(item => item.id === id ? { ...item, position: { ...item.position, y: Math.max(0, item.position.y + dy) } } : item) }) : undefined}
            onApprove={(activationId, decision) => props.onRunCommand({ type: 'run.approve', payload: { runId: view.run!.runId, activationId, decision } })}
            onStartChat={() => props.onStartStageChat(node.id)} onOpenConversation={props.onOpenConversation}
            settingsSlot={slots?.settings} topSlot={slots?.top} kindLabel={slots?.kindLabel} instructionsLabel={slots?.instructionsLabel} conversationHint={slots?.conversationHint} statusLabel={slots?.statusLabel}
            onOpenAttemptResult={props.onOpenAttemptResult && view.run ? attemptId => props.onOpenAttemptResult!(view.run!.runId, attemptId) : undefined} />
          {view.run && !view.overlay && <div className="workflow-node-run"><p className="workflow-hint">{text('편집 중인 흐름의 단계나 연결이 실행에 고정된 흐름과 달라 상태를 겹쳐 보이지 않습니다.', 'The stages or connections being edited differ from the flow this run froze, so its state is not overlaid.')}</p>
            <Button onClick={() => props.onRunViewChange(true)}>{text('실행에서 이 단계 보기', 'See this stage in the run')}</Button></div>}
        </> : edge ? <>
          <div className="workflow-flow__panel-head"><small>{text('연결', 'Connection')}</small><h3>{workflowOutcomeLabel(edge.outcome, text)}</h3></div>
          <WorkflowEdgeInspector graph={view.graph} edge={edge} text={text} readOnly={!shaping} taken={view.overlay?.edges[edge.id]?.taken} onChange={change} onSelectNode={id => select({ kind: 'node', id })} />
        </> : <div className="workflow-flow__summary">
          <h3>{text('흐름 요약', 'Flow summary')}</h3>
          {controls?.blocked && <p className="workflow-notice">{text('실행이 멈췄습니다. 더 진행할 수 있는 단계가 없습니다. 아래 단계의 기록을 확인하고 초안을 고쳐 새 실행을 준비하세요.', 'The run stopped: no stage can proceed. Check the stages below, fix the draft and prepare a new run.')}</p>}
          {view.run && view.overlay && <ul className="workflow-flow__states">{view.graph.nodes.filter(item => view.overlay!.nodes[item.id] && !['pending', 'not-reached'].includes(view.overlay!.nodes[item.id].status)).map(item => {
            const status = workflowRunStatusPresentation(view.overlay!.nodes[item.id], text);
            return <li key={item.id}><Button variant="ghost" onClick={() => jumpTo(item.id, 'run')}>{item.title}</Button><Status variant={status.variant} icon={status.variant === 'loading' ? undefined : status.icon}>{status.label}</Status></li>;
          })}</ul>}
          {issues.length > 0 && <section className="workflow-validation" aria-label={text('실행 전 확인', 'Before execution')}>
            <h4><Glyph name="warn" />{text(`실행 전 확인 · ${issues.length}`, `Before execution · ${issues.length}`)}</h4>
            <ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}><Button variant="ghost" onClick={() => { if (issue.nodeId) jumpTo(issue.nodeId, 'settings'); else if (issue.edgeId) select({ kind: 'edge', id: issue.edgeId }); }}>{issue.nodeId ? `${view.graph.nodes.find(item => item.id === issue.nodeId)?.title ?? issue.nodeId}: ` : ''}{workflowIssueLabel(issue, text)}</Button></li>)}</ul>
          </section>}
          <p className="workflow-hint">{help}</p>
          {view.graph.nodes.length === 0 && editable && <Button leadingIcon={<Glyph name="plus" />} onClick={() => { props.onStructureChange(true); addStage('agent'); }}>{text('첫 AI 작업 단계 추가', 'Add a first AI task')}</Button>}
        </div>}
      </aside>
    </div>
    <Dialog open={active && removeId !== null} onOpenChange={open => { if (!open) setRemoveId(null); }} title={text('단계를 삭제할까요?', 'Delete this stage?')}
      description={text('연결도 초안에서 제거합니다. 저장된 대화·문서·실행 기록은 보관됩니다.', 'Connections are removed from the draft. Saved conversations, documents and execution records remain in history.')} closeLabel={text('닫기', 'Close')}
      footer={<><Button onClick={() => setRemoveId(null)}>{text('취소', 'Cancel')}</Button><Button variant="danger" disabled={!shaping} onClick={() => { if (removeId && shaping) { removeNode(removeId); if (selection?.id === removeId) props.onSelectionChange(null); } setRemoveId(null); }}>{text('삭제', 'Delete')}</Button></>}>
      <p>{removeId ? view.graph.nodes.find(item => item.id === removeId)?.title ?? removeId : ''}</p>
    </Dialog>
  </div>;
}
