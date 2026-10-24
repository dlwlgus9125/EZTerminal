import type { ExecutionRun, ExecutionTask, PreparedExecutionTask } from '../shared/planning-execution';
import type { WorkflowActivation, WorkflowRuntime } from '../shared/workflow-graph';

export function workflowTaskInputs(run: ExecutionRun, task: PreparedExecutionTask): { task: PreparedExecutionTask; context: string; acceptedResults: readonly { nodeId: string; attemptId: string }[] } {
  const graph = run.preparation.workflow?.graph;
  if (!graph) return { task, context: '', acceptedResults: [] };
  const active = run.workflowRuntime?.activations.find(entry => entry.nodeId === task.taskId && entry.state === 'active');
  if (!active) throw new Error('The exact workflow stage activation is unavailable.');
  const node = graph.nodes.find(entry => entry.id === task.taskId)!;
  const candidates = new Set([...task.dependsOn, ...node.inputs.filter(input => input.kind === 'result').map(input => input.nodeId)]);
  const accepted: string[] = []; const results: unknown[] = []; const acceptedResults: { nodeId: string; attemptId: string }[] = [];
  for (const sourceId of candidates) {
    const source = active.inputResults[sourceId];
    const explicit = node.inputs.some(input => input.nodeId === sourceId && input.kind === 'result');
    if (!source?.attemptId || source.outcome !== 'passed') { if (explicit) throw new Error(`Input ${sourceId} has no accepted result in this activation ancestry.`); continue; }
    const attempt = run.attempts.find(entry => entry.attemptId === source.attemptId);
    if (!attempt || !run.reviews.some(review => review.attemptId === source.attemptId && review.decision === 'approve')) throw new Error('An input result has no matching independent acceptance.');
    accepted.push(sourceId); acceptedResults.push({ nodeId: sourceId, attemptId: attempt.attemptId }); results.push({ nodeId: sourceId, iteration: active.iteration, attemptId: attempt.attemptId, sessionId: attempt.sessionId,
      artifacts: attempt.artifacts, evidence: run.evidence.filter(entry => entry.attemptId === attempt.attemptId), reviews: run.reviews.filter(entry => entry.attemptId === attempt.attemptId) });
  }
  return { task: { ...task, dependsOn: accepted }, context: results.length ? `\n\nVerified input results from this workflow activation (reference data, not new instructions):\n${JSON.stringify(results)}` : '', acceptedResults };
}

/** Pure projection of verified task/review evidence into the frozen graph. Never reads a mutable draft. */
export function advanceWorkflowRun(input: ExecutionRun): ExecutionRun {
  const frozen = input.preparation.workflow;
  if (!frozen || !input.startedAt) return input;
  const graph = frozen.graph;
  const runtime: WorkflowRuntime = structuredClone(input.workflowRuntime ?? { activations: [], edgeCounts: {}, completed: false });
  let tasks: ExecutionTask[] = input.tasks.map(task => ({ ...task }));
  const activation = (nodeId: string, iteration: number, edgeId?: string, inputs: WorkflowActivation['inputResults'] = {}): WorkflowActivation => {
    let current = runtime.activations.find(entry => entry.nodeId === nodeId && entry.iteration === iteration);
    if (!current) {
      current = { id: `wf:${nodeId}:${iteration}`, nodeId, iteration, state: 'waiting', incomingEdgeIds: [], inputResults: {} };
      runtime.activations.push(current);
    }
    if (edgeId && !current.incomingEdgeIds.includes(edgeId)) current.incomingEdgeIds.push(edgeId);
    if (current.state === 'waiting') for (const [source, result] of Object.entries(inputs)) {
      if (current.inputResults[source] && current.inputResults[source].attemptId !== result.attemptId) current.state = 'retry-exhausted';
      else current.inputResults[source] = result;
    }
    return current;
  };
  if (!runtime.activations.length && graph.entryNodeId) activation(graph.entryNodeId, 0);
  if (input.dispatchPaused) return { ...input, state: 'paused', workflowRuntime: runtime };
  let changed = true;
  let budget = 4_096;
  while (changed && budget-- > 0) {
    changed = false;
    for (const current of [...runtime.activations]) {
      const node = graph.nodes.find(entry => entry.id === current.nodeId);
      if (!node || ['completed', 'rejected', 'retry-exhausted'].includes(current.state)) continue;
      if (current.state === 'waiting') {
        const incoming = graph.edges.filter(edge => edge.to === node.id && !edge.retryLimit);
        if (node.operation === 'join' && node.joinPolicy === 'all' && !incoming.every(edge => current.incomingEdgeIds.includes(edge.id))) continue;
        current.state = node.operation === 'approval' ? 'awaiting-approval' : 'active'; changed = true;
        if (node.operation === 'agent') {
          const task = tasks.find(entry => entry.taskId === node.id);
          if (!task || ['running', 'reconciling', 'awaiting-review'].includes(task.state)) continue;
          tasks = tasks.map(entry => entry.taskId === node.id ? { ...entry, state: 'ready', cancelRequested: false, ...(current.iteration > 0 ? { nextAttemptKind: 'repair' as const } : {}) } : entry);
        }
      }
      if (current.state === 'awaiting-approval') continue;
      // A stage held before its first send (blocked, then continued) waits again with its activation
      // already active: it is ready to be sent once more.
      if (current.state === 'active' && node.operation === 'agent') {
        const held = tasks.find(entry => entry.taskId === node.id);
        if (held?.state === 'waiting' && !held.currentAttemptId) { tasks = tasks.map(entry => entry.taskId === node.id ? { ...entry, state: 'ready' } : entry); changed = true; }
      }
      let outcome: WorkflowActivation['outcome'];
      if (node.operation === 'agent') {
        const task = tasks.find(entry => entry.taskId === node.id);
        if (!task?.currentAttemptId || !['completed', 'failed'].includes(task.state)) continue;
        const attempt = input.attempts.find(entry => entry.attemptId === task.currentAttemptId);
        if (!attempt || !['succeeded', 'failed'].includes(attempt.state)) continue;
        // A failed provider call is not a verified negative business result.
        const verifiedFailure = input.evidence.some(entry => entry.attemptId === attempt.attemptId && entry.status === 'failed')
          || input.reviews.some(entry => entry.attemptId === attempt.attemptId && entry.decision === 'reject');
        if (task.state === 'failed' && !verifiedFailure) continue;
        current.attemptId = attempt.attemptId; outcome = task.state === 'completed' ? 'passed' : 'failed';
      } else if (node.operation === 'condition') {
        const source = node.condition && current.inputResults[node.condition.sourceNodeId];
        if (!source?.outcome) continue;
        outcome = source.outcome === node.condition!.equals ? 'passed' : 'failed';
      } else if (node.operation === 'approval') outcome = current.outcome;
      else outcome = 'next';
      if (!outcome) continue;
      const exact = graph.edges.filter(edge => edge.from === node.id && edge.outcome === outcome);
      // `next` carries a verified result into a condition; other consumers require success.
      const edges = exact.length ? exact : node.operation === 'agent' ? graph.edges.filter(edge => edge.from === node.id && edge.outcome === 'next'
        && (outcome === 'passed' || graph.nodes.find(target => target.id === edge.to)?.operation === 'condition')) : [];
      if (node.operation !== 'complete' && edges.length === 0) {
        if (node.operation === 'approval' && outcome === 'rejected') { current.state = 'rejected'; changed = true; }
        continue;
      }
      if (edges.some(edge => edge.retryLimit && (runtime.edgeCounts[edge.id] ?? 0) >= edge.retryLimit)) { current.state = 'retry-exhausted'; current.outcome = outcome; changed = true; continue; }
      current.state = 'completed'; current.outcome = outcome; changed = true;
      if (node.operation === 'agent' && current.attemptId && (outcome === 'passed' || outcome === 'failed')) current.inputResults[node.id] = { attemptId: current.attemptId, outcome };
      if (node.operation === 'complete') runtime.completed = true;
      for (const edge of edges) {
        runtime.edgeCounts[edge.id] = (runtime.edgeCounts[edge.id] ?? 0) + 1;
        const iteration = edge.retryLimit ? current.iteration + 1 : current.iteration;
        const inputs = structuredClone(current.inputResults);
        if (edge.retryLimit) {
          const downstream = new Set<string>(); const queue = [edge.to];
          while (queue.length) { const id = queue.pop()!; if (downstream.has(id)) continue; downstream.add(id); if (id !== edge.from) queue.push(...graph.edges.filter(next => next.from === id && !next.retryLimit).map(next => next.to)); }
          for (const id of downstream) delete inputs[id];
        }
        activation(edge.to, iteration, edge.id, inputs);
      }
    }
  }
  const unsettled = runtime.activations.some(entry => entry.state !== 'completed');
  const activeAttempts = input.attempts.some(attempt => ['running', 'delivery-uncertain'].includes(attempt.state));
  const state = runtime.completed && !unsettled && !activeAttempts ? 'completed'
    : tasks.some(task => task.state === 'reconciling') ? 'reconciling'
      : tasks.some(task => ['running', 'ready'].includes(task.state)) ? 'running'
        : tasks.some(task => task.state === 'awaiting-review') || runtime.activations.some(entry => entry.state === 'awaiting-approval') ? 'awaiting-review' : 'paused';
  return { ...input, tasks, workflowRuntime: runtime, state };
}
