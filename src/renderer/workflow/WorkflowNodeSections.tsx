import { FileSearch, MessageSquare, MessageSquarePlus, ScanSearch } from 'lucide-react';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL, type ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowNode } from '../../shared/workflow-graph';
import { Badge, Button, Status } from '../ui';
import type { WorkflowNodeRunView } from './workflow-canvas-model';
import { workflowRunStatusPresentation } from './WorkflowNodeCard';
import { workflowOutcomeLabel, workflowStateLabel, type WorkflowCopy } from './workflow-copy';

export interface WorkflowStageLink { readonly sessionId: string; readonly title: string; readonly graphRevision: number }

/** The stage's document and its conversations (the former "단계 문서·대화" tab). */
export function WorkflowStageSection({ node, text, readOnly, archived = false, links, canStartChat, onDocumentChange, onStartChat, onOpenConversation }: {
  readonly node: WorkflowNode; readonly text: WorkflowCopy; readonly readOnly: boolean; readonly archived?: boolean;
  readonly links: readonly WorkflowStageLink[]; readonly canStartChat: boolean;
  readonly onDocumentChange: (document: string) => void; readonly onStartChat: () => void; readonly onOpenConversation?: (sessionId: string) => void;
}): JSX.Element {
  return <div className="workflow-stage">
    {archived && <p role="status">{text('삭제된 단계의 기록입니다. 문서와 대화는 보관되어 있습니다.', 'This is a deleted stage. Its document and conversations remain in history.')}</p>}
    <label className="workflow-field">{text('단계 문서', 'Stage document')}<textarea rows={10} value={node.document} readOnly={readOnly || archived} onChange={event => onDocumentChange(event.target.value)} /></label>
    <div className="workflow-toolbar"><h3>{text('이 단계의 대화', 'Conversations in this stage')}</h3><Button leadingIcon={<MessageSquarePlus />} disabled={readOnly || archived || !canStartChat} onClick={onStartChat}>{text('새 단계 대화', 'New stage conversation')}</Button></div>
    {links.length > 0 ? <ul className="workflow-items">{links.map(link => <li key={link.sessionId}><Button variant="ghost" leadingIcon={<MessageSquare />} onClick={() => onOpenConversation?.(link.sessionId)}>{link.title}</Button><small>v{link.graphRevision}</small></li>)}</ul>
      : <p className="workflow-hint">{text('아직 대화가 없습니다. 문서를 작성하거나 이 단계에서 대화를 시작하세요.', 'No conversations yet. Write the document or start a conversation in this stage.')}</p>}
  </div>;
}

/** What one stage did in one run, and the actions that belong to it. Read from the frozen run only. */
export function WorkflowNodeRunSection({ run, node, view, text, commandsDisabled, onApprove, onOpenConversation, onOpenAttemptResult }: {
  readonly run: ExecutionRun; readonly node: WorkflowNode; readonly view?: WorkflowNodeRunView; readonly text: WorkflowCopy; readonly commandsDisabled: boolean;
  readonly onApprove: (activationId: string, decision: 'approve' | 'reject') => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenAttemptResult?: (attemptId: string) => void;
}): JSX.Element {
  const ended = run.state === 'completed' || run.state === 'cancelled';
  const activations = (run.workflowRuntime?.activations ?? []).filter(entry => entry.nodeId === node.id).sort((a, b) => b.iteration - a.iteration);
  const attempts = run.attempts.filter(attempt => attempt.taskId === node.id).sort((a, b) => b.number - a.number);
  const status = view ? workflowRunStatusPresentation(view, text) : null;
  return <div className="workflow-node-run">
    {status && <Status variant={status.variant} icon={status.variant === 'loading' ? undefined : status.icon}>{status.label}</Status>}
    {activations.length === 0 && <p className="workflow-hint">{ended ? text('이 실행은 이 단계에 도달하지 않았습니다.', 'This run never reached this stage.') : text('앞 단계가 끝나면 시작합니다.', 'Starts when the stages before it finish.')}</p>}
    {activations.map(activation => <section key={activation.id} className="workflow-node-run__round" aria-label={text(`회차 ${activation.iteration + 1}`, `Round ${activation.iteration + 1}`)}>
      <div className="workflow-inline"><Badge>{text(`회차 ${activation.iteration + 1}`, `Round ${activation.iteration + 1}`)}</Badge><span>{workflowStateLabel(activation.state, text)}{activation.outcome ? ` · ${workflowOutcomeLabel(activation.outcome, text)}` : ''}</span>
        {activation.resolvedBy === PLANNING_AUTO_APPROVAL_PRINCIPAL && <Badge variant="warning">{text('자동 승인됨', 'Auto-approved')}</Badge>}</div>
      {node.operation === 'join' && view?.arrivals && activation === activations[0] && <p>{text(`도착한 입력 ${view.arrivals.arrived}/${view.arrivals.expected}`, `Arrived inputs ${view.arrivals.arrived}/${view.arrivals.expected}`)}</p>}
      {activation.state === 'awaiting-approval' && <div className="workflow-approval">
        <p>{node.instructions || text('이 단계 이후의 실행을 승인합니다.', 'Approve execution after this stage.')}</p>
        <div className="workflow-inline">
          <Button variant="primary" disabled={commandsDisabled || ended} onClick={() => onApprove(activation.id, 'approve')}>{text('허용', 'Approve')}</Button>
          <Button disabled={commandsDisabled || ended} onClick={() => onApprove(activation.id, 'reject')}>{text('거절', 'Reject')}</Button>
        </div>
      </div>}
      {activation.state === 'retry-exhausted' && <p className="workflow-notice">{text('자동 재시도 한도에 도달했습니다. 기록을 확인하고 초안을 수정해 새 실행을 준비하세요.', 'The retry limit was reached. Review the records, edit the draft, and prepare a new run.')}</p>}
    </section>)}
    {attempts.length > 0 && <section className="workflow-node-run__attempts" aria-label={text('작업 시도', 'Attempts')}>
      <h4>{text('작업 시도', 'Attempts')}</h4>
      <ol>{attempts.map(attempt => {
        const reviews = run.reviews.filter(review => review.attemptId === attempt.attemptId);
        return <li key={attempt.attemptId}>
          <div className="workflow-inline"><strong>{text(`시도 ${attempt.number}`, `Attempt ${attempt.number}`)}</strong><span>{({ running: text('진행 중', 'Running'), succeeded: text('성공', 'Succeeded'), failed: text('실패', 'Failed'), interrupted: text('중단됨', 'Interrupted'), 'delivery-uncertain': text('전달 확인 필요', 'Delivery uncertain') })[attempt.state]}</span>
            <small>{attempt.effectiveSettings.providerId}{attempt.effectiveSettings.model ? ` · ${attempt.effectiveSettings.model}` : ''}</small></div>
          {attempt.summary && <p>{attempt.summary}</p>}
          {reviews.map(review => <p key={review.reviewId} className="workflow-hint">{review.decision === 'approve' ? text('독립 검토: 통과', 'Independent review: passed') : text('독립 검토: 거절', 'Independent review: rejected')}{review.detail ? ` — ${review.detail}` : ''}</p>)}
          <div className="workflow-inline">
            <Button leadingIcon={<MessageSquare />} onClick={() => onOpenConversation?.(attempt.sessionId)}>{text('작업 대화 열기', 'Open task conversation')}</Button>
            {reviews.map(review => <Button key={review.reviewId} variant="ghost" leadingIcon={<ScanSearch />} onClick={() => onOpenConversation?.(review.reviewerSessionId)}>{text('검토 대화 열기', 'Open review conversation')}</Button>)}
            {onOpenAttemptResult && attempt.state !== 'running' && <Button variant="ghost" leadingIcon={<FileSearch />} onClick={() => onOpenAttemptResult(attempt.attemptId)}>{text('결과 상세', 'Result details')}</Button>}
          </div>
        </li>;
      })}</ol>
    </section>}
  </div>;
}
