import { Glyph, glyphIcon, type GlyphIcon } from '../ui/Glyph';
import type { ReactNode } from 'react';
import { workflowOutcomePorts, type WorkflowEdge, type WorkflowNode } from '../../shared/workflow-graph';
import { Status, type SemanticVariant } from '../ui';
import type { WorkflowNodeRunStatus, WorkflowNodeRunView } from './workflow-canvas-model';
import type { WorkflowNodeDecoration } from './workflow-canvas-types';
import { workflowOperationLabel, workflowOutcomeLabel, type WorkflowCopy } from './workflow-copy';
import './workflow-canvas.css';

const OPERATION_ICONS: Record<WorkflowNode['operation'], GlyphIcon> = {
  agent: glyphIcon('bot'), condition: glyphIcon('flow'), parallel: glyphIcon('flow'), join: glyphIcon('merge'), approval: glyphIcon('req'), complete: glyphIcon('flag'),
};

export interface WorkflowRunStatusPresentation { readonly label: string; readonly icon: GlyphIcon; readonly variant: SemanticVariant | 'loading' }
/** Every run state carries an icon and words; colour only reinforces them. */
export function workflowRunStatusPresentation(view: Pick<WorkflowNodeRunView, 'status' | 'outcome'>, text: WorkflowCopy): WorkflowRunStatusPresentation {
  const table: Record<WorkflowNodeRunStatus, WorkflowRunStatusPresentation> = {
    pending: { label: text('대기 전', 'Not started'), icon: glyphIcon('clock'), variant: 'neutral' },
    'not-reached': { label: text('미도달', 'Not reached'), icon: glyphIcon('clock'), variant: 'neutral' },
    waiting: { label: text('입력 대기', 'Waiting for input'), icon: glyphIcon('clock'), variant: 'neutral' },
    queued: { label: text('시작 대기', 'Queued'), icon: glyphIcon('clock'), variant: 'neutral' },
    working: { label: text('작업 중', 'Working'), icon: glyphIcon('spin'), variant: 'loading' },
    reviewing: { label: text('독립 검토 중', 'Independent review'), icon: glyphIcon('search'), variant: 'info' },
    reconciling: { label: text('결과 확인 중', 'Checking result'), icon: glyphIcon('spin'), variant: 'loading' },
    paused: { label: text('일시정지', 'Paused'), icon: glyphIcon('pause'), variant: 'neutral' },
    'needs-attention': { label: text('확인 필요', 'Needs attention'), icon: glyphIcon('warn'), variant: 'warning' },
    'awaiting-approval': { label: text('승인 대기 · 조치 필요', 'Awaiting approval · action needed'), icon: glyphIcon('req'), variant: 'warning' },
    completed: { label: text('완료', 'Done'), icon: glyphIcon('check'), variant: 'success' },
    rejected: { label: text('거절됨', 'Rejected'), icon: glyphIcon('x'), variant: 'danger' },
    'retry-exhausted': { label: text('재시도 한도 도달', 'Retry limit reached'), icon: glyphIcon('warn'), variant: 'danger' },
    cancelled: { label: text('취소됨', 'Cancelled'), icon: glyphIcon('x'), variant: 'neutral' },
  };
  const base = table[view.status];
  if (view.status !== 'completed' || !view.outcome) return base;
  // A completed stage can still have routed a failure or rejection: say which.
  const failed = view.outcome === 'failed' || view.outcome === 'rejected';
  return { label: `${base.label} · ${workflowOutcomeLabel(view.outcome, text)}`, icon: failed ? glyphIcon('x') : view.outcome === 'approved' ? glyphIcon('check') : glyphIcon('check'), variant: failed ? 'warning' : 'success' };
}

export interface WorkflowNodeCardProps {
  readonly node: WorkflowNode;
  readonly text: WorkflowCopy;
  readonly entry?: boolean;
  readonly selected?: boolean;
  readonly run?: WorkflowNodeRunView;
  readonly issueCount?: number;
  /** The renderer owns connection handles; the card only reserves their rows. */
  readonly inputHandle?: ReactNode;
  readonly outputHandle?: (outcome: WorkflowEdge['outcome']) => ReactNode;
  /** The agent placed on it, its chain and checks (see WorkflowNodeDecoration). */
  readonly decoration?: WorkflowNodeDecoration;
}

/** One stage, as both canvas renderers and the outline draw it. */
export function WorkflowNodeCard({ node, text, entry = false, selected = false, run, issueCount = 0, inputHandle, outputHandle, decoration }: WorkflowNodeCardProps): JSX.Element {
  const Icon = decoration?.kindLabel ? glyphIcon('q') : OPERATION_ICONS[node.operation];
  const status = run ? workflowRunStatusPresentation(run, text) : null;
  const ports = workflowOutcomePorts(node.operation).filter(outcome => !decoration?.hiddenPorts?.includes(outcome));
  const agent = decoration?.agent;
  const detail = agent || decoration?.kindLabel || decoration?.dropTarget ? null : node.operation === 'agent'
    ? [node.providerId, node.model].filter(Boolean).join(' · ') || text('AI 설정 확인', 'Check AI settings')
    : node.operation === 'join' ? (node.joinPolicy === 'any' ? text('하나 이상 도착하면 진행', 'Continues on any input') : text('모두 도착하면 진행', 'Continues when all arrive'))
      : node.operation === 'approval' ? text('사람이 허용/거절', 'A person approves or rejects')
        : node.operation === 'condition' ? text('검토 결과로 분기', 'Branches on a verified result')
          : null;
  return <div className="workflow-node-card" data-operation={node.operation} data-selected={selected || undefined} data-run-state={run?.status}
    data-chain={decoration?.chain?.position} data-drop-target={decoration?.dropTarget || undefined} data-agent-missing={agent?.missing || undefined} data-attention={decoration?.attention || undefined}>
    {inputHandle && <div className="workflow-node-card__input">{inputHandle}</div>}
    <div className="workflow-node-card__body">
      <div className="workflow-node-card__kind"><Icon aria-hidden="true" /><span>{decoration?.kindLabel ?? workflowOperationLabel(node.operation, text)}</span>{entry && <span className="workflow-node-card__entry">{text('시작', 'Start')}</span>}</div>
      <strong className="workflow-node-card__title">{node.title}</strong>
      {agent && <span className="workflow-node-card__agent" data-tone={agent.tone ?? 'other'}>
        {agent.missing ? <Glyph name="warn" /> : <span className="workflow-node-card__lamp" aria-hidden="true" />}
        <span className="workflow-node-card__agent-name">{agent.name}</span>
        {agent.effort && <span className="workflow-node-card__agent-effort">{agent.effort}</span>}
      </span>}
      {agent && <span className="workflow-node-card__detail">{agent.missing ? text('이 PC에 없는 에이전트 · 다시 배정 필요', 'Agent not on this PC · reassign') : agent.detail}</span>}
      {decoration?.chain && <span className="workflow-node-card__chain"><Glyph name="link" />{decoration.chain.label}</span>}
      {decoration?.badges?.length ? <span className="workflow-node-card__badges">{decoration.badges.map(badge => <span key={badge}>{badge}</span>)}</span> : null}
      {decoration?.dropTarget && <span className="workflow-node-card__drop" role="status">{text('여기에 놓아 배정', 'Drop to assign here')}</span>}
      {detail && <span className="workflow-node-card__detail">{detail}</span>}
      {status && <span className="workflow-node-card__run">
        <Status variant={status.variant} icon={status.variant === 'loading' ? undefined : status.icon}>{status.label}</Status>
        {run && run.iteration > 0 && <span className="workflow-node-card__meta">{text(`회차 ${run.iteration + 1}`, `Round ${run.iteration + 1}`)}</span>}
        {run?.arrivals && <span className="workflow-node-card__meta">{text(`${run.arrivals.arrived}/${run.arrivals.expected} 도착`, `${run.arrivals.arrived}/${run.arrivals.expected} arrived`)}</span>}
      </span>}
      {issueCount > 0 && <span className="workflow-node-card__issues"><Glyph name="warn" />{text(`확인할 점 ${issueCount}`, `${issueCount} to check`)}</span>}
    </div>
    {ports.length > 0 && <ul className="workflow-node-card__ports" aria-label={text('나가는 연결', 'Outputs')}>
      {ports.map(outcome => <li key={outcome} data-port={outcome}><span>{decoration?.portLabels?.[outcome] ?? workflowOutcomeLabel(outcome, text)}</span>{outputHandle?.(outcome)}</li>)}
    </ul>}
  </div>;
}
