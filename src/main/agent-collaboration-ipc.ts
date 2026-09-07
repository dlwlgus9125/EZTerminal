import { gateLocalMutation, gateAbortableLocalMutation } from './local-mutation-ipc';
import { BrowserWindow, dialog } from 'electron';
import type { AgentDecisionResult } from '../shared/agent';
import type { InstallAgentAdapterInput } from '../shared/agent-adapter';
import {
  EMPTY_AGENT_COORDINATION_SNAPSHOT,
  type AgentParticipantInput,
  type AgentProjectCoordinationInput,
  type ManagedMergeDecisionInput,
  type ManagedMergeGrantInput,
} from '../shared/agent-coordination';
import type { CollaborationPolicyInput } from '../shared/agent-orchestration';
import { AgentActivityService } from './agent-activity-service';
import { AgentAdapterService } from './agent-adapter-service';
import { AgentCliShim } from './agent-cli-shim';
import { AgentControlServer } from './agent-control-server';
import { AgentCoordinationService } from './agent-coordination-service';
import { AgentHookInstaller } from './agent-hook-installer';
import { isAgentIntegrationProvider } from './agent-hook-relay';
import { AgentOrchestrationService } from './agent-orchestration-service';
import { AgentOrchestrationStore } from './agent-orchestration-store';
import { AgentSettingsStore } from './agent-settings-store';
import { InterpreterBroker } from './interpreter-broker';
import { IpcRegistration, type FeatureIpc } from './ipc-registration';
import { LocalMutationIngress, raceLocalOperationWithAbort } from './local-mutation-ingress';
import { ManagedMergeService } from './managed-merge-service';

interface InstallAgentCollaborationIpcOptions {
  readonly ipc: FeatureIpc;
  readonly agentActivityService: AgentActivityService | null;
  readonly agentCoordinationService: AgentCoordinationService | null;
  readonly agentOrchestrationReady: Promise<void>;
  readonly agentOrchestrationService: AgentOrchestrationService | null;
  readonly agentOrchestrationStore: AgentOrchestrationStore;
  readonly desktopAgentMutationIngress: LocalMutationIngress;
  readonly agentAdapterReady: Promise<void>;
  readonly agentAdapterService: AgentAdapterService;
  readonly mainWindowRef: BrowserWindow | null;
  readonly agentControlServer: AgentControlServer | null;
  readonly broker: InterpreterBroker | null;
  readonly agentCliShim: AgentCliShim;
  readonly managedMergeService: ManagedMergeService | null;
}

export function installAgentCollaborationIpc(dependencies: InstallAgentCollaborationIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('agents:get-snapshot', () => dependencies.agentActivityService?.getSnapshot() ?? { revision: 0, items: [] });
    ipcMain.handle('agents:get-coordination-snapshot', () => (
      dependencies.agentCoordinationService?.getSnapshot() ?? EMPTY_AGENT_COORDINATION_SNAPSHOT
    ));
    ipcMain.handle('agents:get-orchestration-snapshot', async () => {
      await dependencies.agentOrchestrationReady;
      return dependencies.agentOrchestrationService?.getSnapshot() ?? {
        revision: 0,
        providers: [],
        profiles: [],
        policies: [],
        runs: [],
        events: [],
        migration: dependencies.agentOrchestrationStore.migrationStatus,
      };
    });
    ipcMain.handle('agents:save-collaboration-policy', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, input: unknown) => {
      await dependencies.agentOrchestrationReady;
      if (!dependencies.agentOrchestrationService || typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, error: 'invalid', message: 'Invalid collaboration policy.' } as const;
      }
      return dependencies.agentOrchestrationService.savePolicy(input as CollaborationPolicyInput);
    }));
    ipcMain.handle('agents:confirm-team-migration', gateLocalMutation(dependencies.desktopAgentMutationIngress, async () => {
      await dependencies.agentOrchestrationReady;
      return dependencies.agentOrchestrationService?.confirmLegacyMigration() ?? dependencies.agentOrchestrationStore.migrationStatus;
    }));
    ipcMain.handle('agents:cancel-worker', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, runId: unknown, taskId: unknown) => {
      if (!dependencies.agentOrchestrationService || typeof runId !== 'string' || typeof taskId !== 'string') {
        return { ok: false, error: 'invalid', message: 'Invalid worker cancellation.' } as const;
      }
      const run = dependencies.agentOrchestrationStore.getRun(runId);
      const lead = run ? dependencies.agentActivityService?.getSnapshot().items.find((item) => item.id === run.leadActivityId) : undefined;
      return lead
        ? dependencies.agentOrchestrationService.cancelWorker(lead, taskId)
        : { ok: false, error: 'not-found', message: 'Lead session is unavailable.' } as const;
    }));
    ipcMain.handle('agents:archive-worker', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, runId: unknown, taskId: unknown) => {
      if (!dependencies.agentOrchestrationService || typeof runId !== 'string' || typeof taskId !== 'string') {
        return { ok: false, error: 'invalid', message: 'Invalid worker archive request.' } as const;
      }
      const run = dependencies.agentOrchestrationStore.getRun(runId);
      const lead = run ? dependencies.agentActivityService?.getSnapshot().items.find((item) => item.id === run.leadActivityId) : undefined;
      return lead
        ? dependencies.agentOrchestrationService.archiveWorker(lead, taskId)
        : { ok: false, error: 'not-found', message: 'Lead session is unavailable.' } as const;
    }));
    ipcMain.handle('agents:stop-orchestration-run', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, runId: unknown) => {
      if (!dependencies.agentOrchestrationService || typeof runId !== 'string') {
        return { ok: false, error: 'invalid', message: 'Invalid Lead run.' } as const;
      }
      const run = dependencies.agentOrchestrationStore.getRun(runId);
      const lead = run ? dependencies.agentActivityService?.getSnapshot().items.find((item) => item.id === run.leadActivityId) : undefined;
      return lead
        ? dependencies.agentOrchestrationService.stopRun(lead, runId)
        : { ok: false, error: 'not-found', message: 'Lead session is unavailable.' } as const;
    }));
    ipcMain.handle('agents:get-adapter-snapshot', async () => {
      await dependencies.agentAdapterReady;
      return dependencies.agentAdapterService.getSnapshot();
    });
    ipcMain.handle('agents:select-adapter-bundle', gateAbortableLocalMutation(dependencies.desktopAgentMutationIngress, async (signal, event) => {
      await raceLocalOperationWithAbort(dependencies.agentAdapterReady, signal);
      signal.throwIfAborted();
      const owner = BrowserWindow.fromWebContents(event.sender) ?? dependencies.mainWindowRef ?? undefined;
      const options: OpenDialogOptions = {
        title: 'Install an Agent adapter',
        properties: ['openFile'],
        filters: [{ name: 'EZTerminal Agent adapter', extensions: ['ezadapter'] }],
      };
      let selected: Electron.OpenDialogReturnValue;
      try {
        selected = await raceLocalOperationWithAbort(
          owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options),
          signal,
        );
      } catch (error) {
        if (signal.aborted) return null;
        throw error;
      }
      const archivePath = selected.filePaths[0];
      return selected.canceled || !archivePath ? null : dependencies.agentAdapterService.inspect(archivePath);
    }));
    ipcMain.handle('agents:install-adapter', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, input: unknown) => {
      await dependencies.agentAdapterReady;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, error: 'invalid', message: 'Invalid adapter installation request.' } as const;
      }
      return dependencies.agentAdapterService.install(input as InstallAgentAdapterInput);
    }));
    ipcMain.handle('agents:set-adapter-enabled', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, adapterId: unknown, enabled: unknown) => {
      await dependencies.agentAdapterReady;
      if (typeof adapterId !== 'string' || typeof enabled !== 'boolean') {
        return { ok: false, error: 'invalid', message: 'Invalid adapter state request.' } as const;
      }
      return dependencies.agentAdapterService.setEnabled(adapterId, enabled);
    }));
    ipcMain.handle('agents:remove-adapter', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, adapterId: unknown) => {
      await dependencies.agentAdapterReady;
      if (typeof adapterId !== 'string') {
        return { ok: false, error: 'invalid', message: 'Invalid adapter removal request.' } as const;
      }
      return dependencies.agentAdapterService.remove(adapterId);
    }));
    ipcMain.handle('agents:join-collaboration', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input) || !dependencies.agentCoordinationService) {
        return { ok: false, error: 'invalid', message: 'Invalid collaboration request.' } as const;
      }
      const result = await dependencies.agentCoordinationService.join(input as AgentParticipantInput);
      if (result.ok && dependencies.agentControlServer && dependencies.broker) {
        const descriptor = dependencies.agentControlServer.descriptorForSession(result.value.participant.sessionId);
        dependencies.broker.setPrivateSessionEnvironment(result.value.participant.sessionId, {
          EZTERMINAL_AGENT_CONTROL_DESCRIPTOR: descriptor,
          PATH: dependencies.agentCliShim.prependToPath(process.env.PATH),
        });
      }
      return result;
    }));
    ipcMain.handle('agents:leave-collaboration', gateLocalMutation(dependencies.desktopAgentMutationIngress, (_event, activityId: unknown) => {
      if (typeof activityId !== 'string' || !dependencies.agentCoordinationService) return false;
      return dependencies.agentCoordinationService.leave(activityId);
    }));
    ipcMain.handle('agents:save-coordination-project', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input) || !dependencies.agentCoordinationService) {
        return { ok: false, error: 'invalid', message: 'Invalid Project coordination settings.' } as const;
      }
      return dependencies.agentCoordinationService.saveProject(input as AgentProjectCoordinationInput);
    }));
    ipcMain.handle('agents:mark-seen', gateLocalMutation(dependencies.desktopAgentMutationIngress, (_event, activityId: unknown, stateSeq: unknown) => (
      typeof activityId === 'string'
      && typeof stateSeq === 'number'
      && Number.isSafeInteger(stateSeq)
      && dependencies.agentCoordinationService?.markSeen(activityId, stateSeq) === true
    )));
    ipcMain.handle('agents:prompt', gateAbortableLocalMutation(dependencies.desktopAgentMutationIngress, (
      signal,
      _event,
      activityId: unknown,
      text: unknown,
      options?: unknown,
    ) => {
      const validOptions = options === undefined || (
        typeof options === 'object'
        && options !== null
        && !Array.isArray(options)
        && Object.keys(options).every((key) => key === 'whenReady')
        && (
          (options as { readonly whenReady?: unknown; }).whenReady === undefined
          || typeof (options as { readonly whenReady?: unknown; }).whenReady === 'boolean'
        )
      );
      if (
        typeof activityId !== 'string'
        || typeof text !== 'string'
        || !validOptions
        || !dependencies.agentActivityService
      ) {
        return { ok: false, error: 'invalid-text' } as const;
      }
      const whenReady = (options as { readonly whenReady?: boolean; } | undefined)?.whenReady === true;
      if (whenReady) {
        return dependencies.agentCoordinationService?.prompt(activityId, text, { whenReady: true, signal })
          ?? { ok: false, error: 'not-found' } as const;
      }
      return dependencies.agentActivityService.sendPrompt(activityId, text);
    }));
    ipcMain.handle('agents:request-managed-merge', gateLocalMutation(dependencies.desktopAgentMutationIngress, (_event, activityId: unknown, targetBranch: unknown) => {
      if (typeof activityId !== 'string' || typeof targetBranch !== 'string' || !dependencies.managedMergeService) {
        return { ok: false, error: 'invalid', message: 'Invalid managed merge request.' } as const;
      }
      return dependencies.managedMergeService.requestForActivity(activityId, targetBranch);
    }));
    ipcMain.handle('agents:decide-managed-merge', gateLocalMutation(dependencies.desktopAgentMutationIngress, (_event, input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input) || !dependencies.managedMergeService) {
        return { ok: false, error: 'invalid', message: 'Invalid managed merge decision.' } as const;
      }
      return dependencies.managedMergeService.decide({
        ...(input as ManagedMergeDecisionInput),
        actor: 'desktop',
      });
    }));
    ipcMain.handle('agents:grant-next-managed-merge', gateLocalMutation(dependencies.desktopAgentMutationIngress, (_event, input: unknown) => {
      if (typeof input !== 'object' || input === null || Array.isArray(input) || !dependencies.managedMergeService) {
        return { ok: false, error: 'invalid', message: 'Invalid one-shot merge grant.' } as const;
      }
      return dependencies.managedMergeService.grantNext(input as ManagedMergeGrantInput);
    }));
    ipcMain.handle('agents:get-managed-merge-diff', gateLocalMutation(dependencies.desktopAgentMutationIngress, (_event, requestId: unknown, revision: unknown) => {
      if (
        typeof requestId !== 'string'
        || typeof revision !== 'number'
        || !Number.isSafeInteger(revision)
        || !dependencies.managedMergeService
      ) return { ok: false, error: 'git-failed' } as const;
      return dependencies.managedMergeService.readCandidateDiff(requestId, revision);
    }));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}

interface InstallAgentActionsIpcOptions {
  readonly ipc: FeatureIpc;
  readonly desktopAgentMutationIngress: LocalMutationIngress;
  readonly agentActivityService: AgentActivityService | null;
  readonly agentInfrastructureReady: Promise<void>;
  readonly agentHookInstaller: AgentHookInstaller;
  readonly agentRelayReady: boolean;
  readonly refreshAgentLauncherCapabilities: () => Promise<void>;
  readonly agentSettingsStore: AgentSettingsStore;
}

export function installAgentActionsIpc(dependencies: InstallAgentActionsIpcOptions): () => void {
  const ipcMain = new IpcRegistration(dependencies.ipc);
  try {
    ipcMain.handle('agents:decide', gateLocalMutation(dependencies.desktopAgentMutationIngress, (
      _event,
      activityId: unknown,
      approvalId: unknown,
      decision: unknown,
    ): AgentDecisionResult => {
      if (
        typeof activityId !== 'string'
        || activityId.length < 1
        || activityId.length > 128
        || typeof approvalId !== 'string'
        || approvalId.length < 1
        || approvalId.length > 128
        || (decision !== 'allow' && decision !== 'deny')
      ) {
        return { ok: false, error: 'not-found' };
      }
      return dependencies.agentActivityService?.decideApproval(activityId, approvalId, decision)
        ?? { ok: false, error: 'not-found' };
    }));
    ipcMain.handle('agents:list-integrations', async () => {
      await dependencies.agentInfrastructureReady;
      return dependencies.agentHookInstaller.list();
    });
    ipcMain.handle('agents:set-integration-enabled', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, provider: unknown, enabled: unknown) => {
      await dependencies.agentInfrastructureReady;
      if (!isAgentIntegrationProvider(provider) || typeof enabled !== 'boolean') {
        throw new Error('invalid agent integration request');
      }
      if (enabled && !dependencies.agentRelayReady) {
        return {
          ok: false,
          error: 'io-error',
          message: 'The local agent hook relay is unavailable; no hook configuration was changed.',
          status: await dependencies.agentHookInstaller.status(provider),
        } as const;
      }
      const result = await dependencies.agentHookInstaller.mutate(provider, enabled);
      await dependencies.refreshAgentLauncherCapabilities();
      return result;
    }));
    ipcMain.handle('agents:get-settings', async () => {
      await dependencies.agentInfrastructureReady;
      return dependencies.agentSettingsStore.get();
    });
    ipcMain.handle('agents:set-settings', gateLocalMutation(dependencies.desktopAgentMutationIngress, async (_event, settings: unknown) => {
      await dependencies.agentInfrastructureReady;
      const saved = await dependencies.agentSettingsStore.set(settings);
      if (saved) dependencies.agentActivityService?.applySettings(saved);
      return saved;
    }));
  } catch (error) {
    ipcMain.dispose();
    throw error;
  }
  return ipcMain.dispose;
}
import type { OpenDialogOptions } from 'electron';
