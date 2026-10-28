import type { DaemonAgent, DaemonPendingAgentSettings, PermissionPreset } from '../shared/daemon-protocol';

/** The values a request runs with: model, permission and effort. */
export interface ConversationSettingsValues {
  readonly model?: string;
  readonly permissionPreset: PermissionPreset;
  readonly reasoningEffort?: string;
}

/**
 * The input box's "지금 차례 → 다음 요청" line: what the running request uses (the next values are the
 * composer's own settings), the effort's scope when an effort waits, and cancelling what waits.
 */
export interface QueuedSettingsProp {
  readonly current: ConversationSettingsValues;
  readonly scope?: 'once' | 'keep';
  readonly onScope?: (scope: 'once' | 'keep') => void;
  readonly onCancel?: () => void;
}

/** What the next request uses: the agent record with what waits for it on top. */
export function nextConversationSettings(agent: DaemonAgent, pending: DaemonPendingAgentSettings | undefined): ConversationSettingsValues {
  const model = pending?.model ?? agent.model;
  const reasoningEffort = pending?.reasoningEffort ?? agent.reasoningEffort;
  return {
    ...(model ? { model } : {}),
    permissionPreset: pending?.permissionPreset ?? agent.permissionPreset,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

/** The line's data from the host snapshot (`pendingAgentSettings`); nothing when nothing waits or differs. */
export function queuedSettingsFor(
  agent: DaemonAgent,
  pending: DaemonPendingAgentSettings | undefined,
  actions: {
    readonly cancel: () => void;
    readonly scope: (scope: 'once' | 'keep', reasoningEffort: string) => void;
  },
): QueuedSettingsProp | undefined {
  if (!pending) return undefined;
  const runningEffort = pending.runningTurnId !== undefined && pending.runningTurnId === agent.currentTurnId
    ? pending.runningEffort
    : undefined;
  const waits = Boolean(pending.model || pending.permissionPreset || pending.reasoningEffort);
  if (!waits && !runningEffort) return undefined;
  const effort = runningEffort ?? agent.reasoningEffort;
  const waitingEffort = pending.reasoningEffort;
  return {
    current: {
      ...(agent.model ? { model: agent.model } : {}),
      permissionPreset: agent.permissionPreset,
      ...(effort ? { reasoningEffort: effort } : {}),
    },
    ...(waitingEffort ? { scope: pending.effortScope ?? 'keep', onScope: (scope: 'once' | 'keep') => actions.scope(scope, waitingEffort) } : {}),
    ...(waits ? { onCancel: actions.cancel } : {}),
  };
}

function effortName(value: string, korean: boolean): string {
  const names: Record<string, readonly [string, string]> = {
    minimal: ['최소', 'Minimal'], low: ['낮음', 'Low'], medium: ['보통', 'Medium'],
    high: ['높음', 'High'], xhigh: ['매우 높음', 'Extra high'], max: ['최대', 'Max'],
  };
  const name = names[value];
  return name ? name[korean ? 0 : 1] : value;
}

/**
 * The plan approval dock's note on who implements the approved plan (Settings › AI › 단계 연결). The
 * implementation starts as a new request, so the linked agent runs it (Claude ends its plan turn at the
 * approval for that). Nothing when the link changes nothing.
 */
export function planPhaseNote(input: {
  readonly korean: boolean;
  readonly providerLabel: string;
  readonly agentName: string;
  readonly linkedModel?: string;
  readonly linkedEffort?: string;
  readonly currentModel?: string;
  readonly currentEffort?: string;
  readonly modelLabel: (model: string) => string;
}): string | undefined {
  const modelChanges = input.linkedModel !== undefined && input.linkedModel !== input.currentModel;
  const effortChanges = input.linkedEffort !== undefined && input.linkedEffort !== input.currentEffort;
  if (!modelChanges && !effortChanges) return undefined;
  const model = input.linkedModel ?? input.currentModel;
  const effort = input.linkedEffort ?? input.currentEffort;
  const linked = [
    ...(model ? [input.modelLabel(model)] : []),
    ...(effort ? [effortName(effort, input.korean)] : []),
  ].join(' · ');
  return input.korean
    ? `구현은 '${input.agentName}'(${input.providerLabel} · ${linked})으로 시작합니다 · 설정 › AI › 단계 연결`
    : `The implementation starts with '${input.agentName}' (${input.providerLabel} · ${linked}) · Settings › AI › Phase links`;
}
