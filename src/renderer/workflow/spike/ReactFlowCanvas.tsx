import {
  Background, BackgroundVariant, EdgeLabelRenderer, Handle, MiniMap, Panel, Position, ReactFlow, useReactFlow,
  type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps, type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { WorkflowEdge, WorkflowNode } from '../../../shared/workflow-graph';
import { IconButton } from '../../ui';
import { canConnectWorkflow, connectWorkflowEdge, workflowEdgeBadge, workflowEdgePath, type WorkflowEdgeRunView, type WorkflowNodeRunView } from '../workflow-canvas-model';
import { WorkflowNodeCard, workflowRunStatusPresentation } from '../WorkflowNodeCard';
import { workflowOperationLabel, workflowOutcomeLabel, type WorkflowCopy } from '../workflow-copy';
import type { WorkflowCanvasRendererProps } from './spike-types';
import './spike.css';

/** A: React Flow renders the same cards and edge shape; it brings drag, connect, zoom and keyboard focus. */
type StageData = { stage: WorkflowNode; entry: boolean; run?: WorkflowNodeRunView; text: WorkflowCopy; editable: boolean };
type StageNode = Node<StageData, 'stage'>;
type FlowEdgeData = { badge: string | null; run?: WorkflowEdgeRunView; retry: boolean; marker: string };
type FlowEdge = Edge<FlowEdgeData, 'workflow'>;

function StageNodeView({ data, selected }: NodeProps<StageNode>): JSX.Element {
  return <WorkflowNodeCard node={data.stage} text={data.text} entry={data.entry} selected={selected} run={data.run}
    inputHandle={<Handle type="target" position={Position.Left} id="in" className="wf-handle" isConnectable={data.editable} />}
    outputHandle={outcome => <Handle type="source" position={Position.Right} id={outcome} className="wf-handle" isConnectable={data.editable} />} />;
}
function WorkflowEdgeView({ sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<FlowEdge>): JSX.Element {
  const path = workflowEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
  return <>
    <path className="workflow-edge-path" d={path.d} markerEnd={data ? `url(#${data.marker})` : undefined} data-retry={data?.retry ? '' : undefined}
      data-run={data?.run ? (data.run.taken > 0 ? 'taken' : 'idle') : undefined} data-selected={selected ? '' : undefined} />
    <path className="react-flow__edge-interaction" d={path.d} fill="none" strokeOpacity={0} strokeWidth={16} />
    {data?.badge && <EdgeLabelRenderer><span className="workflow-edge-badge wf-rf__badge" style={{ transform: `translate(-50%, -50%) translate(${path.labelX}px, ${path.labelY}px)` }}>{data.badge}</span></EdgeLabelRenderer>}
  </>;
}
const nodeTypes = { stage: StageNodeView };
const edgeTypes = { workflow: WorkflowEdgeView };

function CanvasControls({ text }: { text: WorkflowCopy }): JSX.Element {
  const flow = useReactFlow();
  return <Panel position="top-right" className="wf-canvas__controls wf-rf__controls" aria-label={text('캔버스 보기', 'Canvas view')}>
    <IconButton icon={ZoomIn} aria-label={text('확대', 'Zoom in')} onClick={() => void flow.zoomIn()} />
    <IconButton icon={ZoomOut} aria-label={text('축소', 'Zoom out')} onClick={() => void flow.zoomOut()} />
    <IconButton icon={Maximize} aria-label={text('전체 보기', 'Fit view')} onClick={() => void flow.fitView({ padding: 0.12 })} />
  </Panel>;
}

export function ReactFlowCanvas({ graph, overlay, editable, selection, onSelect, onGraphChange, text }: WorkflowCanvasRendererProps): JSX.Element {
  const marker = `wf-rf-arrow-${useId().replace(/:/gu, '')}`;
  const [dragging, setDragging] = useState<Record<string, XYPosition>>({});
  const draggingRef = useRef(dragging);
  // Controlled nodes must carry React Flow's measurements back, or rebuilt node objects stay uninitialized (hidden, not draggable).
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const titleOf = useCallback((id: string) => graph.nodes.find(node => node.id === id)?.title ?? id, [graph.nodes]);
  const nodes = useMemo<StageNode[]>(() => graph.nodes.map(node => {
    const run = overlay?.nodes[node.id];
    return {
      id: node.id, type: 'stage', position: dragging[node.id] ?? node.position, draggable: editable, connectable: editable, deletable: false,
      ...(measured[node.id] ? { measured: measured[node.id] } : {}),
      selected: selection?.kind === 'node' && selection.id === node.id,
      ariaLabel: [node.title, workflowOperationLabel(node.operation, text), run ? workflowRunStatusPresentation(run, text).label : ''].filter(Boolean).join(', '),
      data: { stage: node, entry: graph.entryNodeId === node.id, run, text, editable },
    };
  }), [dragging, editable, graph.entryNodeId, graph.nodes, measured, overlay, selection, text]);
  const edges = useMemo<FlowEdge[]>(() => graph.edges.filter(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to)).map(edge => ({
    id: edge.id, source: edge.from, target: edge.to, sourceHandle: edge.outcome, targetHandle: 'in', type: 'workflow', deletable: editable,
    selected: selection?.kind === 'edge' && selection.id === edge.id,
    ariaLabel: `${titleOf(edge.from)} · ${workflowOutcomeLabel(edge.outcome, text)} → ${titleOf(edge.to)}`,
    data: { badge: workflowEdgeBadge(edge, overlay?.edges[edge.id], text), run: overlay?.edges[edge.id], retry: Boolean(edge.retryLimit), marker },
  })), [editable, graph.edges, graph.nodes, marker, overlay, selection, text, titleOf]);

  const onNodesChange = useCallback((changes: NodeChange<StageNode>[]) => {
    const commits: Record<string, XYPosition> = {};
    const sizes = changes.filter(change => change.type === 'dimensions' && change.dimensions);
    if (sizes.length) setMeasured(current => {
      const next = { ...current };
      for (const change of sizes) if (change.type === 'dimensions' && change.dimensions) next[change.id] = change.dimensions;
      return next;
    });
    const moving = { ...draggingRef.current }; let moved = false;
    for (const change of changes) {
      if (change.type !== 'position') continue;
      moved = true;
      if (change.dragging && change.position) moving[change.id] = change.position;
      else if (!change.dragging) { const at = change.position ?? moving[change.id]; if (at) commits[change.id] = at; delete moving[change.id]; }
    }
    if (moved) { draggingRef.current = moving; setDragging(moving); }
    // Drag end and arrow-key moves both arrive as a non-dragging position change: commit once to the draft.
    if (Object.keys(commits).length && editable) onGraphChange({ ...graph, nodes: graph.nodes.map(node => commits[node.id] ? { ...node, position: { x: Math.round(commits[node.id].x), y: Math.round(commits[node.id].y) } } : node) });
    const picked = changes.find(change => change.type === 'select' && change.selected);
    if (picked && 'id' in picked) onSelect({ kind: 'node', id: picked.id });
  }, [editable, graph, onGraphChange, onSelect]);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    const removed = new Set(changes.filter(change => change.type === 'remove').map(change => change.id));
    if (removed.size && editable) { onGraphChange({ ...graph, edges: graph.edges.filter(edge => !removed.has(edge.id)) }); onSelect(null); return; }
    const picked = changes.find(change => change.type === 'select' && change.selected);
    if (picked && 'id' in picked) onSelect({ kind: 'edge', id: picked.id });
  }, [editable, graph, onGraphChange, onSelect]);
  const isValidConnection = useCallback((connection: Connection | FlowEdge) => Boolean(connection.sourceHandle) && canConnectWorkflow(graph, connection.source, connection.sourceHandle as WorkflowEdge['outcome'], connection.target), [graph]);
  const onConnect = useCallback((connection: Connection) => {
    if (!isValidConnection(connection)) return;
    onGraphChange(connectWorkflowEdge(graph, connection.source, connection.sourceHandle as WorkflowEdge['outcome'], connection.target, `edge-${crypto.randomUUID()}`));
  }, [graph, isValidConnection, onGraphChange]);
  const ariaLabelConfig = useMemo(() => ({
    'node.a11yDescription.default': text('Enter 또는 Space로 단계를 선택합니다. Esc로 선택을 취소합니다.', 'Press Enter or Space to select a stage. Press Escape to clear.'),
    'node.a11yDescription.keyboardDisabled': text('Enter 또는 Space로 선택한 뒤 화살표 키로 위치를 옮깁니다.', 'Press Enter or Space to select, then use the arrow keys to move it.'),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) => text(`단계를 ${direction} 쪽으로 옮겼습니다. 위치 x ${x}, y ${y}`, `Moved the stage ${direction}. Position x ${x}, y ${y}`),
    'edge.a11yDescription.default': text('Enter 또는 Space로 연결을 선택하고 Delete로 지웁니다.', 'Press Enter or Space to select a connection, then Delete to remove it.'),
    'controls.ariaLabel': text('캔버스 보기', 'Canvas view'), 'controls.zoomIn.ariaLabel': text('확대', 'Zoom in'), 'controls.zoomOut.ariaLabel': text('축소', 'Zoom out'),
    'controls.fitView.ariaLabel': text('전체 보기', 'Fit view'), 'controls.interactive.ariaLabel': text('조작 잠금', 'Toggle interactivity'),
    'minimap.ariaLabel': text('미니맵', 'Mini map'), 'handle.ariaLabel': text('연결 핸들', 'Connection handle'),
  }), [text]);

  return <div className="wf-canvas" data-renderer="react-flow">
    <svg className="wf-rf__defs" aria-hidden="true"><defs><marker id={marker} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,1 L8,5 L0,9" /></marker></defs></svg>
    <ReactFlow<StageNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection}
      onPaneClick={() => onSelect(null)} nodesDraggable={editable} nodesConnectable={editable} elementsSelectable
      deleteKeyCode={editable ? ['Delete', 'Backspace'] : null} elevateNodesOnSelect={false} minZoom={0.3} maxZoom={2}
      fitView fitViewOptions={{ padding: 0.12 }} ariaLabelConfig={ariaLabelConfig}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
      <MiniMap pannable zoomable ariaLabel={text('미니맵', 'Mini map')} nodeClassName={node => `wf-mini wf-mini--${(node as StageNode).data.run?.status ?? 'none'}`} />
      <CanvasControls text={text} />
    </ReactFlow>
  </div>;
}
