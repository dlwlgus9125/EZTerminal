import type { IDockviewPanelProps } from "dockview-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { createFeatureModuleLoader } from "./feature-loader";
import type { DaemonSnapshot } from "../shared/daemon-protocol";
import {
  attachedChildSessionIds,
  isDaemonSessionArchived,
  isStructuredDaemonAgentSession,
} from "../shared/daemon-session-visibility";
import { rendererCapabilities } from "./capability-access";
import { WorkflowWorkspacePanel, type WorkflowDaemonAccess } from "./workflow/WorkflowWorkspacePanel";
import type { WorkflowAccess } from "../shared/workflow";
import type { WorkflowDraftAccess } from "../shared/workflow-draft";
import type { AgentCapabilitiesClient } from "../shared/agent-capabilities";
import { daemonEventAffectsAgentSessionProjection } from "./daemon-session-events";
import type { PlanningConversation } from "./workflow/workflow-conversations";
import type { WorkflowExecutionAccess } from "./workflow/workflow-execution-access";
import type { PlanningResultReader } from "./PlanningResultDetails";

export interface PlanningNavigation {
  readonly openHistory?: (projectId?: string) => void;
  /** `launch`: run the flow again once it is open (see WorkflowWorkspacePanel). */
  readonly openWorkflow?: (projectId: string, projectName: string, subprojectId: string, nodeId?: string, launch?: boolean, runId?: string) => void;
  readonly openConversation: (id: string, title?: string) => void;
  readonly newConversation: (projectId: string, projectName: string) => void;
  readonly openFiles: (projectId: string) => void;
  readonly openTerminal: (projectId: string, projectName: string) => void;
  readonly openProjects: () => void;
  /** The project board (판), from a subproject's flow. */
  readonly openBoard?: (projectId: string) => void;
  /** Settings › General: start at login and keep running (반복 needs both). */
  readonly openAutomationSettings?: () => void;
  /** Settings › AI › 에이전트, from a workflow's agent list. */
  readonly openAgentSettings?: () => void;
}
export const PlanningNavigationContext =
  createContext<PlanningNavigation | null>(null);
/** The React Flow canvas is a desktop-only lazy chunk; Android and tests never load it. */
const workflowCanvasLoader = createFeatureModuleLoader(
  () => import("./workflow/WorkflowFlowCanvas"),
  (module) => module.WorkflowFlowCanvas,
);
const workflowAccess: WorkflowAccess = {
  getWorkflowSnapshot: projectId => window.ezterminal.getWorkflowSnapshot(projectId),
  executeWorkflowCommand: command => window.ezterminal.executeWorkflowCommand(command),
  workflowPreview: request => window.ezterminal.workflowPreview?.(request) ?? Promise.resolve({ ok: false, message: 'Update the host to use conversational workflow setup.' }),
  // A run moves without a flow revision: the host says when a project's runs changed.
  onWorkflowRunsChanged: listener => window.ezterminal.onWorkflowRunsChanged?.(listener) ?? (() => undefined),
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
/** Run results for the flow screen: the integration result and each attempt's diff, log and capture. */
const readPlanningResult: PlanningResultReader = (query) => window.ezterminal.readPlanningResult(query);
/** The flow screen's execution access: retry a failed independent review in the flow's own scope. */
const workflowExecutionAccess: WorkflowExecutionAccess = {
  getPlanningExecutionSnapshot: (projectId, subprojectId) => window.ezterminal.getPlanningExecutionSnapshot(projectId, subprojectId),
  executePlanningRun: (command) => window.ezterminal.executePlanningRun(command),
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
  // Subagent chats are reached through their parent conversation.
  const subagents = attachedChildSessionIds(snapshot.agentRelations);
  return snapshot.sessions
    .filter(
      (session) =>
        workspaces.has(session.workspaceId) &&
        isStructuredDaemonAgentSession(session) &&
        !subagents.has(session.id) &&
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
  const [conversations, setConversations] = useState<
    readonly PlanningConversation[]
  >([]);
  // A hidden dock tab has no size: the canvas fits and the panel polls only while visible.
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setVisible(props.api.isVisible);
    const disposable = props.api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => disposable.dispose();
  }, [props.api]);
  // A rejected lazy import stays rejected: "다시 불러오기" resets the loader and makes a new component.
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  const FlowCanvas = useMemo(() => {
    void canvasGeneration;
    return workflowCanvasLoader.lazyComponent();
  }, [canvasGeneration]);
  useEffect(() => { void workflowCanvasLoader.preload().catch(() => undefined); }, []);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async (): Promise<void> => {
      const current = ++generation;
      try {
        const snapshot = await rendererCapabilities.daemon.getSnapshot();
        if (disposed || current !== generation) return;
        if (snapshot) setConversations(projectPlanningConversations(snapshot, projectId));
      } catch {
        // The list keeps what it last read; the flow itself reports host failures.
      }
    };
    void refresh();
    const stop = rendererCapabilities.daemon.observeEvents(
      (event) => {
        if (daemonEventAffectsAgentSessionProjection(event)) void refresh();
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [projectId]);
  return (
    <WorkflowWorkspacePanel
      onOpenHistory={navigation?.openHistory ? () => navigation.openHistory?.(projectId) : undefined}
      onOpenAutomationSettings={navigation?.openAutomationSettings}
      onOpenAgentSettings={navigation?.openAgentSettings}
      retentionAccess={window.ezterminal.runRetention}
      templateAccess={window.ezterminal.workflowTemplates}
      projectId={projectId}
      projectName={projectName}
      access={workflowAccess}
      active={visible}
      canvasRenderer={FlowCanvas}
      onReloadCanvas={() => { workflowCanvasLoader.reset(); setCanvasGeneration((current) => current + 1); }}
      readPlanningResult={readPlanningResult}
      executionAccess={workflowExecutionAccess}
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
      navigationTarget={typeof props.params.subprojectId === 'string' ? { subprojectId: props.params.subprojectId, nodeId: props.params.nodeId as string | undefined, key: props.params.workflowNavigationKey as string ?? props.params.subprojectId, ...(props.params.launch === true ? { launch: true } : {}), ...(typeof props.params.runId === 'string' ? { runId: props.params.runId } : {}) } : undefined}
      conversations={conversations}
      onBack={navigation?.openProjects}
      onBoard={navigation?.openBoard ? () => navigation.openBoard!(projectId) : undefined}
      onNewConversation={navigation ? () => navigation.newConversation(projectId, projectName) : undefined}
      onNewTerminal={navigation ? () => navigation.openTerminal(projectId, projectName) : undefined}
      onOpenConversation={navigation ? id => navigation.openConversation(id, conversations.find(item => item.id === id)?.title) : undefined}
    />
  );
}
