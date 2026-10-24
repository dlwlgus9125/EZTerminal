import type { ExecutionRun, PlanningExecutionSnapshot } from './planning-execution';
import type { PlanningRunResult } from './planning-run';
import type { ProjectArchiveResult } from './project-archive';
import type { WorkflowPreviewResult, WorkflowRegistry, WorkflowResult, WorkflowSnapshot, WorkflowSubproject } from './workflow';

/**
 * Flow fields added with remote protocol v17. Installed v16-and-older readers
 * parse every flow and run reply with strict schemas, so one unknown key makes
 * the whole project unreadable to them. Hosts send those readers this reduced
 * view instead (see remote-bridge) and refuse their flow edits that would drop
 * a field they cannot see (see WorkflowService).
 */
export const FLOW_V17_NODE_FIELDS = ['reasoningEffort'] as const;
export const FLOW_V17_SUBPROJECT_FIELDS = ['runSettings', 'repeat'] as const;
export const FLOW_V17_SNAPSHOT_FIELDS = ['repeatStatus'] as const;
export const FLOW_V17_RUN_FIELDS = ['stageBindings'] as const;

function without<T extends object>(value: T, keys: readonly string[]): T {
  if (!keys.some((key) => Object.hasOwn(value, key))) return value;
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function legacyNode<T extends object>(node: T): T {
  return without(node, FLOW_V17_NODE_FIELDS);
}

function legacyGraph<T extends { readonly nodes: readonly object[] }>(graph: T): T {
  return { ...graph, nodes: graph.nodes.map(legacyNode) };
}

function legacySubproject(subproject: WorkflowSubproject): WorkflowSubproject {
  const base = without(subproject, FLOW_V17_SUBPROJECT_FIELDS);
  return {
    ...base,
    graph: legacyGraph(base.graph),
    history: base.history.map((entry) => ({ ...entry, before: legacyGraph(entry.before), after: legacyGraph(entry.after) })),
    archivedNodes: base.archivedNodes.map(legacyNode),
  };
}

export function legacyWorkflowRegistry<T extends WorkflowRegistry>(registry: T): T {
  return { ...registry, subprojects: registry.subprojects.map(legacySubproject) };
}

/** A run as a v16 reader can parse it. Task profiles keep their own reasoning effort: v16 already had it. */
export function legacyExecutionRun(run: ExecutionRun): ExecutionRun {
  const base = without(run, FLOW_V17_RUN_FIELDS);
  const workflow = base.preparation.workflow;
  return workflow ? { ...base, preparation: { ...base.preparation, workflow: { ...workflow, graph: legacyGraph(workflow.graph) } } } : base;
}

function legacyExecutionSnapshot(snapshot: PlanningExecutionSnapshot): PlanningExecutionSnapshot {
  return { ...snapshot, runs: snapshot.runs.map(legacyExecutionRun) };
}

export function legacyWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const base = without(snapshot, FLOW_V17_SNAPSHOT_FIELDS);
  return { ...legacyWorkflowRegistry(base), runs: base.runs.map(legacyExecutionRun) };
}

export function legacyWorkflowResult(result: WorkflowResult): WorkflowResult {
  return result.ok ? { ...result, snapshot: legacyWorkflowSnapshot(result.snapshot) } : result;
}

export function legacyWorkflowPreviewResult(result: WorkflowPreviewResult): WorkflowPreviewResult {
  return result.ok && result.preview ? { ...result, preview: { ...result.preview, graph: legacyGraph(result.preview.graph) } } : result;
}

export function legacyPlanningRunResult(result: PlanningRunResult): PlanningRunResult {
  return result.ok ? { ...result, snapshot: legacyExecutionSnapshot(result.snapshot) } : result;
}

export function legacyProjectArchiveResult(result: ProjectArchiveResult): ProjectArchiveResult {
  if (!result.ok || result.kind !== 'history' || !result.history) return result;
  const { history } = result;
  return { ...result, history: {
    ...history,
    execution: legacyExecutionSnapshot(history.execution),
    ...(history.workflow ? { workflow: legacyWorkflowRegistry(history.workflow) } : {}),
  } };
}

/**
 * The v17 values of one subproject a v16 reader cannot see, in a stable form.
 * A v16 client's flow edit is refused when it would change them.
 */
export function flowV17Fields(subproject: WorkflowSubproject): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  const pick = (value: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, (value as Record<string, unknown>)[key]]));
  const nodes = (list: readonly object[]) => list.map((node) => [(node as { id: string }).id, pick(node, FLOW_V17_NODE_FIELDS)] as const)
    .filter(([, fields]) => Object.keys(fields).length > 0).sort(([left], [right]) => left.localeCompare(right));
  // One map over active and removed stages: deleting a stage moves it to archivedNodes intact, which loses nothing.
  return JSON.stringify(canonical({
    subproject: pick(subproject, FLOW_V17_SUBPROJECT_FIELDS),
    stages: nodes([...subproject.graph.nodes, ...subproject.archivedNodes]),
  }));
}
