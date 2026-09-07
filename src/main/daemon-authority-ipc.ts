import type { IpcMainInvokeEvent, WebContents } from 'electron';

import { isSessionSurfaceId } from '../shared/session-surface';

import { synchronizeDaemonLifecycleAuthority, type DaemonLifecycleSettings } from './daemon-lifecycle-settings';
import { DaemonRuntime } from './daemon-runtime';

import { DaemonCommandRouter } from './daemon-command-router';

import { DaemonAutomationRuntime } from './daemon-automation-runtime';

import type { DaemonCommandReceipt } from '../shared/daemon-protocol';
import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';

import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface InstallDaemonAuthorityIpcOptions {
  readonly ipc: FeatureIpc;
  readonly daemonRuntimeReady: Promise<DaemonLifecycleSettings>;
  readonly daemonRuntime: DaemonRuntime | null;
  readonly daemonAvailabilityReady: Promise<DaemonAuthorityAvailability>;
  readonly daemonAuthorityReady: Promise<DaemonCommandRouter>;
  readonly daemonCommandRouter: DaemonCommandRouter;
  readonly daemonAutomationRuntime: DaemonAutomationRuntime;
  readonly resolveDesktopSessionPrincipal: (event: IpcMainInvokeEvent, clientInstanceId: unknown) => string | null;
  readonly daemonProjectsReady: Promise<void>;
  readonly setDaemonEventSubscription: (sender: WebContents, subscribed: boolean) => void;
}

export function installDaemonAuthorityIpc(dependencies: InstallDaemonAuthorityIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('settings:get-daemon-lifecycle', async () => {
      await dependencies.daemonRuntimeReady;
      return dependencies.daemonRuntime!.settingsSnapshot();
    });
    ipcMain.handle('settings:set-daemon-lifecycle', async (_event, value: unknown) => {
      await dependencies.daemonRuntimeReady;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid daemon lifecycle settings.');
      }
      const candidate = value as Record<string, unknown>;
      if (
        Object.keys(candidate).some((key) => key !== 'keepRunning' && key !== 'startAtLogin')
        || ('keepRunning' in candidate && typeof candidate.keepRunning !== 'boolean')
        || ('startAtLogin' in candidate && typeof candidate.startAtLogin !== 'boolean')
      ) {
        throw new Error('Invalid daemon lifecycle settings.');
      }
      const lifecycle = await dependencies.daemonRuntime!.updateSettings({
        ...('keepRunning' in candidate ? { keepRunning: candidate.keepRunning as boolean } : {}),
        ...('startAtLogin' in candidate ? { startAtLogin: candidate.startAtLogin as boolean } : {}),
      });
      await synchronizeDaemonLifecycleAuthority(lifecycle, {
        availability: await dependencies.daemonAvailabilityReady,
        authorityReady: dependencies.daemonAuthorityReady,
        getCurrent: () => dependencies.daemonCommandRouter.getSnapshot().runtime,
        apply: async (settings) => {
          await dependencies.daemonCommandRouter.applySystemCommit({
            mutations: [{
              kind: 'runtime.update',
              value: {
                keepRunning: settings.keepRunning,
                startAtLogin: settings.startAtLogin,
              },
            }],
          });
        },
        notifyChanged: () => dependencies.daemonAutomationRuntime.notifyAuthorityChanged(),
      });
      return lifecycle;
    });
    const rejectedDaemonCommand = (
      value: unknown,
      message: string,
      code: 'unauthorized' | 'internal-error' = 'unauthorized',
      details?: Readonly<Record<string, unknown>>,
    ): DaemonCommandReceipt => ({
      ok: false,
      status: 'rejected',
      commandId: (
        typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && typeof (value as { commandId?: unknown; }).commandId === 'string'
      ) ? (value as { commandId: string; }).commandId : 'invalid-command',
      revision: (() => {
        try {
          return dependencies.daemonCommandRouter.getSnapshot().revision;
        } catch {
          return 0;
        }
      })(),
      error: { code, message, retryable: false, ...(details ? { details } : {}) },
    });
    ipcMain.handle('daemon:get-availability', async (event, clientInstanceId: unknown) => {
      const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (!principalId) return null;
      return dependencies.daemonAvailabilityReady;
    });
    ipcMain.handle('daemon:get-snapshot', async (event, clientInstanceId: unknown) => {
      const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (!principalId) return null;
      try {
        await Promise.all([dependencies.daemonAuthorityReady, dependencies.daemonProjectsReady]);
        return dependencies.daemonCommandRouter.getSnapshot();
      } catch {
        return null;
      }
    });
    ipcMain.handle(
      'daemon:get-transcript',
      async (
        event,
        clientInstanceId: unknown,
        sessionId: unknown,
        afterSequence: unknown,
        limit: unknown,
      ) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (
          !principalId
          || !isSessionSurfaceId(sessionId)
          || !Number.isSafeInteger(afterSequence)
          || (afterSequence as number) < 0
          || !Number.isSafeInteger(limit)
          || (limit as number) < 1
          || (limit as number) > 2_000
        ) return [];
        try {
          await dependencies.daemonAuthorityReady;
          return dependencies.daemonCommandRouter.getTranscript(
            sessionId,
            afterSequence as number,
            limit as number,
          );
        } catch {
          return [];
        }
      },
    );
    ipcMain.handle('daemon:command', async (event, clientInstanceId: unknown, value: unknown) => {
      const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
      if (!principalId) return rejectedDaemonCommand(value, 'Desktop daemon authority is unavailable.');
      try {
        await Promise.all([dependencies.daemonAuthorityReady, dependencies.daemonProjectsReady]);
      } catch {
        const availability = await dependencies.daemonAvailabilityReady;
        return rejectedDaemonCommand(
          value,
          availability.state === 'legacy-only-safe-mode'
            ? 'Structured Agent authority is unavailable in terminal-only safe mode.'
            : 'The daemon store could not be initialized.',
          'internal-error',
          { availability },
        );
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return dependencies.daemonCommandRouter.execute(value);
      }
      return dependencies.daemonCommandRouter.execute({
        ...(value as Record<string, unknown>),
        principal: { kind: 'desktop', id: principalId },
      });
    });
    ipcMain.handle(
      'daemon:set-events-subscribed',
      async (event, clientInstanceId: unknown, subscribed: unknown) => {
        const principalId = dependencies.resolveDesktopSessionPrincipal(event, clientInstanceId);
        if (!principalId || typeof subscribed !== 'boolean') return;
        const availability = await dependencies.daemonAvailabilityReady;
        if (availability.state !== 'ready') {
          dependencies.setDaemonEventSubscription(event.sender, false);
          return;
        }
        await dependencies.daemonAuthorityReady;
        dependencies.setDaemonEventSubscription(event.sender, subscribed);
      },
    );
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
