import type { ExecutionKind } from './ipc';

export type CloseRisk =
  | 'ssh-prompt'
  | 'active-agent'
  | 'ssh-active'
  | 'running-command'
  | 'unknown';

export interface CloseRiskInput {
  readonly destroysSession: boolean;
  readonly isBusy: boolean;
  readonly executionKind: ExecutionKind | null;
  readonly hasSshPrompt: boolean;
  readonly hasActiveAgent: boolean;
  readonly isDead?: boolean;
}

export type PaneClosePlan =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'close' }
  | { readonly kind: 'confirm'; readonly risk: CloseRisk };

/**
 * Single close-risk policy shared by the desktop pane guard and mobile
 * session-destroy guard. A missing execution kind fails closed while busy.
 */
export function classifyCloseRisk(input: CloseRiskInput): CloseRisk | null {
  if (!input.destroysSession || input.isDead) return null;
  if (input.hasSshPrompt) return 'ssh-prompt';
  if (input.hasActiveAgent) return 'active-agent';
  if (!input.isBusy) return null;
  if (input.executionKind === 'ssh') return 'ssh-active';
  if (input.executionKind === 'local') return 'running-command';
  return 'unknown';
}

/**
 * Decide only from known pane state. A registry miss is never equivalent to a
 * safe pane, even when the user disabled ordinary risky-close confirmations.
 */
export function planPaneClose(
  input: CloseRiskInput | null,
  confirmRiskyClose: boolean,
): PaneClosePlan {
  if (input === null) return { kind: 'blocked' };
  const risk = classifyCloseRisk(input);
  if (!confirmRiskyClose || risk === null) return { kind: 'close' };
  return { kind: 'confirm', risk };
}

export const CLOSE_RISK_LABEL: Readonly<Record<CloseRisk, string>> = {
  'ssh-prompt': 'an SSH authentication prompt',
  'active-agent': 'an active agent workflow',
  'ssh-active': 'an active SSH connection',
  'running-command': 'a running command',
  unknown: 'activity that could not be identified',
};

export function countCloseRisks(risks: readonly CloseRisk[]): Readonly<Record<CloseRisk, number>> {
  const counts: Record<CloseRisk, number> = {
    'ssh-prompt': 0,
    'active-agent': 0,
    'ssh-active': 0,
    'running-command': 0,
    unknown: 0,
  };
  for (const risk of risks) counts[risk] += 1;
  return counts;
}

/** Order-independent run identity check used when a close confirmation is
 * accepted. Any added or replaced run requires a fresh confirmation. */
export function sameActiveRunSet(
  first: readonly string[],
  second: readonly string[],
): boolean {
  const left = [...new Set(first)].sort();
  const right = [...new Set(second)].sort();
  return left.length === right.length && left.every((runId, index) => runId === right[index]);
}
