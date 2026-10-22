import { ArrowLeft, Eye, FileSearch, GitBranch, Hand, LayoutGrid, List, MessageSquare, Pause, Play, Plus, Save, Square, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL, type ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowCommand, WorkflowNode } from '../../shared/workflow';
import { Badge, Button, Select } from '../ui';
import { workflowRunControls, type WorkflowCanvasMode } from './workflow-canvas-model';
import { workflowOperationLabel, workflowStateLabel, type WorkflowCopy } from './workflow-copy';

type RunCommand = Extract<WorkflowCommand, { type: 'run.start' | 'run.pause' | 'run.resume' | 'run.approve' | 'run.cancel' | 'run.integrate' }>;
export type WorkflowRunCommandInput<C = RunCommand> = C extends RunCommand ? Pick<C, 'type' | 'payload'> : never;
const OPERATIONS: WorkflowNode['operation'][] = ['agent', 'approval', 'condition', 'parallel', 'join', 'complete'];

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
  /** Stored positions overlap at the current card size: offer a one-click tidy. */
  readonly overlapping: boolean;
  readonly awaiting: readonly { readonly nodeId: string; readonly title: string }[];
  readonly layout: 'graph' | 'list';
  readonly onLayoutChange: (layout: 'graph' | 'list') => void;
  readonly onPickRun: (runId: string) => void;
  readonly onRunView: (open: boolean) => void;
  readonly onJumpToNode: (nodeId: string) => void;
  readonly onAddStage: (operation: WorkflowNode['operation']) => void;
  readonly onSaveDraft: () => void;
  readonly onDiscardDraft: () => void;
  readonly onAutoLayout: () => void;
  readonly onPrepareRun: () => void;
  readonly onRunCommand: (command: WorkflowRunCommandInput) => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenResults?: (runId: string) => void;
}

/**
 * Above the one canvas: what is being edited and its actions on the left, the run and only the
 * actions that can succeed now on the right, the graph/list switch at the end.
 */
export function WorkflowCanvasHeader(props: WorkflowCanvasHeaderProps): JSX.Element {
  const { text, mode, run, editLocked, commandsDisabled } = props;
  const [operation, setOperation] = useState<WorkflowNode['operation']>('agent');
  const controls = run ? workflowRunControls(run) : null;
  const ended = run ? run.state === 'completed' || run.state === 'cancelled' : true;
  const version = run?.preparation.workflow?.revision ?? '?';
  const command = (input: WorkflowRunCommandInput) => props.onRunCommand(input);
  return <div className="workflow-canvas-header" data-mode={mode}>
    {mode === 'run-view' && run && <div className="workflow-canvas-header__banner" role="status">
      <Eye aria-hidden="true" /><span>{text(`실행 v${version}이 시작할 때 고정된 흐름입니다. 여기서는 편집할 수 없습니다.`, `The flow frozen when run v${version} started. It cannot be edited here.`)}</span>
      <Button size="sm" leadingIcon={<ArrowLeft />} onClick={() => props.onRunView(false)}>{text('편집으로 돌아가기', 'Back to editing')}</Button>
    </div>}
    <div className="workflow-canvas-header__row">
      {mode === 'run-view' ? <Badge>{text(`실행 v${version} · 읽기 전용`, `Run v${version} · read-only`)}</Badge>
        : <div className="workflow-canvas-header__group" role="group" aria-label={text('초안', 'Draft')}>
          {props.hasLocalDraft ? <Badge variant="warning">{text('미저장 변경', 'Unsaved changes')}</Badge> : <Badge>{`${text('편집 초안', 'Draft')} v${props.revision}`}</Badge>}
          {props.hasLocalDraft && <>
            <Button size="sm" variant="primary" leadingIcon={<Save />} disabled={editLocked || commandsDisabled} onClick={props.onSaveDraft}>{text('초안 저장', 'Save draft')}</Button>
            <Button size="sm" leadingIcon={<Undo2 />} disabled={editLocked} onClick={props.onDiscardDraft}>{text('변경 취소', 'Discard changes')}</Button>
          </>}
          <span className="workflow-canvas-header__add">
            <Select aria-label={text('추가할 단계 종류', 'New stage type')} value={operation} disabled={editLocked} onChange={event => setOperation(event.target.value as WorkflowNode['operation'])}>{OPERATIONS.map(item => <option key={item} value={item}>{workflowOperationLabel(item, text)}</option>)}</Select>
            <Button size="sm" leadingIcon={<Plus />} disabled={editLocked} onClick={() => props.onAddStage(operation)}>{text('단계 추가', 'Add stage')}</Button>
          </span>
          <Button size="sm" leadingIcon={<Play />} disabled={editLocked || commandsDisabled || props.hasLocalDraft || props.issueCount > 0} onClick={props.onPrepareRun}>{run && !ended ? text('새 실행 준비', 'Prepare a new run') : text('실행 준비', 'Prepare run')}</Button>
        </div>}
      {run && controls && <div className="workflow-canvas-header__group workflow-canvas-header__run" role="group" aria-label={text('실행', 'Run')}>
        {props.runs.length > 1
          ? <Select aria-label={text('실행 기록', 'Execution history')} value={run.runId} onChange={event => props.onPickRun(event.target.value)}>{[...props.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(item => <option key={item.runId} value={item.runId}>{`v${item.preparation.workflow?.revision} · ${new Date(item.createdAt).toLocaleString()} · ${workflowStateLabel(item.state, text)}`}</option>)}</Select>
          : <Badge variant={ended ? 'neutral' : 'info'}>{`${text('실행', 'Run')} v${version} · ${workflowStateLabel(run.state, text)}`}</Badge>}
        {controls.cancelling && <Badge variant="warning">{text('취소 처리 중', 'Cancelling')}</Badge>}
        {controls.blocked && <Badge variant="warning">{text('멈춤 · 진행할 수 있는 단계 없음', 'Stopped · no stage can proceed')}</Badge>}
        {run.preparation.approvalPolicy === 'auto' && <Badge variant="warning">{text('자동 승인', 'Auto-approve')}</Badge>}
        {props.awaiting.length > 0 && controls.approvalsOpen && <Button size="sm" variant="primary" leadingIcon={<Hand />} onClick={() => props.onJumpToNode(props.awaiting[0].nodeId)}>{text(`승인 대기 ${props.awaiting.length}`, `${props.awaiting.length} awaiting approval`)}</Button>}
        {props.diverged && <Button size="sm" leadingIcon={<GitBranch />} onClick={() => props.onRunView(true)}>{ended ? text('최근 실행 보기', 'View last run') : text('진행 중인 실행 보기', 'View running run')}</Button>}
        {controls.canStart && <Button size="sm" variant="primary" leadingIcon={<Play />} disabled={commandsDisabled} onClick={() => command({ type: 'run.start', payload: { runId: run.runId } })}>{text('실행 시작', 'Start execution')}</Button>}
        {controls.canPause && <Button size="sm" leadingIcon={<Pause />} disabled={commandsDisabled} onClick={() => command({ type: 'run.pause', payload: { runId: run.runId } })}>{text('일시정지', 'Pause')}</Button>}
        {controls.canResume && <Button size="sm" leadingIcon={<Play />} disabled={commandsDisabled} onClick={() => command({ type: 'run.resume', payload: { runId: run.runId } })}>{text('같은 버전으로 재개', 'Resume this version')}</Button>}
        {controls.canCancel && <Button size="sm" leadingIcon={<Square />} disabled={commandsDisabled} onClick={() => command({ type: 'run.cancel', payload: { runId: run.runId } })}>{text('실행 취소', 'Cancel execution')}</Button>}
        {controls.canIntegrate && <Button size="sm" variant="primary" disabled={commandsDisabled} onClick={() => command({ type: 'run.integrate', payload: { runId: run.runId } })}>{text('검토된 결과 통합 허용', 'Allow integration of reviewed results')}</Button>}
        {run.integrationAuthorized && <Badge variant="success">{run.integrationAuthorized.by === PLANNING_AUTO_APPROVAL_PRINCIPAL ? text('통합 허용됨 · 자동 승인', 'Integration allowed · auto-approve') : text('통합 허용됨', 'Integration allowed')}</Badge>}
        {run.preparation.startedBy && props.onOpenConversation && <Button size="sm" variant="ghost" leadingIcon={<MessageSquare />} onClick={() => props.onOpenConversation!(run.preparation.startedBy!.sessionId)}>{text('시작한 대화', 'Started from')}</Button>}
        {props.onOpenResults && run.state !== 'prepared' && <Button size="sm" variant="ghost" leadingIcon={<FileSearch />} onClick={() => props.onOpenResults!(run.runId)}>{text('결과·검토·통합', 'Results, review, integration')}</Button>}
      </div>}
      <div className="workflow-canvas-header__view" role="group" aria-label={text('흐름 보기', 'Workflow view')}>
        <Button size="sm" aria-pressed={props.layout === 'graph'} onClick={() => props.onLayoutChange('graph')} leadingIcon={<GitBranch />}>{text('그래프', 'Graph')}</Button>
        <Button size="sm" aria-pressed={props.layout === 'list'} onClick={() => props.onLayoutChange('list')} leadingIcon={<List />}>{text('목록', 'List')}</Button>
      </div>
    </div>
    {props.overlapping && mode !== 'run-view' && props.layout === 'graph' && <p className="workflow-canvas-header__overlap" role="status"><span>{text('겹쳐 있는 단계가 있습니다.', 'Some stages overlap.')}</span><Button size="sm" leadingIcon={<LayoutGrid />} disabled={editLocked} onClick={props.onAutoLayout}>{text('자동 정렬', 'Tidy layout')}</Button></p>}
    {mode === 'edit' && run && !ended && <p className="workflow-hint">{text('편집 내용은 다음 실행에 사용합니다. 현재 실행은 시작한 버전과 설정을 유지합니다.', 'Edits apply to the next run. The current run keeps its original version and settings.')}</p>}
  </div>;
}
