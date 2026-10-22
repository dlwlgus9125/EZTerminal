import { describe, expect, it } from 'vitest';
import { PlanningExecutionSnapshotSchema } from '../../shared/planning-execution';
import { validateWorkflowGraph } from '../../shared/workflow-graph';
import { projectRunOverlay } from './workflow-canvas-model';
import { workflowCanvasFixture, type WorkflowCanvasScenario } from './workflow-canvas-fixtures';

const scenarios: WorkflowCanvasScenario[] = ['prepared', 'just-started', 'retry-running', 'awaiting-approval', 'retry-exhausted', 'completed', 'integrated-auto', 'cancelled', 'parallel-join'];
const status = (scenario: WorkflowCanvasScenario, node: string) => projectRunOverlay(workflowCanvasFixture(scenario).run!)!.nodes[`login:${node}`];

describe('workflow canvas fixtures', () => {
  it('are runs the host would accept, on graphs the validator accepts', () => {
    for (const scenario of scenarios) {
      const { graph, run } = workflowCanvasFixture(scenario);
      expect(() => PlanningExecutionSnapshotSchema.shape.runs.element.parse(run), scenario).not.toThrow();
      expect(validateWorkflowGraph(graph).map(issue => issue.code), scenario).toEqual([]);
    }
  });

  it('show the states each story is named for', () => {
    expect(status('prepared', 'plan').status).toBe('pending');
    expect(status('just-started', 'plan').status).toBe('working');
    expect(status('retry-running', 'implement')).toMatchObject({ status: 'working', iteration: 1 });
    expect(status('retry-running', 'review')).toMatchObject({ status: 'completed', outcome: 'failed' });
    expect(status('awaiting-approval', 'approval').status).toBe('awaiting-approval');
    expect(status('retry-exhausted', 'condition').status).toBe('retry-exhausted');
    expect(status('completed', 'done').status).toBe('completed');
    expect(status('cancelled', 'implement').status).toBe('cancelled');
    expect(status('cancelled', 'review').status).toBe('not-reached');
    expect(status('parallel-join', 'join')).toMatchObject({ status: 'waiting', arrivals: { arrived: 1, expected: 2 } });
  });

  it('count the retry edge the way the runtime does', () => {
    expect(projectRunOverlay(workflowCanvasFixture('retry-running').run!)!.edges['login:retry']).toEqual({ taken: 1, retryLimit: 2 });
    expect(projectRunOverlay(workflowCanvasFixture('retry-exhausted').run!)!.edges['login:retry']).toEqual({ taken: 2, retryLimit: 2 });
  });
});
