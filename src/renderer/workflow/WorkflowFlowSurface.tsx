import { TriangleAlert } from 'lucide-react';
import { useMemo, useState, type ComponentType } from 'react';
import type { ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowGraph, WorkflowIssue, WorkflowNode } from '../../shared/workflow-graph';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import { Button, Dialog, Status } from '../ui';
import { layoutWorkflowGraph, resolveCanvasView, type WorkflowPanelSection } from './workflow-canvas-model';
import type { CanvasSelection, WorkflowCanvasRendererProps } from './workflow-canvas-types';
import { WorkflowCanvasHeader, type WorkflowRunCommandInput } from './WorkflowCanvasHeader';
import { WorkflowNodeRunSection, WorkflowStageSection, type WorkflowStageLink } from './WorkflowNodeSections';
import { WorkflowEdgeInspector, WorkflowNodeSettings } from './WorkflowNodeSettings';
import { workflowRunStatusPresentation } from './WorkflowNodeCard';
import { WorkflowOutline } from './WorkflowOutline';
import { WorkflowCanvasBoundary, WorkflowStaticGraph } from './WorkflowStaticGraph';
import { workflowIssueLabel, workflowOperationLabel, workflowOutcomeLabel, type WorkflowCopy } from './workflow-copy';
import './workflow-canvas.css';

export interface WorkflowFlowSurfaceProps {
  readonly text: WorkflowCopy;
  readonly mobile?: boolean;
  readonly savedGraph: WorkflowGraph;
  readonly draftGraph: WorkflowGraph | null;
  readonly revision: number;
  readonly archivedNodes: readonly WorkflowNode[];
  readonly runs: readonly ExecutionRun[];
  readonly editLocked: boolean;
  readonly commandsDisabled: boolean;
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
  readonly onPrepareRun: () => void;
  readonly onRunCommand: (command: WorkflowRunCommandInput) => void;
  readonly stageLinks: (nodeId: string) => readonly WorkflowStageLink[];
  readonly canStartStageChat: boolean;
  readonly onStartStageChat: (nodeId: string) => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenResults?: (runId: string) => void;
  readonly onOpenAttemptResult?: (runId: string, attemptId: string) => void;
  /** Desktop injects the React Flow canvas; without it (Android, tests) the static graph draws. */
  readonly canvasRenderer?: ComponentType<WorkflowCanvasRendererProps>;
  readonly active?: boolean;
  readonly initialViewport?: WorkflowCanvasRendererProps['initialViewport'];
}

function cardSize(): { width: number; height: number } {
  const rem = typeof document === 'undefined' ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return { width: 15.5 * rem, height: 8.5 * rem };
}

/**
 * The subproject flow as one canvas: build it, run it and act on its stages in one place.
 * Presentational: all data and commands come from WorkflowWorkspacePanel.
 */
export function WorkflowFlowSurface(props: WorkflowFlowSurfaceProps): JSX.Element {
  const { text, selection, section } = props;
  const view = resolveCanvasView({ savedGraph: props.savedGraph, draftGraph: props.draftGraph, runs: props.runs, pickedRunId: props.pickedRunId, runView: props.runView });
  const editable = view.editable && !props.editLocked;
  const [removeId, setRemoveId] = useState<string | null>(null);
  const issueCounts = useMemo(() => props.issues.reduce<Record<string, number>>((counts, issue) => { if (issue.nodeId) counts[issue.nodeId] = (counts[issue.nodeId] ?? 0) + 1; return counts; }, {}), [props.issues]);
  const node = selection?.kind === 'node' ? view.graph.nodes.find(item => item.id === selection.id) ?? props.archivedNodes.find(item => item.id === selection.id) : undefined;
  const archived = !!node && !view.graph.nodes.some(item => item.id === node.id);
  const edge = selection?.kind === 'edge' ? view.graph.edges.find(item => item.id === selection.id) : undefined;
  const awaiting = (view.overlay?.awaitingApproval ?? []).map(entry => ({ nodeId: entry.nodeId, title: view.graph.nodes.find(item => item.id === entry.nodeId)?.title ?? entry.nodeId }));
  const select = (next: CanvasSelection) => { props.onSelectionChange(next); if (next?.kind === 'node' && view.overlay?.nodes[next.id]?.status === 'awaiting-approval') props.onSectionChange('run'); };
  const change = (graph: WorkflowGraph) => { if (editable) props.onGraphChange(graph); };
  const Renderer = props.layout === 'graph' ? props.canvasRenderer ?? WorkflowStaticGraph : null;
  const staticRenderer = Renderer === WorkflowStaticGraph;
  const rendererProps: WorkflowCanvasRendererProps = {
    graph: view.graph, overlay: view.overlay, editable, selection, onSelect: select, onGraphChange: change, text, issueCounts,
    label: text('흐름 캔버스', 'Flow canvas'), active: props.active, initialViewport: props.initialViewport, onRequestDeleteNode: editable ? setRemoveId : undefined,
  };
  const removeNode = (id: string) => change({ ...view.graph, nodes: view.graph.nodes.filter(item => item.id !== id), edges: view.graph.edges.filter(item => item.from !== id && item.to !== id), entryNodeId: view.graph.entryNodeId === id ? null : view.graph.entryNodeId });
  const sections: Array<[WorkflowPanelSection, string]> = [['settings', text('설정', 'Settings')], ['stage', text('단계 문서·대화', 'Stage documents and chats')], ['run', text('실행 상태', 'Run status')]];

  return <div className="workflow-flow" data-mode={view.mode} data-mobile={props.mobile || undefined}>
    <WorkflowCanvasHeader text={text} mode={view.mode} revision={props.revision} hasLocalDraft={!!props.draftGraph} diverged={view.diverged} run={view.run} runs={props.runs}
      editLocked={props.editLocked || view.mode === 'run-view'} commandsDisabled={props.commandsDisabled} issueCount={props.issues.length} awaiting={awaiting}
      layout={props.layout} onLayoutChange={props.onLayoutChange} onPickRun={props.onPickRun} onRunView={props.onRunViewChange}
      onJumpToNode={id => { select({ kind: 'node', id }); props.onSectionChange('run'); }}
      onSaveDraft={props.onSaveDraft} onDiscardDraft={props.onDiscardDraft} onAutoLayout={() => change(layoutWorkflowGraph(view.graph, cardSize()))}
      onPrepareRun={props.onPrepareRun} onRunCommand={props.onRunCommand} onOpenConversation={props.onOpenConversation} onOpenResults={props.onOpenResults} />
    <div className="workflow-flow__body">
      <div className="workflow-flow__canvas">
        {Renderer ? <WorkflowCanvasBoundary fallback={retry => <div className="workflow-flow__fallback">
          <p role="alert" className="workflow-notice">{text('캔버스를 불러오지 못해 간단한 그래프로 보여 줍니다. 편집은 오른쪽 패널과 목록에서 할 수 있습니다.', 'The canvas did not load, so a simple graph is shown. Edit in the panel and the list.')}</p>
          <Button size="sm" onClick={retry}>{text('캔버스 다시 불러오기', 'Reload the canvas')}</Button>
          <WorkflowStaticGraph {...rendererProps} />
        </div>}><Renderer {...rendererProps} /></WorkflowCanvasBoundary>
          : <WorkflowOutline graph={view.graph} overlay={view.overlay} selection={selection} onSelect={select} text={text} />}
      </div>
      <aside className="workflow-flow__panel" aria-label={node ? node.title : edge ? text('연결', 'Connection') : text('흐름 요약', 'Flow summary')}>
        {node ? <>
          <div className="workflow-flow__panel-head"><small>{workflowOperationLabel(node.operation, text)}{view.graph.entryNodeId === node.id ? text(' · 시작', ' · Entry') : ''}</small><h3>{node.title}</h3></div>
          <div className="workflow-toolbar workflow-tabs workflow-flow__sections" role="group" aria-label={text('단계 패널', 'Stage panel')}>
            {sections.map(([value, label]) => <Button key={value} aria-pressed={section === value} onClick={() => props.onSectionChange(value)}>{label}</Button>)}
          </div>
          {section === 'settings' && <WorkflowNodeSettings graph={view.graph} node={node} text={text} readOnly={!editable || archived} providers={props.providers} onChange={change} onRequestDelete={setRemoveId}
            onMove={staticRenderer && editable ? (id, dy) => change({ ...view.graph, nodes: view.graph.nodes.map(item => item.id === id ? { ...item, position: { ...item.position, y: Math.max(0, item.position.y + dy) } } : item) }) : undefined} />}
          {section === 'stage' && <WorkflowStageSection node={node} text={text} readOnly={!editable} archived={archived} links={props.stageLinks(node.id)} canStartChat={props.canStartStageChat && !props.commandsDisabled}
            onDocumentChange={document => change({ ...view.graph, nodes: view.graph.nodes.map(item => item.id === node.id ? { ...item, document } : item) })}
            onStartChat={() => props.onStartStageChat(node.id)} onOpenConversation={props.onOpenConversation} />}
          {section === 'run' && (view.run && view.overlay
            ? <WorkflowNodeRunSection run={view.run} node={view.run.preparation.workflow?.graph.nodes.find(item => item.id === node.id) ?? node} view={view.overlay.nodes[node.id]} text={text} commandsDisabled={props.commandsDisabled}
              onApprove={(activationId, decision) => props.onRunCommand({ type: 'run.approve', payload: { runId: view.run!.runId, activationId, decision } })}
              onOpenConversation={props.onOpenConversation} onOpenAttemptResult={props.onOpenAttemptResult ? attemptId => props.onOpenAttemptResult!(view.run!.runId, attemptId) : undefined} />
            : <div className="workflow-node-run"><p className="workflow-hint">{view.run ? text('편집 중인 흐름이 실행에 고정된 흐름과 달라 상태를 겹쳐 보이지 않습니다.', 'The draft differs from the flow this run froze, so its state is not overlaid.') : text('아직 이 흐름을 실행하지 않았습니다.', 'This flow has not run yet.')}</p>
              {view.run && <Button onClick={() => props.onRunViewChange(true)}>{text('실행에서 이 단계 보기', 'See this stage in the run')}</Button>}</div>)}
        </> : edge ? <>
          <div className="workflow-flow__panel-head"><small>{text('연결', 'Connection')}</small><h3>{workflowOutcomeLabel(edge.outcome, text)}</h3></div>
          <WorkflowEdgeInspector graph={view.graph} edge={edge} text={text} readOnly={!editable} taken={view.overlay?.edges[edge.id]?.taken} onChange={change} onSelectNode={id => select({ kind: 'node', id })} />
        </> : <div className="workflow-flow__summary">
          <h3>{text('흐름 요약', 'Flow summary')}</h3>
          {view.run && view.overlay && <ul className="workflow-flow__states">{view.graph.nodes.filter(item => view.overlay!.nodes[item.id] && !['pending', 'not-reached'].includes(view.overlay!.nodes[item.id].status)).map(item => {
            const status = workflowRunStatusPresentation(view.overlay!.nodes[item.id], text);
            return <li key={item.id}><Button variant="ghost" onClick={() => select({ kind: 'node', id: item.id })}>{item.title}</Button><Status variant={status.variant} icon={status.variant === 'loading' ? undefined : status.icon}>{status.label}</Status></li>;
          })}</ul>}
          {props.issues.length > 0 && <section className="workflow-validation" aria-label={text('실행 전 확인', 'Before execution')}>
            <h4><TriangleAlert aria-hidden="true" />{text(`실행 전 확인 · ${props.issues.length}`, `Before execution · ${props.issues.length}`)}</h4>
            <ul>{props.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><Button variant="ghost" onClick={() => { if (issue.nodeId) { select({ kind: 'node', id: issue.nodeId }); props.onSectionChange('settings'); } else if (issue.edgeId) select({ kind: 'edge', id: issue.edgeId }); }}>{issue.nodeId ? `${view.graph.nodes.find(item => item.id === issue.nodeId)?.title ?? issue.nodeId}: ` : ''}{workflowIssueLabel(issue, text)}</Button></li>)}</ul>
          </section>}
          <p className="workflow-hint">{props.layout === 'graph'
            ? text('단계를 누르면 설정·문서·실행 상태를 여기서 봅니다. 오른쪽 동그라미(출력)에서 다른 단계의 왼쪽 동그라미로 끌면 연결됩니다.', 'Select a stage to see its settings, document and run status here. Drag from a right-side output circle to another stage\'s left circle to connect.')
            : text('단계를 누르면 설정·문서·실행 상태를 여기서 봅니다.', 'Select a stage to see its settings, document and run status here.')}</p>
        </div>}
      </aside>
    </div>
    <Dialog open={removeId !== null} onOpenChange={open => { if (!open) setRemoveId(null); }} title={text('단계를 삭제할까요?', 'Delete this stage?')}
      description={text('연결도 초안에서 제거합니다. 저장된 대화·문서·실행 기록은 보관됩니다.', 'Connections are removed from the draft. Saved conversations, documents and execution records remain in history.')} closeLabel={text('닫기', 'Close')}
      footer={<><Button onClick={() => setRemoveId(null)}>{text('취소', 'Cancel')}</Button><Button variant="danger" onClick={() => { if (removeId) { removeNode(removeId); if (selection?.id === removeId) props.onSelectionChange(null); } setRemoveId(null); }}>{text('삭제', 'Delete')}</Button></>}>
      <p>{removeId ? view.graph.nodes.find(item => item.id === removeId)?.title ?? removeId : ''}</p>
    </Dialog>
  </div>;
}
