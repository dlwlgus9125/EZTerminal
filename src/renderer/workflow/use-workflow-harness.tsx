import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatAgentProfile, ChatAgentProfileAccess } from '../../shared/chat-agent-profiles';
import type { ProviderModel } from '../../shared/daemon-provider';
import type { ExecutionRun } from '../../shared/planning-execution';
import type { WorkflowAgentCatalogEntry, WorkflowSubproject } from '../../shared/workflow';
import type { WorkflowCheckConsentResult, WorkflowCheckStatus } from '../../shared/workflow-checks';
import { workflowApprovalNeedsPerson, type WorkflowGraph, type WorkflowNode } from '../../shared/workflow-graph';
import type { StructuredAgentProviderOption } from '../StructuredAgentSession';
import { ActionSheet, Switch } from '../ui';
import { workflowRunControls, type WorkflowNodeRunView } from './workflow-canvas-model';
import type { WorkflowEdgeDecoration, WorkflowNodeDecoration } from './workflow-canvas-types';
import { workflowEffortLabel, workflowPermissionLabel, type WorkflowCopy } from './workflow-copy';
import {
  agentTone, workflowAgentListItems, workflowAssignAgent, workflowCanSkipUnchanged, workflowEffortOptions, workflowHarnessDecorations, workflowNextCheckId,
  workflowReviewChoice, workflowReviewPatch, workflowStageSession,
} from './workflow-harness-model';
import { WorkflowAgentList } from './WorkflowAgentList';
import { WorkflowAnswerBox } from './WorkflowAnswerBox';
import type { WorkflowRunCommandInput } from './WorkflowCanvasHeader';
import { WorkflowCheckConsent } from './WorkflowCheckConsent';
import { WorkflowStageAgent, type WorkflowStageAgentCheck } from './WorkflowStageAgent';

/** 확인 명령 동의 on this PC (desktop preload): what the saved workflow's checks are and whether they may run. */
export interface WorkflowCheckAccess {
  status(projectId: string, subprojectId: string): Promise<WorkflowCheckConsentResult>;
  allow(projectId: string, subprojectId: string, nodeId: string, checkId: string, digest: string): Promise<WorkflowCheckConsentResult>;
}

export interface WorkflowHarnessInput {
  /** The phone: no dragging, 배정 opens a sheet, and check allowance stays on the PC. */
  readonly mobile: boolean;
  readonly active: boolean;
  readonly text: WorkflowCopy;
  readonly projectId: string;
  readonly subproject: WorkflowSubproject | undefined;
  /** The flow being edited (the saved one or its draft). */
  readonly graph: WorkflowGraph | undefined;
  /** This PC's saved agents (desktop); without it, the catalog the PC sends with the flow (the phone). */
  readonly profileAccess?: ChatAgentProfileAccess;
  readonly catalog?: readonly WorkflowAgentCatalogEntry[];
  readonly checkAccess?: WorkflowCheckAccess;
  /** Settings › AI › 에이전트 (desktop): 설정에서 관리 and 새 에이전트 in the list. */
  readonly onManageAgents?: () => void;
  readonly providers: readonly StructuredAgentProviderOption[];
  readonly catalogs: Readonly<Record<string, readonly ProviderModel[]>>;
  readonly selectedNodeId: string | null;
  /** A stage of the draft can change now (not locked, not the frozen run view, not working). */
  readonly canEdit: (nodeId: string) => boolean;
  readonly commandsDisabled: boolean;
  readonly agentsOpen: boolean;
  readonly onAgentsOpenChange: (open: boolean) => void;
  readonly onGraphChange: (graph: WorkflowGraph) => void;
  readonly onRunCommand: (command: WorkflowRunCommandInput) => void;
  readonly onOpenAttemptResult?: (runId: string, attemptId: string) => void;
}

export interface WorkflowHarness {
  /** The saved agents (null: this PC cannot list them, so stages keep the AI · 모델 · 노력 fields). */
  readonly profiles: readonly ChatAgentProfile[] | null;
  readonly profileIds?: ReadonlySet<string>;
  readonly decorations?: Readonly<Record<string, WorkflowNodeDecoration>>;
  readonly edgeDecorations?: Readonly<Record<string, WorkflowEdgeDecoration>>;
  readonly panelTop?: ReactNode;
  readonly stageSlots?: (node: WorkflowNode, run: ExecutionRun | null, view: WorkflowNodeRunView | undefined) => { readonly settings?: ReactNode; readonly top?: ReactNode; readonly conversationHint?: string } | undefined;
  readonly onDropAgent?: (nodeId: string, agentId: string) => void;
  /** Checks of the saved workflow this PC has not allowed (a run refused with 'unconfirmed-command' points to them). */
  readonly unallowed: readonly WorkflowCheckStatus[];
  readonly refreshChecks: () => void;
  readonly dialog: ReactNode;
}

/** Drops keys set to undefined, so a cleared field leaves the stored stage as if it was never set. */
function patched(node: WorkflowNode, patch: Partial<WorkflowNode>): WorkflowNode {
  const next = { ...node, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
  return next as WorkflowNode;
}
function latestAttempt(run: ExecutionRun, taskId: string): string | undefined {
  return run.attempts.filter(attempt => attempt.taskId === taskId).at(-1)?.attemptId;
}

/**
 * The approved harness canvas (2026-10 시안) on the real flow: agents from Settings placed on stages (drag or 배정),
 * each stage's own effort, permission, conversation, checks and review, the chain band, and what a run waits for
 * from the person (an answer, an approval with a note). Edits go to the draft like every stage edit.
 */
export function useWorkflowHarness(input: WorkflowHarnessInput): WorkflowHarness {
  const { mobile, text, graph, subproject, profileAccess, checkAccess, projectId } = input;
  const [listed, setListed] = useState<readonly ChatAgentProfile[] | null>(null);
  const [profileRead, setProfileRead] = useState(0);
  useEffect(() => {
    if (!profileAccess) { setListed(null); return undefined; }
    let alive = true;
    void profileAccess.list().then(list => { if (alive) setListed(list); }).catch(() => { if (alive) setListed(null); });
    return () => { alive = false; };
    // Read again for each workflow and when the list is opened (agents change in Settings meanwhile).
  }, [profileAccess, subproject?.id, profileRead]);
  // An older PC sends no catalog: its stages keep the AI · 모델 · 노력 fields. A PC with none saved sends an empty one.
  const profiles: readonly ChatAgentProfile[] | null = profileAccess ? listed : input.catalog ?? null;
  const { agentsOpen, onAgentsOpenChange } = input;
  const openAgents = (open: boolean) => { if (open) setProfileRead(count => count + 1); onAgentsOpenChange(open); };
  /** The phone's 배정 sheet (no dragging there). */
  const [sheetOpen, setSheetOpen] = useState(false);

  // Allowances read the saved workflow: again when a save changes its revision, and after allowing one.
  const [checks, setChecks] = useState<{ readonly key: string; readonly statuses: readonly WorkflowCheckStatus[] | null }>({ key: '', statuses: null });
  const [checkRead, setCheckRead] = useState(0);
  const checkKey = checkAccess && subproject ? `${projectId}:${subproject.id}:${subproject.revision}:${checkRead}` : '';
  useEffect(() => {
    if (!checkKey || !checkAccess || !subproject) return undefined;
    let alive = true;
    void checkAccess.status(projectId, subproject.id).then(result => { if (alive) setChecks({ key: checkKey, statuses: result.ok ? result.checks : null }); })
      .catch(() => { if (alive) setChecks({ key: checkKey, statuses: null }); });
    return () => { alive = false; };
  }, [checkKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the key names everything the read depends on
  const statuses = checks.key === checkKey ? checks.statuses : null;
  const refreshChecks = useCallback(() => setCheckRead(count => count + 1), []);
  const [consent, setConsent] = useState<{ readonly nodeId: string; readonly checkId: string } | null>(null);
  const allowing = useRef(false);
  const [allowError, setAllowError] = useState<{ readonly nodeId: string; readonly message: string } | null>(null);

  const [dragging, setDragging] = useState<string | null>(null);
  /** Stages whose agent came with 전체 권한, lowered to 승인 후 실행 when it was placed (said until it changes). */
  const [lowered, setLowered] = useState<Readonly<Record<string, string>>>({});
  /** What the person is writing for each waiting activation (an answer or a note), kept across polls. */
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  const listRef = useRef<HTMLDivElement>(null);

  const usable = profiles !== null;
  const profileIds = useMemo(() => profiles ? new Set(profiles.map(profile => profile.id)) : undefined, [profiles]);
  const decorationSet = useMemo(() => graph ? workflowHarnessDecorations(graph, { profileIds, providers: input.providers, text }) : null,
    // text is a fresh closure each render; the language is what matters.
    [graph, profileIds, input.providers, text('ko', 'en')]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchNode = (nodeId: string, patch: Partial<WorkflowNode>) => {
    if (!graph || !input.canEdit(nodeId)) return;
    input.onGraphChange({ ...graph, nodes: graph.nodes.map(node => node.id === nodeId ? patched(node, patch) : node) });
  };
  const assign = (nodeId: string, agentId: string) => {
    const profile = profiles?.find(entry => entry.id === agentId);
    const node = graph?.nodes.find(entry => entry.id === nodeId);
    if (!profile || node?.operation !== 'agent' || !input.canEdit(nodeId)) return;
    const result = workflowAssignAgent(profile, new Date().toISOString());
    patchNode(nodeId, result.patch);
    setLowered(current => { const next = { ...current }; if (result.lowered) next[nodeId] = profile.name; else delete next[nodeId]; return next; });
    // Said at once: the lowered permission shows in the stage's settings, brought into view below the list.
    if (result.lowered && !mobile) requestAnimationFrame(() => requestAnimationFrame(() => listRef.current?.closest('.workflow-flow__panel')
      ?.querySelector('.workflow-stage-agent__notice')?.scrollIntoView?.({ block: 'nearest' })));
  };
  const showList = () => {
    if (mobile) { setSheetOpen(true); return; }
    openAgents(true);
    requestAnimationFrame(() => {
      const list = listRef.current;
      list?.scrollIntoView?.({ block: 'nearest' });
      list?.querySelector<HTMLButtonElement>('.workflow-agent button:not(:disabled)')?.focus();
    });
  };
  const consentOf = (nodeId: string, check: { readonly id: string; readonly command: string }): WorkflowStageAgentCheck['consent'] => {
    const saved = subproject?.graph.nodes.find(node => node.id === nodeId)?.checks?.find(entry => entry.id === check.id);
    if (!saved || saved.command.trim() !== check.command.trim()) return 'unsaved';
    // A person allows a check on the PC that runs it; the phone cannot read or give that allowance.
    if (!checkAccess) return mobile ? 'pc-only' : 'unknown';
    if (!statuses) return 'unknown';
    const status = statuses.find(entry => entry.nodeId === nodeId && entry.checkId === check.id);
    return !status ? 'unknown' : status.allowed ? 'confirmed' : 'needed';
  };
  const reviewer = subproject?.runSettings?.reviewer;
  const reviewerLabel = reviewer ? [input.providers.find(item => item.id === reviewer.providerId)?.label ?? reviewer.providerId,
    input.providers.find(item => item.id === reviewer.providerId)?.models.find(item => item.id === reviewer.model)?.label ?? reviewer.model].join(' · ') : undefined;

  const agentSettings = (node: WorkflowNode): { readonly settings: ReactNode; readonly conversationHint?: string } => {
    const all = profiles ?? [];
    const session = graph ? workflowStageSession(graph, node, text) : { value: 'fresh' as const };
    const provider = input.providers.find(item => item.id === node.providerId);
    const permissionOptions = [{ value: 'plan', label: workflowPermissionLabel('plan', text) }, { value: 'standard', label: workflowPermissionLabel('standard', text) },
      ...(node.permissionPreset === 'full-access' ? [{ value: 'full-access', label: `${workflowPermissionLabel('full-access', text)} · ${text('워크플로에서 쓸 수 없음', 'not for workflows')}` }] : [])];
    const capturedAt = () => new Date().toISOString();
    const settings = <WorkflowStageAgent text={text} key={node.id}
      agent={node.agent ? {
        name: node.agent.name, tone: agentTone(node.providerId ?? node.agent.providerId), missing: !profileIds?.has(node.agent.profileId) || undefined,
        detail: [provider?.label ?? node.providerId, provider?.models.find(model => model.id === node.model)?.label ?? node.model, workflowPermissionLabel(node.permissionPreset, text)].filter(Boolean).join(' · '),
        effortLabel: (effort => effort ? workflowEffortLabel(effort, text) : undefined)(all.find(profile => profile.id === node.agent!.profileId)?.reasoningEffort),
        permissionLabel: workflowPermissionLabel(node.permissionPreset, text),
      } : undefined}
      tunable={!!node.agent || !!node.providerId}
      notice={lowered[node.id] ? text(`'${lowered[node.id]}'은(는) 전체 권한 에이전트라 이 단계는 승인 후 실행으로 낮췄습니다. 워크플로는 작업 폴더 안에서만 씁니다.`, `'${lowered[node.id]}' has full access; this stage runs with approval instead. Workflows write only inside their work folder.`) : undefined}
      session={session}
      effort={{ value: node.reasoningEffort ?? '', options: workflowEffortOptions(node, input.catalogs, text) }}
      permission={{ value: node.permissionPreset, options: permissionOptions,
        note: node.permissionPreset === 'plan' ? undefined : node.allowedPaths.length ? text(`바꿀 수 있는 경로: ${node.allowedPaths.join(', ')}`, `May change: ${node.allowedPaths.join(', ')}`) : text('바꿀 수 있는 경로를 고급에서 정하세요(필수).', 'Set the paths it may change under Advanced (required).') }}
      checks={(node.checks ?? []).map(check => ({ id: check.id, command: check.command, consent: consentOf(node.id, check) }))}
      review={workflowReviewChoice(node, all, reviewerLabel, text)}
      onChange={change => {
        if (change.session) patchNode(node.id, { session: change.session as 'continue' | 'fresh' });
        if (change.effort !== undefined) patchNode(node.id, { reasoningEffort: change.effort || undefined });
        if (change.permission === 'plan' || change.permission === 'standard') patchNode(node.id, { permissionPreset: change.permission });
        if (change.review !== undefined) patchNode(node.id, workflowReviewPatch(change.review, all, node, capturedAt()));
      }}
      onReplace={showList} onAssign={showList} onRemove={() => { patchNode(node.id, { agent: undefined }); setLowered(current => { const next = { ...current }; delete next[node.id]; return next; }); }}
      onConfirmCheck={checkAccess ? checkId => { setAllowError(null); setConsent({ nodeId: node.id, checkId }); } : undefined}
      onAddCheck={command => patchNode(node.id, { checks: [...(node.checks ?? []), { id: workflowNextCheckId(node), command }] })}
      onRemoveCheck={checkId => { const rest = (node.checks ?? []).filter(check => check.id !== checkId); patchNode(node.id, { checks: rest.length ? rest : undefined }); }}>
      {graph && (node.skipWhenUnchanged || workflowCanSkipUnchanged(graph, node.id)) && <Switch checked={node.skipWhenUnchanged === true} data-testid="workflow-stage-skip-unchanged"
        label={text('결과가 같으면 건너뜀', 'Skip when unchanged')}
        description={text('앞 단계 확인 명령 결과가 지난번 실행과 같으면 이 단계는 AI를 돌리지 않고 "변화 없음"으로 넘어갑니다. 명령이 실패하거나 시간이 넘으면 건너뛰지 않습니다.', 'When the checks before it give the same result as the last run, this stage runs no AI and passes as "no change". A failed or timed-out check never skips it.')}
        onChange={event => patchNode(node.id, { skipWhenUnchanged: event.target.checked || undefined })} />}
      {allowError?.nodeId === node.id ? <p className="workflow-stage-agent__notice" role="alert">{text('확인 명령을 허용하지 못했습니다.', 'The check could not be allowed.')} {allowError.message}</p> : null}
    </WorkflowStageAgent>;
    return { settings, ...(session.conversationHint ? { conversationHint: session.conversationHint } : {}) };
  };

  /** What a run waits for from the person at this stage, or why it passed without running. */
  const runTop = (node: WorkflowNode, run: ExecutionRun | null, view: WorkflowNodeRunView | undefined): ReactNode => {
    if (!run || !view) return undefined;
    if (view.skipped !== undefined) return <p className="workflow-stage-note" role="status" data-testid="workflow-stage-skipped"><strong>{text('변화 없음 · 건너뜀', 'No change · skipped')}</strong>{view.skipped ? ` — ${view.skipped}` : ''}</p>;
    if (view.status !== 'awaiting-approval' || !view.activationId) return undefined;
    const frozenGraph = run.preparation.workflow?.graph;
    const frozen = frozenGraph?.nodes.find(entry => entry.id === node.id) ?? node;
    const titleOf = (id: string) => frozenGraph?.nodes.find(entry => entry.id === id)?.title ?? id;
    const activationId = view.activationId;
    // Activation ids repeat from run to run (wf:<node>:<iteration>): a draft belongs to this run of this workflow.
    const draftKey = JSON.stringify([projectId, subproject?.id ?? '', run.runId, activationId]);
    const value = notes[draftKey] ?? '';
    const setValue = (next: string) => setNotes(current => ({ ...current, [draftKey]: next }));
    const disabled = input.commandsDisabled || !workflowRunControls(run).approvalsOpen;
    const resultOf = (stageId: string | undefined) => {
      const attempt = stageId ? latestAttempt(run, stageId) : undefined;
      return attempt && input.onOpenAttemptResult ? () => input.onOpenAttemptResult!(run.runId, attempt) : undefined;
    };
    if (view.asks === 'answer') {
      const shown = frozen.answer?.showResultOf;
      return <WorkflowAnswerBox text={text} question={frozen.answer?.prompt ?? text('이 단계는 사람의 답을 기다립니다.', 'This stage waits for your answer.')} {...(shown ? { from: titleOf(shown) } : {})}
        value={value} disabled={disabled} onChange={setValue} onOpenResult={resultOf(shown)}
        onSend={() => { const answer = value.trim(); if (answer) input.onRunCommand({ type: 'run.answer', payload: { runId: run.runId, activationId, answer } }); }} />;
    }
    // An approval that sends its rejection back to a stage: approve, or send it back with a note for that stage.
    const back = frozenGraph?.edges.find(edge => edge.from === node.id && edge.outcome === 'rejected');
    // A rejection that ends the run (or goes anywhere but an AI stage) keeps the stage panel's own 승인 · 거부.
    if (node.operation !== 'approval' || !back || frozenGraph?.nodes.find(entry => entry.id === back.to)?.operation !== 'agent') return undefined;
    const source = frozenGraph?.edges.find(edge => edge.to === node.id && !edge.retryLimit)?.from;
    return <WorkflowAnswerBox text={text} question={frozen.instructions || text('이 단계 이후의 실행을 승인합니다.', 'Approve execution after this stage.')} {...(source ? { from: titleOf(source) } : {})}
      value={value} disabled={disabled} onChange={setValue} onOpenResult={resultOf(source)}
      decision={{ returnsTo: titleOf(back.to),
        onApprove: () => input.onRunCommand({ type: 'run.approve', payload: { runId: run.runId, activationId, decision: 'approve' } }),
        onReturn: () => { const comment = value.trim(); input.onRunCommand({ type: 'run.approve', payload: { runId: run.runId, activationId, decision: 'reject', ...(comment ? { comment } : {}) } }); } }} />;
  };

  const stageSlots = (node: WorkflowNode, run: ExecutionRun | null, view: WorkflowNodeRunView | undefined) => {
    const top = runTop(node, run, view);
    const slot = { ...(top ? { top } : {}) };
    // With no agent to place and none placed, a stage keeps choosing its AI · 모델 · 노력 itself.
    if (node.operation === 'agent' && profiles && (profiles.length > 0 || node.agent)) return { ...slot, ...agentSettings(node) };
    if (node.operation === 'approval' && graph && workflowApprovalNeedsPerson(graph, node.id)) {
      const source = graph.edges.find(edge => edge.to === node.id && !edge.retryLimit)?.from;
      const title = graph.nodes.find(entry => entry.id === source)?.title ?? '';
      return { ...slot, settings: <p className="workflow-stage-note" data-testid="workflow-stage-person-accepts">{text(`'${title}'은(는) 검토도 확인 명령도 없는 단계입니다. 여기서 승인하면 사람이 결과를 수락한 것으로 기록되며, 자동 승인으로 넘어가지 않습니다.`, `'${title}' has no review and no check. Approving here records that a person accepted its result; auto-approve never answers it.`)}</p> };
    }
    return top ? slot : undefined;
  };

  const target = graph?.nodes.find(node => node.id === input.selectedNodeId && node.operation === 'agent' && input.canEdit(node.id));
  const consentStatus = consent ? statuses?.find(entry => entry.nodeId === consent.nodeId && entry.checkId === consent.checkId) : undefined;
  const allow = async () => {
    if (!consentStatus || !checkAccess || !subproject || allowing.current) return;
    allowing.current = true;
    const result = await checkAccess.allow(projectId, subproject.id, consentStatus.nodeId, consentStatus.checkId, consentStatus.digest)
      .catch((reason: unknown) => ({ ok: false as const, error: 'failed', message: String(reason) }));
    allowing.current = false;
    setConsent(null);
    if (result.ok) setChecks({ key: checkKey, statuses: result.checks });
    else { setAllowError({ nodeId: consentStatus.nodeId, message: result.message }); refreshChecks(); }
  };

  const items = usable ? workflowAgentListItems(profiles, graph, input.providers, text) : [];
  return {
    profiles, profileIds,
    decorations: decorationSet?.nodes, edgeDecorations: decorationSet?.edges,
    panelTop: usable && !mobile ? <div ref={listRef}><WorkflowAgentList text={text} agents={items} open={agentsOpen} onOpenChange={openAgents}
      targetStage={target?.title} dragging={dragging ?? undefined} onDragAgent={setDragging} onAssign={target ? agentId => assign(target.id, agentId) : undefined}
      {...(input.onManageAgents ? { onManage: input.onManageAgents } : {})} /></div>
      // A phone whose PC sends no agent list runs an older EZTerminal: stages keep their AI fields until it is updated.
      : mobile && !usable ? <p className="workflow-stage-note" role="note" data-testid="workflow-agents-need-pc-update">{text('PC의 EZTerminal을 업데이트하면 이 폰에서도 단계에 에이전트를 배정할 수 있습니다.', 'Update EZTerminal on the PC to assign agents to stages from this phone.')}</p>
        : undefined,
    stageSlots,
    onDropAgent: usable && !mobile ? assign : undefined,
    unallowed: statuses?.filter(entry => !entry.allowed) ?? [],
    refreshChecks,
    dialog: <>
      {consentStatus && <WorkflowCheckConsent text={text} open={input.active} command={consentStatus.command} reason={consentStatus.reason ?? 'new'}
        location={text('이 단계의 결과 폴더 (실행마다 만드는 작업 폴더 · 프로젝트 폴더가 아님)', 'This stage’s result folder (a work folder made for each run, never the project folder)')}
        {...(consentStatus.scripts.length ? { resolved: { label: text('부르는 스크립트', 'Scripts it calls'), value: consentStatus.scripts.join(', ') } } : {})}
        {...(consentStatus.before ? { before: consentStatus.before } : {})}
        onAllow={() => void allow()} onClose={() => setConsent(null)} />}
      {mobile && usable && <ActionSheet open={input.active && sheetOpen && !!target} onOpenChange={setSheetOpen} title={text('에이전트 배정', 'Assign an agent')} closeLabel={text('닫기', 'Close')}>
        <WorkflowAgentList text={text} variant="sheet" agents={items} open onOpenChange={() => undefined} targetStage={target?.title}
          onAssign={target ? agentId => { assign(target.id, agentId); setSheetOpen(false); } : undefined} />
      </ActionSheet>}
    </>,
  };
}
