import type { WorkflowGraph } from '../../shared/workflow-graph';
import { Status } from '../ui';
import type { WorkflowRunOverlay } from './workflow-canvas-model';
import type { CanvasSelection, WorkflowNodeDecoration } from './workflow-canvas-types';
import { workflowRunStatusPresentation } from './WorkflowNodeCard';
import { workflowOperationLabel, workflowOutcomeLabel, type WorkflowCopy } from './workflow-copy';

/** The list view of the same graph: the keyboard and touch path, and Android's default. */
export function WorkflowOutline({ graph, overlay, selection, onSelect, text, decorations }: { readonly graph: WorkflowGraph; readonly overlay: WorkflowRunOverlay | null; readonly selection: CanvasSelection; readonly onSelect: (selection: CanvasSelection) => void; readonly text: WorkflowCopy; readonly decorations?: Readonly<Record<string, WorkflowNodeDecoration>> }): JSX.Element {
  const title = (id: string) => graph.nodes.find(node => node.id === id)?.title ?? id;
  return <ol className="workflow-node-list workflow-outline" aria-label={text('단계 목록', 'Stages')}>{graph.nodes.map(node => {
    const run = overlay?.nodes[node.id]; const status = run ? workflowRunStatusPresentation(run, text) : null;
    const decoration = decorations?.[node.id];
    const outgoing = graph.edges.filter(edge => edge.from === node.id).map(edge => `${decoration?.portLabels?.[edge.outcome] ?? workflowOutcomeLabel(edge.outcome, text)} → ${title(edge.to)}`).join(' · ');
    return <li key={node.id}><button type="button" className="workflow-item" data-node-id={node.id} data-drop-target={decoration?.dropTarget || undefined} aria-pressed={selection?.kind === 'node' && selection.id === node.id} onClick={() => onSelect({ kind: 'node', id: node.id })}>
      <strong>{node.title}</strong>
      <span>{decoration?.kindLabel ?? workflowOperationLabel(node.operation, text)}{graph.entryNodeId === node.id ? text(' · 시작', ' · Entry') : ''}</span>
      {decoration?.agent && <span className="workflow-outline__agent" data-missing={decoration.agent.missing || undefined}>{decoration.agent.missing ? text(`에이전트 없음 · ${decoration.agent.name}`, `Agent missing · ${decoration.agent.name}`) : [decoration.agent.name, decoration.agent.effort].filter(Boolean).join(' · ')}{decoration.chain ? text(' · 이어서', ' · continues') : ''}</span>}
      {status && <Status variant={status.variant} icon={status.variant === 'loading' ? undefined : status.icon}>{status.label}{run && run.iteration > 0 ? ` · ${text(`회차 ${run.iteration + 1}`, `round ${run.iteration + 1}`)}` : ''}</Status>}
      <small>{outgoing || text('다음 연결 없음', 'No outgoing connection')}</small>
    </button></li>;
  })}</ol>;
}
