import { FileSearch, Hand, MessageSquare, Pause, Play, RotateCw, Square } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL, blockingRunOf, type ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowSubproject } from '../../shared/workflow';
import { flowRunNumber } from '../../shared/workflow-run-view';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import { Badge, Button, Select } from '../ui';
import type { WorkflowRunCommandInput } from './WorkflowCanvasHeader';
import { workflowRunControls } from './workflow-canvas-model';
import { workflowStateLabel, type WorkflowCopy } from './workflow-copy';

export interface WorkflowRunBarProps {
  readonly text: WorkflowCopy;
  /** The run the flow shows (the one still going, else the latest), or none yet. */
  readonly run: ExecutionRun | null;
  /** This flow's runs. */
  readonly runs: readonly ExecutionRun[];
  readonly subproject: Pick<WorkflowSubproject, 'id' | 'autoApprove' | 'runSettings' | 'status'>;
  readonly providers: readonly StructuredAgentProviderOption[];
  /**
   * The host keeps run settings and runs the saved flow in one request (protocol v17). An older host
   * prepares from the run dialog instead, so the review AI is chosen there.
   */
  readonly savedRunSettings: boolean;
  /** Host writes are closed (offline, a request not confirmed yet). */
  readonly commandsDisabled: boolean;
  readonly hasLocalDraft: boolean;
  readonly issueCount: number;
  readonly awaiting: readonly { readonly nodeId: string; readonly title: string }[];
  readonly onLaunch: () => void;
  readonly onRunCommand: (command: WorkflowRunCommandInput) => void;
  readonly onPickRun: (runId: string) => void;
  readonly onSaveReviewer: (reviewer: { readonly providerId: string; readonly model: string }) => void;
  readonly onAutoApprove: (on: boolean) => void;
  readonly onJumpToNode: (nodeId: string) => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenResults?: (runId: string) => void;
}

/**
 * One line for everything that belongs to the flow's runs: where the shown run stands, 다시 실행 (the
 * saved flow with its saved settings), the actions that can succeed now, the run number menu, and the
 * settings every run uses (승인 내가/자동, 검토 AI), saved once on the subproject.
 */
export function WorkflowRunBar(props: WorkflowRunBarProps): JSX.Element {
  const { text, run, runs, subproject, commandsDisabled } = props;
  const why = useId();
  const controls = run ? workflowRunControls(run) : null;
  const going = blockingRunOf(runs, subproject.id);
  const reviewer = subproject.runSettings?.reviewer;
  // The provider is chosen first; the saved setting changes once a model of it is picked.
  const [providerId, setProviderId] = useState(reviewer?.providerId ?? '');
  useEffect(() => { setProviderId(reviewer?.providerId ?? ''); }, [reviewer?.providerId]);
  const provider = props.providers.find((entry) => entry.id === providerId);
  const archived = subproject.status === 'archived';
  const launchBlocked = archived ? text('보관된 소프로젝트입니다. 복원한 뒤 실행하세요.', 'This subproject is archived. Restore it to run.')
    : commandsDisabled ? text('호스트에 연결된 뒤 실행할 수 있습니다.', 'Connect to the host to run.')
      : going ? text(`실행 #${flowRunNumber(runs, going)}이 아직 끝나지 않았습니다. 끝나거나 취소한 뒤 다시 실행할 수 있습니다.`, `Run #${flowRunNumber(runs, going)} has not finished. Run again once it finishes or is cancelled.`)
        : props.hasLocalDraft ? text('저장하지 않은 변경이 있습니다. 저장한 흐름을 실행합니다.', 'There are unsaved changes. Save them first: a run uses the saved flow.')
          : props.issueCount > 0 ? text('실행 전에 확인할 단계가 있습니다.', 'Some stages need attention before running.')
            : props.savedRunSettings && !reviewer ? text('검토 AI를 먼저 고르세요.', 'Choose the review AI first.') : null;
  const number = run ? flowRunNumber(runs, run) : 0;
  const ordered = [...runs].sort((left, right) => flowRunNumber(runs, right) - flowRunNumber(runs, left));
  const command = (input: WorkflowRunCommandInput) => props.onRunCommand(input);
  return <div className="workflow-run-bar" role="group" aria-label={text('실행', 'Run')} data-testid="workflow-run-bar">
    <span className="workflow-run-bar__phase" data-testid="workflow-run-phase">
      {run ? text(`실행 #${number} · ${workflowStateLabel(run.state, text)}`, `Run #${number} · ${workflowStateLabel(run.state, text)}`) : text('아직 실행하지 않음', 'Not run yet')}
    </span>
    <Button size="sm" variant={launchBlocked ? 'secondary' : 'primary'} leadingIcon={<RotateCw />} disabled={!!launchBlocked} aria-describedby={launchBlocked ? why : undefined}
      onClick={props.onLaunch} data-testid="workflow-run-again">{runs.length ? text('다시 실행', 'Run again') : text('실행', 'Run')}</Button>
    {launchBlocked && <small id={why} className="workflow-run-bar__why">{launchBlocked}</small>}
    {run && controls && <>
      {controls.cancelling && <Badge variant="warning">{text('취소 처리 중', 'Cancelling')}</Badge>}
      {controls.blocked && <Badge variant="warning">{text('멈춤 · 진행할 수 있는 단계 없음', 'Stopped · no stage can proceed')}</Badge>}
      {props.awaiting.length > 0 && controls.approvalsOpen && <Button size="sm" variant="primary" leadingIcon={<Hand />} onClick={() => props.onJumpToNode(props.awaiting[0].nodeId)}>{text(`승인 대기 ${props.awaiting.length}`, `${props.awaiting.length} awaiting approval`)}</Button>}
      {controls.canStart && <Button size="sm" leadingIcon={<Play />} disabled={commandsDisabled || !!going} onClick={() => command({ type: 'run.start', payload: { runId: run.runId } })}>{text('실행 시작', 'Start execution')}</Button>}
      {controls.canPause && <Button size="sm" leadingIcon={<Pause />} disabled={commandsDisabled} onClick={() => command({ type: 'run.pause', payload: { runId: run.runId } })}>{text('일시정지', 'Pause')}</Button>}
      {controls.canResume && <Button size="sm" leadingIcon={<Play />} disabled={commandsDisabled} onClick={() => command({ type: 'run.resume', payload: { runId: run.runId } })}>{text('계속', 'Continue')}</Button>}
      {controls.canCancel && <Button size="sm" leadingIcon={<Square />} disabled={commandsDisabled} onClick={() => command({ type: 'run.cancel', payload: { runId: run.runId } })}>{text('실행 취소', 'Cancel execution')}</Button>}
      {controls.canIntegrate && <Button size="sm" variant="primary" disabled={commandsDisabled} onClick={() => command({ type: 'run.integrate', payload: { runId: run.runId } })}>{text('검토된 결과 통합 허용', 'Allow integration of reviewed results')}</Button>}
      {run.integrationAuthorized && <Badge variant="success">{run.integrationAuthorized.by === PLANNING_AUTO_APPROVAL_PRINCIPAL ? text('통합 허용됨 · 자동 승인', 'Integration allowed · auto-approve') : text('통합 허용됨', 'Integration allowed')}</Badge>}
      {runs.length > 1 && <Select aria-label={text('실행 번호', 'Run number')} value={run.runId} onChange={(event) => props.onPickRun(event.target.value)}>
        {ordered.map((entry) => <option key={entry.runId} value={entry.runId}>{`#${flowRunNumber(runs, entry)} · ${workflowStateLabel(entry.state, text)}${entry.startedAt ? '' : text(' · 시작 안 함', ' · not started')} · ${new Date(entry.createdAt).toLocaleString()}`}</option>)}
      </Select>}
      {props.onOpenResults && run.state !== 'prepared' && <Button size="sm" variant="ghost" leadingIcon={<FileSearch />} onClick={() => props.onOpenResults!(run.runId)}>{text('결과', 'Results')}</Button>}
      {run.preparation.startedBy && props.onOpenConversation && <Button size="sm" variant="ghost" leadingIcon={<MessageSquare />} onClick={() => props.onOpenConversation!(run.preparation.startedBy!.sessionId)}>{text('시작한 대화', 'Started from')}</Button>}
    </>}
    {/* 승인 and 검토 AI are saved on the subproject: runs prepared from now on use them (a run keeps its own). */}
    <span className="workflow-run-bar__group" role="group" aria-label={text('승인 단계 · 다음 실행부터', 'Approval stages · from the next run')} title={text('다음에 준비하는 실행부터 적용됩니다.', 'Applies to runs prepared from now on.')}>
      <span className="workflow-run-bar__label">{text('승인', 'Approval')}</span>
      {/* The person's switch (agents can never turn it on); runs prepared from now on use it. */}
      <Button size="sm" variant="ghost" aria-pressed={subproject.autoApprove !== true} disabled={commandsDisabled || archived} onClick={() => props.onAutoApprove(false)}>{text('내가 승인', 'I approve')}</Button>
      <Button size="sm" variant="ghost" aria-pressed={subproject.autoApprove === true} disabled={commandsDisabled || archived} onClick={() => props.onAutoApprove(true)} data-testid="workflow-auto-approve">{text('자동 승인', 'Auto-approve')}</Button>
    </span>
    {props.savedRunSettings && <span className="workflow-run-bar__group" role="group" aria-label={text('검토 AI · 다음 실행부터', 'Review AI · from the next run')} title={text('다음에 준비하는 실행부터 적용됩니다.', 'Applies to runs prepared from now on.')}>
      <span className="workflow-run-bar__label">{text('검토 AI', 'Review AI')}</span>
      <Select aria-label={text('검토 AI 제공자', 'Review AI provider')} value={providerId} disabled={commandsDisabled || archived} onChange={(event) => setProviderId(event.target.value)}>
        <option value="">{text('제공자 선택', 'Choose a provider')}</option>
        {reviewer && !props.providers.some((entry) => entry.id === reviewer.providerId) && <option value={reviewer.providerId}>{reviewer.providerId} · {text('사용 불가', 'Unavailable')}</option>}
        {props.providers.map((entry) => <option key={entry.id} value={entry.id} disabled={entry.disabled}>{entry.label}{entry.disabled ? text(' · 사용 불가', ' · Unavailable') : ''}</option>)}
      </Select>
      <Select aria-label={text('검토 모델', 'Reviewer model')} value={reviewer?.providerId === providerId ? reviewer.model : ''} disabled={commandsDisabled || archived || !providerId}
        onChange={(event) => { if (event.target.value) props.onSaveReviewer({ providerId, model: event.target.value }); }}>
        <option value="">{text('모델 선택', 'Choose a model')}</option>
        {/* A phone does not read model catalogs: the saved model is listed as it is unless the catalog says otherwise. */}
        {reviewer?.providerId === providerId && !provider?.models.some((model) => model.id === reviewer.model) && <option value={reviewer.model}>{reviewer.model}{provider?.models.length ? ` · ${text('재확인 필요', 'Recheck required')}` : ''}</option>}
        {provider?.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </Select>
    </span>}
  </div>;
}
