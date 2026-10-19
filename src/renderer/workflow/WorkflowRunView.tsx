import { Pause, Play } from 'lucide-react';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL } from '../../shared/planning-execution';
import type { WorkflowCommand, WorkflowRun } from '../../shared/workflow';
import { Badge, Button, Field, Select } from '../ui';
import { useWorkflowCopy, workflowStateLabel, workflowOperationLabel, workflowOutcomeLabel, workflowPermissionLabel } from './WorkflowEditor';

type RunCommand = Extract<WorkflowCommand, { type: 'run.start' | 'run.pause' | 'run.resume' | 'run.approve' | 'run.cancel' | 'run.integrate' }>;
type CommandInput<C = RunCommand> = C extends RunCommand ? Pick<C, 'type' | 'payload'> : never;
export function WorkflowRunView({ runs, selectedRunId, onSelectRun, disabled, onCommand, onOpenConversation, onOpenResults }: {
  readonly runs: readonly WorkflowRun[];
  readonly selectedRunId: string | null;
  readonly onSelectRun: (id: string) => void;
  readonly disabled: boolean;
  readonly onCommand: (command: CommandInput) => Promise<boolean>;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenResults?: (runId: string) => void;
}): JSX.Element {
  const text = useWorkflowCopy();
  const run = runs.find(item => item.runId === selectedRunId) ?? runs.at(-1);
  if (!run) return <p role="status">{text('준비된 실행이 없습니다. 흐름과 AI 설정을 확인하고 실행을 준비하세요.', 'No prepared run. Review the workflow and AI settings, then prepare a run.')}</p>;
  const frozen = run.preparation.workflow;
  return <section className="workflow-run" aria-label={text('흐름 실행', 'Workflow execution')}>
    <Field label={text('실행 기록', 'Execution history')}><Select value={run.runId} onChange={event => onSelectRun(event.target.value)}>{runs.map(item => <option key={item.runId} value={item.runId}>v{item.preparation.workflow?.revision} · {new Date(item.createdAt).toLocaleString()} · {workflowStateLabel(item.state, text)}</option>)}</Select></Field>
    <div className="workflow-toolbar"><h3>{text('고정된 실행 버전', 'Frozen execution version')} {frozen?.revision}</h3><Badge>{workflowStateLabel(run.state, text)}</Badge>{run.preparation.approvalPolicy === 'auto' && <Badge variant="warning" data-testid="workflow-run-auto-approve">{text('자동 승인', 'Auto-approve')}</Badge>}{run.preparation.startedBy && onOpenConversation && <Button variant="ghost" onClick={() => onOpenConversation(run.preparation.startedBy!.sessionId)}>{text('시작한 대화 열기', 'Open the conversation that started it')}</Button>}{run.state === 'prepared' && <Button leadingIcon={<Play />} variant="primary" disabled={disabled} onClick={() => void onCommand({ type: 'run.start', payload: { runId: run.runId } })}>{text('실행 시작', 'Start execution')}</Button>}{(run.state === 'running' || run.state === 'awaiting-review') && <Button leadingIcon={<Pause />} disabled={disabled} onClick={() => void onCommand({ type: 'run.pause', payload: { runId: run.runId } })}>{text('일시정지', 'Pause')}</Button>}{run.state === 'paused' && <Button leadingIcon={<Play />} disabled={disabled} onClick={() => void onCommand({ type: 'run.resume', payload: { runId: run.runId } })}>{text('같은 버전으로 재개', 'Resume this version')}</Button>}</div>
    <p className="workflow-hint">{text('각 단계는 시작 당시의 문서·참조·모델·권한을 사용합니다. 완료 노드는 통합이나 배포를 자동으로 실행하지 않습니다.', 'Stages use the documents, references, models and permissions frozen at preparation. A completion node does not automatically integrate or deploy changes.')}</p>
    {!['completed', 'cancelled'].includes(run.state) && <Button disabled={disabled} onClick={() => void onCommand({ type: 'run.cancel', payload: { runId: run.runId } })}>{text('실행 취소', 'Cancel execution')}</Button>}
    {run.state === 'completed' && !run.integrationAuthorized && <Button disabled={disabled} onClick={() => void onCommand({ type: 'run.integrate', payload: { runId: run.runId } })}>{text('검토된 결과 통합 허용', 'Allow integration of reviewed results')}</Button>}
    {run.integrationAuthorized && <p role="status">{run.integrationAuthorized.by === PLANNING_AUTO_APPROVAL_PRINCIPAL
      ? text('자동 승인으로 결과 통합을 허용했습니다. 작업 결과 화면에서 진행 상태를 확인하세요.', 'Auto-approve allowed result integration. Check its progress in task results.')
      : text('결과 통합을 명시적으로 허용했습니다. 작업 결과 화면에서 진행 상태를 확인하세요.', 'Result integration was explicitly authorized. Check its progress in task results.')}</p>}
    {onOpenResults && <Button onClick={() => onOpenResults(run.runId)}>{text('작업 결과·독립 검토·통합 열기', 'Open task results, independent review and integration')}</Button>}
    <ol className="workflow-run-nodes">{frozen?.graph.nodes.map(node => {
      const activations = run.workflowRuntime?.activations.filter(item => item.nodeId === node.id) ?? [];
      return <li key={node.id}><strong>{node.title}</strong><small>{workflowOperationLabel(node.operation, text)} · {node.providerId} · {node.model} · {workflowPermissionLabel(node.permissionPreset, text)}</small>{activations.length === 0 && <Badge>{text('대기', 'Waiting')}</Badge>}{activations.map(activation => {
        const attempt = run.attempts.find(item => item.attemptId === (activation.attemptId ?? run.tasks.find(task => task.taskId === node.id)?.currentAttemptId));
        return <div className="workflow-activation" key={activation.id}><Badge variant={activation.state === 'awaiting-approval' || activation.state === 'retry-exhausted' ? 'warning' : 'neutral'}>{workflowStateLabel(activation.state, text)} · {text('회차', 'Iteration')} {activation.iteration + 1}</Badge>{activation.outcome && <span>{text('결과', 'Outcome')}: {workflowOutcomeLabel(activation.outcome, text)}{activation.resolvedBy === PLANNING_AUTO_APPROVAL_PRINCIPAL ? ` · ${text('자동 승인됨', 'Auto-approved')}` : ''}</span>}{node.operation === 'join' && <span>{text('도착한 입력', 'Arrived inputs')}: {activation.incomingEdgeIds.length} / {frozen.graph.edges.filter(edge => edge.to === node.id && !edge.retryLimit).length}</span>}{attempt?.sessionId && <Button onClick={() => onOpenConversation?.(attempt.sessionId)}>{text('작업 대화 열기', 'Open task conversation')}</Button>}{activation.state === 'awaiting-approval' && <div className="workflow-approval"><p>{node.instructions || text('이 단계 이후의 실행을 승인합니다.', 'Approve execution after this stage.')}</p><small>{run.runId} · {activation.id}</small><Button disabled={disabled} onClick={() => void onCommand({ type: 'run.approve', payload: { runId: run.runId, activationId: activation.id, decision: 'approve' } })}>{text('허용', 'Approve')}</Button><Button disabled={disabled} onClick={() => void onCommand({ type: 'run.approve', payload: { runId: run.runId, activationId: activation.id, decision: 'reject' } })}>{text('거절', 'Reject')}</Button></div>}{activation.state === 'retry-exhausted' && <p>{text('자동 재시도 한도에 도달했습니다. 기록을 확인하고 초안을 수정해 새 실행을 준비하세요.', 'The retry limit was reached. Review the records, edit the draft, and prepare a new run.')}</p>}</div>;
      })}</li>;
    })}</ol>
    <details><summary>{text('고정된 연결과 참조', 'Frozen connections and references')}</summary><ul>{frozen?.graph.edges.map(edge => <li key={edge.id}>{frozen.graph.nodes.find(node => node.id === edge.from)?.title} — {workflowOutcomeLabel(edge.outcome, text)} → {frozen.graph.nodes.find(node => node.id === edge.to)?.title}{edge.retryLimit ? ` · ${text('최대', 'limit')} ${edge.retryLimit}` : ''}</li>)}</ul><p>{text('흐름 식별값', 'Graph fingerprint')}: <code>{frozen?.fingerprint}</code></p></details>
  </section>;
}
