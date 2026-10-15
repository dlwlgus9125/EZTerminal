import type { IDockviewPanelProps } from "dockview-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { DaemonSnapshot } from "../shared/daemon-protocol";
import {
  isDaemonSessionArchived,
  isStructuredDaemonAgentSession,
} from "../shared/daemon-session-visibility";
import { rendererCapabilities } from "./capability-access";
import { desktopPlanningDraftStorage } from "./planning-draft-state";
import type { PlanningExecutionAccess } from "./PlanningExecutionPanel";
import type { PlanningAssetApi } from "../shared/planning-asset";
import type { ProjectArchiveAccess } from "./ProjectArchivePanel";
import type { PlanningAiAccess } from "./planning/PlanningAiPanel";
import { WorkflowWorkspacePanel, type WorkflowDaemonAccess } from "./workflow/WorkflowWorkspacePanel";
import type { WorkflowAccess } from "../shared/workflow";
import type { WorkflowDraftAccess } from "../shared/workflow-draft";
import type { AgentCapabilitiesClient } from "../shared/agent-capabilities";
import { daemonEventAffectsAgentSessionProjection } from "./DaemonAgentSessions";
import {
  PlanningWorkspacePanel,
  type PlanningConversation,
  type PlanningWorkspaceAccess,
  type PlanningWorkspaceSection,
} from "./PlanningWorkspacePanel";

export interface PlanningNavigation {
  readonly openHistory?: (projectId?: string) => void;
  readonly openWorkflow?: (projectId: string, projectName: string, subprojectId: string, nodeId?: string) => void;
  readonly openConversation: (id: string, title?: string) => void;
  readonly newConversation: (projectId: string, projectName: string) => void;
  readonly openFiles: (projectId: string) => void;
  readonly openTerminal: (projectId: string, projectName: string) => void;
  readonly openProjects: () => void;
}
export const PlanningNavigationContext =
  createContext<PlanningNavigation | null>(null);
const access: PlanningWorkspaceAccess = {
  getPlanningSnapshot: (projectId, subprojectId) =>
    window.ezterminal.getPlanningSnapshot(projectId, subprojectId),
  executePlanningCommand: (command) =>
    window.ezterminal.executePlanningCommand(command),
};
const workflowAccess: WorkflowAccess = {
  getWorkflowSnapshot: projectId => window.ezterminal.getWorkflowSnapshot(projectId),
  executeWorkflowCommand: command => window.ezterminal.executeWorkflowCommand(command),
  workflowPreview: request => window.ezterminal.workflowPreview?.(request) ?? Promise.resolve({ ok: false, message: 'Update the host to use conversational workflow setup.' }),
};
const workflowDaemonAccess: WorkflowDaemonAccess = {
  getDaemonSnapshot: () => rendererCapabilities.daemon.getSnapshot(),
  sendDaemonCommand: command => rendererCapabilities.daemon.sendCommand(command),
  listDaemonProviderModels: providerId => window.ezterminal.listDaemonProviderModels(providerId),
};
const workflowRecoveryAccess: WorkflowDraftAccess = {
  workflowDraftRead: projectId => window.ezterminal.workflowDraftRead(projectId),
  workflowDraftWrite: (projectId, request) => window.ezterminal.workflowDraftWrite(projectId, request),
};
const workflowCapabilityClient: AgentCapabilitiesClient = {
  list: request => window.ezterminal.agentCapabilitiesList(request),
  manage: request => window.ezterminal.agentCapabilitiesManage(request),
};
const executionAccess: PlanningExecutionAccess = {
  readPlanningResult: (query) => window.ezterminal.readPlanningResult(query),
  getPlanningExecutionSnapshot: (projectId) =>
    window.ezterminal.getPlanningExecutionSnapshot(projectId),
  executePlanningRun: (command) =>
    window.ezterminal.executePlanningRun(command),
  getDaemonSnapshot: () => window.ezterminal.getDaemonSnapshot(),
  listDaemonProviderModels: (providerId) =>
    window.ezterminal.listDaemonProviderModels(providerId),
};
const assetApi: PlanningAssetApi = {
  executePlanningAsset: (request) =>
    window.ezterminal.executePlanningAsset(request),
};
const archiveAccess: ProjectArchiveAccess = {
  executeProjectArchive: (request) =>
    window.ezterminal.executeProjectArchive(request),
};
const aiAccess: PlanningAiAccess = {
  planningAiRequest: (request) => window.ezterminal.planningAiRequest(request),
  getDaemonSnapshot: () => window.ezterminal.getDaemonSnapshot(),
  listDaemonProviderModels: (providerId) =>
    window.ezterminal.listDaemonProviderModels(providerId),
};

export function projectPlanningConversations(
  snapshot: DaemonSnapshot,
  projectId: string,
): readonly PlanningConversation[] {
  const agents = new Map(
    snapshot.agents.map((agent) => [agent.sessionId, agent]),
  );
  const workspaces = new Map(
    snapshot.workspaces
      .filter(
        (workspace) =>
          workspace.projectId === projectId && !workspace.archivedAt,
      )
      .map((workspace) => [workspace.id, workspace]),
  );
  const providers = new Map(
    snapshot.providers.map((provider) => [provider.id, provider.displayName]),
  );
  return snapshot.sessions
    .filter(
      (session) =>
        workspaces.has(session.workspaceId) &&
        isStructuredDaemonAgentSession(session) &&
        !isDaemonSessionArchived(session, agents.get(session.id)),
    )
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    .map((session) => {
      const agent = agents.get(session.id);
      return {
        id: session.id,
        title: session.title,
        status: agent?.state ?? session.state,
        providerLabel: agent
          ? (providers.get(agent.providerId) ?? agent.providerId)
          : undefined,
        workspaceLabel: workspaces.get(session.workspaceId)?.name,
      };
    });
}

export function PlanningWorkspaceDockPanel(
  props: IDockviewPanelProps,
): JSX.Element {
  const navigation = useContext(PlanningNavigationContext);
  const projectId =
    typeof props.params.projectId === "string" ? props.params.projectId : "";
  const projectName =
    typeof props.params.projectName === "string"
      ? props.params.projectName
      : projectId;
  const draftStores = useMemo(
    () => ({ projectId, stores: new Map<string, ReturnType<typeof desktopPlanningDraftStorage>>() }),
    [projectId],
  ).stores;
  const [conversations, setConversations] = useState<
    readonly PlanningConversation[]
  >([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async (): Promise<void> => {
      const current = ++generation;
      try {
        const snapshot = await rendererCapabilities.daemon.getSnapshot();
        if (disposed || current !== generation) return;
        if (snapshot) {
          setConversations(projectPlanningConversations(snapshot, projectId));
          setError(undefined);
        }
      } catch (reason) {
        if (!disposed && current === generation) setError(String(reason));
      }
    };
    void refresh();
    const stop = rendererCapabilities.daemon.observeEvents(
      (event) => {
        if (daemonEventAffectsAgentSessionProjection(event)) void refresh();
      },
      (reason) => {
        if (!disposed) setError(String(reason));
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [projectId]);
  return (
    <WorkflowWorkspacePanel
      onOpenHistory={navigation?.openHistory ? () => navigation.openHistory?.(projectId) : undefined}
      projectId={projectId}
      projectName={projectName}
      access={workflowAccess}
      daemonAccess={workflowDaemonAccess}
      capabilityClient={workflowCapabilityClient}
      recoveryAccess={workflowRecoveryAccess}
      onSeedConversationDraft={async (sessionId, draft) => {
        const scope = { projectId, sessionId };
        const saved = await window.ezterminal.chatStateRead(scope);
        if (!saved.ok) throw new Error(saved.message);
        if (saved.snapshot.state.draft.text && saved.snapshot.state.draft.text !== draft.text) throw new Error('A draft already exists in this conversation. It was preserved.');
        const written = await window.ezterminal.chatStateWrite(scope, { expectedRevision: saved.snapshot.revision, state: { ...saved.snapshot.state, draft } });
        if (!written.ok) throw new Error(written.message);
      }}
      navigationTarget={typeof props.params.subprojectId === 'string' ? { subprojectId: props.params.subprojectId, nodeId: props.params.nodeId as string | undefined, key: props.params.workflowNavigationKey as string ?? props.params.subprojectId } : undefined}
      conversations={conversations}
      onBack={navigation?.openProjects}
      onNewConversation={navigation ? () => navigation.newConversation(projectId, projectName) : undefined}
      onNewTerminal={navigation ? () => navigation.openTerminal(projectId, projectName) : undefined}
      onOpenConversation={navigation ? id => navigation.openConversation(id, conversations.find(item => item.id === id)?.title) : undefined}
      renderPlanning={(subproject, section, runId) => {
        const key = subproject?.id ?? '';
        if (!draftStores.has(key)) draftStores.set(key, desktopPlanningDraftStorage(projectId, subproject?.id));
        return <PlanningWorkspacePanel
      projectId={projectId}
      projectName={subproject?.title ?? projectName}
      subprojectId={subproject?.id}
      access={access}
      draftStorage={draftStores.get(key)}
      executionAccess={executionAccess}
      assetApi={assetApi}
      archiveAccess={archiveAccess}
      aiAccess={aiAccess}
      initialSection={
        section ?? props.params.section as PlanningWorkspaceSection | undefined
      }
      initialRunId={runId}
      conversations={conversations}
      conversationError={error}
      onBack={navigation?.openProjects}
      onNewConversation={
        navigation
          ? () => navigation.newConversation(projectId, projectName)
          : undefined
      }
      onOpenConversation={
        navigation
          ? (id) =>
              navigation.openConversation(
                id,
                conversations.find((item) => item.id === id)?.title,
              )
          : undefined
      }
      onOpenFiles={
        navigation ? () => navigation.openFiles(projectId) : undefined
      }
      onOpenTerminal={
        navigation
          ? () => navigation.openTerminal(projectId, projectName)
          : undefined
      }
    />;
      }}
    />
  );
}
