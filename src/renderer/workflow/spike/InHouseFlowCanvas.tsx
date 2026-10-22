import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { WorkflowEdge } from '../../../shared/workflow-graph';
import { IconButton } from '../../ui';
import { canConnectWorkflow, connectWorkflowEdge, workflowEdgeBadge, workflowEdgePath, type WorkflowPoint } from '../workflow-canvas-model';
import { WorkflowNodeCard, workflowRunStatusPresentation } from '../WorkflowNodeCard';
import { workflowOperationLabel } from '../workflow-copy';
import type { WorkflowCanvasRendererProps } from './spike-types';
import './spike.css';

/** B: the in-house canvas. Camera pattern adapted from ProjectMapCanvas; HTML cards in a transformed layer. */
interface Camera { readonly x: number; readonly y: number; readonly k: number }
interface NodeAnchors { readonly width: number; readonly height: number; readonly input: WorkflowPoint; readonly outputs: Readonly<Record<string, WorkflowPoint>> }
type Gesture =
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; camera: Camera }
  | { kind: 'node'; pointerId: number; startX: number; startY: number; id: string; origin: WorkflowPoint; moved: boolean }
  | { kind: 'link'; pointerId: number; from: string; outcome: WorkflowEdge['outcome'] };

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const FALLBACK = { width: 248, height: 132 };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function InHouseFlowCanvas({ graph, overlay, editable, selection, onSelect, onGraphChange, text }: WorkflowCanvasRendererProps): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const nodeElements = useRef(new Map<string, HTMLDivElement>());
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const [view, setView] = useState({ width: 0, height: 0 });
  const [anchors, setAnchors] = useState<Record<string, NodeAnchors>>({});
  const [dragged, setDragged] = useState<{ id: string; position: WorkflowPoint } | null>(null);
  const [link, setLink] = useState<{ from: string; outcome: WorkflowEdge['outcome']; to: WorkflowPoint } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const fitted = useRef(false);
  const markerId = `wf-ih-arrow-${useId().replace(/:/gu, '')}`;

  const positionOf = useCallback((id: string): WorkflowPoint => dragged?.id === id ? dragged.position : graph.nodes.find(node => node.id === id)?.position ?? { x: 0, y: 0 }, [dragged, graph.nodes]);
  const toGraph = (clientX: number, clientY: number): WorkflowPoint => {
    const rect = viewport.current!.getBoundingClientRect(); const { x, y, k } = cameraRef.current;
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k };
  };

  // Measure card size and handle centres in graph units, so edges meet the handles at any UI scale.
  const measure = useCallback(() => {
    const k = cameraRef.current.k; const next: Record<string, NodeAnchors> = {};
    for (const [id, element] of nodeElements.current) {
      const box = element.getBoundingClientRect();
      const centre = (handle: Element | null): WorkflowPoint | null => { if (!handle) return null; const rect = handle.getBoundingClientRect(); return { x: (rect.left + rect.width / 2 - box.left) / k, y: (rect.top + rect.height / 2 - box.top) / k }; };
      const outputs: Record<string, WorkflowPoint> = {};
      element.querySelectorAll<HTMLElement>('[data-handle-out]').forEach(handle => { outputs[handle.dataset.handleOut!] = centre(handle)!; });
      next[id] = { width: box.width / k, height: box.height / k, input: centre(element.querySelector('[data-handle-in]')) ?? { x: 0, y: box.height / k / 2 }, outputs };
    }
    setAnchors(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  useLayoutEffect(measure, [measure, graph, camera.k]);
  useEffect(() => {
    const observer = new ResizeObserver(() => measure());
    nodeElements.current.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [measure, graph.nodes]);

  const bounds = useCallback(() => {
    if (!graph.nodes.length) return { x: 0, y: 0, width: 1, height: 1 };
    const boxes = graph.nodes.map(node => ({ ...node.position, ...(anchors[node.id] ?? FALLBACK) }));
    const minX = Math.min(...boxes.map(box => box.x)); const minY = Math.min(...boxes.map(box => box.y));
    const maxX = Math.max(...boxes.map(box => box.x + box.width)); const maxY = Math.max(...boxes.map(box => box.y + box.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [anchors, graph.nodes]);
  const fit = useCallback(() => {
    const element = viewport.current; if (!element) return;
    const { width, height } = element.getBoundingClientRect(); if (!width || !height) return;
    const area = bounds(); const pad = 32;
    const k = clamp(Math.min((width - pad * 2) / area.width, (height - pad * 2) / area.height), MIN_ZOOM, 1.25);
    setCamera({ k, x: (width - area.width * k) / 2 - area.x * k, y: (height - area.height * k) / 2 - area.y * k });
  }, [bounds]);
  // Fit once the panel is actually visible and the cards are measured (a hidden dock tab has no size).
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setView({ width: entry.contentRect.width, height: entry.contentRect.height });
      if (!fitted.current && entry.contentRect.width > 0 && Object.keys(anchors).length === graph.nodes.length) { fitted.current = true; fit(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchors, fit, graph.nodes.length]);

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const element = viewport.current; if (!element) return;
    const rect = element.getBoundingClientRect();
    const px = clientX === undefined ? rect.width / 2 : clientX - rect.left; const py = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    setCamera(current => { const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM); return { k, x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k) }; });
  }, []);
  // A native, non-passive wheel listener keeps the surrounding panel from scrolling while zooming.
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  const capture = (event: ReactPointerEvent, next: Gesture) => { event.stopPropagation(); gesture.current = next; viewport.current?.setPointerCapture(event.pointerId); };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => { if (event.button === 0) capture(event, { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, camera: cameraRef.current }); };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    if (current.kind === 'pan') setCamera({ ...current.camera, x: current.camera.x + event.clientX - current.startX, y: current.camera.y + event.clientY - current.startY });
    else if (current.kind === 'node') {
      const dx = (event.clientX - current.startX) / cameraRef.current.k; const dy = (event.clientY - current.startY) / cameraRef.current.k;
      if (!current.moved && Math.hypot(dx, dy) < 3) return;
      current.moved = true; if (editable) setDragged({ id: current.id, position: { x: current.origin.x + dx, y: current.origin.y + dy } });
    } else setLink({ from: current.from, outcome: current.outcome, to: toGraph(event.clientX, event.clientY) });
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current; gesture.current = null;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.kind === 'pan' && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 3) onSelect(null);
    if (current.kind === 'node') {
      if (!current.moved) onSelect({ kind: 'node', id: current.id });
      else if (dragged && editable) onGraphChange({ ...graph, nodes: graph.nodes.map(node => node.id === dragged.id ? { ...node, position: { x: Math.round(dragged.position.x), y: Math.round(dragged.position.y) } } : node) });
      setDragged(null);
    }
    if (current.kind === 'link') {
      // Edges end on input handles, so look through everything under the pointer for a stage.
      const target = document.elementsFromPoint(event.clientX, event.clientY).map(element => element.closest<HTMLElement>('[data-node-id]')).find(Boolean)?.dataset.nodeId;
      if (target && canConnectWorkflow(graph, current.from, current.outcome, target)) onGraphChange(connectWorkflowEdge(graph, current.from, current.outcome, target, `edge-${crypto.randomUUID()}`));
      setLink(null);
    }
  };

  const onNodeKey = (event: KeyboardEvent<HTMLDivElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'node', id }); return; }
    const step = event.shiftKey ? 64 : 16;
    const delta = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key];
    if (!delta || !editable) return;
    event.preventDefault();
    onGraphChange({ ...graph, nodes: graph.nodes.map(node => node.id === id ? { ...node, position: { x: node.position.x + delta[0], y: node.position.y + delta[1] } } : node) });
  };
  const onViewportKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'Delete' || event.key === 'Backspace') && editable && selection?.kind === 'edge') { event.preventDefault(); onGraphChange({ ...graph, edges: graph.edges.filter(edge => edge.id !== selection.id) }); onSelect(null); }
    else if (event.key === '+' || event.key === '=') zoomAt(1.2);
    else if (event.key === '-') zoomAt(1 / 1.2);
  };

  const anchorOut = (id: string, outcome: string): WorkflowPoint => { const at = positionOf(id); const local = anchors[id]?.outputs[outcome] ?? { x: (anchors[id] ?? FALLBACK).width, y: (anchors[id] ?? FALLBACK).height / 2 }; return { x: at.x + local.x, y: at.y + local.y }; };
  const anchorIn = (id: string): WorkflowPoint => { const at = positionOf(id); const local = anchors[id]?.input ?? { x: 0, y: FALLBACK.height / 2 }; return { x: at.x + local.x, y: at.y + local.y }; };
  const area = bounds();
  const mini = { pad: 40, scale: 0 }; mini.scale = Math.min(168 / (area.width + mini.pad * 2), 104 / (area.height + mini.pad * 2));

  return <div className="wf-canvas" data-renderer="in-house">
    <div ref={viewport} className="wf-canvas__viewport" tabIndex={0} role="group" aria-label={text('흐름 캔버스 · 끌어서 이동, 휠로 확대', 'Flow canvas · drag to pan, wheel to zoom')}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { gesture.current = null; setDragged(null); setLink(null); }} onKeyDown={onViewportKey}>
      <div className="wf-canvas__layer" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}>
        <svg className="wf-canvas__edges" aria-hidden="true">
          <defs><marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,1 L8,5 L0,9" /></marker></defs>
          {graph.edges.map(edge => {
            if (!graph.nodes.some(node => node.id === edge.from) || !graph.nodes.some(node => node.id === edge.to)) return null;
            const path = workflowEdgePath(anchorOut(edge.from, edge.outcome), anchorIn(edge.to));
            const run = overlay?.edges[edge.id];
            return <g key={edge.id}>
              <path className="workflow-edge-path" d={path.d} markerEnd={`url(#${markerId})`} data-retry={edge.retryLimit ? '' : undefined} data-run={run ? (run.taken > 0 ? 'taken' : 'idle') : undefined} data-selected={selection?.kind === 'edge' && selection.id === edge.id ? '' : undefined} />
              <path className="wf-canvas__edge-hit" d={path.d} onPointerDown={event => { event.stopPropagation(); onSelect({ kind: 'edge', id: edge.id }); viewport.current?.focus(); }} />
            </g>;
          })}
          {link && <path className="workflow-edge-path" data-selected="" d={workflowEdgePath(anchorOut(link.from, link.outcome), link.to).d} />}
        </svg>
        {graph.edges.map(edge => {
          const badge = workflowEdgeBadge(edge, overlay?.edges[edge.id], text);
          if (!badge || !graph.nodes.some(node => node.id === edge.from) || !graph.nodes.some(node => node.id === edge.to)) return null;
          const path = workflowEdgePath(anchorOut(edge.from, edge.outcome), anchorIn(edge.to));
          return <span key={edge.id} className="workflow-edge-badge wf-canvas__badge" style={{ left: path.labelX, top: path.labelY }}>{badge}</span>;
        })}
        {graph.nodes.map(node => {
          const at = positionOf(node.id); const run = overlay?.nodes[node.id];
          const status = run ? workflowRunStatusPresentation(run, text).label : '';
          return <div key={node.id} ref={element => { if (element) nodeElements.current.set(node.id, element); else nodeElements.current.delete(node.id); }}
            className="wf-canvas__node" data-node-id={node.id} style={{ left: at.x, top: at.y }} tabIndex={0} role="button"
            aria-pressed={selection?.kind === 'node' && selection.id === node.id} aria-label={[node.title, workflowOperationLabel(node.operation, text), status].filter(Boolean).join(', ')}
            onPointerDown={event => { if (event.button === 0) capture(event, { kind: 'node', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, id: node.id, origin: at, moved: false }); }}
            onKeyDown={event => onNodeKey(event, node.id)}>
            <WorkflowNodeCard node={node} text={text} entry={graph.entryNodeId === node.id} selected={selection?.kind === 'node' && selection.id === node.id} run={run}
              inputHandle={<span className="wf-handle wf-handle--in" data-handle-in="" aria-hidden="true" />}
              outputHandle={outcome => <span className="wf-handle wf-handle--out" data-handle-out={outcome} aria-hidden="true" data-editable={editable || undefined}
                onPointerDown={event => { if (editable && event.button === 0) { capture(event, { kind: 'link', pointerId: event.pointerId, from: node.id, outcome }); setLink({ from: node.id, outcome, to: anchorOut(node.id, outcome) }); } }} />} />
          </div>;
        })}
      </div>
    </div>
    <div className="wf-canvas__controls" role="group" aria-label={text('캔버스 보기', 'Canvas view')}>
      <IconButton icon={ZoomIn} aria-label={text('확대', 'Zoom in')} onClick={() => zoomAt(1.2)} />
      <IconButton icon={ZoomOut} aria-label={text('축소', 'Zoom out')} onClick={() => zoomAt(1 / 1.2)} />
      <IconButton icon={Maximize} aria-label={text('전체 보기', 'Fit view')} onClick={fit} />
    </div>
    <svg className="wf-canvas__minimap" role="img" aria-label={text('미니맵', 'Mini map')} width="168" height="104"
      viewBox={`${area.x - mini.pad} ${area.y - mini.pad} ${area.width + mini.pad * 2} ${area.height + mini.pad * 2}`}
      onPointerDown={event => {
        const rect = event.currentTarget.getBoundingClientRect(); const w = area.width + mini.pad * 2; const h = area.height + mini.pad * 2;
        const scale = Math.min(rect.width / w, rect.height / h);
        const gx = area.x - mini.pad + (event.clientX - rect.left - (rect.width - w * scale) / 2) / scale; const gy = area.y - mini.pad + (event.clientY - rect.top - (rect.height - h * scale) / 2) / scale;
        setCamera(current => ({ ...current, x: view.width / 2 - gx * current.k, y: view.height / 2 - gy * current.k }));
      }}>
      {graph.nodes.map(node => { const size = anchors[node.id] ?? FALLBACK; return <rect key={node.id} className="wf-canvas__mini-node" data-run-state={overlay?.nodes[node.id]?.status} x={positionOf(node.id).x} y={positionOf(node.id).y} width={size.width} height={size.height} rx="12" />; })}
      <rect className="wf-canvas__mini-view" x={-camera.x / camera.k} y={-camera.y / camera.k} width={view.width / camera.k} height={view.height / camera.k} />
    </svg>
  </div>;
}
