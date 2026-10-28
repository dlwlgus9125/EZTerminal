import { Glyph } from '../ui/Glyph';
import { useEffect, useState, type ReactNode } from 'react';
import type { ProviderModel } from '../../shared/daemon-provider';
import type { ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowGraph, WorkflowNode } from '../../shared/workflow-graph';
import { runStageConversation } from '../../shared/workflow-run-view';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import { Button, Field, Input, Select, Status } from '../ui';
import { workflowRunControls, type WorkflowNodeRunView } from './workflow-canvas-model';
import { workflowEffortLabel, workflowOperationLabel, workflowPermissionLabel, type WorkflowCopy } from './workflow-copy';
import { workflowRunStatusPresentation } from './WorkflowNodeCard';
import { WorkflowNodeRunSection, WorkflowStageSection, type WorkflowStageLink } from './WorkflowNodeSections';
import { WorkflowNodeSettings } from './WorkflowNodeSettings';

export type WorkflowStageScope = 'this-run' | 'next-run' | 'locked';

export interface WorkflowStagePanelProps {
  readonly text: WorkflowCopy;
  /** The graph being edited (the saved flow, or its unsaved draft). */
  readonly graph: WorkflowGraph;
  readonly node: WorkflowNode;
  /** A removed stage's record: read only. */
  readonly archived: boolean;
  /** Local edits are possible (not archived, no request waiting, recovery ready). */
  readonly editable: boolean;
  /** "단계 편집": the stage's place in the flow (kind, connections, start) is editable too. */
  readonly structure: boolean;
  readonly run: ExecutionRun | null;
  readonly runNumber: number;
  /** This stage's work folder in the shown run was cleaned up (작업 폴더 정리): its conversations stay readable as history. */
  readonly runCleaned?: boolean;
  /** This stage in the shown run, when the run is shown over this flow. */
  readonly view?: WorkflowNodeRunView;
  /** Whether a change reaches the run still going (see stageEditScope); null without one. */
  readonly scope: WorkflowStageScope | null;
  /** Open "이 단계 기록" (a stage reached from an approval or a run status). */
  readonly recordOpen?: boolean;
  readonly providers: readonly StructuredAgentProviderOption[];
  /** Model catalogs per provider: the efforts a model offers. */
  readonly catalogs: Readonly<Record<string, readonly ProviderModel[]>>;
  readonly commandsDisabled: boolean;
  readonly links: readonly WorkflowStageLink[];
  readonly canStartChat: boolean;
  readonly onChange: (graph: WorkflowGraph) => void;
  readonly onRequestDelete?: (nodeId: string) => void;
  readonly onMove?: (nodeId: string, dy: number) => void;
  readonly onApprove: (activationId: string, decision: 'approve' | 'reject') => void;
  readonly onStartChat: () => void;
  readonly onOpenConversation?: (sessionId: string) => void;
  readonly onOpenAttemptResult?: (attemptId: string) => void;
  /** The agent placed on the stage with its own effort, permission, checks and review, in place of AI · 모델 · 노력. */
  readonly settingsSlot?: ReactNode;
  /** What the stage waits for from the person (an answer), under its run state. */
  readonly topSlot?: ReactNode;
  /** The stage's kind as the flow names it (e.g. 답변 기다림), in place of the operation's name. */
  readonly kindLabel?: string;
  readonly instructionsLabel?: string;
  /** The run state in this stage's own words (e.g. 답변 대기 for an answer stage). */
  readonly statusLabel?: string;
  /** Where this stage's conversation comes from (e.g. it continues the previous stage's). */
  readonly conversationHint?: string;
}

/** Lines in a text box ↔ a list; the box keeps what is typed (blank lines too) and stores the list. */
function useLines(value: readonly string[]): [string, (next: string) => readonly string[]] {
  const [typed, setTyped] = useState(value.join('\n'));
  const joined = value.join('\n');
  useEffect(() => { setTyped((current) => current.split('\n').map((line) => line.trim()).filter(Boolean).join('\n') === joined ? current : joined); }, [joined]);
  return [typed, (next) => { setTyped(next); return next.split('\n').map((line) => line.trim()).filter(Boolean); }];
}

/** The AI stages before this one (forward connections only): the results an answer stage can show. */
function earlierAiStages(graph: WorkflowGraph, nodeId: string): readonly WorkflowNode[] {
  const seen = new Set<string>(); const pending = [nodeId];
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of graph.edges) if (edge.to === current && !edge.retryLimit && !seen.has(edge.from)) { seen.add(edge.from); pending.push(edge.from); }
  }
  return graph.nodes.filter((item) => item.id !== nodeId && seen.has(item.id) && item.operation === 'agent');
}

/**
 * An answer stage's question and the result it shows beside it. A question is required to store the answer
 * settings (the flow keeps none while it is blank), so the box keeps what is typed and the result waits for it.
 */
function WorkflowAnswerFields({ text, graph, node, onChange }: { readonly text: WorkflowCopy; readonly graph: WorkflowGraph; readonly node: WorkflowNode; readonly onChange: (patch: Partial<WorkflowNode>) => void }): JSX.Element {
  const saved = node.answer?.prompt ?? '';
  const [typed, setTyped] = useState(saved);
  useEffect(() => { setTyped((current) => current.trim() === saved.trim() ? current : saved); }, [saved]);
  const results = earlierAiStages(graph, node.id);
  const shown = node.answer?.showResultOf;
  return <>
    <label className="workflow-field">{text('물어볼 내용', 'What to ask')}
      <textarea rows={4} value={typed} maxLength={4000} data-testid="workflow-answer-prompt" onChange={(event) => {
        const value = event.target.value; setTyped(value);
        onChange({ answer: value.trim() ? { prompt: value, ...(shown ? { showResultOf: shown } : {}) } : undefined });
      }} /></label>
    <Field label={text('보여 줄 결과', 'Result to show')} description={saved.trim() ? undefined : text('물어볼 내용을 쓰면 고를 수 있습니다.', 'Write what to ask first.')}>
      <Select value={shown ?? ''} disabled={!saved.trim()} data-testid="workflow-answer-result"
        onChange={(event) => onChange({ answer: { prompt: saved, ...(event.target.value ? { showResultOf: event.target.value } : {}) } })}>
        <option value="">{text('보여 주지 않음', 'None')}</option>
        {shown && !results.some((item) => item.id === shown) && <option value={shown}>{graph.nodes.find((item) => item.id === shown)?.title ?? shown}{` · ${text('앞 AI 단계 아님', 'not an earlier AI stage')}`}</option>}
        {results.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </Select>
    </Field>
  </>;
}

/**
 * What belongs to one stage, in one column: where it stands in the shown run and its conversations,
 * then its own settings (AI · 모델, 노력, 지시; the rest under 고급), its place in the flow while the flow
 * is being edited, its document and conversations, and its full record in the run.
 */
export function WorkflowStagePanel(props: WorkflowStagePanelProps): JSX.Element {
  const { text, graph, node, run, view, scope } = props;
  const update = (patch: Partial<WorkflowNode>) => props.onChange({ ...graph, nodes: graph.nodes.map((item) => item.id === node.id ? { ...item, ...patch } : item) });
  const locked = scope === 'locked';
  const editable = props.editable && !props.archived && !locked;
  const status = view ? workflowRunStatusPresentation(view, text) : null;
  const conversation = runStageConversation(run ?? undefined, node.id);
  const awaiting = run?.workflowRuntime?.activations.find((entry) => entry.nodeId === node.id && entry.state === 'awaiting-approval');
  // What the person approves is what the run froze, never an unsaved draft of it.
  const frozen = run?.preparation.workflow?.graph.nodes.find((item) => item.id === node.id);
  const approvalsOpen = run ? workflowRunControls(run).approvalsOpen : false;
  const provider = props.providers.find((item) => item.id === node.providerId);
  const catalog = props.catalogs[node.providerId ?? ''];
  const efforts = catalog?.find((model) => model.id === node.model)?.reasoningEfforts ?? [];
  const [acceptance, setAcceptance] = useLines(node.acceptance);
  const [paths, setPaths] = useLines(node.allowedPaths);
  const scopeNote = scope === 'this-run' ? text('이번 실행에서 아직 시작하지 않은 단계입니다. 저장하면 이번 실행에 반영됩니다.', 'This stage has not started in this run: saved changes apply to this run.')
    : scope === 'next-run' ? text('이번 실행에서는 이미 정해졌습니다. 바꾸면 다음 실행부터 적용됩니다.', 'This run has already settled this stage: changes apply from the next run.')
      : locked ? text('이 단계가 지금 작업 중이라 설정을 바꿀 수 없습니다. 끝나면 다음 실행용으로 바꿀 수 있습니다.', 'This stage is working now, so its settings are locked. Once it finishes they can change for the next run.') : null;
  return <div className="workflow-stage-panel" data-testid="workflow-stage-panel">
    <div className="workflow-flow__panel-head"><small>{props.kindLabel ?? workflowOperationLabel(node.operation, text)}{graph.entryNodeId === node.id ? text(' · 시작', ' · Entry') : ''}</small><h3>{node.title}</h3></div>
    {run && <p className="workflow-stage-panel__state" data-testid="workflow-stage-state">
      {/* An element, so WebView 74's flex-gap fallback spaces it too (mobile-shared.css). */}
      <span>{text(`실행 #${props.runNumber}`, `Run #${props.runNumber}`)}</span>
      {status ? <Status variant={status.variant} icon={status.variant === 'loading' ? undefined : status.icon}>{props.statusLabel ?? status.label}</Status> : <span>{text('이 실행에 표시하지 않음', 'Not shown for this run')}</span>}
    </p>}
    {props.topSlot}
    {/* A stage that asks the person in its own way (an answer, an approval with a comment) shows that instead. */}
    {awaiting && !props.topSlot && <div className="workflow-approval" data-testid="workflow-stage-approval">
      <p>{(frozen ?? node).instructions || text('이 단계 이후의 실행을 승인합니다.', 'Approve execution after this stage.')}</p>
      <div className="workflow-inline">
        <Button variant="primary" disabled={props.commandsDisabled || !approvalsOpen} onClick={() => props.onApprove(awaiting.id, 'approve')}>{text('승인', 'Approve')}</Button>
        <Button disabled={props.commandsDisabled || !approvalsOpen} onClick={() => props.onApprove(awaiting.id, 'reject')}>{text('거부', 'Reject')}</Button>
      </div>
    </div>}
    {node.operation === 'agent' && <div className="workflow-stage-panel__conversations">
      <Button leadingIcon={<Glyph name="chat" />} variant={conversation?.working ? 'primary' : 'secondary'} disabled={!conversation || !props.onOpenConversation}
        onClick={() => conversation && props.onOpenConversation?.(conversation.sessionId)} data-testid="workflow-stage-open">
        {conversation?.working ? text('작업 중인 대화 열기', 'Open the working conversation') : text('이 단계 대화 열기', 'Open this stage’s conversation')}
      </Button>
      {conversation?.reviewSessionId && <Button variant="ghost" leadingIcon={<Glyph name="search" />} onClick={() => props.onOpenConversation?.(conversation.reviewSessionId!)}>{text('검토 대화 열기', 'Open the review conversation')}</Button>}
      {!conversation && <p className="workflow-hint">{run ? text('이번 실행에서 아직 시작하지 않아 대화가 없습니다.', 'No conversation yet: this stage has not started in this run.') : props.conversationHint ?? text('실행하면 단계마다 새 대화가 생깁니다.', 'Each run starts a new conversation for each stage.')}</p>}
      {props.runCleaned && <p className="workflow-hint" data-testid="workflow-stage-cleaned">{text('이 단계의 작업 폴더는 정리되었습니다. 대화 기록과 결과는 그대로 볼 수 있습니다.', 'This stage’s work folder was cleaned up. Its conversations and results stay readable.')}</p>}
    </div>}
    {/* Only an AI stage binds its settings when it is first sent; other stages change from the next run. */}
    {scopeNote && node.operation === 'agent' && <p className="workflow-notice" role="status" data-scope={scope} data-testid="workflow-stage-scope">{scopeNote}</p>}
    <fieldset className="workflow-stage-panel__fields" disabled={!editable} data-testid="workflow-stage-fields">
      <legend>{text('이 단계 설정', 'This stage’s settings')}</legend>
      <div className="workflow-stage-panel__grid">
      {props.settingsSlot}
      {node.operation === 'agent' && !props.settingsSlot && <>
        <Field label={text('AI', 'AI')}><Select value={node.providerId ?? ''} onChange={(event) => update({ providerId: event.target.value || undefined, model: undefined, reasoningEffort: undefined })}>
          <option value="">{text('선택하세요', 'Choose a provider')}</option>
          {node.providerId && !provider && <option value={node.providerId}>{node.providerId} · {text('사용 불가', 'Unavailable')}</option>}
          {props.providers.map((item) => <option value={item.id} key={item.id} disabled={item.disabled}>{item.label}{item.disabled ? text(' · 사용 불가', ' · Unavailable') : ''}</option>)}
        </Select></Field>
        <Field label={text('모델', 'Model')}><Select value={node.model ?? ''} onChange={(event) => update({ model: event.target.value || undefined, reasoningEffort: undefined })}>
          <option value="">{text('모델 선택', 'Choose a model')}</option>
          {/* Without a catalog (a phone) the stage's model is listed as it is. */}
          {node.model && !provider?.models.some((model) => model.id === node.model) && <option value={node.model}>{node.model}{provider?.models.length ? ` · ${text('재확인 필요', 'Recheck required')}` : ''}</option>}
          {provider?.models.map((model) => <option value={model.id} key={model.id}>{model.label}</option>)}
        </Select></Field>
        {/* Only the efforts the chosen model offers (a stage keeps none unless one is picked). */}
        <Field label={text('노력', 'Effort')} description={efforts.length ? undefined : catalog?.length ? text('이 모델은 노력 설정을 알리지 않습니다.', 'This model does not offer an effort setting.') : undefined}>
          <Select value={node.reasoningEffort ?? ''} disabled={!efforts.length && !node.reasoningEffort} onChange={(event) => update({ reasoningEffort: event.target.value || undefined })} data-testid="workflow-stage-effort">
            <option value="">{text('모델 기본값', 'Model default')}</option>
            {node.reasoningEffort && !efforts.includes(node.reasoningEffort) && <option value={node.reasoningEffort}>{workflowEffortLabel(node.reasoningEffort, text)}{catalog?.length ? ` · ${text('재확인 필요', 'Recheck required')}` : ''}</option>}
            {efforts.map((effort) => <option key={effort} value={effort}>{workflowEffortLabel(effort, text)}</option>)}
          </Select>
        </Field>
      </>}
      {node.operation === 'answer' && <WorkflowAnswerFields text={text} graph={graph} node={node} onChange={update} />}
      {/* An answer stage asks with its question; it has no instructions to run. */}
      {node.operation !== 'answer' && <label className="workflow-field">{props.instructionsLabel ?? (node.operation === 'approval' ? text('승인할 내용', 'What to approve') : text('지시', 'Instructions'))}<textarea rows={4} value={node.instructions} onChange={(event) => update({ instructions: event.target.value })} /></label>}
      {node.operation === 'agent' && <details className="workflow-stage-panel__more" data-testid="workflow-stage-advanced">
        <summary>{text('고급', 'Advanced')}</summary>
        {/* With an agent placed, permission sits with the agent settings above. */}
        {!props.settingsSlot && <Field label={text('권한', 'Permissions')}><Select value={node.permissionPreset} onChange={(event) => update({ permissionPreset: event.target.value as WorkflowNode['permissionPreset'] })}>
          <option value="plan">{workflowPermissionLabel('plan', text)}</option><option value="standard">{workflowPermissionLabel('standard', text)}</option>
          {node.permissionPreset === 'full-access' && <option value="full-access" disabled>{`${workflowPermissionLabel('full-access', text)} · ${text('관리형 실행에서 미지원', 'unsupported for managed execution')}`}</option>}
        </Select></Field>}
        <label className="workflow-field">{text('완료 조건 · 한 줄에 하나', 'Acceptance criteria · one per line')}<textarea rows={3} value={acceptance} onChange={(event) => update({ acceptance: [...setAcceptance(event.target.value)] })} /></label>
        <label className="workflow-field">{node.permissionPreset === 'plan' ? text('바꿀 수 있는 경로 · 한 줄에 하나', 'Paths it may change · one per line') : text('바꿀 수 있는 경로 · 한 줄에 하나 (필수)', 'Paths it may change · one per line (required)')}
          <textarea rows={2} value={paths} placeholder="src/login/" onChange={(event) => update({ allowedPaths: [...setPaths(event.target.value)] })} /></label>
        <Field label={text('실패하면 다시 시도', 'Retry on failure')}><Input type="number" min={0} max={20} value={node.retryLimit} onChange={(event) => update({ retryLimit: Math.min(20, Math.max(0, Number(event.target.value))) })} /></Field>
      </details>}
      </div>
    </fieldset>
    {props.structure && <details className="workflow-stage-panel__more" open data-testid="workflow-stage-structure">
      <summary>{text('구조', 'Structure')}</summary>
      {/* Where the stage sits: these changes apply from the next run. */}
      {/* Its connections may change while it works (they apply next run); its title is one of its settings. */}
      <WorkflowNodeSettings part="structure" graph={graph} node={node} text={text} readOnly={!props.editable || props.archived} titleLocked={locked} providers={props.providers} onChange={props.onChange} onRequestDelete={props.onRequestDelete} onMove={props.onMove} />
    </details>}
    <WorkflowStageSection node={node} text={text} readOnly={!editable} archived={props.archived} links={props.links} canStartChat={props.canStartChat && !props.commandsDisabled}
      onDocumentChange={(document) => update({ document })} onStartChat={props.onStartChat} onOpenConversation={props.onOpenConversation} />
    {run && <details className="workflow-stage-panel__more" open={props.recordOpen || undefined} data-testid="workflow-stage-record">
      <summary>{text('이 단계 기록', 'This stage’s record')}</summary>
      <WorkflowNodeRunSection run={run} node={run.preparation.workflow?.graph.nodes.find((item) => item.id === node.id) ?? node} view={view} text={text} commandsDisabled={props.commandsDisabled} decisions={false}
        onApprove={props.onApprove} onOpenConversation={props.onOpenConversation} onOpenAttemptResult={props.onOpenAttemptResult} />
    </details>}
  </div>;
}
