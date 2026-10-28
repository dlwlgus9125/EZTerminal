import type { ChatAgentPhaseMap, ChatAgentProfile } from '../../shared/chat-agent-profiles';
import type { ExecutionAttempt, ExecutionReview, ExecutionRun, ExecutionTask, PreparedExecutionTask } from '../../shared/planning-execution';
import type { WorkflowActivation, WorkflowGraph, WorkflowNode } from '../../shared/workflow-graph';
import type { WorkflowAgentListItem } from '../workflow/WorkflowAgentList';
import type { WorkflowEdgeDecoration, WorkflowNodeDecoration } from '../workflow/workflow-canvas-types';
import type { WorkflowTemplateChoice } from '../workflow/WorkflowTemplateDialog';

/**
 * Mockup data (2026-10 harness 시안): the "개발 절차" template as a workflow with agents placed on it,
 * the agents from Settings and the 단계 연결. Storybook only; production code never imports this file.
 */
export const HARNESS_PROFILES: readonly ChatAgentProfile[] = [
  { id: 'agent-design', name: '설계 담당', providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard', whenToUse: '요구 정리·계획·시안처럼 판단이 많은 일' },
  { id: 'agent-claude-build', name: 'Claude 구현', providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'medium', permissionPreset: 'standard', whenToUse: 'Claude 대화에서 승인된 계획을 구현할 때' },
  { id: 'agent-build', name: '구현 담당', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'standard', whenToUse: '정해진 계획대로 코드를 바꾸고 테스트를 고칠 때' },
  { id: 'agent-codex-plan', name: 'Codex 계획', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', permissionPreset: 'plan', whenToUse: 'Codex 대화에서 계획을 세울 때' },
  { id: 'agent-review', name: '교차 검토', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', permissionPreset: 'plan', whenToUse: '다른 AI가 만든 결과를 고치지 않고 검토만 할 때' },
  { id: 'agent-quick', name: '빠른 조사', providerId: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low', permissionPreset: 'plan', whenToUse: '짧은 조사·요약, 정기 점검 요약' },
];
export const HARNESS_PHASES: ChatAgentPhaseMap = {
  byProvider: { claude: { plan: { profileId: 'agent-design' }, implement: { profileId: 'agent-claude-build' } }, codex: { plan: { profileId: 'agent-codex-plan' }, implement: { profileId: 'agent-build' } } },
  review: { profileId: 'agent-review' }, switchModel: false,
};
const EFFORT_KO: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
const PROVIDER: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const MODEL: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'gpt-6-astra': 'GPT-6-Astra' };
const PERMISSION_KO: Record<string, string> = { plan: '계획만', standard: '승인 후 실행', 'full-access': '전체 권한' };

export function harnessAgents(usedOn: Readonly<Record<string, number>> = {}): readonly WorkflowAgentListItem[] {
  return HARNESS_PROFILES.map(profile => ({
    id: profile.id, name: profile.name, providerLabel: PROVIDER[profile.providerId] ?? profile.providerId, model: MODEL[profile.model ?? ''] ?? profile.model ?? '',
    effortLabel: EFFORT_KO[profile.reasoningEffort ?? ''], permissionLabel: PERMISSION_KO[profile.permissionPreset] ?? profile.permissionPreset, whenToUse: profile.whenToUse,
    tone: profile.providerId === 'codex' ? 'codex' : profile.providerId === 'claude' ? 'claude' : 'other', usedOn: usedOn[profile.id],
  }));
}

const COLUMN = 344;
const ROW = 300;
function stage(id: string, title: string, operation: WorkflowNode['operation'], role: WorkflowNode['role'], column: number, row: number, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id: `dev:${id}`, title, operation, role, instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', inputs: [], position: { x: 40 + column * COLUMN, y: 40 + row * ROW }, ...extra };
}

/** "개발 절차": requirements → my answer → plan → mockup → cross review → approval → implement (+ check) → done. */
export const HARNESS_GRAPH: WorkflowGraph = {
  entryNodeId: 'dev:req',
  nodes: [
    stage('req', '요구 정리', 'agent', 'planning', 0, 0, { providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', instructions: '요구를 정리하고, 결정이 필요한 점을 한 번에 하나씩 질문으로 씁니다.', acceptance: ['질문 목록과 가정'] }),
    stage('answer', '내 답변', 'approval', 'planning', 1, 0, { instructions: '요구 정리의 질문에 답합니다.' }),
    stage('plan', '계획', 'agent', 'planning', 2, 0, { providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', instructions: '답을 반영해 단계별 구현 계획을 씁니다.', acceptance: ['파일·검증 방법까지 적힌 계획'] }),
    stage('mock', '시안', 'agent', 'design', 3, 0, { providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'medium', instructions: '계획한 화면을 Storybook 시안으로 만듭니다.', acceptance: ['바뀐 화면마다 시안'], permissionPreset: 'standard', allowedPaths: ['src/renderer/'] }),
    stage('review', '교차 검토', 'agent', 'review', 0, 1, { providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', instructions: '시안과 계획을 고치지 않고 검토합니다.', acceptance: ['문제와 근거 목록'] }),
    stage('approval', '시안 승인', 'approval', 'review', 1, 1, { instructions: '검토를 거친 시안으로 구현해도 되는지 정합니다.' }),
    stage('implement', '구현', 'agent', 'implementation', 2, 1, { providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', instructions: '승인된 계획과 시안대로 구현하고 테스트를 고칩니다.', acceptance: ['pnpm test 통과'], permissionPreset: 'standard', allowedPaths: ['src/', 'test/'] }),
    stage('done', '완료', 'complete', 'integration', 3, 1),
  ],
  edges: [
    { id: 'dev:req-answer', from: 'dev:req', to: 'dev:answer', outcome: 'next' },
    { id: 'dev:answer-plan', from: 'dev:answer', to: 'dev:plan', outcome: 'approved' },
    { id: 'dev:plan-mock', from: 'dev:plan', to: 'dev:mock', outcome: 'next' },
    { id: 'dev:mock-review', from: 'dev:mock', to: 'dev:review', outcome: 'next' },
    { id: 'dev:review-approval', from: 'dev:review', to: 'dev:approval', outcome: 'passed' },
    { id: 'dev:review-mock', from: 'dev:review', to: 'dev:mock', outcome: 'failed', retryLimit: 2 },
    { id: 'dev:approval-implement', from: 'dev:approval', to: 'dev:implement', outcome: 'approved' },
    { id: 'dev:approval-mock', from: 'dev:approval', to: 'dev:mock', outcome: 'rejected', retryLimit: 2 },
    { id: 'dev:implement-done', from: 'dev:implement', to: 'dev:done', outcome: 'next' },
  ],
};

type DecorationSet = { readonly nodes: Readonly<Record<string, WorkflowNodeDecoration>>; readonly edges: Readonly<Record<string, WorkflowEdgeDecoration>> };
const design = { name: '설계 담당', tone: 'claude' as const };
const build = { name: '구현 담당', tone: 'codex' as const };
/** What the cards show: the design agent runs 요구 정리 → 계획 → 시안 in one conversation (effort per stage). */
export function harnessDecorations(options: { readonly dropOn?: string; readonly implementWithoutAgent?: boolean; readonly missingOn?: string; readonly answerWaiting?: boolean; readonly approvalWaiting?: boolean } = {}): DecorationSet {
  const nodes: Record<string, WorkflowNodeDecoration> = {
    'dev:req': { agent: { ...design, detail: 'Claude · Opus 5.5', effort: '높음' }, chain: { label: '이어서 1/3 · 같은 대화', position: 'first' } },
    'dev:answer': { kindLabel: '답변 기다림', chain: { label: '대화 유지 · AI 비용 없음', position: 'middle' }, badges: [options.answerWaiting ? '내 답을 기다림 · 지금' : '사람이 답함'], attention: options.answerWaiting, ...(options.answerWaiting ? { statusLabel: '답변 대기 · 조치 필요' } : {}), portLabels: { approved: '답함' }, hiddenPorts: ['rejected'] },
    'dev:plan': { agent: { ...design, detail: 'Claude · Opus 5.5', effort: '높음' }, chain: { label: '이어서 2/3', position: 'middle' } },
    'dev:mock': { agent: { ...design, detail: 'Claude · Opus 5.5 · 노력만 낮춤', effort: '보통' }, chain: { label: '이어서 3/3', position: 'last' } },
    'dev:review': { agent: { name: '교차 검토', tone: 'codex', detail: 'Codex · GPT-6-Astra · 늘 새 대화', effort: '매우 높음' }, badges: ['읽기 전용'] },
    'dev:approval': { badges: [options.approvalWaiting ? '내 승인을 기다림 · 지금' : '사람이 승인 · 의견 남기기'], attention: options.approvalWaiting, ...(options.approvalWaiting ? { statusLabel: '승인 대기 · 의견 가능' } : {}), portLabels: { rejected: '의견 달아 되돌림' } },
    'dev:implement': options.implementWithoutAgent ? { badges: ['pnpm test', '검토 끔'] } : { agent: { ...build, detail: 'Codex · GPT-6-Astra', effort: '보통' }, badges: ['pnpm test', '검토 끔'] },
  };
  if (options.dropOn) nodes[options.dropOn] = { ...nodes[options.dropOn], dropTarget: true };
  if (options.missingOn) nodes[options.missingOn] = { ...nodes[options.missingOn], agent: { name: '구현 담당', tone: 'codex', detail: '', missing: true } };
  return { nodes, edges: { 'dev:req-answer': { chain: true, label: '이어서' }, 'dev:answer-plan': { chain: true, label: '이어서' }, 'dev:plan-mock': { chain: true, label: '이어서' } } };
}

export const HARNESS_TEMPLATES: readonly WorkflowTemplateChoice[] = [
  { id: 'tpl-dev', origin: 'builtin', title: '개발 절차', description: '요구를 정리하고 계획·시안을 교차 검토한 뒤, 승인되면 구현하고 테스트로 확인합니다.',
    steps: [{ label: '요구 정리' }, { label: '내 답변', kind: 'person' }, { label: '계획' }, { label: '시안' }, { label: '교차 검토' }, { label: '시안 승인', kind: 'person' }, { label: '구현' }, { label: 'pnpm test', kind: 'check' }],
    needs: '에이전트 3개(설계·구현·검토) · 확인 명령 1개' },
  { id: 'tpl-check', origin: 'builtin', title: '정기 점검', description: '의존성·테스트를 명령으로 확인하고, 결과가 지난번과 다를 때만 AI가 요약합니다.',
    steps: [{ label: 'pnpm audit', kind: 'check' }, { label: 'pnpm test', kind: 'check' }, { label: '바뀐 점 요약' }, { label: '결과 확인', kind: 'person' }],
    needs: '에이전트 1개(요약) · 확인 명령 2개 · 반복 매일' },
  { id: 'tpl-hotfix', origin: 'user', title: '버그 빠르게 고치기', description: '재현 → 수정 → 테스트를 한 에이전트가 같은 대화로 이어서 합니다.',
    steps: [{ label: '재현' }, { label: '수정' }, { label: 'pnpm test', kind: 'check' }],
    needs: '에이전트 1개 · 2026-10-20 저장' },
];

export const STORY_EFFORTS = [
  { value: '', label: '기본 (높음)' }, { value: 'low', label: '낮음' }, { value: 'medium', label: '보통' }, { value: 'high', label: '높음' }, { value: 'xhigh', label: '매우 높음' }, { value: 'max', label: '최대' },
];
/** What the stage panel says about its conversation, per stage of the 설계 담당 chain. */
export const CHAIN_HINTS: Readonly<Record<string, string>> = {
  'dev:req': '실행하면 새 대화로 시작하고, 같은 대화에서 계획·시안까지 이어서 합니다.',
  'dev:plan': '실행하면 요구 정리 대화에서 이어서 합니다. 내 답변도 그 대화로 들어갑니다.',
  'dev:mock': '실행하면 계획 대화에서 이어서 합니다. 노력만 보통으로 낮춰 같은 대화를 쓰므로 토큰과 시간을 아낄 수 있습니다(얼마나 아끼는지는 개발 전에 측정).',
};
export const STORY_PERMISSIONS = [{ value: 'plan', label: '계획만 · 읽기 전용' }, { value: 'standard', label: '승인 후 실행' }];
export const STORY_REVIEWS = [{ value: 'run', label: '실행 기본 (교차 검토)' }, { value: 'off', label: '끔 · 확인 명령으로만' }, { value: 'agent', label: '다른 에이전트…' }];

/**
 * A run of the 개발 절차 graph in the shape the runtime records, stopped where the person is needed:
 * at 내 답변 (an answer) or at 시안 승인 (an approval with a comment). Only for the mockup's overlay.
 */
export function harnessRun(at: 'answer' | 'approval'): ExecutionRun {
  const AT = '2026-10-29T00:10:00.000Z';
  type Step = { readonly node: string; readonly state: WorkflowActivation['state']; readonly outcome?: WorkflowActivation['outcome'] };
  const done = (node: string, outcome: WorkflowActivation['outcome'] = 'passed'): Step => ({ node, state: 'completed', outcome });
  const steps: readonly Step[] = at === 'answer'
    ? [done('req'), { node: 'answer', state: 'awaiting-approval' }]
    : [done('req'), done('answer', 'approved'), done('plan'), done('mock'), done('review'), { node: 'approval', state: 'awaiting-approval' }];
  const agents = HARNESS_GRAPH.nodes.filter(node => node.operation === 'agent');
  const ran = steps.filter(step => agents.some(node => node.id === `dev:${step.node}`) && step.state === 'completed');
  const activations: WorkflowActivation[] = steps.map(step => ({ id: `wf:dev:${step.node}:0`, nodeId: `dev:${step.node}`, iteration: 0, state: step.state, incomingEdgeIds: [], inputResults: {},
    ...(step.outcome ? { outcome: step.outcome } : {}), ...(ran.includes(step) ? { attemptId: `attempt-${step.node}-1` } : {}) }));
  const attempts: ExecutionAttempt[] = ran.map(step => {
    const node = agents.find(entry => entry.id === `dev:${step.node}`)!;
    const settings = { providerId: node.providerId!, model: node.model!, permissionPreset: node.permissionPreset };
    return { attemptId: `attempt-${step.node}-1`, taskId: node.id, taskRevision: 1, dispatchId: `dispatch-${step.node}`, workspaceId: 'chain-design', number: 1, reason: 'initial',
      sessionId: step.node === 'review' ? 'session-review-1' : 'session-design-chain', turnId: `turn-${step.node}`, state: 'succeeded', startedAt: AT, finishedAt: AT, summary: `${node.title} 마침`,
      artifacts: [], requestedSettings: settings, effectiveSettings: settings };
  });
  const reviews: ExecutionReview[] = ran.map(step => ({ reviewId: `review-${step.node}`, attemptId: `attempt-${step.node}-1`, reviewerSessionId: `reviewer-${step.node}`, reviewerTurnId: `reviewer-turn-${step.node}`,
    decidedBy: 'reviewer', baseline: { baselineId: 'baseline-dev', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], evidenceIds: [], decision: 'approve', detail: '완료 조건을 충족합니다.', decidedAt: AT }));
  const tasks: ExecutionTask[] = agents.map(node => {
    const step = ran.find(entry => `dev:${entry.node}` === node.id);
    return { taskId: node.id, state: step ? 'completed' : 'waiting', retriesUsed: 0, ...(step ? { currentAttemptId: `attempt-${step.node}-1` } : {}) };
  });
  const prepared: PreparedExecutionTask[] = agents.map(node => ({ taskId: node.id, taskRevision: 1, stage: node.role, title: node.title, brief: node.instructions, dependsOn: [], retryLimit: node.retryLimit,
    profile: { profileId: `profile-${node.id}`, revision: 1, role: node.role, providerId: node.providerId!, model: node.model!, prompt: 'Stage profile', permissionPreset: node.permissionPreset, capabilities: [] },
    acceptance: [{ acceptanceId: `${node.id}:ok`, description: node.acceptance[0] ?? 'Done' }], validations: [{ validationId: `${node.id}:check`, acceptanceIds: [`${node.id}:ok`], method: 'inspection', environment: 'review' }] }));
  return {
    runId: 'run-dev-1', projectId: 'project-story', revision: 9, state: 'awaiting-review', createdAt: AT, updatedAt: AT, startedAt: AT,
    preparation: { workflow: { subprojectId: 'dev', revision: 6, fingerprint: 'a'.repeat(64), graph: HARNESS_GRAPH }, subprojectId: 'dev', baseCommit: 'd'.repeat(40),
      baseline: { baselineId: 'baseline-dev', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks: prepared, approvalPolicy: 'user' },
    preparationFingerprint: 'c'.repeat(64), tasks, attempts, evidence: [], reviews, gates: [],
    workflowRuntime: { activations, edgeCounts: Object.fromEntries(HARNESS_GRAPH.edges.filter(edge => steps.some(step => step.state === 'completed' && `dev:${step.node}` === edge.from)
      && steps.some(step => `dev:${step.node}` === edge.to)).map(edge => [edge.id, 1])), completed: false },
  };
}
/** "정기 점검": checks by command (no AI), then a cheap summary only when the result changed, then a look by the person. */
export const CHECK_GRAPH: WorkflowGraph = {
  entryNodeId: 'chk:run',
  nodes: [
    stage('run', '의존성·테스트 확인', 'agent', 'review', 0, 0, { providerId: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low', instructions: '확인 명령을 돌리고 결과를 정리합니다.', acceptance: ['pnpm audit · pnpm test 결과'] }),
    stage('sum', '바뀐 점 요약', 'agent', 'planning', 1, 0, { providerId: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low', instructions: '지난번과 달라진 점만 다섯 줄 안으로 요약합니다.', acceptance: ['다섯 줄 요약'] }),
    stage('look', '결과 확인', 'approval', 'review', 2, 0, { instructions: '요약을 보고 할 일을 정합니다.' }),
    stage('done', '완료', 'complete', 'integration', 3, 0),
  ].map(node => ({ ...node, id: node.id.replace('dev:', 'chk:') })),
  edges: [
    { id: 'chk:run-sum', from: 'chk:run', to: 'chk:sum', outcome: 'next' },
    { id: 'chk:sum-look', from: 'chk:sum', to: 'chk:look', outcome: 'next' },
    { id: 'chk:look-done', from: 'chk:look', to: 'chk:done', outcome: 'approved' },
  ],
};
export const CHECK_DECORATIONS: { readonly nodes: Readonly<Record<string, WorkflowNodeDecoration>>; readonly edges: Readonly<Record<string, WorkflowEdgeDecoration>> } = {
  nodes: {
    'chk:run': { agent: { name: '빠른 조사', tone: 'claude', detail: 'Claude · Sonnet 5.5', effort: '낮음' }, badges: ['pnpm audit', 'pnpm test', '검토 끔'], chain: { label: '이어서 1/2', position: 'first' } },
    'chk:sum': { agent: { name: '빠른 조사', tone: 'claude', detail: 'Claude · Sonnet 5.5', effort: '낮음' }, badges: ['결과가 같으면 건너뜀'], chain: { label: '이어서 2/2', position: 'last' } },
    'chk:look': { badges: ['사람이 확인'] },
  },
  edges: { 'chk:run-sum': { chain: true, label: '이어서' } },
};