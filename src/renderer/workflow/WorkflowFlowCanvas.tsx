import {
  Background, BackgroundVariant, EdgeLabelRenderer, Handle, MiniMap, Panel, Position, ReactFlow, useNodesInitialized, useReactFlow, useStore, useUpdateNodeInternals,
  type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps, type OnBeforeDelete, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './workflow-flow-canvas.css';
import { glyphIcon } from '../ui/Glyph';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { workflowOutcomePorts, type WorkflowEdge, type WorkflowNode } from '../../shared/workflow-graph';
import { IconButton } from '../ui';
import { canConnectWorkflow, connectWorkflowEdge, reconnectWorkflowEdge, workflowBackwardDepths, workflowEdgeBadge, workflowEdgePath, workflowFitPadding, type WorkflowEdgeRunView, type WorkflowNodeRunView } from './workflow-canvas-model';
import type { WorkflowCanvasRendererProps } from './workflow-canvas-types';
import { WORKFLOW_CARD_UNITS, useWorkflowScale } from './use-workflow-scale';
import { WorkflowNodeCard, workflowRunStatusPresentation } from './WorkflowNodeCard';
import { workflowOperationLabel, workflowOutcomeLabel, type WorkflowCopy } from './workflow-copy';

/**
 * Desktop canvas on React Flow. This is the only module that imports @xyflow/react; the panel
 * receives it as an injected renderer so the shared workspace (and Android) never bundles it.
 */
type StageData = { stage: WorkflowNode; entry: boolean; run?: WorkflowNodeRunView; text: WorkflowCopy; editable: boolean; issues: number };
type StageNode = Node<StageData, 'stage'>;
type FlowEdgeData = { badge: string | null; run?: WorkflowEdgeRunView; retry: boolean; marker: string; depth: number; scale: number };
type FlowEdge = Edge<FlowEdgeData, 'workflow'>;

function StageNodeView({ id, data, selected }: NodeProps<StageNode>): JSX.Element {
  // A new operation brings new ports; React Flow re-reads handles only on resize unless told.
  const updateInternals = useUpdateNodeInternals();
  const ports = workflowOutcomePorts(data.stage.operation).join(' ');
  useEffect(() => { updateInternals(id); }, [id, ports, updateInternals]);
  return <WorkflowNodeCard node={data.stage} text={data.text} entry={data.entry} selected={selected} run={data.run} issueCount={data.issues}
    inputHandle={<Handle type="target" position={Position.Left} id="in" className="wf-handle" isConnectable={data.editable} />}
    outputHandle={outcome => <Handle type="source" position={Position.Right} id={outcome} className="wf-handle" isConnectable={data.editable} />} />;
}
function WorkflowEdgeView({ sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<FlowEdge>): JSX.Element {
  const path = workflowEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, data?.depth ?? 0, data?.scale ?? 1);
  return <>
    <path className="workflow-edge-path" d={path.d} markerEnd={data ? `url(#${data.marker})` : undefined} data-retry={data?.retry ? '' : undefined}
      data-run={data?.run ? (data.run.taken > 0 ? 'taken' : 'idle') : undefined} data-selected={selected ? '' : undefined} />
    <path className="react-flow__edge-interaction" d={path.d} fill="none" strokeOpacity={0} strokeWidth={16} />
    {data?.badge && <EdgeLabelRenderer><span className="workflow-edge-badge workflow-canvas__badge" style={{ transform: `translate(-50%, -50%) translate(${path.labelX}px, ${path.labelY}px)` }}>{data.badge}</span></EdgeLabelRenderer>}
  </>;
}
const nodeTypes = { stage: StageNodeView };
const edgeTypes = { workflow: WorkflowEdgeView };

/** Fits the flow above the minimap corner while the map shows (a narrow canvas hides it; see the CSS). */
function useWorkflowFit(): (options?: { maxZoom?: number }) => void {
  const flow = useReactFlow();
  const root = useStore(state => state.domNode);
  return useCallback((options = {}) => {
    const map = root?.querySelector('.react-flow__minimap')?.getBoundingClientRect();
    const mapReserve = root && map && map.height > 0 ? root.getBoundingClientRect().bottom - map.top : 0;
    void flow.fitView({ ...options, padding: workflowFitPadding(mapReserve) });
  }, [flow, root]);
}
function CanvasControls({ text, onTidy }: { text: WorkflowCopy; onTidy?: () => void }): JSX.Element {
  const flow = useReactFlow();
  const fit = useWorkflowFit();
  return <Panel position="top-right" className="workflow-canvas__controls" aria-label={text('캔버스 보기', 'Canvas view')}>
    <IconButton icon={glyphIcon('zoomIn')} aria-label={text('확대', 'Zoom in')} onClick={() => void flow.zoomIn()} />
    <IconButton icon={glyphIcon('zoomOut')} aria-label={text('축소', 'Zoom out')} onClick={() => void flow.zoomOut()} />
    <IconButton icon={glyphIcon('expand')} aria-label={text('전체 보기', 'Fit view')} onClick={() => fit()} />
    {onTidy && <IconButton icon={glyphIcon('grid')} aria-label={text('자동 정렬', 'Tidy layout')} onClick={onTidy} />}
  </Panel>;
}
/** Fit once, the first time the canvas is visible with measured cards; later fits are the user's. */
function FitOnFirstShow({ active, skip }: { active: boolean; skip: boolean }): null {
  const fit = useWorkflowFit();
  const initialized = useNodesInitialized();
  const done = useRef(skip);
  useEffect(() => {
    if (done.current || !active || !initialized) return;
    done.current = true;
    fit({ maxZoom: 1 });
  }, [active, fit, initialized]);
  return null;
}
/** Centres a stage on request (approval chip, summary list) without changing the zoom. */
function RevealNode({ reveal, onRevealed }: { reveal?: WorkflowCanvasRendererProps['reveal']; onRevealed?: () => void }): null {
  const flow = useReactFlow();
  useEffect(() => {
    if (!reveal) return;
    const node = flow.getInternalNode(reveal.nodeId);
    if (node) {
      const { x, y } = node.internals.positionAbsolute;
      void flow.setCenter(x + (node.measured.width ?? 0) / 2, y + (node.measured.height ?? 0) / 2, { zoom: flow.getZoom(), duration: 0 });
    }
    onRevealed?.();
  }, [flow, onRevealed, reveal]);
  return null;
}
const DIRECTION_KO: Record<string, string> = { up: '위', down: '아래', left: '왼', right: '오른' };

export function WorkflowFlowCanvas({ graph, overlay, editable, selection, onSelect, onGraphChange, text, label, issueCounts, initialViewport, active = true, onRequestDeleteNode, reveal, onViewportChange, onTidy, onRevealed, onCardSize }: WorkflowCanvasRendererProps): JSX.Element {
  const marker = `workflow-arrow-${useId().replace(/:/gu, '')}`;
  const scale = useWorkflowScale();
  const [dragging, setDragging] = useState<Record<string, XYPosition>>({});
  const draggingRef = useRef(dragging);
  // Controlled nodes must carry React Flow's measurements back, or rebuilt node objects stay
  // uninitialized: hidden and refusing to drag (React Flow error #015).
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  // React Flow reports the new selection before the old one's deselection, possibly in separate
  // node/edge callbacks; this ref sees the newest choice so a late deselect cannot clear it.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const choose = useCallback((next: typeof selection) => { selectionRef.current = next; onSelect(next); }, [onSelect]);
  useEffect(() => {
    const sizes = Object.values(measured);
    if (!sizes.length || !onCardSize) return;
    onCardSize({ width: Math.max(...sizes.map(size => size.width)) / scale, height: Math.max(...sizes.map(size => size.height)) / scale });
  }, [measured, onCardSize, scale]);
  const titleOf = useCallback((id: string) => graph.nodes.find(node => node.id === id)?.title ?? id, [graph.nodes]);
  const depths = useMemo(() => workflowBackwardDepths(graph, WORKFLOW_CARD_UNITS.width), [graph]);
  const nodes = useMemo<StageNode[]>(() => graph.nodes.map(node => {
    const run = overlay?.nodes[node.id];
    return {
      id: node.id, type: 'stage', position: dragging[node.id] ?? { x: node.position.x * scale, y: node.position.y * scale },
      draggable: editable, connectable: editable, deletable: editable && !!onRequestDeleteNode,
      ...(measured[node.id] ? { measured: measured[node.id] } : {}),
      selected: selection?.kind === 'node' && selection.id === node.id,
      ariaLabel: [node.title, workflowOperationLabel(node.operation, text), run ? workflowRunStatusPresentation(run, text).label : ''].filter(Boolean).join(', '),
      data: { stage: node, entry: graph.entryNodeId === node.id, run, text, editable, issues: issueCounts?.[node.id] ?? 0 },
    };
  }), [dragging, editable, graph.entryNodeId, graph.nodes, issueCounts, measured, onRequestDeleteNode, overlay, scale, selection, text]);
  const edges = useMemo<FlowEdge[]>(() => graph.edges.filter(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to)).map(edge => ({
    id: edge.id, source: edge.from, target: edge.to, sourceHandle: edge.outcome, targetHandle: 'in', type: 'workflow', deletable: editable, reconnectable: editable,
    selected: selection?.kind === 'edge' && selection.id === edge.id,
    ariaLabel: `${titleOf(edge.from)} · ${workflowOutcomeLabel(edge.outcome, text)} → ${titleOf(edge.to)}`,
    data: { badge: workflowEdgeBadge(edge, overlay?.edges[edge.id], text), run: overlay?.edges[edge.id], retry: Boolean(edge.retryLimit), marker, depth: depths[edge.id] ?? 0, scale },
  })), [depths, editable, graph.edges, graph.nodes, marker, overlay, scale, selection, text, titleOf]);

  const onNodesChange = useCallback((changes: NodeChange<StageNode>[]) => {
    const sizes = changes.flatMap(change => change.type === 'dimensions' && change.dimensions ? [[change.id, change.dimensions] as const] : []);
    if (sizes.length) setMeasured(current => ({ ...current, ...Object.fromEntries(sizes) }));
    const moving = { ...draggingRef.current }; const commits: Record<string, XYPosition> = {}; let moved = false;
    for (const change of changes) {
      if (change.type !== 'position') continue;
      moved = true;
      if (change.dragging && change.position) moving[change.id] = change.position;
      else if (!change.dragging) { const at = change.position ?? moving[change.id]; if (at) commits[change.id] = at; delete moving[change.id]; }
    }
    if (moved) { draggingRef.current = moving; setDragging(moving); }
    // Drag end and arrow-key moves both arrive as a non-dragging position change: one draft update.
    if (Object.keys(commits).length && editable) onGraphChange({ ...graph, nodes: graph.nodes.map(node => commits[node.id] ? { ...node, position: { x: Math.round(commits[node.id].x / scale), y: Math.round(commits[node.id].y / scale) } } : node) });
    const picked = changes.find(change => change.type === 'select' && change.selected);
    if (picked && 'id' in picked) choose({ kind: 'node', id: picked.id });
    // Escape deselects: clear only if the node leaving the selection is still the current one.
    else { const current = selectionRef.current; if (current?.kind === 'node' && changes.some(change => change.type === 'select' && !change.selected && change.id === current.id)) choose(null); }
  }, [choose, editable, graph, onGraphChange, scale]);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    const removed = new Set(changes.filter(change => change.type === 'remove').map(change => change.id));
    if (removed.size && editable) { onGraphChange({ ...graph, edges: graph.edges.filter(edge => !removed.has(edge.id)) }); choose(null); return; }
    const picked = changes.find(change => change.type === 'select' && change.selected);
    if (picked && 'id' in picked) choose({ kind: 'edge', id: picked.id });
    else { const current = selectionRef.current; if (current?.kind === 'edge' && changes.some(change => change.type === 'select' && !change.selected && change.id === current.id)) choose(null); }
  }, [choose, editable, graph, onGraphChange]);
  // Dragging an existing connection's end moves it; the port it now leaves from becomes its outcome.
  const onReconnect = useCallback((old: FlowEdge, connection: Connection) => {
    if (!editable || !connection.sourceHandle) return;
    const next = reconnectWorkflowEdge(graph, old.id, connection.source, connection.sourceHandle as WorkflowEdge['outcome'], connection.target);
    if (next) onGraphChange(next);
  }, [editable, graph, onGraphChange]);
  const onBeforeDelete = useCallback<OnBeforeDelete<StageNode, FlowEdge>>(async ({ nodes: doomed, edges: doomedEdges }) => {
    if (doomed.length) { onRequestDeleteNode?.(doomed[0].id); return false; }
    return { nodes: [], edges: doomedEdges };
  }, [onRequestDeleteNode]);
  const isValidConnection = useCallback((connection: Connection | FlowEdge) => Boolean(connection.sourceHandle) && canConnectWorkflow(graph, connection.source, connection.sourceHandle as WorkflowEdge['outcome'], connection.target), [graph]);
  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) return;
    onGraphChange(connectWorkflowEdge(graph, connection.source, connection.sourceHandle as WorkflowEdge['outcome'], connection.target, `edge-${crypto.randomUUID()}`));
  }, [graph, isValidConnection, onGraphChange]);
  const ariaLabelConfig = useMemo(() => ({
    // React Flow shows 'keyboardDisabled' while keyboard movement is ON (its key names are inverted).
    'node.a11yDescription.default': text('Enter 또는 Space로 단계를 선택합니다. Esc로 선택을 취소합니다.', 'Press Enter or Space to select a stage. Press Escape to clear.'),
    'node.a11yDescription.keyboardDisabled': text('Enter 또는 Space로 선택한 뒤 화살표 키로 위치를 옮깁니다.', 'Press Enter or Space to select, then use the arrow keys to move it.'),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) => text(`단계를 ${DIRECTION_KO[direction] ?? direction}쪽으로 옮겼습니다. 위치 x ${Math.round(x)}, y ${Math.round(y)}`, `Moved the stage ${direction}. Position x ${Math.round(x)}, y ${Math.round(y)}`),
    'edge.a11yDescription.default': text('Enter 또는 Space로 연결을 선택하고 Delete로 지웁니다.', 'Press Enter or Space to select a connection, then Delete to remove it.'),
    'controls.ariaLabel': text('캔버스 보기', 'Canvas view'), 'controls.zoomIn.ariaLabel': text('확대', 'Zoom in'), 'controls.zoomOut.ariaLabel': text('축소', 'Zoom out'),
    'controls.fitView.ariaLabel': text('전체 보기', 'Fit view'), 'controls.interactive.ariaLabel': text('조작 잠금', 'Toggle interactivity'),
    'minimap.ariaLabel': text('미니맵', 'Mini map'), 'handle.ariaLabel': text('연결 핸들', 'Connection handle'),
  }), [text]);

  return <div className="workflow-canvas" data-renderer="react-flow" role="region" aria-label={label}>
    <svg className="workflow-canvas__defs" aria-hidden="true"><defs><marker id={marker} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,1 L8,5 L0,9" /></marker></defs></svg>
    <ReactFlow<StageNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onBeforeDelete={onBeforeDelete} onConnect={onConnect} onReconnect={onReconnect} isValidConnection={isValidConnection}
      onMoveEnd={(_event, viewport) => onViewportChange?.(viewport)}
      onPaneClick={() => choose(null)} nodesDraggable={editable} nodesConnectable={editable} elementsSelectable
      deleteKeyCode={editable ? ['Delete', 'Backspace'] : null} elevateNodesOnSelect={false} minZoom={0.3} maxZoom={2}
      {...(initialViewport ? { defaultViewport: initialViewport } : {})} ariaLabelConfig={ariaLabelConfig}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
      <MiniMap pannable zoomable ariaLabel={text('미니맵', 'Mini map')} nodeClassName={node => `workflow-mini workflow-mini--${(node as StageNode).data.run?.status ?? 'none'}`} />
      <CanvasControls text={text} onTidy={editable ? onTidy : undefined} />
      <FitOnFirstShow active={active} skip={!!initialViewport} />
      <RevealNode reveal={reveal} onRevealed={onRevealed} />
    </ReactFlow>
  </div>;
}
export default WorkflowFlowCanvas;
