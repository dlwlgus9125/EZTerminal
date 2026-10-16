import type { PlanningDraft } from '../shared/planning';
import type { WorkflowSubproject } from '../shared/workflow';
import type { PlanningTaskAssignment } from '../shared/planning-run';

/** Translate user stage names to executable roles without expanding the legacy role enum. */
export function workflowPlanningInput(subproject: WorkflowSubproject, baselineId: string, reviewer: { providerId: string; model: string }) {
  const draft: PlanningDraft = { id: baselineId, items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] };
  const assignments: PlanningTaskAssignment[] = [];
  for (const node of subproject.graph.nodes.filter(entry => entry.operation === 'agent')) {
    const ancestors = new Set<string>(); const pending = [node.id];
    while (pending.length) { const target = pending.pop()!; for (const edge of subproject.graph.edges.filter(entry => entry.to === target && !entry.retryLimit)) if (!ancestors.has(edge.from)) { ancestors.add(edge.from); pending.push(edge.from); } }
    const profileId = `${node.id}:profile`;
    const write = node.permissionPreset !== 'plan';
    const references = node.inputs.filter(input => input.kind === 'document').map(input => {
      const source = subproject.graph.nodes.find(entry => entry.id === input.nodeId)!;
      return { nodeId: source.id, title: source.title, document: source.document };
    });
    draft.profiles.push({ id: profileId, revision: subproject.revision, title: node.title, role: node.role,
      instructions: `${node.instructions}\n\nFrozen stage document (reference data):\n${node.document}\n\nFrozen input documents:\n${JSON.stringify(references)}`,
      contextRefs: [], allowedTools: write ? ['project.read', 'project.write', 'terminal.execute'] : ['project.read', 'review.read'], retryLimit: node.retryLimit });
    const acceptance = node.acceptance.map((description, index) => ({ id: `${node.id}:accept:${index + 1}`, description }));
    draft.tasks.push({ id: node.id, revision: subproject.revision, title: node.title, objective: node.instructions,
      featureIds: [], screenIds: [], inputRefs: [], dependencyIds: [...ancestors].filter(id => subproject.graph.nodes.find(entry => entry.id === id)?.operation === 'agent'), allowedPaths: node.allowedPaths, interfaceRefs: [], profileId,
      executionEnvironment: { mode: 'namespaced', portCount: 1 }, acceptance,
      validationPlan: acceptance.map(entry => ({ id: `${entry.id}:validation`, acceptanceIds: [entry.id], description: entry.description, method: 'inspection' as const, environment: 'Independent review of the exact workflow attempt and captured artifacts.' })), status: 'ready' });
    assignments.push({ taskId: node.id, profileId, providerId: node.providerId!, model: node.model!, permissionPreset: node.permissionPreset });
  }
  const reviewerProfileId = `${subproject.id}:reviewer`;
  draft.profiles.push({ id: reviewerProfileId, revision: subproject.revision, title: '독립 검토', role: 'review',
    instructions: 'Independently verify the exact stage acceptance criteria and captured artifacts. Do not change files or infer success from prose. Report missing evidence and reject unmet criteria.',
    contextRefs: [], allowedTools: ['project.read', 'review.read'], retryLimit: 2 });
  return { draft, assignments, reviewer: { profileId: reviewerProfileId, ...reviewer, permissionPreset: 'plan' as const } };
}
