import type { ExecutionAttempt, ExecutionReview, ExecutionRun, ExecutionTask, PreparedExecutionTask } from '../../shared/planning-execution';
import { PLANNING_AUTO_APPROVAL_PRINCIPAL } from '../../shared/planning-execution';
import { createWorkflowGraph, type WorkflowActivation, type WorkflowGraph } from '../../shared/workflow-graph';
import { layoutWorkflowGraph } from './workflow-canvas-model';
import { WORKFLOW_CARD_UNITS } from './use-workflow-scale';

/**
 * Storybook/test data for the one-canvas flow: the "Login improvements" subproject and runs in the
 * exact shape the runtime records (activations per round, edge counts, tasks, attempts, reviews).
 * Production code never imports this file.
 */
export type WorkflowCanvasScenario =
  | 'edit' | 'prepared' | 'just-started' | 'retry-running' | 'awaiting-approval' | 'retry-exhausted'
  | 'completed' | 'integrated-auto' | 'cancelled' | 'parallel-join';

const TITLES: Record<string, readonly [string, string]> = {
  plan: ['기획', 'Planning'], design: ['디자인', 'Design'], implement: ['구현', 'Implementation'], review: ['검토', 'Review'],
  condition: ['검토 결과', 'Review result'], approval: ['승인', 'Approval'], done: ['완료', 'Complete'],
  fork: ['병렬 시작', 'Parallel start'], ui: ['화면 구현', 'UI build'], api: ['API 구현', 'API build'], join: ['결과 합류', 'Join results'],
};
const AGENTS: Record<string, readonly [string, string]> = {
  plan: ['codex', 'gpt-6-astra'], design: ['claude', 'claude-opus-5-5'], implement: ['codex', 'gpt-6-astra'], review: ['claude', 'claude-opus-5-5'],
  ui: ['claude', 'claude-opus-5-5'], api: ['codex', 'gpt-6-astra'],
};
const INSTRUCTIONS: Record<string, readonly [string, string]> = {
  plan: ['로그인 실패 시 안내와 잠금 정책을 정리합니다.', 'Define the failed-login message and lockout policy.'],
  design: ['오류 상태와 잠금 안내 화면을 설계합니다.', 'Design the error and lockout screens.'],
  implement: ['설계대로 로그인 오류 처리를 구현합니다.', 'Implement login error handling as designed.'],
  review: ['구현을 독립적으로 검토합니다.', 'Review the implementation independently.'],
  approval: ['검토를 통과한 변경을 통합해도 되는지 확인합니다.', 'Confirm the reviewed change may be integrated.'],
  ui: ['로그인 화면을 구현합니다.', 'Build the login screen.'], api: ['인증 API를 구현합니다.', 'Build the auth API.'],
};
const AT = '2026-10-22T09:00:00.000Z';
const key = (nodeId: string) => nodeId.replace('login:', '');

export function workflowCanvasGraph(preset: 'feature' | 'parallel', locale: 'ko' | 'en', size: { width: number; height: number }): WorkflowGraph {
  const base = createWorkflowGraph(preset, 'login');
  const pick = (pair: readonly [string, string] | undefined, fallback: string) => pair ? pair[locale === 'ko' ? 0 : 1] : fallback;
  return layoutWorkflowGraph({ ...base, nodes: base.nodes.map(node => {
    const agent = AGENTS[key(node.id)];
    return { ...node, title: pick(TITLES[key(node.id)], node.title), instructions: pick(INSTRUCTIONS[key(node.id)], ''),
      ...(agent ? { providerId: agent[0], model: agent[1], acceptance: [locale === 'ko' ? '단위 테스트 통과' : 'Unit tests pass'] } : {}) };
  }) }, size);
}

interface Step { readonly node: string; readonly round: number; readonly state: WorkflowActivation['state']; readonly outcome?: WorkflowActivation['outcome']; readonly attempt?: ExecutionAttempt['state']; readonly review?: 'approve' | 'reject'; readonly auto?: boolean; readonly from?: readonly string[] }
const done = (node: string, round = 1, outcome: WorkflowActivation['outcome'] = 'passed'): Step => ({ node, round, state: 'completed', outcome, ...(AGENTS[node] ? { attempt: outcome === 'failed' ? 'failed' : 'succeeded', review: outcome === 'failed' ? 'reject' : 'approve' } : {}) });

function buildRun(graph: WorkflowGraph, steps: readonly Step[], state: ExecutionRun['state'], extra: Partial<ExecutionRun> & { approvalPolicy?: 'user' | 'auto' } = {}): ExecutionRun {
  const activations: WorkflowActivation[] = steps.map(step => ({ id: `wf:login:${step.node}:${step.round - 1}`, nodeId: `login:${step.node}`, iteration: step.round - 1, state: step.state, incomingEdgeIds: (step.from ?? []).flatMap(source => graph.edges.filter(edge => edge.from === `login:${source}` && edge.to === `login:${step.node}`).map(edge => edge.id)), inputResults: {},
    ...(step.outcome ? { outcome: step.outcome } : {}), ...(step.attempt ? { attemptId: `attempt-${step.node}-${step.round}` } : {}), ...(step.auto ? { resolvedBy: PLANNING_AUTO_APPROVAL_PRINCIPAL, resolvedAt: AT } : {}) }));
  const attempts: ExecutionAttempt[] = steps.filter(step => step.attempt).map(step => {
    const [providerId, model] = AGENTS[step.node];
    return { attemptId: `attempt-${step.node}-${step.round}`, taskId: `login:${step.node}`, taskRevision: 1, dispatchId: `dispatch-${step.node}-${step.round}`, workspaceId: `planning-workspace-${step.node}`, number: step.round, reason: step.round > 1 ? 'repair' : 'initial',
      sessionId: `session-${step.node}-${step.round}`, turnId: `turn-${step.node}-${step.round}`, state: step.attempt!, startedAt: AT, ...(step.attempt === 'running' ? {} : { finishedAt: AT, summary: step.outcome === 'failed' ? '로그인 실패 시 잠금 안내가 빠졌습니다. 수정이 필요합니다.' : `${TITLES[step.node][0]} 작업을 마쳤습니다. 단위 테스트 12개 통과.` }),
      artifacts: [], requestedSettings: { providerId, model, permissionPreset: 'plan' }, effectiveSettings: { providerId, model, permissionPreset: 'plan' } };
  });
  const reviews: ExecutionReview[] = steps.filter(step => step.review).map(step => ({ reviewId: `review-${step.node}-${step.round}`, attemptId: `attempt-${step.node}-${step.round}`, reviewerSessionId: `reviewer-${step.node}-${step.round}`, reviewerTurnId: `reviewer-turn-${step.node}-${step.round}`,
    decidedBy: 'reviewer', baseline: { baselineId: 'baseline-login', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], evidenceIds: [], decision: step.review!, detail: step.review === 'reject' ? '잠금 정책 안내가 없습니다.' : '완료 조건을 충족합니다.', decidedAt: AT }));
  const latest = (node: string) => [...steps].reverse().find(step => step.node === node);
  const tasks: ExecutionTask[] = Object.keys(AGENTS).filter(node => graph.nodes.some(item => item.id === `login:${node}`)).map(node => {
    const step = latest(node);
    const taskState: ExecutionTask['state'] = !step ? 'waiting' : step.attempt === 'running' ? 'running' : step.state === 'active' ? 'ready' : step.outcome === 'failed' ? 'failed' : state === 'cancelled' && step.state !== 'completed' ? 'cancelled' : 'completed';
    return { taskId: `login:${node}`, state: taskState, retriesUsed: Math.max(0, (step?.round ?? 1) - 1), ...(step?.attempt ? { currentAttemptId: `attempt-${node}-${step.round}` } : {}) };
  });
  // Same routing rule as advanceWorkflowRun: the exact outcome port, else an agent's `next` port
  // (always on success; on failure only into a condition).
  const edgeCounts: Record<string, number> = {};
  for (const step of steps) {
    if (step.state !== 'completed' || !step.outcome) continue;
    const from = `login:${step.node}`;
    const exact = graph.edges.filter(edge => edge.from === from && edge.outcome === step.outcome);
    const agent = graph.nodes.find(node => node.id === from)?.operation === 'agent';
    const taken = exact.length ? exact : agent ? graph.edges.filter(edge => edge.from === from && edge.outcome === 'next' && (step.outcome === 'passed' || graph.nodes.find(node => node.id === edge.to)?.operation === 'condition')) : [];
    for (const edge of taken) edgeCounts[edge.id] = (edgeCounts[edge.id] ?? 0) + 1;
  }
  const prepared: PreparedExecutionTask[] = tasks.map(task => ({ taskId: task.taskId, taskRevision: 1, stage: graph.nodes.find(node => node.id === task.taskId)!.role, title: TITLES[key(task.taskId)][1], brief: TITLES[key(task.taskId)][1], dependsOn: [], retryLimit: 2,
    profile: { profileId: `profile-${key(task.taskId)}`, revision: 1, role: key(task.taskId), providerId: AGENTS[key(task.taskId)][0], model: AGENTS[key(task.taskId)][1], prompt: 'Stage profile', permissionPreset: 'plan', capabilities: [] },
    acceptance: [{ acceptanceId: `${key(task.taskId)}-tests`, description: 'Unit tests pass' }], validations: [{ validationId: `${key(task.taskId)}-check`, acceptanceIds: [`${key(task.taskId)}-tests`], method: 'command', environment: 'local', command: 'pnpm test' }] }));
  const { approvalPolicy = 'user', ...rest } = extra;
  return {
    runId: 'run-login-4', projectId: 'project-story', revision: 14, state, createdAt: AT, updatedAt: AT, ...(state === 'prepared' ? {} : { startedAt: AT }),
    preparation: { workflow: { subprojectId: 'login', revision: 4, fingerprint: 'a'.repeat(64), graph }, subprojectId: 'login', baseline: { baselineId: 'baseline-login', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks: prepared, approvalPolicy },
    preparationFingerprint: 'c'.repeat(64), tasks, attempts, evidence: [], reviews, gates: [],
    ...(state === 'prepared' ? {} : { workflowRuntime: { activations, edgeCounts, completed: state === 'completed' } }), ...rest,
  };
}

const roundOne = [done('plan'), done('design'), done('implement'), done('review', 1, 'failed'), { node: 'condition', round: 1, state: 'completed', outcome: 'failed' } as Step];
/** A canvas scenario: the graph to edit and, unless editing, the run to overlay. */
export function workflowCanvasFixture(scenario: WorkflowCanvasScenario, locale: 'ko' | 'en' = 'ko', size: { width: number; height: number } = WORKFLOW_CARD_UNITS): { graph: WorkflowGraph; run?: ExecutionRun } {
  if (scenario === 'parallel-join') {
    const graph = workflowCanvasGraph('parallel', locale, size);
    return { graph, run: buildRun(graph, [done('plan'), { node: 'fork', round: 1, state: 'completed', outcome: 'next' }, done('ui'), { node: 'api', round: 1, state: 'active', attempt: 'running' }, { node: 'join', round: 1, state: 'waiting', from: ['ui'] }], 'running') };
  }
  const graph = workflowCanvasGraph('feature', locale, size);
  const approval = (state: WorkflowActivation['state'], outcome?: WorkflowActivation['outcome'], auto = false): Step => ({ node: 'approval', round: 2, state, ...(outcome ? { outcome } : {}), auto });
  const passedRoundTwo = [...roundOne, done('implement', 2), done('review', 2), { node: 'condition', round: 2, state: 'completed', outcome: 'passed' } as Step];
  switch (scenario) {
    case 'edit': return { graph };
    case 'prepared': return { graph, run: buildRun(graph, [], 'prepared') };
    case 'just-started': return { graph, run: buildRun(graph, [{ node: 'plan', round: 1, state: 'active', attempt: 'running' }], 'running') };
    case 'retry-running': return { graph, run: buildRun(graph, [...roundOne, { node: 'implement', round: 2, state: 'active', attempt: 'running' }], 'running') };
    case 'awaiting-approval': return { graph, run: buildRun(graph, [...passedRoundTwo, approval('awaiting-approval')], 'awaiting-review') };
    case 'retry-exhausted': return { graph, run: buildRun(graph, [...roundOne, done('implement', 2), done('review', 2, 'failed'), { node: 'condition', round: 2, state: 'completed', outcome: 'failed' }, done('implement', 3), done('review', 3, 'failed'), { node: 'condition', round: 3, state: 'retry-exhausted', outcome: 'failed' }], 'paused') };
    case 'completed': return { graph, run: buildRun(graph, [...passedRoundTwo, approval('completed', 'approved'), { node: 'done', round: 2, state: 'completed', outcome: 'next' }], 'completed') };
    case 'integrated-auto': return { graph, run: buildRun(graph, [...passedRoundTwo, approval('completed', 'approved', true), { node: 'done', round: 2, state: 'completed', outcome: 'next' }], 'completed', { approvalPolicy: 'auto', integrationAuthorized: { by: PLANNING_AUTO_APPROVAL_PRINCIPAL, at: AT } }) };
    case 'cancelled': return { graph, run: buildRun(graph, [done('plan'), done('design'), { node: 'implement', round: 1, state: 'active', attempt: 'interrupted' }], 'cancelled') };
  }
}
