import { useCallback, useEffect, useMemo, useRef } from 'react';

import { type DockviewApi } from 'dockview-react';
import { buildLayoutEnvelope } from '../shared/layout-schema';
import {
  RENDERER_RECOVERY_MAX_ACTIVE_RUNS,
  RENDERER_RECOVERY_MAX_HISTORY,
  RENDERER_RECOVERY_VERSION,
  type RendererRecoveryCheckpoint,
  type RendererRecoveryStructuredAgentCreate,
} from '../shared/renderer-recovery';

import {
  structuredAgentCreateCheckpointRecords,
  StructuredAgentCreateRecoveryRegistry,
} from './structured-agent-create-recovery';

import { listPaneSnapshots } from './pane-registry';

import type { MutableRefObject } from 'react';

function buildRendererRecoveryCheckpoint(
  api: DockviewApi,
  structuredAgentCreates: readonly RendererRecoveryStructuredAgentCreate[],
): RendererRecoveryCheckpoint | null {
  const rawLayout = structuredClone(api.toJSON()) as unknown as Record<string, unknown>;
  // Cwd/adoption are forbidden in durable layouts. The volatile checkpoint
  // stores them in its bounded pane section, so keep its layout equally clean.
  if (typeof rawLayout.panels === 'object' && rawLayout.panels !== null) {
    for (const panel of Object.values(rawLayout.panels as Record<string, unknown>)) {
      if (typeof panel !== 'object' || panel === null) continue;
      const record = panel as Record<string, unknown>;
      if (record.contentComponent !== 'terminal') continue;
      const params = typeof record.params === 'object' && record.params !== null
        ? record.params as Record<string, unknown>
        : null;
      if (params?.projectSession) record.params = { projectSession: params.projectSession };
      else delete record.params;
    }
  }
  const savedAt = Date.now();
  const layout = buildLayoutEnvelope(rawLayout, new Date(savedAt).toISOString());
  if (!layout) return null;
  const panelIds = new Set(Object.keys(layout.layout.panels));
  const panelBoundStructuredAgentCreates = structuredAgentCreateCheckpointRecords(
    structuredAgentCreates,
    panelIds,
  );
  if (!panelBoundStructuredAgentCreates) return null;
  const panes = listPaneSnapshots()
    .filter((pane) => panelIds.has(pane.panelId))
    .map((pane) => {
      const hasRecoverableSurface = Boolean(pane.sessionId && pane.sessionSurfaceId);
      return Object.freeze({
        panelId: pane.panelId,
        sessionId: hasRecoverableSurface ? pane.sessionId : null,
        sessionSurfaceId: hasRecoverableSurface ? pane.sessionSurfaceId : null,
        cwd: pane.cwd.slice(0, 4096),
        history: Object.freeze(
          pane.history.slice(-RENDERER_RECOVERY_MAX_HISTORY).map((entry) => entry.slice(0, 8192)),
        ),
        draft: pane.draft.slice(0, 64 * 1024),
        activeRunIds: Object.freeze(
          pane.activeRunIds.slice(0, RENDERER_RECOVERY_MAX_ACTIVE_RUNS),
        ),
        scrollTop: Math.max(0, Number.isFinite(pane.scrollTop) ? pane.scrollTop : 0),
      });
    });
  return Object.freeze({
    version: RENDERER_RECOVERY_VERSION,
    savedAt,
    layout,
    panes: Object.freeze(panes),
    structuredAgentCreates: Object.freeze(panelBoundStructuredAgentCreates),
    activePanelId: api.activePanel?.id ?? null,
  });
}

/** Volatile recovery checkpoints and the subscriptions/timer that maintain them. */
export function useRendererRecovery(
  apiRef: MutableRefObject<DockviewApi | null>,
  structuredAgentCreateRecoveryRegistry: StructuredAgentCreateRecoveryRegistry,
) {
  const recoveryLayoutSubscriptionRef = useRef<{ dispose(): void; } | null>(null);
  const recoverySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeRendererRecoveryCheckpoint = useCallback(async (): Promise<RendererRecoveryCheckpoint | null> => {
    recoverySaveTimerRef.current = null;
    const api = apiRef.current;
    const desktop = window.ezterminalDesktop;
    if (!api || !desktop) return null;
    const checkpoint = buildRendererRecoveryCheckpoint(
      api,
      structuredAgentCreateRecoveryRegistry.list(),
    );
    if (!checkpoint) return null;
    const saved = await desktop.saveRendererRecoveryCheckpoint(checkpoint).catch(() => false);
    return saved ? checkpoint : null;
  }, [apiRef, structuredAgentCreateRecoveryRegistry]);

  const structuredAgentCreateRecoveryValue = useMemo(
    () => ({
      registry: structuredAgentCreateRecoveryRegistry,
      persistBeforeSend: async () => (await writeRendererRecoveryCheckpoint()) !== null,
    }),
    [structuredAgentCreateRecoveryRegistry, writeRendererRecoveryCheckpoint],
  );

  const scheduleRendererRecoveryCheckpoint = useCallback((): void => {
    if (recoverySaveTimerRef.current !== null) clearTimeout(recoverySaveTimerRef.current);
    recoverySaveTimerRef.current = setTimeout(() => {
      void writeRendererRecoveryCheckpoint();
    }, 300);
  }, [writeRendererRecoveryCheckpoint]);

  useEffect(() => structuredAgentCreateRecoveryRegistry.subscribe(() => {
    // Create-envelope escrow changes are sparse and safety-critical. Save them
    // immediately rather than sharing the ordinary 300 ms layout debounce.
    void writeRendererRecoveryCheckpoint();
  }), [structuredAgentCreateRecoveryRegistry, writeRendererRecoveryCheckpoint]);

  const attachRecoveryLayout = useCallback((api: DockviewApi): void => {
    recoveryLayoutSubscriptionRef.current?.dispose();
    const recoveryLayoutChanged = api.onDidLayoutChange(scheduleRendererRecoveryCheckpoint);
    const recoveryActiveChanged = api.onDidActivePanelChange(scheduleRendererRecoveryCheckpoint);
    recoveryLayoutSubscriptionRef.current = {
      dispose: () => {
        recoveryLayoutChanged.dispose();
        recoveryActiveChanged.dispose();
      },
    };

  }, [scheduleRendererRecoveryCheckpoint]);
  const flushRendererRecoveryCheckpoint = useCallback(() => {
    if (recoverySaveTimerRef.current !== null) {
      clearTimeout(recoverySaveTimerRef.current);
      recoverySaveTimerRef.current = null;
    }
    return writeRendererRecoveryCheckpoint();
  }, [writeRendererRecoveryCheckpoint]);
  useEffect(() => () => {
    recoveryLayoutSubscriptionRef.current?.dispose();
    recoveryLayoutSubscriptionRef.current = null;
    if (recoverySaveTimerRef.current !== null) clearTimeout(recoverySaveTimerRef.current);
    recoverySaveTimerRef.current = null;
    delete (window as Window & {
      __ezRendererRecoveryFlush?: () => Promise<RendererRecoveryCheckpoint | null>;
    }).__ezRendererRecoveryFlush;
  }, []);
  return {
    structuredAgentCreateRecoveryValue,
    scheduleRendererRecoveryCheckpoint,
    attachRecoveryLayout,
    flushRendererRecoveryCheckpoint,
  };
}
