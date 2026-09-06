import {
  safeParseDaemonCommand,
  type DaemonCommandEnvelope,
} from './daemon-protocol';
import type { LayoutEnvelope } from './layout-schema';
import { validateLayoutEnvelope } from './layout-schema';
import { isSessionSurfaceId } from './session-surface';

export const RENDERER_RECOVERY_VERSION = 1 as const;
export const RENDERER_RECOVERY_MAX_PANES = 64;
export const RENDERER_RECOVERY_MAX_HISTORY = 200;
export const RENDERER_RECOVERY_MAX_ACTIVE_RUNS = 32;
export const RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES = 64;
export const RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_PROMPT_CHARS = 64 * 1024;
export const RENDERER_RECOVERY_MAX_CHARS = 4 * 1024 * 1024;

export interface RendererRecoveryPane {
  readonly panelId: string;
  readonly sessionId: string | null;
  readonly sessionSurfaceId: string | null;
  readonly cwd: string;
  readonly history: readonly string[];
  readonly draft: string;
  readonly activeRunIds: readonly string[];
  readonly scrollTop: number;
}

/**
 * Volatile escrow for one in-flight structured Agent creation. The exact
 * envelope is intentionally kept out of Dockview params because it contains
 * the user's first prompt.
 */
export interface RendererRecoveryStructuredAgentCreate {
  readonly panelId: string;
  readonly historyId: string;
  readonly sessionId: string;
  readonly phase: 'sending' | 'delivery-uncertain';
  readonly command: DaemonCommandEnvelope<'agent.create'>;
}

export interface RendererRecoveryCheckpoint {
  readonly version: typeof RENDERER_RECOVERY_VERSION;
  readonly savedAt: number;
  readonly layout: LayoutEnvelope;
  readonly panes: readonly RendererRecoveryPane[];
  readonly structuredAgentCreates: readonly RendererRecoveryStructuredAgentCreate[];
  readonly activePanelId: string | null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (
    typeof left !== 'object'
    || left === null
    || typeof right !== 'object'
    || right === null
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && sameJsonValue(leftRecord[key], rightRecord[key])
    ));
}

function structuredAgentCreateFromValue(
  value: unknown,
  layout: LayoutEnvelope,
): RendererRecoveryStructuredAgentCreate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 5
    || keys[0] !== 'command'
    || keys[1] !== 'historyId'
    || keys[2] !== 'panelId'
    || keys[3] !== 'phase'
    || keys[4] !== 'sessionId'
    || !boundedString(candidate.panelId, 256)
    || !boundedString(candidate.historyId, 128)
    || !boundedString(candidate.sessionId, 256)
    || (candidate.phase !== 'sending' && candidate.phase !== 'delivery-uncertain')
  ) return null;

  const panel = layout.layout.panels[candidate.panelId];
  if (
    panel?.contentComponent !== 'agent-session'
    || panel.params.historyId !== candidate.historyId
    || !candidate.historyId.startsWith('structured-draft-')
    || candidate.panelId !== `agent-session-${candidate.historyId}`
  ) return null;

  const parsed = safeParseDaemonCommand(candidate.command);
  if (!parsed.success || parsed.data.type !== 'agent.create') return null;
  const command = parsed.data;
  if (
    !sameJsonValue(candidate.command, command)
    || command.principal.kind !== 'desktop'
    || command.principal.id !== 'renderer-agent-ui'
    || command.principal.sessionId !== undefined
    || command.commandId !== command.idempotencyKey
    || command.payload.parentSessionId !== undefined
    || command.payload.sessionId !== candidate.sessionId
    || command.payload.initialPrompt.length > RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_PROMPT_CHARS
    || command.payload.title.length > 256
    || command.issuedAt.length > 128
  ) return null;

  return Object.freeze({
    panelId: candidate.panelId,
    historyId: candidate.historyId,
    sessionId: candidate.sessionId,
    phase: candidate.phase,
    command: Object.freeze({
      ...command,
      principal: Object.freeze({ ...command.principal }),
      payload: Object.freeze({ ...command.payload }),
    }),
  });
}

/** Validate an in-memory renderer checkpoint at the privilege boundary. */
export function validateRendererRecoveryCheckpoint(
  value: unknown,
): RendererRecoveryCheckpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized.length > RENDERER_RECOVERY_MAX_CHARS) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== RENDERER_RECOVERY_VERSION) return null;
  if (typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt)) return null;
  const layout = validateLayoutEnvelope(candidate.layout);
  if (!layout || !Array.isArray(candidate.panes)) return null;
  if (candidate.panes.length > RENDERER_RECOVERY_MAX_PANES) return null;
  const rawStructuredAgentCreates = candidate.structuredAgentCreates === undefined
    ? []
    : candidate.structuredAgentCreates;
  if (
    !Array.isArray(rawStructuredAgentCreates)
    || rawStructuredAgentCreates.length > RENDERER_RECOVERY_MAX_STRUCTURED_AGENT_CREATES
  ) return null;
  if (candidate.activePanelId !== null && !boundedString(candidate.activePanelId, 256)) return null;

  const layoutPanelIds = new Set(Object.keys(layout.layout.panels));
  const seen = new Set<string>();
  const panes: RendererRecoveryPane[] = [];
  for (const raw of candidate.panes) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const pane = raw as Record<string, unknown>;
    if (!boundedString(pane.panelId, 256) || !layoutPanelIds.has(pane.panelId) || seen.has(pane.panelId)) {
      return null;
    }
    if (pane.sessionId !== null && !isSessionSurfaceId(pane.sessionId)) return null;
    if (pane.sessionSurfaceId !== null && !isSessionSurfaceId(pane.sessionSurfaceId)) return null;
    if ((pane.sessionId === null) !== (pane.sessionSurfaceId === null)) return null;
    if (!boundedString(pane.cwd, 4096) || !boundedString(pane.draft, 64 * 1024)) return null;
    if (!Array.isArray(pane.history) || pane.history.length > RENDERER_RECOVERY_MAX_HISTORY) return null;
    if (pane.history.some((entry) => !boundedString(entry, 8192))) return null;
    if (!Array.isArray(pane.activeRunIds) || pane.activeRunIds.length > RENDERER_RECOVERY_MAX_ACTIVE_RUNS) return null;
    if (pane.activeRunIds.some((runId) => !isSessionSurfaceId(runId))) return null;
    if (typeof pane.scrollTop !== 'number' || !Number.isFinite(pane.scrollTop) || pane.scrollTop < 0) return null;
    seen.add(pane.panelId);
    panes.push(Object.freeze({
      panelId: pane.panelId,
      sessionId: pane.sessionId,
      sessionSurfaceId: pane.sessionSurfaceId,
      cwd: pane.cwd,
      history: Object.freeze([...pane.history] as string[]),
      draft: pane.draft,
      activeRunIds: Object.freeze([...pane.activeRunIds] as string[]),
      scrollTop: pane.scrollTop,
    }));
  }

  const structuredAgentCreates: RendererRecoveryStructuredAgentCreate[] = [];
  const structuredAgentPanelIds = new Set<string>();
  const structuredAgentSessionIds = new Set<string>();
  for (const raw of rawStructuredAgentCreates) {
    const recovery = structuredAgentCreateFromValue(raw, layout);
    if (
      !recovery
      || structuredAgentPanelIds.has(recovery.panelId)
      || structuredAgentSessionIds.has(recovery.sessionId)
    ) return null;
    structuredAgentPanelIds.add(recovery.panelId);
    structuredAgentSessionIds.add(recovery.sessionId);
    structuredAgentCreates.push(recovery);
  }

  if (candidate.activePanelId !== null && !layoutPanelIds.has(candidate.activePanelId)) return null;
  return Object.freeze({
    version: RENDERER_RECOVERY_VERSION,
    savedAt: candidate.savedAt,
    layout,
    panes: Object.freeze(panes),
    structuredAgentCreates: Object.freeze(structuredAgentCreates),
    activePanelId: candidate.activePanelId,
  });
}
