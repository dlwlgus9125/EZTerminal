import type { ChatAgentPhaseMap, ChatAgentProfile, ChatAgentProfileAccess } from '../../shared/chat-agent-profiles';
import type { ExecutionAttempt, ExecutionReview, ExecutionRun, ExecutionTask, PreparedExecutionTask } from '../../shared/planning-execution';
import type { WorkflowSubproject } from '../../shared/workflow';
import type { WorkflowCheckConsentResult, WorkflowCheckStatus } from '../../shared/workflow-checks';
import type { WorkflowActivation, WorkflowAgentSnapshot, WorkflowGraph, WorkflowNode } from '../../shared/workflow-graph';
import type { WorkflowAgentListItem } from '../workflow/WorkflowAgentList';
import type { WorkflowTemplateChoice } from '../workflow/WorkflowTemplateDialog';
import type { WorkflowCheckAccess } from '../workflow/use-workflow-harness';

/**
 * Harness data (2026-10 시안, now wired): the "개발 절차" template as a v18 workflow with agents placed on its stages,
 * an answer stage, checks and review off, the agents from Settings and the 단계 연결. Storybook and tests only;
 * production code never imports this file.
 */
export const HARNESS_PROFILES: readonly ChatAgentProfile[] = [
  { id: 'agent-design', name: '설계 담당', providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', permissionPreset: 'standard', whenToUse: '요구 정리·계획·시안처럼 판단이 많은 일' },
  { id: 'agent-claude-build', name: 'Claude 구현', providerId: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'medium', permissionPreset: 'standard', whenToUse: 'Claude 대화에서 승인된 계획을 구현할 때' },
  { id: 'agent-build', name: '구현 담당', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'standard', whenToUse: '정해진 계획대로 코드를 바꾸고 테스트를 고칠 때' },
  { id: 'agent-codex-plan', name: 'Codex 계획', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', permissionPreset: 'plan', whenToUse: 'Codex 대화에서 계획을 세울 때' },
  { id: 'agent-review', name: '교차 검토', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh', permissionPreset: 'plan', whenToUse: '다른 AI가 만든 결과를 고치지 않고 검토만 할 때' },
  { id: 'agent-quick', name: '빠른 조사', providerId: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'low', permissionPreset: 'plan', whenToUse: '짧은 조사·요약, 정기 점검 요약' },
  { id: 'agent-full', name: '전체 권한 구현', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', permissionPreset: 'full-access', whenToUse: '내 PC에서 제한 없이 고칠 때(워크플로에서는 승인 후 실행으로 낮춤)' },
];
export const HARNESS_PHASES: ChatAgentPhaseMap = {
  byProvider: { claude: { plan: { profileId: 'agent-design' }, implement: { profileId: 'agent-claude-build' } }, codex: { plan: { profileId: 'agent-codex-plan' }, implement: { profileId: 'agent-build' } } },
  review: { profileId: 'agent-review' }, switchModel: false,
};
const EFFORT_KO: Record<string, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };
const PROVIDER: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const MODEL: Record<string, string> = { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'gpt-6-astra': 'GPT-6-Astra' };
const PERMISSION_KO: Record<string, string> = { plan: '계획만', standard: '승인 후 실행', 'full-access': '전체 권한' };

/** The phone mockups' list rows (the desktop list is derived by the wiring). */
export function harnessAgents(usedOn: Readonly<Record<string, number>> = {}): readonly WorkflowAgentListItem[] {
  return HARNESS_PROFILES.map(profile => ({
    id: profile.id, name: profile.name, providerLabel: PROVIDER[profile.providerId] ?? profile.providerId, model: MODEL[profile.model ?? ''] ?? profile.model ?? '',
    effortLabel: EFFORT_KO[profile.reasoningEffort ?? ''], permissionLabel: PERMISSION_KO[profile.permissionPreset] ?? profile.permissionPreset, whenToUse: profile.whenToUse,
    tone: profile.providerId === 'codex' ? 'codex' : profile.providerId === 'claude' ? 'claude' : 'other', usedOn: usedOn[profile.id],
  }));
}
/** Providers and their models as the host lists them (labels for the agent list and the cards). */
export const HARNESS_PROVIDERS = [
  { id: 'claude', label: 'Claude', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
  { id: 'codex', label: 'Codex', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] },
] as const;
export const HARNESS_CATALOGS = {
  claude: [{ id: 'claude-opus-5-5', displayName: 'Opus 5.5', isDefault: true, supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', isDefault: false, supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high'] }],
  codex: [{ id: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true, supportsReasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }],
};

const CAPTURED = '2026-10-28T09:00:00.000Z';
export function harnessAgent(id: string): WorkflowAgentSnapshot {
  const profile = HARNESS_PROFILES.find(entry => entry.id === id)!;
  return { profileId: profile.id, name: profile.name, providerId: profile.providerId, ...(profile.model ? { model: profile.model } : {}), capturedAt: CAPTURED };
}
const placed = (id: string): Partial<WorkflowNode> => {
  const profile = HARNESS_PROFILES.find(entry => entry.id === id)!;
  return { agent: harnessAgent(id), providerId: profile.providerId, model: profile.model, reasoningEffort: profile.reasoningEffort, permissionPreset: profile.permissionPreset === 'full-access' ? 'standard' : profile.permissionPreset };
};

const COLUMN = 344;
const ROW = 300;
function stage(id: string, title: string, operation: WorkflowNode['operation'], role: WorkflowNode['role'], column: number, row: number, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return { id: `dev:${id}`, title, operation, role, instructions: '', document: '', acceptance: [], allowedPaths: [], retryLimit: 2, permissionPreset: 'plan', inputs: [], position: { x: 40 + column * COLUMN, y: 40 + row * ROW }, ...extra };
}

export const HARNESS_QUESTION = '1. 로그인을 몇 번 틀리면 잠글까요? (지금은 잠금 없음)\n2. 잠금을 관리자가 풀 수 있어야 하나요?';
/**
 * "개발 절차": requirements → my answer → plan → mockup (설계 담당 in one conversation) → cross review → approval
 * (a note sends it back to the mockup) → implementation with pnpm test · pnpm typecheck and review off → done.
 */
export const HARNESS_GRAPH: WorkflowGraph = {
  entryNodeId: 'dev:req',
  nodes: [
    stage('req', '요구 정리', 'agent', 'planning', 0, 0, { ...placed('agent-design'), permissionPreset: 'plan', instructions: '요구를 정리하고, 결정이 필요한 점을 한 번에 하나씩 질문으로 씁니다.', acceptance: ['질문 목록과 가정'] }),
    stage('answer', '내 답변', 'answer', 'planning', 1, 0, { answer: { prompt: HARNESS_QUESTION, showResultOf: 'dev:req' } }),
    stage('plan', '계획', 'agent', 'planning', 2, 0, { ...placed('agent-design'), permissionPreset: 'plan', instructions: '답을 반영해 단계별 구현 계획을 씁니다.', acceptance: ['파일·검증 방법까지 적힌 계획'] }),
    stage('mock', '시안', 'agent', 'design', 3, 0, { ...placed('agent-design'), reasoningEffort: 'medium', instructions: '계획한 화면을 Storybook 시안으로 만듭니다.', acceptance: ['바뀐 화면마다 시안'], allowedPaths: ['src/renderer/'] }),
    stage('review', '교차 검토', 'agent', 'review', 0, 1, { ...placed('agent-review'), instructions: '시안과 계획을 고치지 않고 검토합니다.', acceptance: ['문제와 근거 목록'] }),
    stage('approval', '시안 승인', 'approval', 'review', 1, 1, { instructions: '검토를 거친 시안으로 구현해도 될까요? 교차 검토 의견 2건은 반영됐습니다.' }),
    stage('implement', '구현', 'agent', 'implementation', 2, 1, { ...placed('agent-build'), instructions: '승인된 계획과 시안대로 구현하고 테스트를 고칩니다.', acceptance: ['pnpm test 통과'], allowedPaths: ['src/', 'test/'],
      checks: [{ id: 'test', command: 'pnpm test' }, { id: 'typecheck', command: 'pnpm typecheck' }], review: { mode: 'off' } }),
    stage('done', '완료', 'complete', 'integration', 3, 1),
  ],
  edges: [
    { id: 'dev:req-answer', from: 'dev:req', to: 'dev:answer', outcome: 'next' },
    { id: 'dev:answer-plan', from: 'dev:answer', to: 'dev:plan', outcome: 'next' },
    { id: 'dev:plan-mock', from: 'dev:plan', to: 'dev:mock', outcome: 'next' },
    { id: 'dev:mock-review', from: 'dev:mock', to: 'dev:review', outcome: 'next' },
    { id: 'dev:review-approval', from: 'dev:review', to: 'dev:approval', outcome: 'passed' },
    { id: 'dev:review-mock', from: 'dev:review', to: 'dev:mock', outcome: 'failed', retryLimit: 2 },
    { id: 'dev:approval-implement', from: 'dev:approval', to: 'dev:implement', outcome: 'approved' },
    { id: 'dev:approval-mock', from: 'dev:approval', to: 'dev:mock', outcome: 'rejected', retryLimit: 2 },
    { id: 'dev:implement-done', from: 'dev:implement', to: 'dev:done', outcome: 'next' },
  ],
};
/** The same flow with one stage changed (no agent yet, an agent not on this PC, ...). */
export function harnessGraph(change: Readonly<Record<string, Partial<WorkflowNode>>> = {}): WorkflowGraph {
  return { ...HARNESS_GRAPH, nodes: HARNESS_GRAPH.nodes.map(node => {
    const patch = change[node.id];
    if (!patch) return node;
    const next = { ...node, ...patch } as Record<string, unknown>;
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
    return next as WorkflowNode;
  }) };
}

/** "정기 점검": checks by command, then a cheap summary only when the result changed, then a look by the person. */
export const CHECK_GRAPH: WorkflowGraph = {
  entryNodeId: 'chk:run',
  nodes: [
    stage('run', '의존성·테스트 확인', 'agent', 'review', 0, 0, { ...placed('agent-quick'), instructions: '확인 명령을 돌리고 결과를 정리합니다.', acceptance: ['pnpm audit · pnpm test 결과'],
      checks: [{ id: 'audit', command: 'pnpm audit' }, { id: 'test', command: 'pnpm test' }], review: { mode: 'off' } }),
    stage('sum', '바뀐 점 요약', 'agent', 'planning', 1, 0, { ...placed('agent-quick'), instructions: '지난번과 달라진 점만 다섯 줄 안으로 요약합니다.', acceptance: ['다섯 줄 요약'], review: { mode: 'off' }, skipWhenUnchanged: true }),
    stage('look', '결과 확인', 'approval', 'review', 2, 0, { instructions: '요약을 보고 할 일을 정합니다.' }),
    stage('done', '완료', 'complete', 'integration', 3, 0),
  ].map(node => ({ ...node, id: node.id.replace('dev:', 'chk:') })),
  edges: [
    { id: 'chk:run-sum', from: 'chk:run', to: 'chk:sum', outcome: 'next' },
    { id: 'chk:run-sum-failed', from: 'chk:run', to: 'chk:sum', outcome: 'failed' },
    { id: 'chk:sum-look', from: 'chk:sum', to: 'chk:look', outcome: 'next' },
    { id: 'chk:look-done', from: 'chk:look', to: 'chk:done', outcome: 'approved' },
  ],
};

/** A saved workflow around a graph, as the host keeps it. */
export function harnessSubproject(graph: WorkflowGraph = HARNESS_GRAPH, extra: Partial<WorkflowSubproject> = {}): WorkflowSubproject {
  return { id: graph === CHECK_GRAPH ? 'chk' : 'dev', title: graph === CHECK_GRAPH ? '정기 점검' : '로그인 오류 안내 개선', goal: '로그인 실패 안내와 잠금', revision: 6, status: 'active',
    createdAt: CAPTURED, updatedAt: CAPTURED, presetId: 'custom', history: [], archivedNodes: [], graph, runSettings: { reviewer: { providerId: 'codex', model: 'gpt-6-astra' } }, ...extra };
}

/** This PC's allowance: pnpm test allowed; pnpm typecheck asked again because the stage's result changed its script. */
export const HARNESS_CHECK_STATUSES: readonly WorkflowCheckStatus[] = [
  { nodeId: 'dev:implement', checkId: 'test', command: 'pnpm test', digest: 'digest-test', allowed: true, scripts: ['package.json#test'] },
  { nodeId: 'dev:implement', checkId: 'typecheck', command: 'pnpm typecheck', digest: 'digest-typecheck', allowed: false, reason: 'script-changed', scripts: ['package.json#typecheck'] },
  { nodeId: 'chk:run', checkId: 'audit', command: 'pnpm audit', digest: 'digest-audit', allowed: true, scripts: [] },
  { nodeId: 'chk:run', checkId: 'test', command: 'pnpm test', digest: 'digest-chk-test', allowed: true, scripts: ['package.json#test'] },
];
export function harnessCheckAccess(statuses: readonly WorkflowCheckStatus[] = HARNESS_CHECK_STATUSES, onAllow?: (nodeId: string, checkId: string, digest: string) => void): WorkflowCheckAccess {
  let current = statuses;
  return {
    status: async (): Promise<WorkflowCheckConsentResult> => ({ ok: true, checks: current }),
    allow: async (_project, _subproject, nodeId, checkId, digest): Promise<WorkflowCheckConsentResult> => {
      onAllow?.(nodeId, checkId, digest);
      current = current.map(entry => entry.nodeId === nodeId && entry.checkId === checkId && entry.digest === digest ? { ...entry, allowed: true, reason: undefined } : entry);
      return { ok: true, checks: current };
    },
  };
}
export function harnessProfileAccess(profiles: readonly ChatAgentProfile[] = HARNESS_PROFILES): ChatAgentProfileAccess {
  let list = profiles;
  return {
    list: async () => list,
    save: async profile => { list = [...list.filter(entry => entry.id !== profile.id), profile]; return { ok: true, profiles: list }; },
    remove: async id => { list = list.filter(entry => entry.id !== id); return { ok: true, profiles: list }; },
  };
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

/** The phone mockups' stage settings (the desktop takes them from the wiring). */
export const STORY_EFFORTS = [
  { value: '', label: '기본 (높음)' }, { value: 'low', label: '낮음' }, { value: 'medium', label: '보통' }, { value: 'high', label: '높음' }, { value: 'xhigh', label: '매우 높음' }, { value: 'max', label: '최대' },
];
export const STORY_PERMISSIONS = [{ value: 'plan', label: '계획만 · 읽기 전용' }, { value: 'standard', label: '승인 후 실행' }];
export const STORY_REVIEWS = [{ value: 'run-default', label: '실행 기본 (교차 검토)' }, { value: 'off', label: '끔 · 확인 명령으로만' }, { value: 'agent:agent-review', label: '다른 에이전트: 교차 검토' }];

/**
 * A run of the 개발 절차 graph in the shape the runtime records, stopped where the person is needed: at 내 답변 (an
 * answer), at 시안 승인 (an approval that can send a note back), or, for 정기 점검, after an unchanged check skipped the summary.
 */
export function harnessRun(at: 'answer' | 'approval' | 'skipped'): ExecutionRun {
  const AT = '2026-10-29T00:10:00.000Z';
  const graph = at === 'skipped' ? CHECK_GRAPH : HARNESS_GRAPH;
  const prefix = at === 'skipped' ? 'chk' : 'dev';
  type Step = { readonly node: string; readonly state: WorkflowActivation['state']; readonly outcome?: WorkflowActivation['outcome']; readonly answer?: string; readonly skipped?: string };
  const done = (node: string, outcome: WorkflowActivation['outcome'] = 'passed'): Step => ({ node, state: 'completed', outcome });
  const steps: readonly Step[] = at === 'answer'
    ? [done('req'), { node: 'answer', state: 'awaiting-answer' }]
    : at === 'approval'
      ? [done('req'), { ...done('answer', 'next'), answer: '잠금은 5회 실패 후 10분. 관리자 해제는 이번 범위 밖입니다.' }, done('plan'), done('mock'), done('review'), { node: 'approval', state: 'awaiting-approval' }]
      : [done('run'), { ...done('sum', 'next'), skipped: '확인 명령 결과가 지난 실행(#3)과 같아 요약을 건너뛰었습니다.' }, { node: 'look', state: 'awaiting-approval' }];
  const agents = graph.nodes.filter(node => node.operation === 'agent');
  const ran = steps.filter(step => agents.some(node => node.id === `${prefix}:${step.node}`) && step.state === 'completed' && !step.skipped);
  const activations: WorkflowActivation[] = steps.map(step => ({ id: `wf:${prefix}:${step.node}:0`, nodeId: `${prefix}:${step.node}`, iteration: 0, state: step.state, incomingEdgeIds: [], inputResults: {},
    ...(step.outcome ? { outcome: step.outcome } : {}), ...(ran.includes(step) ? { attemptId: `attempt-${step.node}-1` } : {}), ...(step.answer ? { answer: step.answer } : {}), ...(step.skipped ? { skipped: step.skipped } : {}) }));
  const attempts: ExecutionAttempt[] = ran.map(step => {
    const node = agents.find(entry => entry.id === `${prefix}:${step.node}`)!;
    const settings = { providerId: node.providerId!, model: node.model!, permissionPreset: node.permissionPreset };
    return { attemptId: `attempt-${step.node}-1`, taskId: node.id, taskRevision: 1, dispatchId: `dispatch-${step.node}`, workspaceId: 'chain-design', number: 1, reason: 'initial',
      sessionId: step.node === 'review' ? 'session-review-1' : 'session-design-chain', turnId: `turn-${step.node}`, state: 'succeeded', startedAt: AT, finishedAt: AT, summary: `${node.title} 마침`,
      artifacts: [], requestedSettings: settings, effectiveSettings: settings };
  });
  const reviews: ExecutionReview[] = ran.map(step => ({ reviewId: `review-${step.node}`, attemptId: `attempt-${step.node}-1`, reviewerSessionId: `reviewer-${step.node}`, reviewerTurnId: `reviewer-turn-${step.node}`,
    decidedBy: 'reviewer', baseline: { baselineId: 'baseline-dev', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], evidenceIds: [], decision: 'approve', detail: '완료 조건을 충족합니다.', decidedAt: AT }));
  const tasks: ExecutionTask[] = agents.map(node => {
    const step = steps.find(entry => `${prefix}:${entry.node}` === node.id && entry.state === 'completed');
    return { taskId: node.id, state: step?.skipped ? 'cancelled' : step ? 'completed' : 'waiting', retriesUsed: 0, ...(step && !step.skipped ? { currentAttemptId: `attempt-${step.node}-1` } : {}) };
  });
  const prepared: PreparedExecutionTask[] = agents.map(node => ({ taskId: node.id, taskRevision: 1, stage: node.role, title: node.title, brief: node.instructions, dependsOn: [], retryLimit: node.retryLimit,
    profile: { profileId: `profile-${node.id}`, revision: 1, role: node.role, providerId: node.providerId!, model: node.model!, prompt: 'Stage profile', permissionPreset: node.permissionPreset, capabilities: [] },
    acceptance: [{ acceptanceId: `${node.id}:ok`, description: node.acceptance[0] ?? 'Done' }], validations: [{ validationId: `${node.id}:check`, acceptanceIds: [`${node.id}:ok`], method: 'inspection', environment: 'review' }] }));
  return {
    runId: `run-${prefix}-1`, projectId: 'project-story', revision: 9, state: 'awaiting-review', createdAt: AT, updatedAt: AT, startedAt: AT,
    preparation: { workflow: { subprojectId: prefix, revision: 6, fingerprint: 'a'.repeat(64), graph }, subprojectId: prefix, baseCommit: 'd'.repeat(40),
      baseline: { baselineId: 'baseline-dev', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks: prepared, approvalPolicy: 'user' },
    preparationFingerprint: 'c'.repeat(64), tasks, attempts, evidence: [], reviews, gates: [],
    workflowRuntime: { activations, edgeCounts: Object.fromEntries(graph.edges.filter(edge => steps.some(step => step.state === 'completed' && `${prefix}:${step.node}` === edge.from)
      && steps.some(step => `${prefix}:${step.node}` === edge.to)).map(edge => [edge.id, 1])), completed: false },
  };
}
