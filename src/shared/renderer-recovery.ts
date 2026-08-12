import type { LayoutEnvelope } from './layout-schema';
import { validateLayoutEnvelope } from './layout-schema';
import { isSessionSurfaceId } from './session-surface';

export const RENDERER_RECOVERY_VERSION = 1 as const;
export const RENDERER_RECOVERY_MAX_PANES = 64;
export const RENDERER_RECOVERY_MAX_HISTORY = 200;
export const RENDERER_RECOVERY_MAX_ACTIVE_RUNS = 32;
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

export interface RendererRecoveryCheckpoint {
  readonly version: typeof RENDERER_RECOVERY_VERSION;
  readonly savedAt: number;
  readonly layout: LayoutEnvelope;
  readonly panes: readonly RendererRecoveryPane[];
  readonly activePanelId: string | null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
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

  if (candidate.activePanelId !== null && !layoutPanelIds.has(candidate.activePanelId)) return null;
  return Object.freeze({
    version: RENDERER_RECOVERY_VERSION,
    savedAt: candidate.savedAt,
    layout,
    panes: Object.freeze(panes),
    activePanelId: candidate.activePanelId,
  });
}
