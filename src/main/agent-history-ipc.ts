import { gateLocalMutation, gateAbortableLocalMutation } from './local-mutation-ipc';
import { BrowserWindow, dialog } from 'electron';
import type { IpcMainInvokeEvent, MessagePortMain } from 'electron';

import { InterpreterBroker } from './interpreter-broker';

import { AgentHistoryService } from './agent-history-service';

import { LocalMutationIngress, raceLocalOperationWithAbort } from './local-mutation-ingress';

import type {
  AgentLaunchStartRequest,
  AgentLaunchStartResult,
  AgentLaunchTarget,
  AgentProjectLaunchStartRequest,
  AgentProjectLaunchStartResult,
  AgentProjectInput,
  AgentResumeStartRequest,
  AgentResumeStartResult,
  AgentProjectSummary,
} from '../shared/agent-history';
import { cliModelLaunchOptions, isAgentLaunchModel } from '../shared/agent-history';

import { IpcRegistration, type FeatureIpc } from './ipc-registration';

interface InstallAgentHistoryIpcOptions {
  readonly ipc: FeatureIpc;
  readonly agentHistoryReady: Promise<void>;
  readonly agentHistoryService: AgentHistoryService;
  readonly desktopAgentMutationIngress: LocalMutationIngress;
  readonly broker: InterpreterBroker | null;
  readonly directoryKey: (value: string) => string;
  readonly requestAgentResumeWork: (historyId: string, lastActiveAt: number) => Promise<void>;
  readonly agentInfrastructureReady: Promise<void>;
  readonly requestAgentLaunchWork: (target: AgentLaunchTarget, roots: readonly string[], lastActiveAt: number) => Promise<void>;
  readonly isAgentLaunchTarget: (value: unknown) => value is AgentLaunchTarget;
  readonly isBoundedAgentString: (value: unknown, maxLength: number) => value is string;
  readonly isAgentLaunchStartRequest: (value: unknown) => value is AgentLaunchStartRequest;
}

export function installAgentHistoryIpc(dependencies: InstallAgentHistoryIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('agent-history:list-projects', async (
      _event,
      force?: unknown,
      cursor?: unknown,
      limit?: unknown,
      query?: unknown,
    ) => {
      await dependencies.agentHistoryReady;
      return dependencies.agentHistoryService.listProjects(
        force === true,
        typeof cursor === 'string' ? cursor : undefined,
        typeof limit === 'number' ? limit : undefined,
        typeof query === 'string' ? query : undefined,
      );
    });
    ipcMain.handle('agent-history:list-sessions', async (
      _event,
      projectId: unknown,
      cursor?: unknown,
      limit?: unknown,
      force?: unknown,
    ) => {
      await dependencies.agentHistoryReady;
      if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 128) {
        return { items: [], nextCursor: null };
      }
      return dependencies.agentHistoryService.listSessions(
        projectId,
        typeof cursor === 'string' ? cursor : undefined,
        typeof limit === 'number' ? limit : undefined,
        force === true,
      );
    });
    ipcMain.handle('agent-history:read', async (
      _event,
      historyId: unknown,
      cursor?: unknown,
      limit?: unknown,
    ) => {
      await dependencies.agentHistoryReady;
      if (typeof historyId !== 'string' || historyId.length === 0 || historyId.length > 128) return null;
      return dependencies.agentHistoryService.readTranscript(
        historyId,
        typeof cursor === 'string' ? cursor : undefined,
        typeof limit === 'number' ? limit : undefined,
      );
    });
    ipcMain.handle('agent-history:prepare-resume', async (_event, historyId: unknown) => {
      await dependencies.agentHistoryReady;
      if (typeof historyId !== 'string' || historyId.length === 0 || historyId.length > 128) return null;
      return dependencies.agentHistoryService.prepareResume(historyId);
    });
    ipcMain.handle('agent-history:start-resume', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (
      event,
      request: unknown,
    ): Promise<AgentResumeStartResult> => {
      await dependencies.agentHistoryReady;
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return { ok: false, reason: 'invalid' };
      }
      const candidate = request as Partial<AgentResumeStartRequest>;
      if (
        typeof candidate.historyId !== 'string'
        || candidate.historyId.length === 0
        || candidate.historyId.length > 128
        || typeof candidate.sessionId !== 'string'
        || candidate.sessionId.length === 0
        || candidate.sessionId.length > 256
        || typeof candidate.runId !== 'string'
        || candidate.runId.length === 0
        || candidate.runId.length > 256
        || typeof candidate.revision !== 'string'
        || candidate.revision.length === 0
        || candidate.revision.length > 128
        || (candidate.rootChoice !== 'recorded' && candidate.rootChoice !== 'current')
      ) {
        return { ok: false, reason: 'invalid' };
      }
      const resolved = await dependencies.agentHistoryService.resolveResume(
        candidate.historyId,
        candidate.revision,
        candidate.rootChoice,
      );
      if (!resolved.ok) return resolved;
      const session = dependencies.broker?.listSessions().find((item) => item.sessionId === candidate.sessionId);
      if (!session || !resolved.roots[0]
        || dependencies.directoryKey(session.cwd) !== dependencies.directoryKey(resolved.roots[0])) {
        return { ok: false, reason: 'session-mismatch' };
      }
      // The launch line is built by the provider adapter; the provider's session id
      // remains main/interpreter private and renderer frames and shell history
      // receive only the redacted display text.
      const port = dependencies.broker?.runPrivateCommand(
        candidate.sessionId,
        candidate.runId,
        resolved.commandText,
        resolved.displayCommandText,
      );
      if (!port) return { ok: false, reason: 'unavailable' };
      void dependencies.requestAgentResumeWork(candidate.historyId, Date.now())
        .catch((err) => {
          console.error('[main] failed to record resumed Agent project:', err);
        });
      event.sender.postMessage('cmd-port', { runId: candidate.runId }, [port as unknown as MessagePortMain]);
      return { ok: true };
    }));
    ipcMain.handle('agent-projects:list-launchers', async () => {
      await dependencies.agentInfrastructureReady;
      return dependencies.agentHistoryService.listLaunchers();
    });
    const startAgentLaunchInSession = async (
      event: IpcMainInvokeEvent,
      candidate: AgentLaunchStartRequest,
    ): Promise<AgentLaunchStartResult> => {
      const resolved = await dependencies.agentHistoryService.resolveLaunch(
        candidate.target,
        candidate.launcherId,
        candidate.revision,
        cliModelLaunchOptions(candidate.launcherId, candidate.model),
      );
      if (!resolved.ok) return resolved;
      const session = dependencies.broker?.listSessions().find((item) => item.sessionId === candidate.sessionId);
      if (!session || !resolved.roots[0]
        || dependencies.directoryKey(session.cwd) !== dependencies.directoryKey(resolved.roots[0])) {
        return { ok: false, reason: 'session-mismatch' };
      }
      const port = dependencies.broker?.runPrivateCommand(
        candidate.sessionId,
        candidate.runId,
        resolved.commandText,
        resolved.displayCommandText,
      );
      if (!port) return { ok: false, reason: 'unavailable' };
      void dependencies.requestAgentLaunchWork(candidate.target, resolved.roots, Date.now())
        .catch((err) => {
          console.error('[main] failed to record launched Agent project:', err);
        });
      event.sender.postMessage('cmd-port', { runId: candidate.runId }, [port as unknown as MessagePortMain]);
      return { ok: true };
    };
    ipcMain.handle('agent-launch:prepare', async (
      _event,
      target: unknown,
      launcherId: unknown,
      model?: unknown,
    ) => {
      await Promise.all([dependencies.agentHistoryReady, dependencies.agentInfrastructureReady]);
      if (!dependencies.isAgentLaunchTarget(target) || !dependencies.isBoundedAgentString(launcherId, 128) || !isAgentLaunchModel(launcherId, model)) {
        return { ok: false, reason: 'invalid' };
      }
      return dependencies.agentHistoryService.prepareLaunch(target, launcherId, cliModelLaunchOptions(launcherId, model as string | undefined));
    });
    ipcMain.handle('agent-launch:start', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (
      event,
      request: unknown,
    ): Promise<AgentLaunchStartResult> => {
      await Promise.all([dependencies.agentHistoryReady, dependencies.agentInfrastructureReady]);
      return dependencies.isAgentLaunchStartRequest(request)
        ? startAgentLaunchInSession(event, request)
        : { ok: false, reason: 'invalid' };
    }));
    ipcMain.handle('agent-projects:prepare-launch', async (
      _event,
      projectId: unknown,
      launcherId: unknown,
    ) => {
      await Promise.all([dependencies.agentHistoryReady, dependencies.agentInfrastructureReady]);
      if (
        typeof projectId !== 'string'
        || projectId.length === 0
        || projectId.length > 128
        || typeof launcherId !== 'string'
        || launcherId.length === 0
        || launcherId.length > 128
      ) {
        return { ok: false, reason: 'invalid' };
      }
      return dependencies.agentHistoryService.prepareProjectLaunch(projectId, launcherId);
    });
    ipcMain.handle('agent-projects:start-launch', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (
      event,
      request: unknown,
    ): Promise<AgentProjectLaunchStartResult> => {
      await Promise.all([dependencies.agentHistoryReady, dependencies.agentInfrastructureReady]);
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        return { ok: false, reason: 'invalid' };
      }
      const candidate = request as Partial<AgentProjectLaunchStartRequest>;
      if (
        typeof candidate.projectId !== 'string'
        || candidate.projectId.length === 0
        || candidate.projectId.length > 128
        || typeof candidate.launcherId !== 'string'
        || candidate.launcherId.length === 0
        || candidate.launcherId.length > 128
        || typeof candidate.sessionId !== 'string'
        || candidate.sessionId.length === 0
        || candidate.sessionId.length > 256
        || typeof candidate.runId !== 'string'
        || candidate.runId.length === 0
        || candidate.runId.length > 256
        || typeof candidate.revision !== 'string'
        || candidate.revision.length === 0
        || candidate.revision.length > 128
      ) {
        return { ok: false, reason: 'invalid' };
      }
      return startAgentLaunchInSession(event, {
        target: { kind: 'project', projectId: candidate.projectId },
        launcherId: candidate.launcherId,
        sessionId: candidate.sessionId,
        runId: candidate.runId,
        revision: candidate.revision,
      });
    }));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}

interface InstallAgentProjectsIpcOptions {
  readonly ipc: FeatureIpc;
  readonly desktopAgentMutationIngress: LocalMutationIngress;
  readonly requestAgentProjectSave: (input: AgentProjectInput) => Promise<{ readonly ok: false; readonly reason: "invalid" | "not-found" | "duplicate"; } | { readonly ok: true; readonly project: AgentProjectSummary; }>;
  readonly requestAgentProjectRemoval: (projectId: unknown) => Promise<boolean>;
  readonly mainWindowRef: BrowserWindow | null;
}

export function installAgentProjectsIpc(dependencies: InstallAgentProjectsIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('agent-projects:save', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, reason: 'invalid' };
      }
      try {
        return await dependencies.requestAgentProjectSave(input as AgentProjectInput);
      } catch (error) {
        console.error('[main] saved Agent Project daemon sync failed:', error);
        return { ok: false, reason: 'invalid' } as const;
      }
    }));
    ipcMain.handle('agent-projects:remove', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, projectId: unknown) => {
      try {
        return await dependencies.requestAgentProjectRemoval(projectId);
      } catch (error) {
        console.error('[main] Agent Project daemon revocation failed:', error);
        return false;
      }
    }));
    ipcMain.handle('agent-projects:select-folders', gateAbortableLocalMutation(dependencies.desktopAgentMutationIngress, async (signal, event, multiple?: unknown) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? dependencies.mainWindowRef ?? undefined;
      const options: Electron.OpenDialogOptions = {
        title: 'Select project folders',
        properties: ['openDirectory', ...(multiple === false ? [] : ['multiSelections' as const])],
      };
      let result: Electron.OpenDialogReturnValue;
      try {
        result = await raceLocalOperationWithAbort(
          owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
          signal,
        );
      } catch (error) {
        if (signal.aborted) return { canceled: true, paths: [] } as const;
        throw error;
      }
      return { canceled: result.canceled, paths: result.canceled ? [] : result.filePaths };
    }));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
