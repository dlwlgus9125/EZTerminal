import { describe, expect, it } from 'vitest';

import { workflowCanvasRuns } from '../src/renderer/workflow/workflow-canvas-fixtures';
import type { ExecutionRun } from '../src/shared/planning-execution';
import type { ProjectArchiveResult } from '../src/shared/project-archive';
import { WorkflowCommandSchema, WorkflowResultSchema, type WorkflowResult, type WorkflowSnapshot, type WorkflowSubproject } from '../src/shared/workflow';
import {
  flowCommandNeedsV17,
  flowV17Fields,
  legacyPlanningRunResult,
  legacyProjectArchiveResult,
  legacyWorkflowPreviewResult,
  legacyWorkflowResult,
} from '../src/shared/workflow-protocol-projection';
// What an already-installed v16 reader parses with (frozen at the last v16 commit).
import { PlanningRunResultSchema as V16PlanningRunResult } from './fixtures/protocol-v16/planning-run';
import { ProjectArchiveResultSchema as V16ProjectArchiveResult } from './fixtures/protocol-v16/project-archive';
import { WorkflowPreviewResultSchema as V16WorkflowPreviewResult, WorkflowResultSchema as V16WorkflowResult } from './fixtures/protocol-v16/workflow';

const AT = '2026-10-24T09:00:00.000Z';

/** Adds every v17 flow field a v16 reader has never seen. */
function withV17<T>(value: T): T {
  const node = <N extends object>(entry: N): N => ({ ...entry, reasoningEffort: 'xhigh' });
  const graph = <G extends { nodes: readonly object[] }>(entry: G): G => ({ ...entry, nodes: entry.nodes.map(node) });
  const run = (entry: ExecutionRun): ExecutionRun => ({ ...entry, stageBindings: {},
    preparation: entry.preparation.workflow ? { ...entry.preparation, workflow: { ...entry.preparation.workflow, graph: graph(entry.preparation.workflow.graph) } } : entry.preparation } as ExecutionRun);
  const subproject = (entry: WorkflowSubproject): WorkflowSubproject => ({ ...entry,
    runSettings: { reviewer: { providerId: 'codex', model: 'gpt-6-astra' } },
    repeat: { cadence: 'weekly', weekday: 1, time: '09:00', timezone: 'Asia/Seoul', enabled: true },
    graph: graph(entry.graph), archivedNodes: entry.archivedNodes.map(node),
    history: entry.history.map((change) => ({ ...change, before: graph(change.before), after: graph(change.after) })) } as WorkflowSubproject);
  const source = value as unknown as { snapshot?: WorkflowSnapshot; preview?: { graph: { nodes: object[] } } | null; history?: { workflow?: { subprojects: WorkflowSubproject[] }; execution: { runs: ExecutionRun[] } } };
  if (source.snapshot && 'subprojects' in source.snapshot) return { ...value, snapshot: { ...source.snapshot, repeatStatus: { next: AT },
    subprojects: source.snapshot.subprojects.map(subproject), runs: source.snapshot.runs.map(run) } } as T;
  if (source.snapshot) return { ...value, snapshot: { ...source.snapshot, runs: (source.snapshot as unknown as { runs: ExecutionRun[] }).runs.map(run) } } as T;
  if (source.preview) return { ...value, preview: { ...source.preview, graph: graph(source.preview.graph) } } as T;
  if (source.history) return { ...value, history: { ...source.history, execution: { ...source.history.execution, runs: source.history.execution.runs.map(run) },
    ...(source.history.workflow ? { workflow: { ...source.history.workflow, subprojects: source.history.workflow.subprojects.map(subproject) } } : {}) } } as T;
  throw new Error('unknown reply');
}

function fixture(): { snapshot: WorkflowSnapshot; runs: ExecutionRun[] } {
  const { graph, runs: canvasRuns } = workflowCanvasRuns('en');
  // A v16 run task profile could already carry its own reasoning effort.
  const runs = canvasRuns.map((run) => ({ ...run, preparation: { ...run.preparation,
    tasks: run.preparation.tasks.map((task) => ({ ...task, profile: { ...task.profile, reasoningEffort: 'high' } })) } }));
  const subproject: WorkflowSubproject = { id: 'sub-login', title: 'Login', goal: 'Faster login', status: 'active', revision: 2,
    createdAt: AT, updatedAt: AT, presetId: 'feature', graph, archivedNodes: [graph.nodes[1]!],
    history: [{ id: 'change-1', commandId: 'change-1', revision: 2, createdAt: AT, actor: { kind: 'user', id: 'desktop' }, summary: 'Edit', before: graph, after: graph }] };
  const snapshot: WorkflowSnapshot = { schemaVersion: 1, projectId: runs[0]!.projectId, registryRevision: 3, subprojects: [subproject],
    sessionLinks: [], legacyBaselineOwners: {}, hostId: 'host-1', runs };
  return { snapshot, runs };
}

describe('the reduced flow view for remote protocol v16 readers', () => {
  it('drops every v17 field from workflow replies so an installed v16 phone still parses them', () => {
    const { snapshot } = fixture();
    const reply: WorkflowResult = withV17({ ok: true, snapshot, commandId: 'command-1' });
    // Without the reduced view the v16 reader rejects the whole project (and holds its conversations).
    expect(V16WorkflowResult.safeParse(reply).success).toBe(false);
    const reduced = legacyWorkflowResult(reply);
    expect(V16WorkflowResult.safeParse(reduced).success).toBe(true);
    expect(JSON.stringify(reduced)).not.toMatch(/reasoningEffort":"xhigh|runSettings|"repeat"|repeatStatus|stageBindings/u);
  });

  it('keeps v16 data exactly as it was, including the effort a run task profile already carried in v16', () => {
    const { snapshot } = fixture();
    const reply: WorkflowResult = { ok: true, snapshot };
    expect(legacyWorkflowResult(reply)).toEqual(reply);
    expect(JSON.stringify(legacyWorkflowResult(reply))).toBe(JSON.stringify(reply));
    const efforts = (legacyWorkflowResult(withV17(reply)) as typeof reply).snapshot.runs.flatMap((run) => run.preparation.tasks.map((task) => task.profile.reasoningEffort));
    expect(efforts.length).toBeGreaterThan(0);
    expect(new Set(efforts)).toEqual(new Set(['high']));
  });

  it('reduces execution, preview and project-history replies the same way', () => {
    const { snapshot, runs } = fixture();
    const run = withV17({ ok: true, snapshot: { version: 1, projectId: snapshot.projectId, revision: 4, runs } } as const);
    expect(V16PlanningRunResult.safeParse(run).success).toBe(false);
    expect(V16PlanningRunResult.safeParse(legacyPlanningRunResult(run)).success).toBe(true);

    const preview = withV17({ ok: true, preview: { id: 'preview-1', projectId: snapshot.projectId, sessionId: 'session-1', revision: 1, graph: snapshot.subprojects[0]!.graph } } as const);
    expect(V16WorkflowPreviewResult.safeParse(preview).success).toBe(false);
    expect(V16WorkflowPreviewResult.safeParse(legacyWorkflowPreviewResult(preview)).success).toBe(true);

    const history: ProjectArchiveResult = withV17({ ok: true, kind: 'history', history: {
      manifest: { version: 1, createdAt: AT, projectId: snapshot.projectId, projectName: 'Demo', source: { planningRevision: 0, daemonRevision: 0, executionRevision: 4 },
        entries: [], exclusions: [], portable: true, notes: [], integrity: 'a'.repeat(64) },
      planning: { schemaVersion: 1, projectId: snapshot.projectId, revision: 0, draft: { id: 'draft-1', items: [], links: [], scenes: [], components: [], profiles: [], tasks: [], assets: [] }, baselines: [], history: [], profileProposals: [] },
      execution: { version: 1, projectId: snapshot.projectId, revision: 4, runs },
      workflow: { schemaVersion: 1, projectId: snapshot.projectId, registryRevision: 3, subprojects: snapshot.subprojects, sessionLinks: [], legacyBaselineOwners: {} },
      conversations: [], results: [], integrations: [],
    } } as ProjectArchiveResult);
    expect(V16ProjectArchiveResult.safeParse(history).success).toBe(false);
    expect(V16ProjectArchiveResult.safeParse(legacyProjectArchiveResult(history)).success).toBe(true);
  });

  it('a flow whose stages carry an effort is valid for this version and reduced for v16 (I2-1)', () => {
    const { snapshot } = fixture();
    const subproject = snapshot.subprojects[0]!;
    const withEffort: WorkflowResult = { ok: true, snapshot: { ...snapshot, subprojects: [{ ...subproject,
      graph: { ...subproject.graph, nodes: subproject.graph.nodes.map((node) => ({ ...node, reasoningEffort: 'high' })) } }] } };
    expect(WorkflowResultSchema.safeParse(withEffort).success).toBe(true);
    expect(V16WorkflowResult.safeParse(withEffort).success).toBe(false);
    expect(V16WorkflowResult.safeParse(legacyWorkflowResult(withEffort)).success).toBe(true);
  });
  it('passes failures through untouched', () => {
    const failure = { ok: false, error: 'unavailable', message: 'Later.' } as const;
    expect(legacyWorkflowResult(failure)).toBe(failure);
    expect(legacyPlanningRunResult(failure)).toBe(failure);
  });
});

describe('flowV17Fields', () => {
  const base = () => fixture().snapshot.subprojects[0]!;
  it('is empty-stable for a v16 subproject and changes when a hidden field changes', () => {
    const plain = base();
    expect(flowV17Fields(plain)).toBe(flowV17Fields(structuredClone(plain)));
    const withEffort = { ...plain, graph: { ...plain.graph, nodes: plain.graph.nodes.map((node, index) => index === 0 ? { ...node, reasoningEffort: 'high' } : node) } } as WorkflowSubproject;
    expect(flowV17Fields(withEffort)).not.toBe(flowV17Fields(plain));
    // Dropping the field (what a v16 client's whole-graph patch does) is a change too.
    expect(flowV17Fields({ ...withEffort, graph: plain.graph })).toBe(flowV17Fields(plain));
  });
  it('treats deleting a stage (it moves to archivedNodes intact) as no change', () => {
    const plain = base();
    const stage = { ...plain.graph.nodes[0]!, reasoningEffort: 'high' };
    const before = { ...plain, graph: { ...plain.graph, nodes: [stage, ...plain.graph.nodes.slice(1)] }, archivedNodes: [] } as unknown as WorkflowSubproject;
    const after = { ...plain, graph: { ...plain.graph, nodes: plain.graph.nodes.slice(1) }, archivedNodes: [stage] } as unknown as WorkflowSubproject;
    expect(flowV17Fields(after)).toBe(flowV17Fields(before));
  });
  it('ignores key order and node order', () => {
    const plain = base();
    const a = { ...plain, runSettings: { reviewer: { providerId: 'codex', model: 'm' } } } as unknown as WorkflowSubproject;
    const b = { ...plain, runSettings: { reviewer: { model: 'm', providerId: 'codex' } }, graph: { ...plain.graph, nodes: [...plain.graph.nodes].reverse() } } as unknown as WorkflowSubproject;
    expect(flowV17Fields(a)).toBe(flowV17Fields(b));
  });
});

describe('commands a newer client keeps for a v17 host (I2-3)', () => {
  const envelope = { commandId: 'c', projectId: 'p', hostId: 'h', expectedRevision: 1, subprojectId: 's' };
  it('needs v17 for 다시 실행 and for saving run settings, not for prepare and start', () => {
    expect(flowCommandNeedsV17(WorkflowCommandSchema.parse({ ...envelope, type: 'run.launch', payload: { runId: 'r' } }))).toBe(true);
    expect(flowCommandNeedsV17(WorkflowCommandSchema.parse({ ...envelope, type: 'subproject.update', payload: { runSettings: { reviewer: { providerId: 'codex', model: 'm' } } } }))).toBe(true);
    expect(flowCommandNeedsV17(WorkflowCommandSchema.parse({ ...envelope, type: 'subproject.update', payload: { title: 'Renamed' } }))).toBe(false);
    expect(flowCommandNeedsV17(WorkflowCommandSchema.parse({ ...envelope, type: 'run.prepare', payload: { runId: 'r', reviewer: { providerId: 'codex', model: 'm' } } }))).toBe(false);
    expect(flowCommandNeedsV17(WorkflowCommandSchema.parse({ ...envelope, type: 'run.start', payload: { runId: 'r' } }))).toBe(false);
  });
});
