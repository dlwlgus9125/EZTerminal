import { ArrowLeft, Eye, FileSearch, GitBranch, Hand, LayoutGrid, List, MessageSquare, Pause, Play, Save, Square, Undo2 } from 'lucide-react';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL, type ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowCommand } from '../../shared/workflow';
import { Badge, Button, Select } from '../ui';
import type { WorkflowCanvasMode } from './workflow-canvas-model';
import { workflowStateLabel, type WorkflowCopy } from './workflow-copy';

type RunCommand = Extract<WorkflowCommand, { type: 'run.start' | 'run.pause' | 'run.resume' | 'run.approve' | 'run.cancel' | 'run.integrate' }>;
export type WorkflowRunCommandInput<C = RunCommand> = C extends RunCommand ? Pick<C, 'type' | 'payload'> : never;

export interface WorkflowCanvasHeaderProps {
  readonly text: WorkflowCopy;
  readonly mode: WorkflowCanvasMode;
  readonly revision: number;
  readonly hasLocalDraft: boolean;
  readonly diverged: boolean;
  readonly run: ExecutionRun | null;
  readonly runs: readonly ExecutionRun[];
  readonly editLocked: boolean;
  readonly commandsDisabled: boolean;
  readonly issueCount: number;
  readonly awaiting: readonly { readonly nodeId: string; readonly title: string }[];
  readonly layout: 'graph' | 'list';
  readonly onLayoutChange: (layout: 'graph' | 'list') => void;
  readonly onPickRun: (runId: string) => void;
  readonly onRunView: (open: boolean) => void;
  readonly onJumpToNode: (nodeId: string) => void;
  readonly onSaveDraft: () => void;
  readonly onDiscardDraft: () => void;
  readonly onAutoLayout: () => void;
  readonly onPrepareRun: () => void;
  readonly onRunCommand: (command: WorkflowRunCommandInput) => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenResults?: (runId: string) => void;
}

/** Status line and actions above the one canvas: the draft on the left, the run on the right. */
export function WorkflowCanvasHeader(props: WorkflowCanvasHeaderProps): JSX.Element {
  const { text, mode, run, editLocked, commandsDisabled } = props;
  const ended = run ? run.state === 'completed' || run.state === 'cancelled' : true;
  const runLabel = run ? `${text('실행', 'Run')} v${run.preparation.workflow?.revision ?? '?'} · ${workflowStateLabel(run.state, text)}` : '';
  const command = (input: WorkflowRunCommandInput) => props.onRunCommand(input);
  return <div className="workflow-canvas-header" data-mode={mode}>
    {mode === 'run-view' && run && <div className="workflow-canvas-header__banner" role="status">
      <Eye aria-hidden="true" /><span>{text(`실행 v${run.preparation.workflow?.revision ?? '?'}이 시작할 때 고정된 흐름입니다. 여기서는 편집할 수 없습니다.`, `The flow frozen when run v${run.preparation.workflow?.revision ?? '?'} started. It cannot be edited here.`)}</span>
      <Button size="sm" leadingIcon={<ArrowLeft />} onClick={() => props.onRunView(false)}>{text('편집으로 돌아가기', 'Back to editing')}</Button>
    </div>}
    <div className="workflow-canvas-header__row">
      <div className="workflow-canvas-header__group" role="group" aria-label={text('초안', 'Draft')}>
        {props.hasLocalDraft ? <Badge variant="warning">{text('미저장 변경', 'Unsaved changes')}</Badge> : <Badge>{`${text('편집 초안', 'Draft')} v${props.revision}`}</Badge>}
        {mode !== 'run-view' && <>
          <Button size="sm" leadingIcon={<Save />} disabled={editLocked || !props.hasLocalDraft} onClick={props.onSaveDraft}>{text('초안 저장', 'Save draft')}</Button>
          <Button size="sm" leadingIcon={<Undo2 />} disabled={editLocked || !props.hasLocalDraft} onClick={props.onDiscardDraft}>{text('변경 취소', 'Discard changes')}</Button>
          {props.layout === 'graph' && <Button size="sm" leadingIcon={<LayoutGrid />} disabled={editLocked} onClick={props.onAutoLayout}>{text('자동 정렬', 'Tidy layout')}</Button>}
          <Button size="sm" leadingIcon={<Play />} disabled={editLocked || commandsDisabled || props.hasLocalDraft || props.issueCount > 0} onClick={props.onPrepareRun}>{text('실행 준비', 'Prepare run')}</Button>
        </>}
      </div>
      <div className="workflow-canvas-header__group workflow-canvas-header__run" role="group" aria-label={text('실행', 'Run')}>
        {props.runs.length > 1 && <Select aria-label={text('실행 기록', 'Execution history')} value={run?.runId ?? ''} onChange={event => props.onPickRun(event.target.value)}>{[...props.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => <option key={item.runId} value={item.runId}>v{item.preparation.workflow?.revision} · {new Date(item.createdAt).toLocaleString()} · {workflowStateLabel(item.state, text)}</option>)}</Select>}
        {run && props.runs.length <= 1 && <Badge variant={ended ? 'neutral' : 'info'}>{runLabel}</Badge>}
        {run?.preparation.approvalPolicy === 'auto' && <Badge variant="warning">{text('자동 승인', 'Auto-approve')}</Badge>}
        {props.awaiting.length > 0 && <Button size="sm" variant="primary" leadingIcon={<Hand />} onClick={() => props.onJumpToNode(props.awaiting[0].nodeId)}>{text(`승인 대기 ${props.awaiting.length}`, `${props.awaiting.length} awaiting approval`)}</Button>}
        {props.diverged && run && <Button size="sm" leadingIcon={<GitBranch />} onClick={() => props.onRunView(true)}>{ended ? text('최근 실행 보기', 'View last run') : text('진행 중인 실행 보기', 'View running run')}</Button>}
        {run?.state === 'prepared' && <Button size="sm" variant="primary" leadingIcon={<Play />} disabled={commandsDisabled} onClick={() => command({ type: 'run.start', payload: { runId: run.runId } })}>{text('실행 시작', 'Start execution')}</Button>}
        {run && (run.state === 'running' || run.state === 'awaiting-review') && <Button size="sm" leadingIcon={<Pause />} disabled={commandsDisabled} onClick={() => command({ type: 'run.pause', payload: { runId: run.runId } })}>{text('일시정지', 'Pause')}</Button>}
        {run?.state === 'paused' && <Button size="sm" leadingIcon={<Play />} disabled={commandsDisabled} onClick={() => command({ type: 'run.resume', payload: { runId: run.runId } })}>{text('같은 버전으로 재개', 'Resume this version')}</Button>}
        {run && !ended && <Button size="sm" leadingIcon={<Square />} disabled={commandsDisabled} onClick={() => command({ type: 'run.cancel', payload: { runId: run.runId } })}>{text('실행 취소', 'Cancel execution')}</Button>}
        {run?.state === 'completed' && !run.integrationAuthorized && <Button size="sm" variant="primary" disabled={commandsDisabled} onClick={() => command({ type: 'run.integrate', payload: { runId: run.runId } })}>{text('검토된 결과 통합 허용', 'Allow integration of reviewed results')}</Button>}
        {run?.integrationAuthorized && <Badge variant="success">{run.integrationAuthorized.by === PLANNING_AUTO_APPROVAL_PRINCIPAL ? text('통합 허용됨 · 자동 승인', 'Integration allowed · auto-approve') : text('통합 허용됨', 'Integration allowed')}</Badge>}
        {run?.preparation.startedBy && props.onOpenConversation && <Button size="sm" variant="ghost" leadingIcon={<MessageSquare />} onClick={() => props.onOpenConversation!(run.preparation.startedBy!.sessionId)}>{text('시작한 대화', 'Started from')}</Button>}
        {run && props.onOpenResults && run.state !== 'prepared' && <Button size="sm" variant="ghost" leadingIcon={<FileSearch />} onClick={() => props.onOpenResults!(run.runId)}>{text('결과·검토·통합', 'Results, review, integration')}</Button>}
      </div>
      <div className="workflow-canvas-header__view" role="group" aria-label={text('흐름 보기', 'Workflow view')}>
        <Button size="sm" aria-pressed={props.layout === 'graph'} onClick={() => props.onLayoutChange('graph')} leadingIcon={<GitBranch />}>{text('그래프', 'Graph')}</Button>
        <Button size="sm" aria-pressed={props.layout === 'list'} onClick={() => props.onLayoutChange('list')} leadingIcon={<List />}>{text('목록', 'List')}</Button>
      </div>
    </div>
    {mode === 'edit' && run && !ended && <p className="workflow-hint">{text('편집 내용은 다음 실행에 사용합니다. 현재 실행은 시작한 버전과 설정을 유지합니다.', 'Edits apply to the next run. The current run keeps its original version and settings.')}</p>}
  </div>;
}
