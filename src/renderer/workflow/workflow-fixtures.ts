import { createWorkflowGraph, type WorkflowNavigationSnapshot, type WorkflowSnapshot, type WorkflowSubproject } from '../../shared/workflow';

/** Deterministic Storybook/test data. Production code never imports these fixtures. */
export function workflowFixture(): WorkflowSnapshot {
  const make = (id: string, title: string): WorkflowSubproject => ({ id, title, goal: `${title} acceptance criteria`, revision: 1, status: 'active', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', presetId: 'research', history: [], archivedNodes: [], graph: { ...createWorkflowGraph('research', id), nodes: createWorkflowGraph('research', id).nodes.map((node, index) => ({ ...node, title: index === 0 ? 'Investigation' : index === 1 ? 'Approval' : 'Complete', ...(node.operation === 'agent' ? { providerId: 'codex', model: 'model-story' } : {}), instructions: 'Inspect the assigned project and record evidence.', acceptance: ['Document the evidence.'], position: { x: 40 + index * 344, y: 50 } })) } });
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

