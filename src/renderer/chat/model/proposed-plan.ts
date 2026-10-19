import type { DaemonTurn, ManagedAgentState, PermissionPreset } from '../../../shared/daemon-protocol';
import type { ChatModel, ChatRow } from './types';

type PlanRow = Extract<ChatRow, { kind: 'plan' }>;

/**
 * Codex plan mode ends its turn with a proposed plan; Codex itself never asks
 * to approve it. The conversation asks instead, once the turn has finished and
 * nothing came after the plan.
 */
export function proposedPlan(model: ChatModel, input: {
  readonly providerId: string;
  readonly permissionPreset: PermissionPreset;
  readonly state: ManagedAgentState;
  readonly turns?: readonly DaemonTurn[];
  readonly historyOnly?: boolean;
}): PlanRow | undefined {
  if (input.providerId !== 'codex' || input.permissionPreset !== 'plan' || input.state !== 'idle') return undefined;
  if (input.historyOnly || model.pending) return undefined;
  let plan: PlanRow | undefined;
  for (let index = model.rows.length - 1; index >= 0; index -= 1) {
    const row = model.rows[index]!;
    if (row.kind === 'user') return undefined;
    if (row.kind === 'plan') { plan = row; break; }
  }
  if (!plan?.markdown.trim()) return undefined;
  if (input.turns && plan.turnId) {
    const turn = input.turns.find((entry) => entry.id === plan!.turnId);
    if (turn && turn.state !== 'completed') return undefined;
  }
  return plan;
}

/** The dock shows the proposal; the transcript does not repeat it. */
export function withoutRow(model: ChatModel, row: ChatRow | undefined): ChatModel {
  return row ? { ...model, rows: model.rows.filter((entry) => entry !== row) } : model;
}
