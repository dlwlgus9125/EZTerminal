import type { ProviderModel } from '../shared/daemon-provider';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import type { PlanningBaseline, PlanningSnapshot } from '../shared/planning';
import {
  PreparedExecutionTaskSchema,
  boundStageIssues,
  changedStageSettings,
  stageInputsRebound,
  stageStructureChanged,
  taskMatchesStage,
  withStageSettings,
  type ExecutionRun,
  type PreparedExecutionTask,
  type StageBinding,
} from '../shared/planning-execution';
import type { WorkflowGraph, WorkflowNode } from '../shared/workflow-graph';
import type { WorkflowSubproject } from '../shared/workflow';
import { writeScopesOverlap } from '../shared/write-scope';
import { prepareExecutionTask } from './planning-preparation';
import { workflowPlanningInput } from './workflow-preparation';
import { workflowTaskInputs } from './workflow-runtime';

/** The last committed subproject, read without the workflow gate (see WorkflowService.committedSubproject). */
export type CommittedSubproject =
  | { readonly ok: true; readonly subproject: WorkflowSubproject }
  | { readonly ok: false; readonly reason: 'unreadable' | 'missing' };

export interface StageBindingDependencies {
  readonly daemon: Pick<DaemonSnapshot, 'providers'>;
  readonly listModels: (providerId: string) => Promise<readonly ProviderModel[]>;
  readonly now: () => Date;
  /** The previous-attempt evidence the sender quotes in this stage's turn (planning-run-service). */
  readonly handoff?: (task: PreparedExecutionTask) => string;
  /** The accepted outputs of this stage's inputs exactly as the sender quotes them (rejects when they cannot be read). */
  readonly outputContext?: (task: PreparedExecutionTask) => Promise<string>;
}

/** What to do with a stage that is about to be sent to its provider for the first time. */
export type StageBindingDecision =
  | { readonly kind: 'record'; readonly binding: StageBinding }
  /** The provider's model list could not be read: hold the stage instead of guessing. */
  | { readonly kind: 'retry'; readonly reason: string }
  /**
   * Its input documents changed upstream and the stage cannot be rebuilt with them: hold it rather than
   * send the documents the upstream stages no longer use. The person edits the stage or cancels the run.
   */
  | { readonly kind: 'hold'; readonly reason: string };

/** The dispatch turn limit (planning-run-service): a rebuilt stage whose own text already exceeds it is refused before binding. */
const TURN_LIMIT = 100_000;
/** Room for the execution-environment notes added at dispatch: ~420 fixed characters, 3 ids (160 each), 4 output/temp folders and the ports, about 3,000 in all. */
const DISPATCH_RESERVE = 4_000;

function ordered(tasks: readonly PreparedExecutionTask[], before: string, after: string): boolean {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const pending = [...(byId.get(after)?.dependsOn ?? [])]; const seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (next === before) return true;
    if (seen.has(next)) continue;
    seen.add(next); pending.push(...(byId.get(next)?.dependsOn ?? []));
  }
  return false;
}

/** The connections and position in the flow that decide when a stage runs and what it receives. */
function surroundings(graph: WorkflowGraph, id: string): string {
  const edges = graph.edges.filter((edge) => edge.from === id || edge.to === id)
    .map((edge) => `${edge.id}|${edge.from}|${edge.to}|${edge.outcome}|${edge.retryLimit ?? ''}`).sort();
  const ancestors = new Set<string>(); const pending = [id];
  while (pending.length) {
    const target = pending.pop()!;
    for (const edge of graph.edges.filter((entry) => entry.to === target && !entry.retryLimit)) if (!ancestors.has(edge.from)) { ancestors.add(edge.from); pending.push(edge.from); }
  }
  return JSON.stringify({ edges, entry: graph.entryNodeId === id, ancestors: [...ancestors].sort() });
}

/**
 * Late binding (I2-2): decided once per workflow stage, right before its first attempt is sent.
 * A stage edited after its run was prepared runs with the edited settings; only the stage's own
 * settings bind (STAGE_BINDABLE_FIELDS). Its structure, connections and every other stage stay as
 * the run uses them. The task is rebuilt by the same code as a prepare (prepareExecutionTask), from
 * the run's own graph with this stage's settings spliced in, so its prompt, brief, validations and
 * the model catalog check are exactly what a fresh prepare would give. A stage whose input documents
 * were rebound upstream is rebuilt too, so it reads what those stages actually used.
 */
export async function decideStageBinding(run: ExecutionRun, taskId: string, committed: CommittedSubproject, dependencies: StageBindingDependencies): Promise<StageBindingDecision> {
  const workflow = run.preparation.workflow;
  const frozenNode = workflow?.graph.nodes.find((node) => node.id === taskId);
  const frozenTask = run.preparation.tasks.find((task) => task.taskId === taskId);
  const boundAt = dependencies.now().toISOString();
  const kept = (reason: NonNullable<StageBinding['reason']>, detail?: string, sourceRevision?: number): StageBindingDecision => ({ kind: 'record',
    binding: { outcome: 'kept', boundAt, reason, ...(detail ? { detail: detail.slice(0, 2_000) } : {}), ...(sourceRevision !== undefined ? { sourceRevision } : {}) } });
  if (!workflow || !frozenNode || !frozenTask || frozenNode.operation !== 'agent') return kept('invalid', 'Only a workflow AI stage can be bound.');
  const inputsChanged = stageInputsRebound(run, taskId);
  const sourceRevision = committed.ok ? committed.subproject.revision : undefined;
  const subproject: Omit<WorkflowSubproject, 'graph'> = committed.ok ? committed.subproject
    : { id: workflow.subprojectId, title: frozenTask.title, goal: '', status: 'active', revision: workflow.revision, createdAt: boundAt, updatedAt: boundAt, presetId: 'custom', history: [], archivedNodes: [] };

  /** This stage rebuilt the way a prepare would, from the run's own graph with `node` spliced in. */
  const build = async (node: WorkflowNode): Promise<{ task: PreparedExecutionTask } | { invalid: string } | { retry: string }> => {
    const issues = boundStageIssues(workflow.graph, node);
    if (issues.length) return { invalid: issues.join(' ') };
    const graph = { ...workflow.graph, nodes: workflow.graph.nodes.map((entry) => entry.id === taskId ? node : entry) };
    const reviewer = run.preparation.reviewer;
    const input = workflowPlanningInput({ ...subproject, revision: workflow.revision, graph } as WorkflowSubproject, run.preparation.baseline.baselineId,
      { providerId: reviewer?.providerId ?? node.providerId!, model: reviewer?.model ?? node.model! });
    const definition = input.draft.tasks.find((entry) => entry.id === taskId);
    const assignment = input.assignments.find((entry) => entry.taskId === taskId);
    if (!definition || !assignment) return { invalid: 'The stage could not be prepared.' };
    // The run's baseline identity with this stage's definition: the brief quotes it as reference data.
    const baseline = { id: run.preparation.baseline.baselineId, title: subproject.title, sourceRevision: run.preparation.baseline.revision,
      createdAt: boundAt, createdBy: { kind: 'user', id: 'workflow-binding' }, hash: run.preparation.baseline.fingerprint, draft: input.draft } satisfies PlanningBaseline;
    let catalogUnavailable: string | undefined;
    let built: PreparedExecutionTask;
    try {
      built = await prepareExecutionTask(definition, assignment, baseline, {
        snapshot: { baselines: [baseline] } as unknown as PlanningSnapshot,
        daemon: dependencies.daemon,
        ...(run.preparation.baseCommit ? { baseCommit: run.preparation.baseCommit } : {}),
        listModels: async (providerId) => {
          try { return await dependencies.listModels(providerId); }
          catch (error) { catalogUnavailable = error instanceof Error ? error.message : 'The provider model list is unavailable.'; throw error; }
        },
      }, { taskId, title: definition.title, dependsOn: frozenTask.dependsOn });
    } catch (error) {
      return catalogUnavailable ? { retry: catalogUnavailable } : { invalid: error instanceof Error ? error.message : 'The stage could not be prepared.' };
    }
    const parsed = PreparedExecutionTaskSchema.safeParse({ ...built, ...(frozenTask.sourceTaskId ? { sourceTaskId: frozenTask.sourceTaskId } : {}),
      ...(frozenTask.executionEnvironment ? { executionEnvironment: frozenTask.executionEnvironment } : {}) });
    if (!parsed.success) return { invalid: `The edited stage exceeds a task limit (${parsed.error.issues[0]?.path.join('.') ?? 'task'}).` };
    const task = parsed.data;
    if (!taskMatchesStage(task, node)) return { invalid: 'The rebuilt task does not match the edited stage.' };
    // The turn this stage sends, as the sender assembles it: its text, the accepted input results of this
    // activation and their exact outputs, the previous attempt evidence and room for the execution
    // environment notes. The sender never truncates any of it.
    let inputs: ReturnType<typeof workflowTaskInputs> | undefined;
    try { inputs = workflowTaskInputs(run, task); } catch { /* inputs are re-checked at dispatch */ }
    const handoff = dependencies.handoff?.(task) ?? '';
    // Outputs that cannot be read now leave the length unknown: hold the stage (nothing recorded) and check again.
    let outputs = '';
    if (inputs?.acceptedResults.length && dependencies.outputContext) {
      try { outputs = await dependencies.outputContext(task); }
      catch (error) { return { retry: `its accepted input results could not be read (${error instanceof Error ? error.message : 'unavailable'})` }; }
    }
    if (task.profile.prompt.length + 2 + task.brief.length + (inputs?.context.length ?? 0) + handoff.length + outputs.length + DISPATCH_RESERVE > TURN_LIMIT) {
      return { invalid: `The edited stage is too long for one turn (${TURN_LIMIT.toLocaleString('en-US')} characters with its inputs).` };
    }
    // Stages that may run alongside this one must not write the same paths (the same rule as prepare and result capture).
    if (task.profile.permissionPreset !== 'plan') {
      for (const sibling of run.preparation.tasks) {
        if (sibling.taskId === taskId || sibling.profile.permissionPreset === 'plan') continue;
        if (ordered(run.preparation.tasks, sibling.taskId, taskId) || ordered(run.preparation.tasks, taskId, sibling.taskId)) continue;
        if (writeScopesOverlap(task.allowedPaths ?? [], sibling.allowedPaths ?? [])) return { invalid: `Its writable paths overlap stage ${sibling.title}, which may run at the same time.` };
      }
    }
    return { task };
  };
  const applied = (task: PreparedExecutionTask, node: WorkflowNode, changed: StageBinding['changed'], detail?: string): StageBindingDecision => ({ kind: 'record',
    binding: { outcome: 'applied', boundAt, ...(sourceRevision !== undefined ? { sourceRevision } : {}), changed: changed ?? [],
      ...(inputsChanged ? { inputsChanged: true as const } : {}), ...(detail ? { detail: detail.slice(0, 2_000) } : {}), task, node } });
  /** The stage's own settings stay as prepared; only its rebound input documents are refreshed. */
  const inputsOnly = async (reason: NonNullable<StageBinding['reason']>, detail?: string): Promise<StageBindingDecision> => {
    if (!inputsChanged) return kept(reason, detail, sourceRevision);
    const rebuilt = await build(frozenNode);
    if ('retry' in rebuilt) return { kind: 'retry', reason: rebuilt.retry };
    if ('invalid' in rebuilt) return { kind: 'hold', reason: `Its input documents changed upstream and it cannot be prepared with them: ${rebuilt.invalid}` };
    return applied(rebuilt.task, frozenNode, [], reason === 'unchanged' ? undefined : detail ? `Own settings kept (${reason}): ${detail}` : `Own settings kept (${reason}).`);
  };

  if (!committed.ok) return inputsOnly(committed.reason);
  const currentNode = committed.subproject.graph.nodes.find((node) => node.id === taskId);
  if (!currentNode) return inputsOnly('missing', 'The stage was removed; this run keeps it as prepared.');
  if (stageStructureChanged(frozenNode, currentNode) || surroundings(workflow.graph, taskId) !== surroundings(committed.subproject.graph, taskId)) {
    return inputsOnly('structure-changed', 'The stage or its connections changed; that applies from the next run.');
  }
  const changed = changedStageSettings(frozenNode, currentNode);
  if (changed.length === 0) return inputsOnly('unchanged');
  const node = withStageSettings(frozenNode, currentNode);
  const result = await build(node);
  if ('retry' in result) return { kind: 'retry', reason: result.retry };
  if ('invalid' in result) return inputsOnly('invalid', result.invalid);
  return applied(result.task, node, changed);
}
