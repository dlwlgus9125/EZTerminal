import { createWorkflowGraph, type WorkflowActivation, type WorkflowGraph, type WorkflowNavigationSnapshot, type WorkflowSnapshot, type WorkflowSubproject } from '../../shared/workflow';
import type { ExecutionAttempt, ExecutionRun, ExecutionTask, PreparedExecutionTask } from '../../shared/planning-execution';
import { layoutWorkflowGraph } from './workflow-canvas-model';

/** Deterministic Storybook/test data. Production code never imports these fixtures. */
export function workflowFixture(): WorkflowSnapshot {
  const make = (id: string, title: string): WorkflowSubproject => ({ id, title, goal: `${title} acceptance criteria`, revision: 1, status: 'active', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', presetId: 'research', history: [], archivedNodes: [], graph: { ...createWorkflowGraph('research', id), nodes: createWorkflowGraph('research', id).nodes.map((node, index) => ({ ...node, title: index === 0 ? 'Investigation' : index === 1 ? 'Approval' : 'Complete', ...(node.operation === 'agent' ? { providerId: 'codex', model: 'model-story' } : {}), instructions: 'Inspect the assigned project and record evidence.', acceptance: ['Document the evidence.'], position: { x: 40 + index * 260, y: 50 } })) } });
  return { schemaVersion: 1, hostId: 'host-story', projectId: 'project-story', registryRevision: 1, subprojects: [make('login', 'Login improvements'), make('payments', 'Payment review')], sessionLinks: [{ sessionId: 'chat-stage', subprojectId: 'login', nodeId: 'login:research', scope: 'stage', graphRevision: 1, linkedAt: '2026-10-13T00:00:00.000Z' }], legacyBaselineOwners: {}, runs: [] };
}

export function workflowNavigationFixture(snapshot = workflowFixture()): WorkflowNavigationSnapshot {
  return {
    projectId: snapshot.projectId, registryRevision: snapshot.registryRevision,
    subprojects: snapshot.subprojects.map(subproject => ({ id: subproject.id, title: subproject.title, status: subproject.status, updatedAt: subproject.updatedAt,
      stages: [...subproject.graph.nodes.map(node => ({ id: node.id, title: node.title, archived: false })), ...subproject.archivedNodes.map(node => ({ id: node.id, title: node.title, archived: true }))],
    })),
    sessionLinks: [...snapshot.historicalSessionLinks ?? [], ...snapshot.sessionLinks].map(link => ({ sessionId: link.sessionId, subprojectId: link.subprojectId, nodeId: link.nodeId, scope: link.scope })),
  };
}

export type WorkflowCanvasScenario = 'edit' | 'retry-running' | 'awaiting-approval';
const CANVAS_TITLES: Record<string, readonly [string, string]> = {
  plan: ['기획', 'Planning'], design: ['디자인', 'Design'], implement: ['구현', 'Implementation'], review: ['검토', 'Review'],
  condition: ['검토 결과', 'Review result'], approval: ['승인', 'Approval'], done: ['완료', 'Complete'],
};
const CANVAS_AGENTS: Record<string, readonly [string, string]> = {
  plan: ['codex', 'gpt-6-astra'], design: ['claude', 'claude-opus-5-5'], implement: ['codex', 'gpt-6-astra'], review: ['claude', 'claude-opus-5-5'],
};

/**
 * The feature flow of a "Login improvements" subproject, laid out for a canvas, plus a run in the
 * shape the runtime records (activations per round, edge counts, tasks and attempts).
 * - retry-running: review rejected round 1, the retry edge fired once, implementation round 2 is working.
 * - awaiting-approval: round 2 passed review and the approval stage waits for the person.
 */
export function workflowCanvasFixture(scenario: WorkflowCanvasScenario, locale: 'ko' | 'en' = 'ko', size = { width: 248, height: 132 }): { graph: WorkflowGraph; run?: ExecutionRun } {
  const base = createWorkflowGraph('feature', 'login');
  const key = (nodeId: string) => nodeId.replace('login:', '');
  const graph = layoutWorkflowGraph({ ...base, nodes: base.nodes.map(node => {
    const agent = CANVAS_AGENTS[key(node.id)];
    return { ...node, title: (CANVAS_TITLES[key(node.id)] ?? [node.title, node.title])[locale === 'ko' ? 0 : 1], ...(agent ? { providerId: agent[0], model: agent[1], instructions: `${node.title}`, acceptance: ['Tests pass'] } : {}) };
  }) }, size);
  if (scenario === 'edit') return { graph };
  const at = '2026-10-22T09:00:00.000Z';
  const edge = (from: string, to: string) => graph.edges.find(entry => entry.from === `login:${from}` && entry.to === `login:${to}` && !entry.retryLimit)!.id;
  const act = (node: string, iteration: number, state: WorkflowActivation['state'], extra: Partial<WorkflowActivation> = {}): WorkflowActivation => ({ id: `wf:login:${node}:${iteration}`, nodeId: `login:${node}`, iteration, state, incomingEdgeIds: [], inputResults: {}, ...extra });
  const attempt = (node: string, round: number, state: ExecutionAttempt['state']): ExecutionAttempt => {
    const [providerId, model] = CANVAS_AGENTS[node];
    return { attemptId: `attempt-${node}-${round}`, taskId: `login:${node}`, taskRevision: 1, dispatchId: `dispatch-${node}-${round}`, workspaceId: `planning-workspace-${node}`, number: round, reason: round > 1 ? 'repair' : 'initial', sessionId: `session-${node}-${round}`, turnId: `turn-${node}-${round}`, state, startedAt: at, ...(state === 'running' ? {} : { finishedAt: at }), summary: state === 'running' ? undefined : `${CANVAS_TITLES[node][1]} round ${round} finished.`, artifacts: [], requestedSettings: { providerId, model, permissionPreset: 'plan' }, effectiveSettings: { providerId, model, permissionPreset: 'plan' } };
  };
  const done = (node: string, round: number, outcome: 'passed' | 'failed' = 'passed') => act(node, round - 1, 'completed', { outcome, attemptId: `attempt-${node}-${round}` });
  const retrying = scenario === 'retry-running';
  const activations: WorkflowActivation[] = [
    done('plan', 1), done('design', 1), done('implement', 1), done('review', 1, 'failed'), act('condition', 0, 'completed', { outcome: 'failed' }),
    retrying ? act('implement', 1, 'active', { attemptId: 'attempt-implement-2' }) : done('implement', 2),
    ...(retrying ? [] : [done('review', 2), act('condition', 1, 'completed', { outcome: 'passed' }), act('approval', 1, 'awaiting-approval')]),
  ];
  const edgeCounts: Record<string, number> = { [edge('plan', 'design')]: 1, [edge('design', 'implement')]: 1, [edge('implement', 'review')]: retrying ? 1 : 2, [edge('review', 'condition')]: retrying ? 1 : 2, 'login:retry': 1, ...(retrying ? {} : { [edge('condition', 'approval')]: 1 }) };
  const tasks: ExecutionTask[] = Object.keys(CANVAS_AGENTS).map(node => ({ taskId: `login:${node}`, state: retrying && node === 'implement' ? 'running' : retrying && node === 'review' ? 'failed' : 'completed', retriesUsed: node === 'implement' || node === 'review' ? 1 : 0, currentAttemptId: `attempt-${node}-${node === 'implement' || (!retrying && node === 'review') ? 2 : 1}` }));
  const attempts: ExecutionAttempt[] = [attempt('plan', 1, 'succeeded'), attempt('design', 1, 'succeeded'), attempt('implement', 1, 'succeeded'), attempt('review', 1, 'failed'), attempt('implement', 2, retrying ? 'running' : 'succeeded'), ...(retrying ? [] : [attempt('review', 2, 'succeeded')])];
  const prepared: PreparedExecutionTask[] = Object.keys(CANVAS_AGENTS).map(node => ({ taskId: `login:${node}`, taskRevision: 1, stage: graph.nodes.find(entry => entry.id === `login:${node}`)!.role, title: CANVAS_TITLES[node][1], brief: CANVAS_TITLES[node][1], dependsOn: [], retryLimit: 2, profile: { profileId: `profile-${node}`, revision: 1, role: node, providerId: CANVAS_AGENTS[node][0], model: CANVAS_AGENTS[node][1], prompt: 'Stage profile', permissionPreset: 'plan', capabilities: [] }, acceptance: [{ acceptanceId: `${node}-tests`, description: 'Tests pass' }], validations: [{ validationId: `${node}-check`, acceptanceIds: [`${node}-tests`], method: 'command', environment: 'local', command: 'pnpm test' }] }));
  const run: ExecutionRun = {
    runId: 'run-login-3', projectId: 'project-story', revision: 14, state: retrying ? 'running' : 'awaiting-review', createdAt: at, startedAt: at, updatedAt: at,
    preparation: { workflow: { subprojectId: 'login', revision: 4, fingerprint: 'a'.repeat(64), graph }, subprojectId: 'login', baseline: { baselineId: 'baseline-login', revision: 1, fingerprint: 'b'.repeat(64) }, artifacts: [], teamMode: 'division', progressPolicy: 'autonomous', tasks: prepared, approvalPolicy: 'user' },
    preparationFingerprint: 'c'.repeat(64), tasks, attempts, evidence: [], reviews: [], gates: [],
    workflowRuntime: { activations, edgeCounts, completed: false },
  };
  return { graph, run };
}
