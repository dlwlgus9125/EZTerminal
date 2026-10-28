import type { ExecutionRun, PlanningExecutionSnapshot } from './planning-execution';
import type { PlanningRunResult } from './planning-run';
import type { ProjectArchiveResult } from './project-archive';
import type { WorkflowCommand, WorkflowPreviewRequest, WorkflowPreviewResult, WorkflowRegistry, WorkflowResult, WorkflowSnapshot, WorkflowSubproject } from './workflow';

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
/**
 * Fields added with remote protocol v18 (agents on stages, '이어서', per-stage review, checks, answer
 * stages). v17 readers parse strictly too, so they get the same kind of reduced view; an answer stage
 * (a value they cannot parse) reads as an approval they cannot act on.
 */
export const FLOW_V18_NODE_FIELDS = ['agent', 'session', 'review', 'checks', 'answer', 'skipWhenUnchanged'] as const;
export const FLOW_V18_ACTIVATION_FIELDS = ['answer', 'comment', 'skipped'] as const;
export const FLOW_V18_RUN_FIELDS: readonly string[] = [];
export const FLOW_V18_SUBPROJECT_FIELDS: readonly string[] = [];
/** The protocol a reduced reader speaks: 16 (no v17 or v18 fields) or 17 (no v18 fields). */
export type FlowReaderProtocol = 16 | 17;
const nodeFields = (reader: FlowReaderProtocol): readonly string[] => reader === 16 ? [...FLOW_V17_NODE_FIELDS, ...FLOW_V18_NODE_FIELDS] : FLOW_V18_NODE_FIELDS;
const subprojectFields = (reader: FlowReaderProtocol): readonly string[] => reader === 16 ? [...FLOW_V17_SUBPROJECT_FIELDS, ...FLOW_V18_SUBPROJECT_FIELDS] : FLOW_V18_SUBPROJECT_FIELDS;
const runFields = (reader: FlowReaderProtocol): readonly string[] => reader === 16 ? [...FLOW_V17_RUN_FIELDS, ...FLOW_V18_RUN_FIELDS] : FLOW_V18_RUN_FIELDS;

function without<T extends object>(value: T, keys: readonly string[]): T {
  if (!keys.some((key) => Object.hasOwn(value, key))) return value;
  const copy = { ...value } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function legacyNode<T extends object>(node: T, reader: FlowReaderProtocol = 16): T {
  const reduced = without(node, nodeFields(reader));
  // An answer stage reads as an approval to a reader without answer stages (it cannot act on it).
  return (reduced as { operation?: string }).operation === 'answer' ? { ...reduced, operation: 'approval' } : reduced;
}

/** A graph as a v16 (or, with `reader` 17, a v17) reader sees it. */
export function legacyWorkflowGraph<T extends { readonly nodes: readonly object[] }>(graph: T, reader: FlowReaderProtocol = 16): T {
  return { ...graph, nodes: graph.nodes.map((node) => legacyNode(node, reader)) };
}
const legacyGraph = legacyWorkflowGraph;

/** True when a graph uses something a v17 reader cannot see. */
export function graphCarriesV18(graph: { readonly nodes: readonly object[] } | undefined): boolean {
  return Boolean(graph?.nodes.some((node) => (node as { operation?: string }).operation === 'answer'
    || FLOW_V18_NODE_FIELDS.some((key) => Object.hasOwn(node, key))));
}

/** Command types added with remote protocol v17 (later I2 steps add theirs). */
export const FLOW_V17_COMMAND_TYPES: readonly string[] = ['run.launch'];
/** Command types added with remote protocol v18. */
export const FLOW_V18_COMMAND_TYPES: readonly string[] = ['run.answer'];

/** True when a command needs a v18 host (a v17 host strict schema would reject it). */
export function flowCommandNeedsV18(command: WorkflowCommand): boolean {
  if (FLOW_V18_COMMAND_TYPES.includes(command.type)) return true;
  const payload = command.payload as Record<string, unknown>;
  if (command.type === 'run.approve' && Object.hasOwn(payload, 'comment')) return true;
  return graphCarriesV18(payload.graph as { nodes: readonly object[] } | undefined);
}

/** The same check for a creation preview. */
export function flowPreviewNeedsV18(request: WorkflowPreviewRequest): boolean {
  return request.action === 'open' && graphCarriesV18(request.graph);
}

function graphCarriesV17(graph: { readonly nodes: readonly object[] } | undefined): boolean {
  return Boolean(graph?.nodes.some((node) => FLOW_V17_NODE_FIELDS.some((key) => Object.hasOwn(node, key))));
}

/**
 * True when a command a client is about to send uses something a v16 host cannot accept (its
 * strict schema would reject it). A newer client keeps such a command and its draft instead.
 */
export function flowCommandNeedsV17(command: WorkflowCommand): boolean {
  if (FLOW_V17_COMMAND_TYPES.includes(command.type)) return true;
  const payload = command.payload as Record<string, unknown>;
  if (command.type === 'subproject.update' && FLOW_V17_SUBPROJECT_FIELDS.some((key) => Object.hasOwn(payload, key))) return true;
  return graphCarriesV17(payload.graph as { nodes: readonly object[] } | undefined);
}

/** The same check for a creation preview a client is about to open on the host. */
export function flowPreviewNeedsV17(request: WorkflowPreviewRequest): boolean {
  return request.action === 'open' && graphCarriesV17(request.graph);
}

function legacySubproject(subproject: WorkflowSubproject, reader: FlowReaderProtocol): WorkflowSubproject {
  const base = without(subproject, subprojectFields(reader));
  return {
    ...base,
    graph: legacyGraph(base.graph, reader),
    history: base.history.map((entry) => ({ ...entry, before: legacyGraph(entry.before, reader), after: legacyGraph(entry.after, reader) })),
    archivedNodes: base.archivedNodes.map((node) => legacyNode(node, reader)),
  };
}

export function legacyWorkflowRegistry<T extends WorkflowRegistry>(registry: T, reader: FlowReaderProtocol = 16): T {
  return { ...registry, subprojects: registry.subprojects.map((subproject) => legacySubproject(subproject, reader)) };
}

/** A run as a v16 (or v17) reader can parse it. Task profiles keep their own reasoning effort: v16 already had it. */
export function legacyExecutionRun(run: ExecutionRun, reader: FlowReaderProtocol = 16): ExecutionRun {
  const base = without(run, runFields(reader));
  const workflow = base.preparation.workflow;
  const runtime = base.workflowRuntime;
  return {
    ...base,
    ...(workflow ? { preparation: { ...base.preparation, workflow: { ...workflow, graph: legacyGraph(workflow.graph, reader) } } } : {}),
    // A waiting answer reads as a pending approval the older reader can see but not resolve.
    ...(runtime ? { workflowRuntime: { ...runtime, activations: runtime.activations.map((activation) => {
      const reduced = without(activation, FLOW_V18_ACTIVATION_FIELDS);
      return reduced.state === 'awaiting-answer' ? { ...reduced, state: 'awaiting-approval' as const } : reduced;
    }) } } : {}),
  };
}

function legacyExecutionSnapshot(snapshot: PlanningExecutionSnapshot, reader: FlowReaderProtocol): PlanningExecutionSnapshot {
  return { ...snapshot, runs: snapshot.runs.map((run) => legacyExecutionRun(run, reader)) };
}

export function legacyWorkflowSnapshot(snapshot: WorkflowSnapshot, reader: FlowReaderProtocol = 16): WorkflowSnapshot {
  const base = reader === 16 ? without(snapshot, FLOW_V17_SNAPSHOT_FIELDS) : snapshot;
  return { ...legacyWorkflowRegistry(base, reader), runs: base.runs.map((run) => legacyExecutionRun(run, reader)) };
}

export function legacyWorkflowResult(result: WorkflowResult, reader: FlowReaderProtocol = 16): WorkflowResult {
  return result.ok ? { ...result, snapshot: legacyWorkflowSnapshot(result.snapshot, reader) } : result;
}

export function legacyWorkflowPreviewResult(result: WorkflowPreviewResult, reader: FlowReaderProtocol = 16): WorkflowPreviewResult {
  return result.ok && result.preview ? { ...result, preview: { ...result.preview, graph: legacyGraph(result.preview.graph, reader) } } : result;
}

export function legacyPlanningRunResult(result: PlanningRunResult, reader: FlowReaderProtocol = 16): PlanningRunResult {
  return result.ok ? { ...result, snapshot: legacyExecutionSnapshot(result.snapshot, reader) } : result;
}

export function legacyProjectArchiveResult(result: ProjectArchiveResult, reader: FlowReaderProtocol = 16): ProjectArchiveResult {
  if (!result.ok || result.kind !== 'history' || !result.history) return result;
  const { history } = result;
  return { ...result, history: {
    ...history,
    execution: legacyExecutionSnapshot(history.execution, reader),
    ...(history.workflow ? { workflow: legacyWorkflowRegistry(history.workflow, reader) } : {}),
  } };
}

/**
 * A graph an older version edited (a reduced view) with the v17 stage fields it could not see taken back
 * from the host's graph: a field the reduced graph lacks was hidden from it, never removed by it.
 */
export function withHiddenFlowFields<T extends { readonly nodes: readonly object[] }>(reduced: T, full: { readonly nodes: readonly object[] }): T {
  let changed = false;
  const nodes = reduced.nodes.map((node) => {
    const id = (node as { id?: string }).id;
    const source = full.nodes.find((entry) => (entry as { id?: string }).id === id) as Record<string, unknown> | undefined;
    if (!source) return node;
    const hidden = [...FLOW_V17_NODE_FIELDS, ...FLOW_V18_NODE_FIELDS].filter((key) => !Object.hasOwn(node, key) && Object.hasOwn(source, key));
    if (!hidden.length) return node;
    changed = true;
    return { ...node, ...Object.fromEntries(hidden.map((key) => [key, source[key]])) };
  });
  return changed ? { ...reduced, nodes } : reduced;
}

/**
 * The v17 values of one subproject a v16 reader cannot see, in a stable form.
 * A v16 client's flow edit is refused when it would change them.
 */
export function flowV17Fields(subproject: WorkflowSubproject, reader: FlowReaderProtocol = 16): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
  const pick = (value: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, (value as Record<string, unknown>)[key]]));
  // An answer stage's kind is hidden from these readers too (they see an approval).
  const hiddenKind = (node: object) => (node as { operation?: string }).operation === 'answer' ? { operation: 'answer' } : {};
  const nodes = (list: readonly object[]) => list.map((node) => [(node as { id: string }).id, { ...pick(node, nodeFields(reader)), ...hiddenKind(node) }] as const)
    .filter(([, fields]) => Object.keys(fields).length > 0).sort(([left], [right]) => left.localeCompare(right));
  // One map over active and removed stages: deleting a stage moves it to archivedNodes intact, which loses nothing.
  return JSON.stringify(canonical({
    subproject: pick(subproject, subprojectFields(reader)),
    stages: nodes([...subproject.graph.nodes, ...subproject.archivedNodes]),
  }));
}
