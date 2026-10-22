import { Component, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { workflowBackwardDepths, workflowEdgeBadge, workflowEdgePath, type WorkflowPoint } from './workflow-canvas-model';
import type { WorkflowCanvasRendererProps } from './workflow-canvas-types';
import { WORKFLOW_CARD_UNITS, useWorkflowScale } from './use-workflow-scale';
import { WorkflowNodeCard, workflowRunStatusPresentation } from './WorkflowNodeCard';
import { workflowOperationLabel } from './workflow-copy';

interface Anchors { readonly width: number; readonly height: number; readonly input: WorkflowPoint; readonly outputs: Readonly<Record<string, WorkflowPoint>> }
const FALLBACK = { width: 248, height: 136 };

/**
 * The graph without React Flow: cards at their stored positions inside a scrolling area, edges
 * drawn to the measured handles. Used on Android, in tests, and when the desktop canvas chunk
 * cannot load. Selection only; stages and connections are edited in the panel and the outline.
 */
export function WorkflowStaticGraph({ graph, overlay, selection, onSelect, text, label, issueCounts, reveal, onRevealed, onCardSize }: WorkflowCanvasRendererProps): JSX.Element {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const [anchors, setAnchors] = useState<Record<string, Anchors>>({});
  const marker = `workflow-static-arrow-${useId().replace(/:/gu, '')}`;
  const depths = useMemo(() => workflowBackwardDepths(graph, WORKFLOW_CARD_UNITS.width), [graph]);
  const scale = useWorkflowScale();
  useLayoutEffect(() => {
    const next: Record<string, Anchors> = {};
    for (const [id, element] of elements.current) {
      const box = element.getBoundingClientRect();
      const centre = (handle: Element | null): WorkflowPoint | null => { if (!handle) return null; const rect = handle.getBoundingClientRect(); return { x: rect.left + rect.width / 2 - box.left, y: rect.top + rect.height / 2 - box.top }; };
      const outputs: Record<string, WorkflowPoint> = {};
      element.querySelectorAll<HTMLElement>('[data-handle-out]').forEach(handle => { outputs[handle.dataset.handleOut!] = centre(handle)!; });
      next[id] = { width: box.width || FALLBACK.width, height: box.height || FALLBACK.height, input: centre(element.querySelector('[data-handle-in]')) ?? { x: 0, y: (box.height || FALLBACK.height) / 2 }, outputs };
    }
    setAnchors(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [graph, overlay, issueCounts, scale]);
  const size = (id: string) => anchors[id] ?? { ...FALLBACK, input: { x: 0, y: FALLBACK.height / 2 }, outputs: {} };
  // Negative stored positions (dragged left/up) shift the drawing so they stay inside the scroll area.
  const origin = { x: Math.min(0, ...graph.nodes.map(node => node.position.x)) * scale - 24, y: Math.min(0, ...graph.nodes.map(node => node.position.y)) * scale - 24 };
  const at = (id: string) => { const position = graph.nodes.find(node => node.id === id)!.position; return { x: position.x * scale - Math.min(0, origin.x), y: position.y * scale - Math.min(0, origin.y) }; };
  const out = (id: string, outcome: string): WorkflowPoint => { const local = size(id).outputs[outcome] ?? { x: size(id).width, y: size(id).height / 2 }; return { x: at(id).x + local.x, y: at(id).y + local.y }; };
  const into = (id: string): WorkflowPoint => ({ x: at(id).x + size(id).input.x, y: at(id).y + size(id).input.y });
  const maxDepth = Math.max(0, ...Object.values(depths));
  const extent = {
    width: Math.max(320, ...graph.nodes.map(node => at(node.id).x + size(node.id).width + 48)),
    height: Math.max(240, ...graph.nodes.map(node => at(node.id).y + size(node.id).height + (132 + maxDepth * 32) * scale)),
  };
  const edges = graph.edges.filter(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to));
  useEffect(() => { if (!reveal) return; elements.current.get(reveal.nodeId)?.scrollIntoView?.({ block: 'nearest', inline: 'center' }); onRevealed?.(); }, [onRevealed, reveal]);
  useEffect(() => {
    const sizes = Object.values(anchors);
    if (sizes.length && onCardSize) onCardSize({ width: Math.max(...sizes.map(size => size.width)) / scale, height: Math.max(...sizes.map(size => size.height)) / scale });
  }, [anchors, onCardSize, scale]);
  const onKey = (event: KeyboardEvent, id: string) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'node', id }); } };
  return <div className="workflow-canvas" data-renderer="static" role="region" aria-label={label}>
    <div className="workflow-static" tabIndex={0} aria-label={text('흐름 그래프 · 내부 스크롤', 'Workflow graph · scrollable canvas')}>
      <div className="workflow-static__content" style={{ width: extent.width, height: extent.height }}>
        <svg className="workflow-static__edges" width={extent.width} height={extent.height} aria-hidden="true">
          <defs><marker id={marker} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,1 L8,5 L0,9" /></marker></defs>
          {edges.map(edge => {
            const path = workflowEdgePath(out(edge.from, edge.outcome), into(edge.to), depths[edge.id] ?? 0, scale); const run = overlay?.edges[edge.id];
            return <g key={edge.id}>
              <path className="workflow-edge-path" d={path.d} markerEnd={`url(#${marker})`} data-retry={edge.retryLimit ? '' : undefined} data-run={run ? (run.taken > 0 ? 'taken' : 'idle') : undefined} data-selected={selection?.kind === 'edge' && selection.id === edge.id ? '' : undefined} />
              <path className="workflow-static__edge-hit" d={path.d} onClick={() => onSelect({ kind: 'edge', id: edge.id })} />
            </g>;
          })}
        </svg>
        {edges.map(edge => {
          const badge = workflowEdgeBadge(edge, overlay?.edges[edge.id], text); if (!badge) return null;
          const path = workflowEdgePath(out(edge.from, edge.outcome), into(edge.to), depths[edge.id] ?? 0, scale);
          return <span key={edge.id} className="workflow-edge-badge workflow-static__badge" style={{ left: path.labelX, top: path.labelY }}>{badge}</span>;
        })}
        {graph.nodes.map(node => {
          const run = overlay?.nodes[node.id]; const chosen = selection?.kind === 'node' && selection.id === node.id;
          return <div key={node.id} ref={element => { if (element) elements.current.set(node.id, element); else elements.current.delete(node.id); }} className="workflow-static__node" style={{ left: at(node.id).x, top: at(node.id).y }}
            role="button" tabIndex={0} aria-pressed={chosen} aria-label={[node.title, workflowOperationLabel(node.operation, text), run ? workflowRunStatusPresentation(run, text).label : ''].filter(Boolean).join(', ')}
            onClick={() => onSelect({ kind: 'node', id: node.id })} onKeyDown={event => onKey(event, node.id)}>
            <WorkflowNodeCard node={node} text={text} entry={graph.entryNodeId === node.id} selected={chosen} run={run} issueCount={issueCounts?.[node.id] ?? 0}
              inputHandle={<span className="wf-handle" data-handle-in="" aria-hidden="true" />}
              outputHandle={outcome => <span className="wf-handle" data-handle-out={outcome} aria-hidden="true" />} />
          </div>;
        })}
      </div>
    </div>
  </div>;
}

/** Keeps the flow usable when the desktop canvas fails: the static graph plus a way to retry. */
export class WorkflowCanvasBoundary extends Component<{ readonly fallback: (retry: () => void) => ReactNode; readonly children: ReactNode; readonly onRetry?: () => void; readonly onFailedChange?: (failed: boolean) => void }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(): void { this.props.onFailedChange?.(true); }
  /** Retry resets the injected loader first (a lazy import keeps its rejection), then renders again. */
  private readonly retry = (): void => { this.props.onRetry?.(); this.props.onFailedChange?.(false); this.setState({ failed: false }); };
  override render(): ReactNode { return this.state.failed ? this.props.fallback(this.retry) : this.props.children; }
}
