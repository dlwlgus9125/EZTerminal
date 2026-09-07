import type { IpcMainInvokeEvent, MessagePortMain } from 'electron';
import type { RunStartedInfo } from '../shared/ipc';
import { MAX_GUARDED_DESTROY_RUN_IDS } from '../shared/ipc';
import {
  isSessionSurfaceCloseDecisions,
  isSessionSurfaceCloseEntries,
  isSessionSurfaceId,
  isSessionSurfaceIntent,
} from '../shared/session-surface';
import { InterpreterBroker } from './interpreter-broker';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { SessionSurfaceAuthority } from './session-surface-authority';

interface InstallSessionSurfaceIpcOptions {
  readonly ipc: FeatureIpc;
  readonly resolveDesktopSessionPrincipal: (event: IpcMainInvokeEvent, clientInstanceId: unknown) => string | null;
  readonly sessionSurfaceAuthority: SessionSurfaceAuthority | null;
  readonly broker: InterpreterBroker | null;
}

export function installSessionSurfaceIpc(dependencies: InstallSessionSurfaceIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    // Session surfaces are the only renderer-facing session lifecycle API. Main
    // derives the principal from the exact WebContents + preload generation; a
    // renderer can never present another client's host-issued binding capability.
    ipcMain.handle(
      'session-surface:open',
      (
        event,
        clientInstanceId: unknown,
        surfaceId: unknown,
        intent: unknown,
      ) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (!principalId || !isSessionSurfaceId(surfaceId) || !isSessionSurfaceIntent(intent)) {
          return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
        }
        return dependencies.sessionSurfaceAuthority!.openSessionSurface(principalId, surfaceId, intent);
      },
    );
    ipcMain.handle(
      'session-surface:prepare-close',
      (event, clientInstanceId: unknown, entries: unknown) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (!principalId || !isSessionSurfaceCloseEntries(entries)) {
          return { ok: false as const, reason: 'state-changed' as const };
        }
        return dependencies.sessionSurfaceAuthority!.prepareSessionSurfaceClose(principalId, entries);
      },
    );
    ipcMain.handle(
      'session-surface:commit-close',
      (
        event,
        clientInstanceId: unknown,
        closeToken: unknown,
        decisions: unknown,
      ) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (
          !principalId
          || !isSessionSurfaceId(closeToken)
          || !isSessionSurfaceCloseDecisions(decisions)
        ) {
          return Promise.resolve({ ok: false as const, reason: 'state-changed' as const });
        }
        return dependencies.sessionSurfaceAuthority!.commitSessionSurfaceClose(
          principalId,
          closeToken,
          decisions,
        );
      },
    );
    ipcMain.handle(
      'session-surface:release',
      (event, clientInstanceId: unknown, bindingId: unknown) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (!principalId || !isSessionSurfaceId(bindingId)) {
          return { ok: false as const, reason: 'state-changed' as const };
        }
        return dependencies.sessionSurfaceAuthority!.releaseSessionSurface(principalId, bindingId);
      },
    );
    ipcMain.handle(
      'session-surface:terminate',
      (
        event,
        clientInstanceId: unknown,
        sessionId: unknown,
        expectedActiveRunIds: unknown,
      ) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (
          !principalId
          || !isSessionSurfaceId(sessionId)
          || !Array.isArray(expectedActiveRunIds)
          || expectedActiveRunIds.length > MAX_GUARDED_DESTROY_RUN_IDS
          || expectedActiveRunIds.some((runId) => !isSessionSurfaceId(runId))
        ) {
          return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
        }
        return dependencies.sessionSurfaceAuthority!.terminateSessionGuarded(
          sessionId,
          expectedActiveRunIds,
        );
      },
    );

    // ── Session mirroring (M2: full mirroring across desktop tabs + mobile) ──
    // list-sessions is a straight passthrough to the broker's directory;
    // session-added/session-removed/run-started fan out to every desktop window
    // via the broker subscriptions wired at broker construction. remote-bridge.ts
    // subscribes to the SAME broker independently for its own WS fan-out (T2.1).
    ipcMain.handle('list-sessions', () => dependencies.broker?.listSessions() ?? []);
    // list-runs (M1 mirror-active-runs): resolves `[]` immediately if there's no
    // broker/interpreter (mirrors create-session's own guard) — there are no runs
    // to report either way, so there is nothing to await.
    ipcMain.handle('list-runs', (): Promise<readonly RunStartedInfo[]> =>
      dependencies.broker ? dependencies.broker.listRuns() : Promise.resolve([]),
    );

    // attach-run (T2.2f): brokers a NON-INITIATING port onto an existing run's
    // ExecutionSession — mirrors the run-command handler in createWindow()
    // exactly (broker mints a fresh port pair, port2 to the interpreter, port1 to
    // THIS event's sender), except it never starts a new run (canRun/session-
    // registry are untouched — attach is view+input, not a second writer).
    ipcMain.on('attach-run', (event, payload: { sessionId: string; runId: string; }) => {
      if (!dependencies.broker) return;
      const port1 = dependencies.broker.attachRun(payload.sessionId, payload.runId);
      if (!port1) return;
      event.sender.postMessage('attach-port', { runId: payload.runId }, [port1 as unknown as MessagePortMain]);
    });
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
