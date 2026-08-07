import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { X } from 'lucide-react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';

import {
  type LayoutEnvelope,
  type TerminalRendererPreference,
  type ThemeName,
} from '../shared/layout-schema';
import {
  EMPTY_AGENT_ACTIVITY_SNAPSHOT,
  type AgentActivitySnapshot,
  type AgentDecision,
  type AgentDecisionResult,
  type AgentIntegrationStatus,
  type AgentStatus,
  type GenericAgentProfile,
} from '../shared/agent';
import type { FilePreviewResult } from '../shared/file-preview';
import type { SessionInfo } from '../shared/ipc';
import type { AuxiliaryCloseRequest } from '../shared/desktop-window';
import type {
  AgentHistorySessionSummary,
  AgentLaunchBootstrap,
  AgentProjectSummary,
} from '../shared/agent-history';
import type { ThemeMod } from '../shared/theme-schema';
import {
  DEFAULT_TERMINAL_PASTE_PREFERENCES,
  type TerminalPastePreferences,
  type TerminalPasteRisk,
} from '../shared/terminal-clipboard';
import { type QuickCommand, type QuickCommandInput, type QuickCommandMutationResult } from '../shared/quick-command';
import { quoteEzArgument } from '../shared/quote-ez-argument';
import type { CloseRisk } from '../shared/close-risk';
import { WORKSPACE_FILE_SEARCH_DEBOUNCE_MS } from '../shared/workspace-search';
import { isAppUpdateAvailable } from '../shared/app-update';
import { AgentHub, countAgentAttention } from './AgentHub';
import {
  AuxiliaryCloseDialog,
  type AuxiliaryCloseChoice,
} from './AuxiliaryCloseDialog';
import { peekAgentTerminalBootstrap } from './agent-terminal-bootstrap';
import { AgentSessionPanel } from './AgentSessionPanel';
import { EFFECT_CATALOG, type EffectId } from './effects';
import {
  DEFAULT_INTERFERENCE_PARAMS,
  DEFAULT_ROLLBAR_PARAMS,
  applyInterferenceParams,
  applyRollbarParams,
  clampInterferenceParams,
  clampRollbarParams,
  type InterferenceParams,
  type RollbarParams,
} from './effect-params';
import { ExplorerWorkbench } from './ExplorerWorkbench';
import { ProjectEditorPanel } from './ProjectEditorPanel';
import {
  projectEditorDocumentParametersEqual,
  projectEditorDocumentPathKey,
  projectEditorDocumentsEqual,
  projectEditorTitle,
  type ProjectEditorDocument,
} from './project-editor-model';
import type { ProjectExplorerState } from './ProjectWorkspacePanel';
import {
  flushProjectCodeFocus,
  requestProjectCodeFocus,
  requestProjectCodeReveal,
  type ProjectCodeLocation,
} from './project-code-navigation';
import {
  projectRelativeReviewHint,
} from './project-diff-navigation';
import {
  applyProjectReviewLayout,
  captureProjectReviewLayout,
  restoreProjectReviewLayout,
  type ProjectReviewLayoutSnapshot,
} from './project-review-layout';
import { FileDropOverlay } from './FileDropOverlay';
import { subsequenceMatch } from './fuzzy';
import { useAppTranslation } from './i18n';
import { OpenClawChatPanel, OpenClawOverlayContext } from './OpenClawChatPanel';
import { OpenClawPanel } from './OpenClawPanel';
import { OpenClawVisibilitySeedLatch } from './openclaw-visibility-seed';
import {
  QuickOpenModal,
  type QuickCommandManageResult,
  type QuickCommandManagerConfig,
  type QuickOpenActionVariant,
  type QuickOpenMode,
  type QuickOpenRow,
} from './QuickOpenModal';
import { RichFileViewerOverlay } from './RichFileViewerOverlay';
import { RemoteControlBanner, useRemoteDesktopHostStatus } from './RemoteDesktopStatusCard';
import { RecentPanelSwitcher, type RecentPanelSwitcherItem } from './RecentPanelSwitcher';
import { PaneHeaderMeta } from './PaneHeaderMeta';
import { RiskyCloseDialog } from './RiskyCloseDialog';
import { SettingsPanel, type SettingsCategory } from './SettingsPanel';
import { StatusPanel } from './StatusPanel';
import { TerminalPane, type PaneApproval } from './TerminalPane';
import { TerminalPasteWarningDialog } from './TerminalPasteWarningDialog';
import { agentHistoryTabTitle, WorkspaceTab } from './WorkspaceTab';
import {
  preflightLayoutEnvelope,
  removePanelFromLayoutEnvelope,
} from './layout-preflight';
import {
  SessionMirroringCoordinator,
  type PaneInstanceToken,
  type SessionPaneLease,
} from './session-mirroring-coordinator';
import { applyThemeVarsAndEffects, setUserFontId, themeModToDefinition } from './theme-runtime';
import { THEME_ORDER, THEMES, listThemes, registerTheme, type ThemeDefinition } from './themes';
import { applyScrollback, clampScrollback, SCROLLBACK_DEFAULT } from './scrollback';
import { applyUiScale, clampUiScale, UI_SCALE_DEFAULT } from './ui-scale';
import { useUiPreferences } from './ui-preferences';
import { rendererCapabilities } from './capability-access';
import {
  auxiliaryPopoutUrl,
  isDetachablePanel,
  installDockviewPopoutBehavior,
} from './dockview-popouts';
import { addAppWindowEventListener } from './desktop-window-registry';
import { useAppUpdate } from './use-app-update';
import {
  buildCommandCenterActionRows,
  type QuickOpenBuiltinAction,
} from './command-center-actions';
import { commandCenterShortcutMode } from './command-center-shortcut';
import { useToast } from './ui';
import type { TerminalNoticeKind } from './terminal-paste';
import {
  ActivityRail,
  AppHeader,
  RemotePanel,
  SidebarShell,
  StatusBar,
  WorkspaceBar,
  WorkspaceMenu,
  useSidebarReflow,
  type SidebarDestination,
} from './workbench';
import {
  getPaneHandle,
  listPaneSnapshots,
  subscribePaneRegistry,
  type PaneActionFailure,
  type PaneActionResult,
} from './pane-registry';
import {
  PaneLifecycleCoordinator,
  type PaneDisposition,
  type PaneLifecycleTarget,
  type PreparedPaneLifecycle,
} from './pane-lifecycle-coordinator';
import {
  installRecentPanelKeybindings,
  type RecentPanelSwitchSession,
} from './recent-panel-switching';
import {
  WorkbenchCoordinator,
  createDockviewWorkbenchAdapter,
  type LayoutTransactionOptions,
  type WorkbenchPanelPosition,
} from './workbench-coordinator';
import { WorkspaceReplacementCoordinator } from './workspace-replacement-coordinator';
import { applyWorkbenchLayoutPreset, type WorkbenchLayoutPreset } from './workbench-layout-presets';
import { DEFAULT_TERMINAL_RUNTIME_OPTIONS, type TerminalRuntimeOptions } from './xterm-runtime';

// Desktop's per-effect default-on state (App.tsx's `applyTheme`/`onToggleEffect`
// platformDefaults): mirrors the effect catalog's own guidance exactly, so a
// theme's declared effects (e.g. Matrix's scanlines+phosphor-glow) are ON by
// default on desktop unless the user has explicitly toggled one off.
const DESKTOP_EFFECT_DEFAULTS = Object.fromEntries(
  Object.values(EFFECT_CATALOG).map((entry) => [entry.id, entry.defaultOn]),
) as Record<EffectId, boolean>;

const CLOSE_RISK_I18N_KEY = {
  'ssh-prompt': 'safetyDialog.risks.sshPrompt',
  'active-agent': 'safetyDialog.risks.activeAgent',
  'ssh-active': 'safetyDialog.risks.sshActive',
  'running-command': 'safetyDialog.risks.runningCommand',
  unknown: 'safetyDialog.risks.unknown',
} as const satisfies Readonly<Record<CloseRisk, string>>;

// App is the dockview host: one TerminalPane per tab or split pane. Each pane holds an
// authority-issued session-surface binding. Panes are created programmatically —
// tabs via addPanel (no position), splits via addPanel with a `position` (a new grid
// group). Mouse drag-to-split / drag-rearrange is enabled; only detached floating windows
// are disabled (disableFloatingGroups). A drag MOVES the existing panel node, so the
// TerminalPane/session/PTY survive the move (dockview re-parents, never remounts). Panels
// render with `renderer: 'always'` so a hidden pane stays MOUNTED (visibility:hidden, not
// unmounted) — its live PTY/xterm survives (Codex B7 / dockview docs).

// C6 sessionId-report channel: TerminalPanel is dockview's registered component
// (module-scoped, outside App's closure), so it can't otherwise reach App's
// Session pane lifecycle leases — a context bridges TerminalPanel to App without
// threading them through dockview panel `params` (which must stay JSON-
// serializable for `saveLayout`'s api.toJSON(), so a function value can't live
// there).
interface SessionBindingContextValue {
  readonly mountPane: (
    panelId: string,
    instanceToken: PaneInstanceToken,
    initialCwd?: string,
    requestedAdoptSessionId?: string,
  ) => SessionPaneLease;
}
const SessionBindingContext = createContext<SessionBindingContextValue | null>(null);

const AgentTabStatusContext = createContext<ReadonlyMap<string, AgentStatus>>(new Map());

interface PaneApprovalContextValue {
  readonly byPanel: ReadonlyMap<string, PaneApproval>;
  readonly onDecide: (
    activityId: string,
    approvalId: string,
    decision: AgentDecision,
  ) => Promise<AgentDecisionResult>;
}

const PaneApprovalContext = createContext<PaneApprovalContextValue | null>(null);
const TerminalRuntimeContext = createContext<TerminalRuntimeOptions>(DEFAULT_TERMINAL_RUNTIME_OPTIONS);
interface ProjectReviewNavigationContextValue {
  readonly openHistoryReview: (
    projectId: string,
    rootId: string,
    workspaceId: string,
    historyId: string,
    reviewTurnId: string,
    changedPath?: string,
  ) => void;
}
const ProjectReviewNavigationContext = createContext<ProjectReviewNavigationContextValue | null>(null);
interface PresetMutationContextValue {
  readonly locked: boolean;
  readonly isLocked: () => boolean;
}
const PresetMutationContext = createContext<PresetMutationContextValue>({
  locked: false,
  isLocked: () => false,
});

interface QuickCommandShelfContextValue {
  readonly commands: readonly QuickCommand[];
  readonly onManage: () => void;
}
const QuickCommandShelfContext = createContext<QuickCommandShelfContextValue | null>(null);

interface WorkspaceTabActionContextValue {
  readonly split: (panelId: string, direction: 'right' | 'below') => void;
  readonly titleChanged: () => void;
}
const WorkspaceTabActionContext = createContext<WorkspaceTabActionContextValue>({
  split: () => undefined,
  titleChanged: () => undefined,
});

interface PaneCloseContextValue {
  requestPanelClose(
    panelId: string,
    component: string,
    instanceToken: object,
    close: () => void,
  ): void;
}
const PaneCloseContext = createContext<PaneCloseContextValue | null>(null);

interface CloseDialogState {
  readonly title: string;
  readonly description: string;
  readonly details?: readonly string[];
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  /** Optional middle course between cancelling and destroying. Only offered
   * where the work can genuinely outlive the pane. */
  readonly alternateLabel?: string;
  readonly onAlternate?: () => void;
}

interface AuxiliaryCloseDialogState {
  readonly request: AuxiliaryCloseRequest;
  readonly targetWindow: Window;
  readonly plan: PreparedPaneLifecycle;
  readonly busy: boolean;
}

interface PendingPasteConfirmation {
  readonly risk: TerminalPasteRisk;
  readonly resolve: (confirmed: boolean) => void;
}

function AgentAwareTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const statuses = useContext(AgentTabStatusContext);
  const closeContext = useContext(PaneCloseContext);
  const actions = useContext(WorkspaceTabActionContext);
  const status = statuses.get(props.api.id);
  return (
    <WorkspaceTab
      {...props}
      status={status}
      requestClose={(close) => {
        if (closeContext) {
          closeContext.requestPanelClose(props.api.id, props.api.component, props.api, close);
        } else close();
      }}
      onSplit={actions.split}
      onTitleChanged={actions.titleChanged}
    />
  );
}

// The dockview panel content. On becoming visible again, broadcast a refit so the
// pane's xterm re-fits: a visibility:hidden panel keeps its layout size, so xterm's
// ResizeObserver does NOT fire on show — an explicit nudge is required (Codex B7).
function TerminalPanel(props: IDockviewPanelProps): JSX.Element {
  useEffect(() => {
    const disposable = props.api.onDidVisibilityChange((event) => {
      if (event.isVisible) {
        requestAnimationFrame(() => window.dispatchEvent(new Event('ez:refit')));
      }
    });
    return () => disposable.dispose();
  }, [props.api]);
  const binding = useContext(SessionBindingContext);
  const terminalRuntimeOptions = useContext(TerminalRuntimeContext);
  const presetMutation = useContext(PresetMutationContext);
  const quickCommandShelf = useContext(QuickCommandShelfContext);
  const paneApprovals = useContext(PaneApprovalContext);
  return (
    <TerminalPane
      panelId={props.api.id}
      pendingApproval={paneApprovals?.byPanel.get(props.api.id)}
      onDecideApproval={paneApprovals?.onDecide}
      paneInstanceToken={props.api}
      initialCwd={props.params?.cwd as string | undefined}
      agentBootstrap={peekAgentTerminalBootstrap(props.api.id)}
      adoptSessionId={props.params?.adoptSessionId as string | undefined}
      mountSessionPane={binding?.mountPane}
      terminalRuntimeOptions={terminalRuntimeOptions}
      commandSubmissionLocked={presetMutation.locked}
      isCommandSubmissionLocked={presetMutation.isLocked}
      quickCommands={quickCommandShelf?.commands}
      onManageQuickCommands={quickCommandShelf?.onManage}
    />
  );
}

function AgentSessionDockPanel(props: IDockviewPanelProps): JSX.Element {
  const historyId = typeof props.params?.historyId === 'string'
    ? props.params.historyId
    : '';
  const projectId = typeof props.params?.projectId === 'string'
    ? props.params.projectId
    : '';
  const rootId = typeof props.params?.rootId === 'string'
    ? props.params.rootId
    : '';
  const workspaceId = typeof props.params?.workspaceId === 'string'
    ? props.params.workspaceId
    : '';
  const binding = useContext(SessionBindingContext);
  const projectReviewNavigation = useContext(ProjectReviewNavigationContext);
  const terminalRuntimeOptions = useContext(TerminalRuntimeContext);
  const presetMutation = useContext(PresetMutationContext);
  const quickCommandShelf = useContext(QuickCommandShelfContext);
  const paneApprovals = useContext(PaneApprovalContext);
  return (
    <AgentSessionPanel
      historyId={historyId}
      onOpenReview={projectId && rootId && workspaceId && projectReviewNavigation
        ? (reviewTurnId, changedPath) => projectReviewNavigation.openHistoryReview(
          projectId,
          rootId,
          workspaceId,
          historyId,
          reviewTurnId,
          changedPath,
        )
        : undefined}
      renderTerminal={(resumeBootstrap, onFailure) => (
        <TerminalPane
          panelId={props.api.id}
          pendingApproval={paneApprovals?.byPanel.get(props.api.id)}
          onDecideApproval={paneApprovals?.onDecide}
          paneInstanceToken={props.api}
          resumeBootstrap={resumeBootstrap}
          onAgentBootstrapFailure={onFailure}
          // Providers without a "run in this directory" flag resolve their
          // session store from the process cwd, so the resumed shell has to
          // start in the project root.
          initialCwd={resumeBootstrap.cwd}
          mountSessionPane={binding?.mountPane}
          terminalRuntimeOptions={terminalRuntimeOptions}
          commandSubmissionLocked={presetMutation.locked}
          isCommandSubmissionLocked={presetMutation.isLocked}
          quickCommands={quickCommandShelf?.commands}
          onManageQuickCommands={quickCommandShelf?.onManage}
        />
      )}
    />
  );
}

const components = {
  terminal: TerminalPanel,
  'openclaw-chat': OpenClawChatPanel,
  'agent-session': AgentSessionDockPanel,
  'project-editor': ProjectEditorPanel,
};

type OpenStateUpdate = boolean | ((open: boolean) => boolean);

type QuickOpenTarget =
  | { readonly type: 'pane'; readonly panelId: string }
  | { readonly type: 'file'; readonly path: string }
  | { readonly type: 'command'; readonly command: string }
  | { readonly type: 'action'; readonly action: QuickOpenBuiltinAction }
  | { readonly type: 'preset'; readonly name: string }
  | { readonly type: 'background-session'; readonly sessionId: string };

type AppQuickOpenRow = QuickOpenRow & { readonly target: QuickOpenTarget };

interface QuickOpenFilePreview {
  readonly path: string;
  readonly result: FilePreviewResult;
  readonly line?: number;
  readonly column?: number;
}

interface AgentLauncher {
  readonly id: string;
  readonly title: string;
  readonly command: string;
  readonly detail: string;
  readonly sourceLabel: string;
}

function recentDistinctCommands(history: readonly string[]): string[] {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const command = history[index] ?? '';
    const key = command.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recent.push(command);
  }
  return recent;
}

function workspaceFilePath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/';
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, '');
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

/** Pick the startup layout: a named preset when configured, else the last
 * layout, falling back from a missing preset to the last layout (never fails
 * hard — a null return means "open the default single pane"). */
async function pickStartupLayout(): Promise<LayoutEnvelope | null> {
  const ez = window.ezterminal;
  const startup = await ez.getStartup();
  if (startup.mode === 'preset' && startup.presetName) {
    const preset = await ez.getPreset(startup.presetName);
    if (preset) return preset;
  }
  return ez.loadLayout();
}

export function App(): JSX.Element {
  const { i18n, t } = useAppTranslation();
  const { pushToast } = useToast();
  const remoteDesktopStatus = useRemoteDesktopHostStatus();
  const appUpdateController = useAppUpdate();
  const appUpdateAvailable = isAppUpdateAvailable(appUpdateController.snapshot);
  const paneActionMessage = useCallback(
    (result: PaneActionResult): string | null => {
      if (result.ok) return null;
      const messages: Record<PaneActionFailure, string> = {
        unavailable: t('commandCenter.paneFailure.unavailable'),
        busy: t('commandCenter.paneFailure.busy'),
        dead: t('commandCenter.paneFailure.dead'),
        'draft-not-empty': t('commandCenter.paneFailure.draftNotEmpty'),
        'not-pty': t('commandCenter.paneFailure.notPty'),
        empty: t('commandCenter.paneFailure.empty'),
      };
      return messages[result.reason];
    },
    [t],
  );
  const quickCommandManageResult = useCallback(
    (result: QuickCommandMutationResult): QuickCommandManageResult => {
      if (result.ok) return { ok: true };
      const message = t(`quickCommands.errors.${result.error}`);
      return {
        ok: false,
        message,
        ...(result.error === 'duplicate-name' ? { fieldErrors: { name: message } } : {}),
      };
    },
    [t],
  );
  const { preferences: uiPreferences, updatePreferences } = useUiPreferences();
  const sidebarReflow = useSidebarReflow();
  const projectWide = useSidebarReflow('(min-width: 1024px)');
  const apiRef = useRef<DockviewApi | null>(null);
  const activeAgentSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const popoutBehaviorRef = useRef<{ dispose(): void } | null>(null);
  const sessionMirroringConnectionRef = useRef<(() => void) | null>(null);
  const paneLifecycleCoordinatorRef = useRef<PaneLifecycleCoordinator | null>(null);
  if (paneLifecycleCoordinatorRef.current === null) {
    paneLifecycleCoordinatorRef.current = new PaneLifecycleCoordinator({
      getPaneHandle,
      prepareSessionSurfaceClose: (entries) =>
        window.ezterminal.prepareSessionSurfaceClose(entries),
      commitSessionSurfaceClose: (closeToken, decisions) =>
        window.ezterminal.commitSessionSurfaceClose(closeToken, decisions),
    });
  }
  const paneLifecycleCoordinator = paneLifecycleCoordinatorRef.current;
  const [closeDialog, setCloseDialog] = useState<CloseDialogState | null>(null);
  const [auxiliaryCloseDialog, setAuxiliaryCloseDialog] =
    useState<AuxiliaryCloseDialogState | null>(null);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectWorkspaceStates, setProjectWorkspaceStates] = useState<Readonly<Record<string, ProjectExplorerState>>>({});
  const projectDrillActive = activeProjectId !== null;
  const projectReviewLayoutRef = useRef<ProjectReviewLayoutSnapshot | null>(null);
  const [recentPanelSwitch, setRecentPanelSwitch] = useState<RecentPanelSwitchSession | null>(null);
  const sessionMirroringCoordinatorRef = useRef<SessionMirroringCoordinator | null>(null);
  const workbenchCoordinatorRef = useRef<WorkbenchCoordinator | null>(null);
  if (workbenchCoordinatorRef.current === null) {
    workbenchCoordinatorRef.current = new WorkbenchCoordinator({
      persistence: {
        saveLayout: (layout) => window.ezterminal.saveLayout(layout),
        flushLayout: () => window.ezterminal.flushLayout(),
        quarantineLayout: () => window.ezterminal.quarantineLayout(),
      },
      // Construction is cyclic only at the callback boundary: the workbench
      // exists first, then its mirroring owner is installed in the same render.
      // Fail closed if a call somehow arrives inside that narrow interval.
      isPaneCreationLocked: () =>
        sessionMirroringCoordinatorRef.current?.getSnapshot().replacementLocked ?? true,
      onActivePanelChange: (panelId, source) => {
        setActivePanelId(panelId);
        setPaneCount(apiRef.current?.panels.length ?? 0);
        if (source !== 'activation') return;
        requestAnimationFrame(() => {
          const activeTab =
            document.querySelector('.ez-dock .dv-active-group .dv-tab.dv-active-tab') ??
            document.querySelector('.ez-dock .dv-tab.dv-active-tab');
          activeTab?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
        });
      },
      onRecentPanelSwitchChange: setRecentPanelSwitch,
      focusPane: (panelId) => {
        const pane = getPaneHandle(panelId);
        if (!pane) return false;
        pane.focus();
        return true;
      },
      onError: (message, error) => console.error(`[renderer] ${message}:`, error),
    });
  }
  const workbenchCoordinator = workbenchCoordinatorRef.current;
  if (sessionMirroringCoordinatorRef.current === null) {
    sessionMirroringCoordinatorRef.current = new SessionMirroringCoordinator({
      workbench: workbenchCoordinator,
      onSessionAdded: (listener) =>
        window.ezterminal?.onSessionAdded?.(listener) ?? (() => undefined),
      onSessionRemoved: (listener) =>
        window.ezterminal?.onSessionRemoved?.(listener) ?? (() => undefined),
      releaseSessionSurface: (bindingId) => window.ezterminal.releaseSessionSurface(bindingId),
      onError: (message, error) => console.error(`[renderer] ${message}:`, error),
    });
  }
  const sessionMirroringCoordinator = sessionMirroringCoordinatorRef.current;
  const sessionMirroringSnapshot = useSyncExternalStore(
    sessionMirroringCoordinator.subscribe,
    sessionMirroringCoordinator.getSnapshot,
  );
  const sessionPaneBindings = sessionMirroringSnapshot.bindingsBySession;
  const workspaceReplacementCoordinatorRef =
    useRef<WorkspaceReplacementCoordinator | null>(null);
  if (workspaceReplacementCoordinatorRef.current === null) {
    workspaceReplacementCoordinatorRef.current = new WorkspaceReplacementCoordinator({
      listPaneSnapshots,
      getActiveAgentSessionIds: () => activeAgentSessionIdsRef.current,
      prepareSessionSurfaceClose: (entries) =>
        window.ezterminal.prepareSessionSurfaceClose(entries),
      commitSessionSurfaceClose: (closeToken, decisions) =>
        window.ezterminal.commitSessionSurfaceClose(closeToken, decisions),
      loadPreset: (presetName) => window.ezterminal.getPreset(presetName),
      preflightLayout: preflightLayoutEnvelope,
      replaceLayout: (envelope, authorize) =>
        workbenchCoordinator.replaceWorkspaceLayout(envelope, authorize),
      acquireLease: () => sessionMirroringCoordinator.acquireWorkspaceReplacementLease(),
      onError: (message, error) => console.error(`[renderer] ${message}:`, error),
    });
  }
  const workspaceReplacementCoordinator = workspaceReplacementCoordinatorRef.current;
  useEffect(
    () => () => {
      sessionMirroringConnectionRef.current?.();
      sessionMirroringConnectionRef.current = null;
      popoutBehaviorRef.current?.dispose();
      popoutBehaviorRef.current = null;
      workbenchCoordinator.detach();
      apiRef.current = null;
    },
    [sessionMirroringCoordinator, workbenchCoordinator],
  );
  const presetMutationValue = useMemo<PresetMutationContextValue>(
    () => ({
      locked: sessionMirroringSnapshot.replacementLocked,
      isLocked: () => sessionMirroringCoordinator.getSnapshot().replacementLocked,
    }),
    [sessionMirroringCoordinator, sessionMirroringSnapshot.replacementLocked],
  );
  const [quickPreview, setQuickPreview] = useState<QuickOpenFilePreview | null>(null);
  const quickPreviewSequenceRef = useRef(0);
  const [confirmRiskyPaneClose, setConfirmRiskyPaneClose] = useState(true);
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getConfirmRiskyPaneClose().then((enabled) => {
      if (alive) setConfirmRiskyPaneClose(enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeConfirmRiskyPaneClose = useCallback((enabled: boolean): void => {
    setConfirmRiskyPaneClose(enabled);
    void window.ezterminalDesktop?.setConfirmRiskyPaneClose(enabled);
  }, []);
  const [bootIntro, setBootIntro] = useState(true);
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getBootIntro().then((enabled) => {
      if (alive) setBootIntro(enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeBootIntro = useCallback((enabled: boolean): void => {
    setBootIntro(enabled);
    void window.ezterminalDesktop?.setBootIntro(enabled);
  }, []);
  const [allowOsc52Clipboard, setAllowOsc52Clipboard] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getAllowOsc52Clipboard().then((enabled) => {
      if (alive) setAllowOsc52Clipboard(enabled);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeAllowOsc52Clipboard = useCallback((enabled: boolean): void => {
    setAllowOsc52Clipboard(enabled);
    void window.ezterminalDesktop?.setAllowOsc52Clipboard(enabled);
  }, []);
  const [terminalPastePreferences, setTerminalPastePreferences] = useState<TerminalPastePreferences>(
    DEFAULT_TERMINAL_PASTE_PREFERENCES,
  );
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getTerminalPastePreferences().then((preferences) => {
      if (alive) setTerminalPastePreferences(preferences);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeTerminalPastePreferences = useCallback((preferences: TerminalPastePreferences): void => {
    setTerminalPastePreferences(preferences);
    void window.ezterminalDesktop?.setTerminalPastePreferences(preferences);
  }, []);
  const pendingPasteConfirmationRef = useRef<PendingPasteConfirmation | null>(null);
  const [pendingPasteConfirmation, setPendingPasteConfirmation] = useState<PendingPasteConfirmation | null>(null);
  const requestPasteConfirmation = useCallback((risk: TerminalPasteRisk): Promise<boolean> => {
    if (pendingPasteConfirmationRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const pending = { risk, resolve };
      pendingPasteConfirmationRef.current = pending;
      setPendingPasteConfirmation(pending);
    });
  }, []);
  const settlePasteConfirmation = useCallback((confirmed: boolean): void => {
    const pending = pendingPasteConfirmationRef.current;
    if (!pending) return;
    pendingPasteConfirmationRef.current = null;
    setPendingPasteConfirmation(null);
    pending.resolve(confirmed);
  }, []);
  useEffect(() => () => {
    const pending = pendingPasteConfirmationRef.current;
    pendingPasteConfirmationRef.current = null;
    pending?.resolve(false);
  }, []);
  const notifyTerminal = useCallback((notice: TerminalNoticeKind): void => {
    if (notice === 'codex-interrupt-help') {
      pushToast({
        title: t('terminalSafety.codexInterruptTitle'),
        description: t('terminalSafety.codexInterruptDescription'),
        variant: 'info',
      });
      return;
    }
    if (notice === 'clipboard-read-failed') {
      pushToast({
        title: t('terminalSafety.clipboardReadFailedTitle'),
        description: t('terminalSafety.clipboardReadFailedDescription'),
        variant: 'warning',
      });
      return;
    }
    if (notice === 'clipboard-no-text') {
      pushToast({
        title: t('terminalSafety.clipboardNoTextTitle'),
        description: t('terminalSafety.clipboardNoTextDescription'),
        variant: 'info',
      });
      return;
    }
    pushToast({
      title: t('terminalSafety.clipboardEmptyTitle'),
      description: t('terminalSafety.clipboardEmptyDescription'),
      variant: 'info',
    });
  }, [pushToast, t]);

  // ── OpenClaw desktop visibility (openclaw-stabilization M2) ───────────────
  // Tri-state `openclawMode` setting resolved main-side into one effective
  // boolean (main.ts's resolveOpenClawVisibility) — gates the header button,
  // drawer, and openOpenClawChat below. Unknown starts hidden and the startup
  // layout restore waits for the first seed/push (or a fail-closed error), so
  // a persisted native chat view cannot flash before capability resolution.
  const [openclawVisible, setOpenclawVisible] = useState(false);
  const openclawVisibleRef = useRef(false);
  const openclawVisibilitySeedLatchRef = useRef<OpenClawVisibilitySeedLatch | null>(null);
  const settleOpenClawVisibility = useCallback((visible: boolean): void => {
    openclawVisibleRef.current = visible;
    setOpenclawVisible(visible);
    openclawVisibilitySeedLatchRef.current?.settle();
  }, []);
  if (!openclawVisibilitySeedLatchRef.current) {
    openclawVisibilitySeedLatchRef.current = new OpenClawVisibilitySeedLatch(
      () => settleOpenClawVisibility(false),
    );
  }
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = rendererCapabilities.openClaw.observeVisibility(
        (visibility) => settleOpenClawVisibility(visibility.visible),
        () => settleOpenClawVisibility(false),
      );
    } catch {
      settleOpenClawVisibility(false);
    }
    return () => {
      unsubscribe?.();
      openclawVisibilitySeedLatchRef.current?.cancelPending();
    };
  }, [settleOpenClawVisibility]);

  const waitForOpenClawVisibility = useCallback((): Promise<void> => {
    return openclawVisibilitySeedLatchRef.current?.wait() ?? Promise.resolve();
  }, []);

  const pickCapabilitySafeStartupLayout = useCallback(async (): Promise<LayoutEnvelope | null> => {
    await waitForOpenClawVisibility();
    const envelope = await pickStartupLayout();
    const capabilitySafe = !envelope || openclawVisibleRef.current
      ? envelope
      : removePanelFromLayoutEnvelope(envelope, 'openclaw-chat');
    if (!capabilitySafe || preflightLayoutEnvelope(capabilitySafe)) return capabilitySafe;
    await window.ezterminal.quarantineLayout().catch(() => undefined);
    return null;
  }, [waitForOpenClawVisibility]);

  // The coordinator owns exact pane/session identity; TerminalPane only reports
  // when its requested adoption or newly-created session actually binds.
  const mountSessionPane = useCallback(
    (
      panelId: string,
      instanceToken: PaneInstanceToken,
      initialCwd?: string,
      requestedAdoptSessionId?: string,
    ): SessionPaneLease => sessionMirroringCoordinator.mountPane(
      panelId,
      instanceToken,
      initialCwd,
      requestedAdoptSessionId,
    ),
    [sessionMirroringCoordinator],
  );

  const sessionBindingValue = useMemo<SessionBindingContextValue>(
    () => ({ mountPane: mountSessionPane }),
    [mountSessionPane],
  );

  // Both "new tab" and "split" open a fresh self-contained TerminalPane. Passing a
  // `position` makes dockview place it in a NEW grid group (a split) instead of the
  // active group (a tab). WorkbenchCoordinator owns globally unique ids/titles
  // across tabs AND splits. `renderer: 'always'` is required either way so a
  // pane that later becomes hidden stays mounted and its live PTY survives.
  const openPanel = useCallback(
    (
      position?: WorkbenchPanelPosition,
      cwd?: string,
    ) => {
      workbenchCoordinator.openTerminal({
        ...(position ? { position } : {}),
        ...(cwd ? { cwd } : {}),
      });
    },
    [workbenchCoordinator],
  );

  const addTab = useCallback(() => openPanel(), [openPanel]);

  // File-explorer drawer's "open terminal here" (M2): a fresh tab whose session
  // starts in `dirPath`, threaded through dockview panel params to TerminalPanel.
  const onOpenTerminalAt = useCallback((dirPath: string) => openPanel(undefined, dirPath), [openPanel]);

  // `worktree open` is resolved and boundary-checked by main. The renderer's
  // only role is the explicit UI seam: select a fresh terminal rooted at the
  // returned canonical path. Create/list/remove never emit this event.
  useEffect(() => {
    return window.ezterminalDesktop?.onWorktreeOpenRequested((worktree) => {
      openPanel(undefined, worktree.path);
    });
  }, [openPanel]);

  // OpenClaw chat panel (openclaw-management M3): a fixed-id singleton — add
  // it once, focus it (bring its tab to front) on every later call. Unlike
  // openPanel above, this never mints a new id (the schema requires the
  // fixed id 'openclaw-chat', see layout-schema.ts's PanelSchema doc).
  const openOpenClawChat = useCallback((): void => {
    // Mode 'off' (or 'auto' with the CLI not installed) — no OpenClaw UI at
    // all (openclaw-stabilization M2); the button/drawer that would call this
    // are themselves hidden, but guard directly too (e.g. a stale closure).
    if (
      !openclawVisible
      || sessionMirroringCoordinator.getSnapshot().replacementLocked
    ) return;
    // Close the drawer first: the [채팅 열기] button lives INSIDE the OpenClaw
    // drawer, but the drawer feeds `chatOverlayOpen`, which the chat panel ANDs
    // into the WebContentsView's effective visibility (z-order rule). Leaving
    // the drawer open would hide the freshly-opened chat view — a blank panel
    // until the user manually closes the drawer.
    setOpenclawOpen(false);
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel('openclaw-chat');
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({
      id: 'openclaw-chat',
      component: 'openclaw-chat',
      title: t('workspaceTab.openClawChat'),
      renderer: 'always',
    });
    // setOpenclawOpen is a stable state adapter declared below this callback;
    // reading it only when invoked avoids a render-order dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openclawVisible, sessionMirroringCoordinator, t]);

  // Split the pane the user last focused. Omitting `direction` would default to
  // 'within' (a tab, not a split), so it is always explicit.
  const splitActive = useCallback(
    (direction: 'right' | 'below') => {
      workbenchCoordinator.splitActive(direction);
    },
    [workbenchCoordinator],
  );

  // ── Layout persistence (Track A ③, A-M3/M4) ──────────────────────────────
  // Startup restore AND preset apply run as generation-tokened TRANSACTIONS
  // (Codex gate B2): StrictMode remounts dispose the first dockview and fire
  // onReady again, so a stale async apply must never touch the new instance —
  // and a disposal-induced fromJSON failure must never quarantine a good file.
  // WorkbenchCoordinator owns the transaction generation, save suppression,
  // debounce cancellation, and persistence ordering behind one Interface.
  // Flips true once the STARTUP restore transaction (onReady below) has
  // settled — the OpenClaw visibility gating effect (near openclawOpen's
  // declaration) waits on this so it never races a persisted layout that's
  // still mid-restore when the visibility seed resolves (openclaw-
  // stabilization M2).
  const [layoutReady, setLayoutReady] = useState(false);

  const scheduleSave = useCallback(
    (): void => workbenchCoordinator.scheduleLayoutSave(),
    [workbenchCoordinator],
  );

  const runLayoutTransaction = useCallback(
    (source: () => Promise<LayoutEnvelope | null>, options: LayoutTransactionOptions): Promise<boolean> =>
      workbenchCoordinator.runLayoutTransaction(source, options),
    [workbenchCoordinator],
  );

  useEffect(() => {
    return window.ezterminalDesktop?.onLayoutFlushRequested((requestId) => {
      void workbenchCoordinator.flushLayoutSave()
        .catch(() => undefined)
        .finally(() => window.ezterminalDesktop?.completeLayoutFlush(requestId));
    });
  }, [workbenchCoordinator]);

  // ── Interpreter-crash banner (B-M5) ───────────────────────────────────────
  // Shared fate: the one utilityProcess backs every session, so its death kills
  // them all. Panes latch dead individually (TerminalPane); this app-level
  // banner tells the user WHAT happened and where the local evidence lives.
  const [crashInfo, setCrashInfo] = useState<{ logPath: string | null; recovered: boolean } | null>(null);
  useEffect(() => {
    const unsubscribeDead = window.ezterminal?.onSessionDead?.((info) => {
      setCrashInfo({ logPath: info?.logPath ?? null, recovered: false });
    });
    const unsubscribeRecovered = window.ezterminal?.onSessionRecovered?.(() => {
      setCrashInfo((current) => current
        ? { ...current, recovered: true }
        : { logPath: null, recovered: true });
    });
    return () => {
      unsubscribeDead?.();
      unsubscribeRecovered?.();
    };
  }, []);

  // One adaptive sidebar owns every navigation destination. At >=1200px it
  // reflows the workspace; below that breakpoint the same shell overlays it.
  const [sidebarDestination, setSidebarDestination] = useState<SidebarDestination | null>(null);
  const [settingsCategoryRequest, setSettingsCategoryRequest] = useState<{
    readonly category: SettingsCategory;
    readonly id: number;
  }>({ category: 'general', id: 0 });
  const setSidebarOpen = useCallback((destination: SidebarDestination, update: OpenStateUpdate): void => {
    setSidebarDestination((current) => {
      const wasOpen = current === destination;
      const nextOpen = typeof update === 'function' ? update(wasOpen) : update;
      if (nextOpen) return destination;
      return wasOpen ? null : current;
    });
  }, []);
  const statsOpen = sidebarDestination === 'monitor';
  const setOpenclawOpen = useCallback(
    (update: OpenStateUpdate) => setSidebarOpen('openclaw', update),
    [setSidebarOpen],
  );
  const setAgentsOpen = useCallback((update: OpenStateUpdate) => setSidebarOpen('agents', update), [setSidebarOpen]);
  useEffect(() => {
    window.ezterminal.setStatsPanelVisible(statsOpen);
  }, [statsOpen]);

  // ── Mobile pairing panel (M4) ─────────────────────────────────────────────

  // ── Settings drawer (v0.2.0 M2) ───────────────────────────────────────────

  // ── OpenClaw management drawer (openclaw-management M2) ───────────────────
  // Same right-slot mutual exclusion as stats/pairing/settings above.

  // Visibility gating (openclaw-stabilization M2): fires whenever effective
  // visibility is false with the startup restore already settled — covers
  // BOTH a runtime Settings-panel toggle to 'off' (drawer/chat panel open at
  // the time) AND a persisted layout that happened to contain the
  // openclaw-chat panel from a prior session while mode is now 'off'/the CLI
  // is now absent. Closing the panel here relies on OpenClawChatPanel's own
  // unmount cleanup to destroy the main-owned WebContentsView.
  useEffect(() => {
    if (!layoutReady || openclawVisible) return;
    setOpenclawOpen(false);
    workbenchCoordinator.closePanel('openclaw-chat');
    // setOpenclawOpen is stable and intentionally declared after OpenClaw's
    // visibility state to preserve the existing hook ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutReady, openclawVisible, workbenchCoordinator]);

  const cycleRecentPanel = useCallback(
    (reverse: boolean): void => workbenchCoordinator.cycleRecentPanel(reverse),
    [workbenchCoordinator],
  );

  const commitRecentPanelSwitch = useCallback(
    (): void => workbenchCoordinator.commitRecentPanelSwitch(),
    [workbenchCoordinator],
  );

  const cancelRecentPanelSwitch = useCallback(
    (restoreFocus: boolean): void => workbenchCoordinator.cancelRecentPanelSwitch(restoreFocus),
    [workbenchCoordinator],
  );

  // Agent Activity is a main-owned monotonic snapshot. Renderer state only
  // adds per-window unread bookkeeping and session-to-panel presentation.
  const [agentSnapshot, setAgentSnapshot] = useState<AgentActivitySnapshot>(EMPTY_AGENT_ACTIVITY_SNAPSHOT);
  const [unreadAgentIds, setUnreadAgentIds] = useState<ReadonlySet<string>>(() => new Set());
  const latestAgentRevisionRef = useRef(-1);
  const previousAgentStatusesRef = useRef<Map<string, AgentStatus>>(new Map());
  useEffect(() => {
    let alive = true;
    const applySnapshot = (next: AgentActivitySnapshot): void => {
      if (!alive || next.revision <= latestAgentRevisionRef.current) return;
      latestAgentRevisionRef.current = next.revision;
      setAgentSnapshot(next);
      const previous = previousAgentStatusesRef.current;
      const nextStatuses = new Map(next.items.map((item) => [item.id, item.status] as const));
      setUnreadAgentIds((current) => {
        const updated = new Set(
          [...current].filter((id) => {
            const status = nextStatuses.get(id);
            return status === 'waiting' || status === 'blocked' || status === 'error';
          }),
        );
        for (const item of next.items) {
          if (item.status !== 'waiting' && item.status !== 'blocked' && item.status !== 'error') continue;
          if (previous.get(item.id) !== item.status) updated.add(item.id);
        }
        return updated;
      });
      previousAgentStatusesRef.current = nextStatuses;
    };
    const unsubscribe = window.ezterminal.onAgentActivitySnapshot(applySnapshot);
    void window.ezterminal
      .getAgentActivitySnapshot()
      .then(applySnapshot)
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const focusAgentSession = useCallback(
    (sessionId: string): void => {
      const api = apiRef.current;
      const candidates = (sessionPaneBindings.get(sessionId) ?? [])
        .filter((binding) => api?.getPanel(binding.panelId)?.api === binding.instanceToken);
      const activePanelId = api?.activePanel?.id;
      const panelId =
        candidates.find((binding) => binding.panelId === activePanelId)?.panelId ?? candidates[0]?.panelId;
      if (panelId) workbenchCoordinator.activatePanel(panelId);
      setUnreadAgentIds(
        (current) =>
          new Set(
            [...current].filter((id) => agentSnapshot.items.find((item) => item.id === id)?.sessionId !== sessionId),
          ),
      );
    },
    [agentSnapshot, sessionPaneBindings, workbenchCoordinator],
  );

  useEffect(() => {
    if (!activePanelId) return;
    setUnreadAgentIds(
      (current) =>
        new Set(
          [...current].filter((id) => {
            const activity = agentSnapshot.items.find((item) => item.id === id);
            return (
              !activity ||
              !(sessionPaneBindings.get(activity.sessionId) ?? [])
                .some(
                  (binding) =>
                    binding.panelId === activePanelId &&
                    apiRef.current?.getPanel(binding.panelId)?.api === binding.instanceToken,
                )
            );
          }),
        ),
    );
  }, [activePanelId, agentSnapshot, sessionPaneBindings]);

  useEffect(() => {
    return window.ezterminalDesktop?.onAgentSessionReveal((sessionId) => focusAgentSession(sessionId));
  }, [focusAgentSession]);

  const agentTabStatuses = useMemo<ReadonlyMap<string, AgentStatus>>(() => {
    const rank: Record<AgentStatus, number> = {
      blocked: 0,
      error: 1,
      waiting: 2,
      working: 3,
      starting: 4,
      done: 5,
    };
    const result = new Map<string, AgentStatus>();
    for (const activity of agentSnapshot.items) {
      for (const binding of sessionPaneBindings.get(activity.sessionId) ?? []) {
        if (apiRef.current?.getPanel(binding.panelId)?.api !== binding.instanceToken) continue;
        const existing = result.get(binding.panelId);
        if (!existing || rank[activity.status] < rank[existing]) {
          result.set(binding.panelId, activity.status);
        }
      }
    }
    return result;
  }, [agentSnapshot, sessionPaneBindings]);

  const paneApprovalValue = useMemo<PaneApprovalContextValue>(() => {
    const byPanel = new Map<string, PaneApproval>();
    for (const activity of agentSnapshot.items) {
      if (!activity.approval) continue;
      for (const binding of sessionPaneBindings.get(activity.sessionId) ?? []) {
        if (apiRef.current?.getPanel(binding.panelId)?.api !== binding.instanceToken) continue;
        byPanel.set(binding.panelId, { activityId: activity.id, approval: activity.approval });
      }
    }
    return {
      byPanel,
      onDecide: (activityId, approvalId, decision) =>
        window.ezterminal.decideAgentApproval(activityId, approvalId, decision),
    };
  }, [agentSnapshot, sessionPaneBindings]);

  const attentionCount = countAgentAttention(agentSnapshot);
  const agentSessionIds = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        agentSnapshot.items
          .filter((item) => item.status !== 'done' && item.status !== 'error')
          .map((item) => item.sessionId),
      ),
    [agentSnapshot],
  );
  activeAgentSessionIdsRef.current = agentSessionIds;

  const resolveAuxiliaryTargets = useCallback((
    request: AuxiliaryCloseRequest,
    targetWindow: Window,
  ): readonly PaneLifecycleTarget[] | null => {
    const api = apiRef.current;
    if (!api) return null;
    const targetStillOpen = api.getPopouts().some(
      (popout) => popout.window === targetWindow && popout.window.name === request.windowName,
    );
    if (!targetStillOpen) return null;
    const panels = api.panels.filter((panel) => {
      try {
        return panel.api.getWindow() === targetWindow;
      } catch {
        return false;
      }
    });
    if (panels.some((panel) => api.getPanel(panel.id) !== panel || !isDetachablePanel(panel))) {
      return null;
    }
    return panels.map((panel) => ({
      panelId: panel.id,
      title: panel.api.title ?? t('workspaceTab.terminal'),
      component: panel.api.component,
      instanceToken: panel.api,
    }));
  }, [t]);

  const rejectAuxiliaryClose = useCallback(
    (request: AuxiliaryCloseRequest, stateChanged: boolean): void => {
      setAuxiliaryCloseDialog(null);
      void window.ezterminalDesktop?.resolveAuxiliaryClose(request.requestId, 'cancel');
      setCloseDialog((current) => current ?? {
        title: stateChanged
          ? t('safetyDialog.terminalStateChangedTitle')
          : t('safetyDialog.terminalStateUnavailableTitle'),
        description: stateChanged
          ? t('safetyDialog.terminalStateChangedDescription')
          : t('safetyDialog.terminalStateUnavailableDescription'),
        confirmLabel: t('common.ok'),
        onConfirm: () => setCloseDialog(null),
      });
    },
    [t],
  );

  const completeAuxiliaryClose = useCallback(
    async (
      request: AuxiliaryCloseRequest,
      targetWindow: Window,
      plan: PreparedPaneLifecycle,
      choices: ReadonlyMap<string, AuxiliaryCloseChoice>,
    ): Promise<void> => {
      const api = apiRef.current;
      const desktop = window.ezterminalDesktop;
      if (!api || !desktop) {
        rejectAuxiliaryClose(request, false);
        return;
      }

      try {
        const dispositions = new Map<string, PaneDisposition>();
        for (const item of plan.items) {
          if (!item.creator) continue;
          const choice = choices.get(item.panelId);
          if (choice) dispositions.set(item.panelId, choice);
          else if (item.risk === null) dispositions.set(item.panelId, 'terminate');
        }
        const resolveCurrentTargets = () => resolveAuxiliaryTargets(request, targetWindow);
        const result = await paneLifecycleCoordinator.commit(plan, {
          dispositions,
          resolveCurrentTargets,
          activeAgentSessionIds: activeAgentSessionIdsRef.current,
        });
        if (!result.ok) {
          rejectAuxiliaryClose(request, result.reason === 'state-changed');
          return;
        }
        if (!paneLifecycleCoordinator.validateFinalization(result.commit, {
          resolveCurrentTargets,
        }).ok) {
          rejectAuxiliaryClose(request, true);
          return;
        }
        for (const target of result.commit.targets) {
          const panel = api.getPanel(target.panelId);
          if (!panel || panel.api !== target.instanceToken) {
            rejectAuxiliaryClose(request, true);
            return;
          }
          panel.api.close();
        }

        // Removing the final panel asks Dockview to close the native window.
        // Main keeps that re-entrant close held until this original request is
        // explicitly allowed below.
        setAuxiliaryCloseDialog(null);
        await desktop.resolveAuxiliaryClose(request.requestId, 'allow');
        if (result.commit.keptSessionIds.length > 0) {
          pushToast({ title: t('safetyDialog.keptRunning'), variant: 'info' });
        }
      } catch {
        rejectAuxiliaryClose(request, false);
      }
    },
    [
      paneLifecycleCoordinator,
      pushToast,
      rejectAuxiliaryClose,
      resolveAuxiliaryTargets,
      t,
    ],
  );

  const handleAuxiliaryCloseRequest = useCallback(
    (request: AuxiliaryCloseRequest): void => {
      const api = apiRef.current;
      const desktop = window.ezterminalDesktop;
      if (!api || !desktop) {
        rejectAuxiliaryClose(request, false);
        return;
      }
      const popout = api.getPopouts().find(
        (candidate) => candidate.window.name === request.windowName,
      );
      if (!popout) {
        // Dockview already removed an empty/redocked popout and its
        // programmatic window.close() is the only remaining operation.
        void desktop.resolveAuxiliaryClose(request.requestId, 'allow');
        return;
      }
      const targets = resolveAuxiliaryTargets(request, popout.window);
      if (!targets) {
        rejectAuxiliaryClose(request, false);
        return;
      }
      if (targets.length === 0) {
        void desktop.resolveAuxiliaryClose(request.requestId, 'allow');
        return;
      }

      const preparation = paneLifecycleCoordinator.prepare({
        kind: 'auxiliary-window',
        targets,
        activeAgentSessionIds: agentSessionIds,
      });
      if (!preparation.ok) {
        rejectAuxiliaryClose(request, false);
        return;
      }
      if (!preparation.plan.requiresConfirmation) {
        void completeAuxiliaryClose(request, popout.window, preparation.plan, new Map());
        return;
      }
      setAuxiliaryCloseDialog({
        request,
        targetWindow: popout.window,
        plan: preparation.plan,
        busy: false,
      });
    },
    [
      agentSessionIds,
      completeAuxiliaryClose,
      paneLifecycleCoordinator,
      rejectAuxiliaryClose,
      resolveAuxiliaryTargets,
    ],
  );

  useEffect(() => (
    window.ezterminalDesktop?.onAuxiliaryCloseRequested(handleAuxiliaryCloseRequest)
  ), [handleAuxiliaryCloseRequest]);

  const focusActivePane = useCallback((): void => {
    workbenchCoordinator.focusActivePanel();
  }, [workbenchCoordinator]);

  const openAgentHistorySession = useCallback(async (
    session: AgentHistorySessionSummary,
    project: AgentProjectSummary,
  ): Promise<void> => {
    if (sessionMirroringCoordinator.getSnapshot().replacementLocked) return;
    let api = apiRef.current;
    if (!api) return;
    const panelId = `agent-session-${session.historyId}`;
    const title = agentHistoryTabTitle(project.name, session.provider);
    let existing = api.getPanel(panelId);
    if (existing) {
      existing.api.setTitle(title);
      existing.api.setActive();
      return;
    }
    const described = await window.ezterminalDesktop
      ?.describeProjectWorkspace(project.projectId)
      .catch(() => null);
    if (sessionMirroringCoordinator.getSnapshot().replacementLocked) return;
    api = apiRef.current;
    if (!api) return;
    existing = api.getPanel(panelId);
    if (existing) {
      existing.api.setTitle(title);
      existing.api.setActive();
      return;
    }
    const recordedRoot = session.roots[0];
    const comparableRecordedRoot = recordedRoot
      ?.replace(/\\/gu, '/')
      .replace(/\/+$/u, '')
      .toLocaleLowerCase('en-US');
    const workspace = described?.ok && comparableRecordedRoot
      ? described.project.workspaces?.find((candidate) => candidate.displayPath
        .replace(/\\/gu, '/')
        .replace(/\/+$/u, '')
        .toLocaleLowerCase('en-US') === comparableRecordedRoot)
      : undefined;
    const root = described?.ok
      ? workspace
        ? described.project.roots.find((candidate) => candidate.rootId === workspace.rootId)
        : described.project.roots.find((candidate) => candidate.displayPath
          .replace(/\\/gu, '/')
          .replace(/\/+$/u, '')
          .toLocaleLowerCase('en-US') === comparableRecordedRoot)
      : undefined;
    const workspaceId = workspace?.workspaceId ?? root?.rootId;
    api.addPanel({
      id: panelId,
      component: 'agent-session',
      title,
      renderer: 'always',
      params: {
        historyId: session.historyId,
        provider: session.provider,
        ...(root && workspaceId ? {
          projectId: project.projectId,
          rootId: root.rootId,
          workspaceId,
        } : {}),
      },
    });
  }, [sessionMirroringCoordinator]);

  const codePanelSequence = useRef(0);
  const projectDocumentNavigationSequence = useRef(0);
  const projectDocumentNavigation = useRef(new Map<string, number>());

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (projectDrillActive) {
      projectReviewLayoutRef.current ??= captureProjectReviewLayout(api);
      const editor = api.activePanel?.api.component === 'project-editor'
        ? api.activePanel
        : api.panels.find((panel) => panel.api.component === 'project-editor');
      if (editor) applyProjectReviewLayout(api, editor, projectWide ? 'wide' : 'narrow');
      return;
    }
    const snapshot = projectReviewLayoutRef.current;
    projectReviewLayoutRef.current = null;
    if (snapshot) restoreProjectReviewLayout(api, snapshot);
  }, [projectDrillActive, projectWide]);

  const commitProjectDocument = useCallback((
    document: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ): void => {
    if (sessionMirroringCoordinator.getSnapshot().replacementLocked) return;
    const api = apiRef.current;
    if (!api) return;
    requestProjectCodeReveal(document, location);
    const shouldFocusEditor = !projectDrillActive || !projectWide;
    if (shouldFocusEditor) requestProjectCodeFocus(document);
    const editorPanels = api.panels.filter((panel) => panel.api.component === 'project-editor');
    let matchingDocument: ProjectEditorDocument | undefined;
    const matching = editorPanels.find((panel) => {
      const params = panel.api.getParameters<ProjectEditorDocument>();
      if (!projectEditorDocumentsEqual(params, document)) return false;
      matchingDocument = params;
      return true;
    });
    const previousActive = api.activePanel;
    let panel = matching;
    if (panel) {
      if (!matchingDocument
        || !projectEditorDocumentParametersEqual(matchingDocument, document)) {
        panel.api.updateParameters(document);
      }
      panel.api.setTitle(projectEditorTitle(document));
    } else {
      codePanelSequence.current += 1;
      const active = api.activePanel;
      panel = api.addPanel({
        id: `project-editor-${Date.now().toString(36)}-${String(codePanelSequence.current)}`,
        component: 'project-editor',
        title: projectEditorTitle(document),
        renderer: 'onlyWhenVisible',
        params: document,
        inactive: projectDrillActive && projectWide,
        ...(active ? {
          position: {
            referencePanel: active,
            direction: projectDrillActive
              ? 'within' as const
              : window.innerWidth >= 1200 ? 'right' as const : 'within' as const,
          },
        } : {}),
      });
      // Dockview passes initial params to the renderer but leaves the panel
      // API parameter store empty until the first explicit update.
      panel.api.updateParameters(document);
    }
    if (projectDrillActive) {
      projectReviewLayoutRef.current ??= captureProjectReviewLayout(api);
      applyProjectReviewLayout(api, panel, projectWide ? 'wide' : 'narrow');
      panel.api.setActive();
      if (projectWide && previousActive?.api.component !== 'project-editor') {
        previousActive?.api.setActive();
      }
      if (!projectWide) {
        setSidebarDestination(null);
        requestAnimationFrame(() => {
          if (api.activePanel?.id === panel.id) flushProjectCodeFocus(document);
        });
      }
    } else {
      panel.api.setActive();
      requestAnimationFrame(() => {
        if (api.activePanel?.id === panel.id) flushProjectCodeFocus(document);
      });
    }
  }, [projectDrillActive, projectWide, sessionMirroringCoordinator]);

  const openProjectDocument = useCallback((
    requested: ProjectEditorDocument,
    location?: ProjectCodeLocation,
  ): void => {
    projectDocumentNavigationSequence.current += 1;
    const navigation = projectDocumentNavigationSequence.current;
    const requestKey = projectEditorDocumentPathKey(requested);
    projectDocumentNavigation.current.set(requestKey, navigation);
    if (requested.documentKey) {
      commitProjectDocument({
        ...requested,
        lens: requested.lens ?? { kind: 'current' },
      }, location);
      return;
    }
    const desktop = window.ezterminalDesktop;
    if (!desktop) return;
    void desktop.resolveProjectDocument({
      kind: 'project-path',
      projectId: requested.projectId,
      rootId: requested.rootId,
      workspaceId: requested.workspaceId,
      relativePath: requested.relativePath,
      lens: requested.lens ?? { kind: 'current' },
      ...(location?.line ? { line: location.line } : {}),
      ...(location?.column ? { column: location.column } : {}),
    }).then((result) => {
      if (projectDocumentNavigation.current.get(requestKey) !== navigation) return;
      if (!result.ok) return;
      commitProjectDocument({
        ...result.target.document.id,
        documentKey: result.target.document.key,
        lens: result.target.lens,
      }, result.target.line
        ? {
            line: result.target.line,
            ...(result.target.column ? { column: result.target.column } : {}),
          }
        : undefined);
    }).catch(() => undefined);
  }, [commitProjectDocument]);

  const openProjectFile = useCallback((
    projectId: string,
    rootId: string,
    relativePath: string,
    location?: ProjectCodeLocation,
    workspaceId = rootId,
  ): void => {
    openProjectDocument({ projectId, rootId, workspaceId, relativePath }, location);
  }, [openProjectDocument]);

  const showProjectWorkspace = useCallback((projectId: string): void => {
    setActiveProjectId(projectId);
    setSidebarDestination('agents');
  }, []);

  const openHistoryReview = useCallback(async (
    _session: AgentHistorySessionSummary,
    project: AgentProjectSummary,
  ): Promise<void> => {
    showProjectWorkspace(project.projectId);
  }, [showProjectWorkspace]);

  const openSessionHistoryReview = useCallback((
    projectId: string,
    rootId: string,
    workspaceId: string,
    historyId: string,
    reviewTurnId: string,
    changedPath?: string,
  ): void => {
    void window.ezterminalDesktop?.describeProjectWorkspace(projectId).then((described) => {
      if (!described.ok) return;
      const root = described.project.roots.find((candidate) => candidate.rootId === rootId);
      if (!root) return;
      const workspace = described.project.workspaces?.find((candidate) =>
        candidate.rootId === rootId && candidate.workspaceId === workspaceId);
      if (described.project.workspaces && !workspace) return;
      const relativePath = changedPath
        ? projectRelativeReviewHint(changedPath, workspace?.displayPath ?? root.displayPath) ?? undefined
        : undefined;
      if (!relativePath) {
        showProjectWorkspace(projectId);
        return;
      }
      openProjectDocument({
        projectId,
        rootId,
        workspaceId,
        relativePath,
        lens: { kind: 'agent-turn', historyId, turnId: reviewTurnId },
      });
    }).catch(() => undefined);
  }, [openProjectDocument, showProjectWorkspace]);

  const openActivityReview = useCallback(async (directory: string): Promise<boolean> => {
    const page = await window.ezterminal.listAgentProjects(false, undefined, 100).catch(() => null);
    const project = page?.items.find((candidate) => [candidate.primaryRoot, ...candidate.additionalRoots]
      .some((root) => root.toLocaleLowerCase() === directory.toLocaleLowerCase()));
    if (!project) return false;
    showProjectWorkspace(project.projectId);
    return true;
  }, [showProjectWorkspace]);

  const locateRegisteredProjectFile = useCallback(async (absolutePath: string) => {
    const desktop = window.ezterminalDesktop;
    if (!desktop) return null;
    const resolved = await desktop.resolveProjectDocument({
      kind: 'absolute-path',
      absolutePath,
    }).catch(() => null);
    return resolved?.ok
      ? {
          ...resolved.target.document.id,
          documentKey: resolved.target.document.key,
        }
      : null;
  }, []);

  const launchAgent = useCallback((bootstrap: AgentLaunchBootstrap): void => {
    workbenchCoordinator.openTerminal({
      cwd: bootstrap.cwd,
      title: bootstrap.name,
      agentBootstrap: bootstrap,
    });
  }, [workbenchCoordinator]);

  const requestPanelClose = useCallback(
    (panelId: string, component: string, instanceToken: object, close: () => void): void => {
      // A read-only Agent Session has no pane handle and closes immediately.
      // After its first send it mounts TerminalPane in the same Dockview panel,
      // so the handle (rather than the component name) becomes the close guard.
      if (component !== 'terminal' && !getPaneHandle(panelId)) {
        close();
        return;
      }
      const retryAfterStateCheck = (): void => {
        setCloseDialog(
          (current) =>
            current ?? {
              title: t('safetyDialog.terminalStateUnavailableTitle'),
              description: t('safetyDialog.terminalStateUnavailableDescription'),
              confirmLabel: t('common.retry'),
              onConfirm: () => {
                setCloseDialog(null);
                requestAnimationFrame(() => (
                  requestPanelClose(panelId, component, instanceToken, close)
                ));
              },
            },
        );
      };
      const preparation = paneLifecycleCoordinator.prepare({
        kind: 'single-pane',
        target: {
          panelId,
          title: panelId,
          component,
          instanceToken,
        },
        activeAgentSessionIds: agentSessionIds,
        confirmRiskyClose: confirmRiskyPaneClose,
      });
      if (!preparation.ok) {
        retryAfterStateCheck();
        return;
      }

      const plan = preparation.plan;
      const commitClose = (disposition: PaneDisposition): void => {
        const dispositions = new Map<string, PaneDisposition>();
        if (plan.items.some((item) => item.panelId === panelId && item.creator)) {
          dispositions.set(panelId, disposition);
        }
        void paneLifecycleCoordinator.commit(plan, {
          dispositions,
          activeAgentSessionIds: activeAgentSessionIdsRef.current,
        }).then((result) => {
          if (!result.ok) {
            if (result.reason !== 'busy') retryAfterStateCheck();
            return;
          }
          if (!paneLifecycleCoordinator.validateFinalization(result.commit).ok) {
            retryAfterStateCheck();
            return;
          }
          close();
          focusActivePane();
          if (result.commit.keptSessionIds.length > 0) {
            pushToast({ title: t('safetyDialog.keptRunning'), variant: 'info' });
          }
        });
      };

      if (!plan.requiresConfirmation) {
        commitClose('terminate');
        return;
      }
      const risk = plan.items[0]?.risk;
      if (!risk) {
        retryAfterStateCheck();
        return;
      }
      setCloseDialog(
        (current) =>
          current ?? {
            title: t('safetyDialog.closeActiveTitle'),
            description: t('safetyDialog.closeActiveDescription', {
              risk: t(CLOSE_RISK_I18N_KEY[risk]),
            }),
            confirmLabel: t('safetyDialog.closeTerminal'),
            // Closing the pane without destroying the session. The session keeps
            // running and stays reclaimable from the Command Center, which is
            // what makes this a real third option rather than a way to strand a
            // PTY with no route back to it.
            alternateLabel: t('safetyDialog.keepInBackground'),
            onAlternate: () => {
              setCloseDialog(null);
              commitClose('keep');
            },
            onConfirm: () => {
              setCloseDialog(null);
              commitClose('terminate');
            },
          },
      );
    },
    [
      agentSessionIds,
      confirmRiskyPaneClose,
      focusActivePane,
      paneLifecycleCoordinator,
      pushToast,
      t,
    ],
  );
  const paneCloseContextValue = useMemo<PaneCloseContextValue>(() => ({ requestPanelClose }), [requestPanelClose]);

  // ── OpenClaw chat overlay visibility (openclaw-management M3) ────────────
  // Single derivation of "some DOM overlay sits above the dockview area right
  // now" — the WebContentsView paints natively above ALL of this DOM, so it
  // must be told to hide whenever any of these would otherwise sit under it
  // (architecture decision (a)'s z-order rule). Computed after every one of
  // the flags below is declared (see the effect further down that reads it).

  // ── Theme (E1) + custom mods, font, effects (theme-effects-font M3) ──────
  // Applied via `data-theme` on <html> so index.css's [data-theme] blocks take
  // over the --term-* vars; 'ez:theme' notifies open PtyBlocks to re-theme their
  // xterm instance (mirrors the existing 'ez:refit' pattern). A custom mod's
  // OWN cssVars/effects are applied by `applyThemeVarsAndEffects` (the shared
  // apply-path helper) right after the attribute is set, before that event.
  const [terminalRendererPreference, setTerminalRendererPreference] = useState<TerminalRendererPreference>('auto');
  useEffect(() => {
    let alive = true;
    void window.ezterminalDesktop?.getTerminalRendererPreference().then((preference) => {
      if (alive && preference) setTerminalRendererPreference(preference);
    });
    return () => {
      alive = false;
    };
  }, []);
  const changeTerminalRendererPreference = useCallback((preference: TerminalRendererPreference): void => {
    setTerminalRendererPreference(preference);
    void window.ezterminalDesktop?.setTerminalRendererPreference(preference);
  }, []);
  const terminalRuntimeOptions = useMemo<TerminalRuntimeOptions>(
    () => ({
      platform: 'desktop',
      rendererPreference: terminalRendererPreference,
      openExternalHttpUrl: (url) => {
        void window.ezterminalDesktop?.openExternalHttpUrl(url);
      },
      allowOsc52Clipboard,
      writeClipboardText: async (text) => {
        await window.ezterminalDesktop?.writeOsc52Clipboard(text);
      },
      readClipboard: async () => {
        const desktopSnapshot = await window.ezterminalDesktop?.readTerminalClipboard();
        if (desktopSnapshot) return desktopSnapshot;
        return {
          hasImage: false,
          text: await navigator.clipboard.readText(),
        };
      },
      pastePreferences: terminalPastePreferences,
      confirmPaste: requestPasteConfirmation,
      notifyTerminal,
      openTerminalFileLocation: (request, _event, intent) => {
        quickPreviewSequenceRef.current += 1;
        const sequence = quickPreviewSequenceRef.current;
        void window.ezterminal
          .resolveTerminalFileLocation(request)
          .then(async (resolved) => {
            if (sequence !== quickPreviewSequenceRef.current) return;
            if (!resolved.ok) {
              const messages = {
                remote: t('terminalFiles.remotePath'),
                invalid: t('terminalFiles.invalidLocation'),
                'outside-workspace': t('terminalFiles.outsideWorkspace'),
                missing: t('terminalFiles.missing'),
                'not-file': t('terminalFiles.notFile'),
                unreadable: t('terminalFiles.unreadable'),
              } as const;
              pushToast({ title: messages[resolved.reason], variant: 'warning' });
              return;
            }

            const target = await locateRegisteredProjectFile(resolved.path);
            if (sequence !== quickPreviewSequenceRef.current) return;
            const location = resolved.line === undefined
              ? undefined
              : { line: resolved.line, ...(resolved.column === undefined ? {} : { column: resolved.column }) };
            if (target) {
              setQuickPreview(null);
              openProjectFile(target.projectId, target.rootId, target.relativePath, location, target.workspaceId);
              return;
            }

            const preview = await window.ezterminal
              .readFilePreview(resolved.path, resolved.capability)
              .catch((): FilePreviewResult => ({
                ok: false,
                error: t('terminalFiles.previewLoadFailed'),
              }));
            if (sequence !== quickPreviewSequenceRef.current) return;
            if (intent === 'review-change') {
              pushToast({ title: t('terminalFiles.changePreviewFallback'), variant: 'warning' });
            }
            setQuickPreview({
              path: resolved.path,
              result: preview,
              line: resolved.line,
              column: resolved.column,
            });
          })
          .catch(() => {
            if (sequence === quickPreviewSequenceRef.current) {
              pushToast({ title: t('terminalFiles.resolveFailed'), variant: 'danger' });
            }
          });
      },
    }),
    [
      allowOsc52Clipboard,
      locateRegisteredProjectFile,
      notifyTerminal,
      openProjectFile,
      pushToast,
      requestPasteConfirmation,
      t,
      terminalPastePreferences,
      terminalRendererPreference,
    ],
  );

  const [theme, setThemeState] = useState<ThemeName>('matrix');
  const [availableThemes, setAvailableThemes] = useState<ThemeDefinition[]>(() => listThemes());
  // Guards the initial getTheme() fetch against a click that lands before its IPC
  // round-trip resolves — without this, a fast click could be silently overwritten
  // by the (now-stale) persisted value moments later.
  const userChangedThemeRef = useRef(false);

  // effectToggles needs to be read from INSIDE `applyTheme` (a stable, dep-free
  // callback — see below) without forcing it to change identity on every
  // toggle, so a ref mirrors the state (same shape as userChangedThemeRef).
  const [effectToggles, setEffectTogglesState] = useState<Record<string, boolean>>({});
  const effectTogglesRef = useRef<Record<string, boolean>>({});
  const setEffectToggles = useCallback((next: Record<string, boolean>): void => {
    effectTogglesRef.current = next;
    setEffectTogglesState(next);
  }, []);

  const [fontId, setFontId] = useState<string | undefined>(undefined);

  // crt-rollbar line params (rollbar-params) — same ref-mirrors-state shape
  // as effectToggles above, needed so onChangeRollbar (a stable, dep-free
  // callback) can read the latest value without becoming a moving target.
  const [rollbar, setRollbarState] = useState<RollbarParams>(DEFAULT_ROLLBAR_PARAMS);
  const rollbarRef = useRef<RollbarParams>(DEFAULT_ROLLBAR_PARAMS);
  const setRollbar = useCallback((next: RollbarParams): void => {
    rollbarRef.current = next;
    setRollbarState(next);
  }, []);

  // CRT-interference params (crt-interference) — same ref-mirrors-state shape
  // as rollbar above, one aggregate for the four parameterized effects.
  const [interference, setInterferenceState] = useState<InterferenceParams>(DEFAULT_INTERFERENCE_PARAMS);
  const interferenceRef = useRef<InterferenceParams>(DEFAULT_INTERFERENCE_PARAMS);
  const setInterference = useCallback((next: InterferenceParams): void => {
    interferenceRef.current = next;
    setInterferenceState(next);
  }, []);

  const applyTheme = useCallback((name: ThemeName): void => {
    document.documentElement.dataset.theme = name;
    applyThemeVarsAndEffects(name, {
      effectToggles: effectTogglesRef.current,
      platformDefaults: DESKTOP_EFFECT_DEFAULTS,
    });
    window.dispatchEvent(new Event('ez:theme'));
    setThemeState(name);
  }, []);

  const registerMods = useCallback((mods: ThemeMod[]): void => {
    for (const mod of mods) registerTheme(themeModToDefinition(mod));
    setAvailableThemes(listThemes());
  }, []);

  const refreshAvailableThemes = useCallback(async (): Promise<void> => {
    try {
      const mods = await window.ezterminalDesktop?.getAvailableThemes();
      if (mods) registerMods(mods);
    } catch {
      // Desktop bridge unavailable — built-ins still work via THEME_ORDER.
    }
  }, [registerMods]);

  const onImportTheme = useCallback(
    async (json: string): Promise<{ ok: boolean; error?: string }> => {
      const result = await window.ezterminalDesktop?.importTheme(json);
      if (!result) return { ok: false, error: t('settings.themeImportUnavailable') };
      if (result.ok) await refreshAvailableThemes();
      return result;
    },
    [refreshAvailableThemes, t],
  );

  // Boot ordering (FOUC fix): custom theme mods must be registered, and the
  // persisted font/effect toggles loaded into state, BEFORE the first
  // `applyTheme(getTheme())` — otherwise a custom theme's `data-theme` value
  // resolves against an empty registry (getActiveTheme() falls back to
  // 'dark') and effects apply with an empty toggle map for one frame.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refreshAvailableThemes();
      if (cancelled) return;
      try {
        const [persistedFontId, persistedToggles, persistedRollbar, persistedEffectParams] = await Promise.all([
          window.ezterminalDesktop?.getFont(),
          window.ezterminalDesktop?.getEffectToggles(),
          window.ezterminalDesktop?.getRollbar(),
          window.ezterminalDesktop?.getEffectParams(),
        ]);
        if (cancelled) return;
        if (persistedFontId) {
          setUserFontId(persistedFontId);
          setFontId(persistedFontId);
        }
        if (persistedToggles) setEffectToggles(persistedToggles);
        if (persistedRollbar) {
          const clamped = clampRollbarParams(persistedRollbar);
          applyRollbarParams(clamped);
          setRollbar(clamped);
        }
        if (persistedEffectParams) {
          const clampedFx = clampInterferenceParams(persistedEffectParams);
          applyInterferenceParams(clampedFx);
          setInterference(clampedFx);
        }
      } catch {
        // Desktop bridge unavailable — no user font override, theme defaults for effects.
      }
      const name = await window.ezterminal.getTheme();
      if (!cancelled && !userChangedThemeRef.current) applyTheme(name);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyTheme, refreshAvailableThemes, setEffectToggles, setRollbar, setInterference]);

  const selectTheme = useCallback(
    (name: ThemeName): void => {
      userChangedThemeRef.current = true;
      applyTheme(name);
      void window.ezterminal.setTheme(name);
    },
    [applyTheme],
  );

  const cycleTheme = useCallback((): void => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    selectTheme(next);
  }, [theme, selectTheme]);

  const activeThemeDef = useMemo<ThemeDefinition>(
    () => availableThemes.find((t) => t.id === theme) ?? THEMES.dark,
    [availableThemes, theme],
  );

  const onSelectFont = useCallback((id: string): void => {
    setUserFontId(id);
    setFontId(id);
    void window.ezterminalDesktop?.setFont(id);
    window.dispatchEvent(new Event('ez:theme')); // re-applies typography (PtyBlock)
  }, []);

  const onToggleEffect = useCallback(
    (id: string, on: boolean): void => {
      const next = { ...effectTogglesRef.current, [id]: on };
      setEffectToggles(next);
      void window.ezterminalDesktop?.setEffectToggles(next).catch(() => undefined);
      applyThemeVarsAndEffects(theme, {
        effectToggles: next,
        platformDefaults: DESKTOP_EFFECT_DEFAULTS,
      });
    },
    [theme, setEffectToggles],
  );

  const onChangeRollbar = useCallback(
    (partial: Partial<RollbarParams>): void => {
      const next = clampRollbarParams({ ...rollbarRef.current, ...partial });
      setRollbar(next);
      applyRollbarParams(next);
      void window.ezterminalDesktop?.setRollbar(next);
    },
    [setRollbar],
  );

  const onChangeEffectParams = useCallback(
    (effectId: keyof InterferenceParams, partial: Record<string, number | boolean>): void => {
      const next = clampInterferenceParams({
        ...interferenceRef.current,
        [effectId]: { ...interferenceRef.current[effectId], ...partial },
      });
      setInterference(next);
      applyInterferenceParams(next);
      void window.ezterminalDesktop?.setEffectParams(next);
    },
    [setInterference],
  );

  // ── UI scale (v0.2.0 D1) ──────────────────────────────────────────────────
  // Mirrors the theme mechanism directly above: applyUiScaleState sets the CSS
  // var + notifies open PtyBlocks (ui-scale.ts's applyUiScale) AND the local
  // label state; the boot fetch guards against a fast user change the same way
  // userChangedThemeRef does.
  const [uiScale, setUiScaleState] = useState<number>(UI_SCALE_DEFAULT);
  const userChangedUiScaleRef = useRef(false);

  const applyUiScaleState = useCallback((percent: number): void => {
    applyUiScale(percent);
    setUiScaleState(clampUiScale(percent));
  }, []);

  useEffect(() => {
    void window.ezterminal.getUiScale().then((percent) => {
      if (!userChangedUiScaleRef.current) applyUiScaleState(percent);
    });
  }, [applyUiScaleState]);

  const changeUiScale = useCallback(
    (percent: number): void => {
      userChangedUiScaleRef.current = true;
      applyUiScaleState(percent);
      void window.ezterminal.setUiScale(clampUiScale(percent));
    },
    [applyUiScaleState],
  );

  // ── Scrollback (WT-parity M5) ──────────────────────────────────────────────
  // Mirrors the UI scale mechanism directly above: applyScrollbackState sets
  // dataset.scrollback + notifies open PtyBlocks (scrollback.ts's
  // applyScrollback) AND the local label state; the boot fetch guards against
  // a fast user change the same way userChangedUiScaleRef does.
  const [scrollback, setScrollbackState] = useState<number>(SCROLLBACK_DEFAULT);
  const userChangedScrollbackRef = useRef(false);

  const applyScrollbackState = useCallback((lines: number): void => {
    applyScrollback(lines);
    setScrollbackState(clampScrollback(lines));
  }, []);

  useEffect(() => {
    void window.ezterminal.getScrollback().then((lines) => {
      if (!userChangedScrollbackRef.current) applyScrollbackState(lines);
    });
  }, [applyScrollbackState]);

  const changeScrollback = useCallback(
    (lines: number): void => {
      userChangedScrollbackRef.current = true;
      applyScrollbackState(lines);
      void window.ezterminal.setScrollback(clampScrollback(lines));
    },
    [applyScrollbackState],
  );

  // ── Presets (A-M4) ────────────────────────────────────────────────────────
  const [paneCount, setPaneCount] = useState(0);
  // The preset the current layout came from, for the workspace bar. Applying or
  // saving sets it; it deliberately survives a later split, because "this began
  // as Agent Desk" stays true and the alternative is a name that blinks away on
  // the first change.
  const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetNames, setPresetNames] = useState<string[]>([]);
  const [startupPreset, setStartupPreset] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');

  const applyLayoutPreset = useCallback(
    (preset: WorkbenchLayoutPreset): void => {
      const api = apiRef.current;
      if (
        !api
        || sessionMirroringCoordinator.getSnapshot().replacementLocked
      ) return;
      try {
        if (!applyWorkbenchLayoutPreset(api, preset)) return;
        const name = preset === 'two-by-one'
          ? t('workspace.layoutTwoByOne')
          : preset === 'one-plus-two'
            ? t('workspace.layoutOnePlusTwo')
            : t('workspace.layoutSingle');
        setAppliedPreset(name);
        scheduleSave();
        requestAnimationFrame(focusActivePane);
      } catch (error) {
        console.error('[renderer] could not apply workspace layout:', error);
      }
    },
    [focusActivePane, scheduleSave, sessionMirroringCoordinator, t],
  );

  const refreshPresets = useCallback(async (): Promise<void> => {
    try {
      const [names, startup] = await Promise.all([window.ezterminal.listPresets(), window.ezterminal.getStartup()]);
      setPresetNames(names);
      setStartupPreset(startup.mode === 'preset' ? (startup.presetName ?? null) : null);
    } catch {
      // Bridge unavailable — leave the current list untouched.
    }
  }, []);

  const saveCurrentAsPreset = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const name = presetNameDraft.trim();
    if (!api || !name) return;
    const ok = await window.ezterminal.savePreset(name, api.toJSON());
    if (ok) {
      setPresetNameDraft('');
      setSavingPreset(false);
      await refreshPresets();
      setAppliedPreset(name);
      pushToast({ title: t('workspace.presetSaved', { name }), variant: 'success' });
      return;
    }
    pushToast({ title: t('workspace.presetSaveFailed', { name }), variant: 'danger' });
  }, [presetNameDraft, pushToast, refreshPresets, t]);

  const applyPreset = useCallback(
    (name: string): void => {
      const showPresetStateChanged = (): void => {
        setCloseDialog({
          title: t('safetyDialog.terminalStateChangedTitle'),
          description: t('safetyDialog.terminalStateChangedDescription'),
          confirmLabel: t('common.ok'),
          onConfirm: () => setCloseDialog(null),
        });
      };
      const plan = workspaceReplacementCoordinator.prepare(agentSessionIds);
      const { creatorCount, riskCounts: counts } = plan.summary;
      const details: string[] = (Object.keys(counts) as CloseRisk[])
        .filter((risk) => counts[risk] > 0)
        .map((risk) => t('safetyDialog.riskCount', {
          count: counts[risk],
          risk: t(CLOSE_RISK_I18N_KEY[risk]),
        }));
      if (creatorCount > 0) {
        details.unshift(
          creatorCount === 1
            ? t('safetyDialog.destroyedSession', { count: creatorCount })
            : t('safetyDialog.destroyedSessions', { count: creatorCount }),
        );
      }
      setCloseDialog(
        (current) =>
          current ?? {
            title: t('safetyDialog.applyPresetTitle', { name }),
            description: t('safetyDialog.replaceWorkspaceDescription'),
            details,
            confirmLabel: t('safetyDialog.applyPreset'),
            onConfirm: () => {
              setCloseDialog(null);
              setPresetsOpen(false);
              void workspaceReplacementCoordinator.applyPreset(plan, name).then(
                (outcome) => {
                  if (outcome.kind === 'applied') {
                    setAppliedPreset(name);
                    setPaneCount(apiRef.current?.panels.length ?? 0);
                    scheduleSave();
                    focusActivePane();
                    pushToast({ title: t('workspace.presetApplied', { name }), variant: 'success' });
                    return;
                  }
                  if (outcome.kind === 'destroy-failed') {
                    setCloseDialog({
                      title:
                        outcome.reason === 'state-changed'
                          ? t('safetyDialog.terminalStateChangedTitle')
                          : t('safetyDialog.terminalStateUnavailableTitle'),
                      description: t('safetyDialog.workspaceNotReplacedDescription'),
                      confirmLabel: t('common.ok'),
                      onConfirm: () => setCloseDialog(null),
                    });
                    return;
                  }
                  if (outcome.reason === 'busy') return;
                  if (outcome.reason === 'state-changed') {
                    showPresetStateChanged();
                    return;
                  }
                  if (outcome.reason === 'preset-unavailable') {
                    setCloseDialog({
                      title: t('safetyDialog.presetUnavailableTitle'),
                      description: t('safetyDialog.presetUnavailableDescription'),
                      confirmLabel: t('common.ok'),
                      onConfirm: () => setCloseDialog(null),
                    });
                    return;
                  }
                  if (outcome.reason === 'layout-invalid') {
                    setCloseDialog({
                      title: t('safetyDialog.presetLayoutInvalidTitle'),
                      description: t('safetyDialog.presetLayoutInvalidDescription'),
                      confirmLabel: t('common.ok'),
                      onConfirm: () => setCloseDialog(null),
                    });
                    return;
                  }
                  setCloseDialog({
                    title: t('safetyDialog.presetApplyFailedTitle'),
                    description: t('safetyDialog.presetApplyFailedDescription'),
                    confirmLabel: t('common.ok'),
                    onConfirm: () => setCloseDialog(null),
                  });
                },
                () => {
                  setCloseDialog({
                    title: t('safetyDialog.presetApplyFailedTitle'),
                    description: t('safetyDialog.presetApplyFailedDescription'),
                    confirmLabel: t('common.ok'),
                    onConfirm: () => setCloseDialog(null),
                  });
                },
              );
            },
          },
      );
    },
    [
      agentSessionIds,
      focusActivePane,
      pushToast,
      scheduleSave,
      t,
      workspaceReplacementCoordinator,
    ],
  );

  const toggleStartupPreset = useCallback(
    async (name: string): Promise<void> => {
      await window.ezterminal.setStartup(
        startupPreset === name ? { mode: 'last' } : { mode: 'preset', presetName: name },
      );
      await refreshPresets();
    },
    [startupPreset, refreshPresets],
  );

  const removePreset = useCallback(
    async (name: string): Promise<void> => {
      await window.ezterminal.deletePreset(name);
      if (startupPreset === name) await window.ezterminal.setStartup({ mode: 'last' });
      await refreshPresets();
      pushToast({ title: t('workspace.presetDeleted', { name }), variant: 'info' });
    },
    [pushToast, refreshPresets, startupPreset, t],
  );

  const openSavePresetDialog = useCallback((): void => {
    setPresetsOpen(true);
    setSavingPreset(true);
  }, []);

  // ── Quick Open: renderer composition over narrow main/pane seams ──────────
  const [quickOpenMode, setQuickOpenMode] = useState<QuickOpenMode | null>(null);
  const [quickOpenQuery, setQuickOpenQuery] = useState('');
  const [quickOpenActionMessage, setQuickOpenActionMessage] = useState<string | null>(null);
  const [quickCommands, setQuickCommands] = useState<readonly QuickCommand[]>([]);
  const [fileSearchRows, setFileSearchRows] = useState<readonly AppQuickOpenRow[]>([]);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchMessage, setFileSearchMessage] = useState<string | null>(null);
  const fileSearchSequenceRef = useRef(0);
  const [, bumpPaneRegistryRevision] = useState(0);
  const [agentIntegrations, setAgentIntegrations] = useState<readonly AgentIntegrationStatus[]>([]);
  const [genericAgentProfiles, setGenericAgentProfiles] = useState<readonly GenericAgentProfile[]>([]);

  useEffect(() => subscribePaneRegistry(() => bumpPaneRegistryRevision((revision) => revision + 1)), []);

  const paneSnapshots = listPaneSnapshots();
  const activePaneSnapshot = paneSnapshots.find((pane) => pane.panelId === activePanelId) ?? null;
  const activeWorkspaceRoot = activePaneSnapshot?.cwd.trim() ?? '';
  const recentPanelItems = useMemo<readonly RecentPanelSwitcherItem[]>(() => {
    if (!recentPanelSwitch) return [];
    const snapshots = new Map(paneSnapshots.map((pane) => [pane.panelId, pane] as const));
    return recentPanelSwitch.panelIds.flatMap((panelId) => {
      const panel = apiRef.current?.getPanel(panelId);
      if (!panel) return [];
      const snapshot = snapshots.get(panelId);
      const statuses: string[] = [];
      if (panelId === recentPanelSwitch.originPanelId) statuses.push(t('recentPanels.statuses.current'));
      if (snapshot?.sessionBindingPending) statuses.push(t('recentPanels.statuses.connecting'));
      if (snapshot?.isBusy) statuses.push(t('recentPanels.statuses.busy'));
      if (snapshot?.draft.trim()) statuses.push(t('recentPanels.statuses.draft'));
      if (snapshot?.hasSshPrompt) statuses.push(t('recentPanels.statuses.sshPrompt'));
      if (snapshot?.isDead) statuses.push(t('recentPanels.statuses.ended'));
      const agentStatus = agentTabStatuses.get(panelId);
      if (agentStatus && agentStatus !== 'done') {
        statuses.push(t('recentPanels.agentStatus', { status: t(`agentHub.status.${agentStatus}`) }));
      }
      if (crashInfo && panel.api.component === 'terminal') {
        statuses.push(t('recentPanels.statuses.interpreterUnavailable'));
      }
      return [
        {
          panelId,
          title:
            panel.api.title?.trim()
            || (panel.api.component === 'terminal'
              ? t('recentPanels.terminal')
              : t('recentPanels.workspacePanel')),
          detail:
            snapshot?.cwd.trim() ||
            (panel.api.component === 'terminal'
              ? t('recentPanels.workingDirectoryUnavailable')
              : t('recentPanels.workspacePanel')),
          statuses,
        },
      ];
    });
  }, [agentTabStatuses, crashInfo, paneSnapshots, recentPanelSwitch, t]);

  const closeQuickOpen = useCallback((): void => {
    setQuickOpenMode(null);
    setQuickOpenQuery('');
    setQuickOpenActionMessage(null);
    setFileSearchMessage(null);
  }, []);

  const refreshAgentLaunchers = useCallback(async (): Promise<void> => {
    try {
      const snapshot = await rendererCapabilities.agentIntegrations.load();
      if (!snapshot) return;
      setAgentIntegrations(snapshot.integrations);
      setGenericAgentProfiles(snapshot.settings.genericProfiles);
    } catch {
      // Launcher discovery is optional; the existing launcher list remains usable.
    }
  }, []);

  useEffect(() => {
    void refreshAgentLaunchers();
  }, [refreshAgentLaunchers]);

  const openQuickOpen = useCallback(
    (mode: QuickOpenMode): void => {
      quickPreviewSequenceRef.current += 1;
      setQuickPreview(null);
      setQuickOpenMode(mode);
      setQuickOpenQuery('');
      setQuickOpenActionMessage(null);
      setFileSearchMessage(null);
      void refreshPresets();
      void refreshAgentLaunchers();
    },
    [refreshAgentLaunchers, refreshPresets],
  );

  useEffect(() => {
    const desktop = window.ezterminalDesktop;
    if (!desktop || typeof desktop.listQuickCommands !== 'function') return;
    let alive = true;
    let receivedPush = false;
    const unsubscribe =
      typeof desktop.onQuickCommandsChanged === 'function'
        ? desktop.onQuickCommandsChanged((commands) => {
            receivedPush = true;
            if (alive) setQuickCommands(commands);
          })
        : undefined;
    void desktop
      .listQuickCommands()
      .then((commands) => {
        if (alive && !receivedPush) setQuickCommands(commands);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const upsertQuickCommand = useCallback((command: QuickCommand): void => {
    setQuickCommands((current) => [command, ...current.filter((candidate) => candidate.id !== command.id)]);
  }, []);

  const createQuickCommand = useCallback(
    async (input: QuickCommandInput): Promise<QuickCommandManageResult> => {
      const desktop = window.ezterminalDesktop;
      if (!desktop || typeof desktop.createQuickCommand !== 'function') {
        return { ok: false, message: t('quickCommands.unavailable') };
      }
      const result = await desktop.createQuickCommand(input);
      if (result.ok) upsertQuickCommand(result.command);
      return quickCommandManageResult(result);
    },
    [quickCommandManageResult, t, upsertQuickCommand],
  );

  const updateQuickCommand = useCallback(
    async (id: string, input: QuickCommandInput): Promise<QuickCommandManageResult> => {
      const desktop = window.ezterminalDesktop;
      if (!desktop || typeof desktop.updateQuickCommand !== 'function') {
        return { ok: false, message: t('quickCommands.unavailable') };
      }
      const result = await desktop.updateQuickCommand(id, input);
      if (result.ok) upsertQuickCommand(result.command);
      return quickCommandManageResult(result);
    },
    [quickCommandManageResult, t, upsertQuickCommand],
  );

  const deleteQuickCommand = useCallback(
    async (id: string): Promise<QuickCommandManageResult> => {
      const desktop = window.ezterminalDesktop;
      if (!desktop || typeof desktop.deleteQuickCommand !== 'function') {
        return { ok: false, message: t('quickCommands.unavailable') };
      }
      const result = await desktop.deleteQuickCommand(id);
      if (result.ok) setQuickCommands((current) => current.filter((command) => command.id !== id));
      return quickCommandManageResult(result);
    },
    [quickCommandManageResult, t],
  );

  const desktopCapabilityAvailable =
    rendererCapabilities.snapshot().desktop === 'available';
  const quickCommandManager = useMemo<QuickCommandManagerConfig | undefined>(
    () =>
      desktopCapabilityAvailable
        ? {
            commands: quickCommands,
            onCreate: createQuickCommand,
            onUpdate: updateQuickCommand,
            onDelete: deleteQuickCommand,
          }
        : undefined,
    [
      createQuickCommand,
      deleteQuickCommand,
      desktopCapabilityAvailable,
      quickCommands,
      updateQuickCommand,
    ],
  );

  const runAvailabilityNote = activePaneSnapshot?.isBusy
    ? t('commandCenter.runUnavailableBusy')
    : activePaneSnapshot?.draft.trim()
      ? t('commandCenter.runUnavailableDraft')
      : null;
  const insertDisabledReason = !activePaneSnapshot
    ? t('commandCenter.selectPaneFirst')
    : activePaneSnapshot.isDead
      ? t('commandCenter.paneFailure.dead')
      : undefined;

  // Sessions that outlived their pane. "Keep running" would otherwise strand a
  // PTY with no route back: the mirror only reacts to add/remove events, so
  // nothing re-surfaces a session whose pane simply went away.
  const [backgroundSessions, setBackgroundSessions] = useState<readonly SessionInfo[]>([]);
  useEffect(() => {
    if (quickOpenMode === null) return;
    let alive = true;
    void window.ezterminal.listSessions().then((sessions) => {
      if (alive) setBackgroundSessions(sessions);
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [quickOpenMode]);

  // Filtered at render against the current panes rather than inside the fetch
  // callback. "No pane is showing this session" is the definition, and pane
  // teardown is asynchronous: resolving the list first would race the removal
  // and hide a session that had in fact just been left running.
  const backgroundSessionRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    const shown = new Set(
      paneSnapshots.map((pane) => pane.sessionId).filter((id): id is string => id !== null),
    );
    return backgroundSessions
      .filter((session) => !shown.has(session.sessionId))
      .map((session) => ({
        id: session.sessionId,
        kind: 'background-session',
        title: session.cwd || t('commandCenter.cwdUnavailable'),
        detail: t('commandCenter.reclaimSession'),
        target: { type: 'background-session', sessionId: session.sessionId },
      }));
  }, [backgroundSessions, paneSnapshots, t]);

  const paneRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      paneSnapshots.map((pane) => {
        const state: string[] = [];
        if (pane.panelId === activePanelId) state.push(t('commandCenter.paneState.active'));
        if (pane.isBusy) state.push(t('commandCenter.paneState.busy'));
        if (pane.draft.trim()) state.push(t('commandCenter.paneState.draft'));
        if (pane.isDead) state.push(t('commandCenter.paneState.ended'));
        return {
          id: pane.panelId,
          kind: 'pane',
          title: apiRef.current?.getPanel(pane.panelId)?.api.title ?? t('mobile.terminal'),
          detail: [pane.cwd || t('commandCenter.cwdUnavailable'), ...state].join(' · '),
          target: { type: 'pane', panelId: pane.panelId },
        };
      }),
    [activePanelId, paneSnapshots, t],
  );

  const historyRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    if (!activePaneSnapshot) return [];
    return recentDistinctCommands(activePaneSnapshot.history).map((command, index) => ({
      id: `${activePaneSnapshot.panelId}-${index}`,
      kind: 'history',
      title: command,
      detail: [t('commandCenter.activePaneHistory'), runAvailabilityNote].filter(Boolean).join(' · '),
      disabledReason: insertDisabledReason,
      target: { type: 'command', command },
    }));
  }, [activePaneSnapshot, insertDisabledReason, runAvailabilityNote, t]);

  const sortedQuickCommands = useMemo(
    () => [...quickCommands].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [quickCommands],
  );
  const quickCommandRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      sortedQuickCommands.map((command) => ({
        id: command.id,
        kind: 'quick-command',
        title: command.name,
        detail: [command.description, command.command, runAvailabilityNote].filter(Boolean).join(' · '),
        disabledReason: insertDisabledReason,
        target: { type: 'command', command: command.command },
      })),
    [insertDisabledReason, runAvailabilityNote, sortedQuickCommands],
  );

  const actionRows = useMemo<readonly AppQuickOpenRow[]>(
    () => buildCommandCenterActionRows(t, openclawVisible),
    [openclawVisible, t],
  );

  const presetRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      presetNames.map((name) => ({
        id: name,
        kind: 'preset',
        title: name,
        detail: t('commandCenter.applyPreset'),
        target: { type: 'preset', name },
      })),
    [presetNames, t],
  );

  const agentLaunchers = useMemo<readonly AgentLauncher[]>(() => {
    const integrationDetail = (provider: 'codex' | 'claude'): string => {
      const integration = agentIntegrations.find((candidate) => candidate.provider === provider);
      if (!integration) return t('commandCenter.agents.launchInPane');
      if (integration.enabled) return t('commandCenter.agents.hookEnabled');
      if (integration.blockers.length > 0) {
        return t('commandCenter.agents.hookUnavailable', {
          reason: integration.blockers[0],
        });
      }
      return t('commandCenter.agents.hookDisabled');
    };
    return [
      {
        id: 'codex',
        title: t('commandCenter.agents.launchNamed', { name: 'Codex' }),
        command: 'codex',
        detail: integrationDetail('codex'),
        sourceLabel: 'Codex',
      },
      {
        id: 'claude',
        title: t('commandCenter.agents.launchNamed', { name: 'Claude' }),
        command: 'claude',
        detail: integrationDetail('claude'),
        sourceLabel: 'Claude',
      },
      ...genericAgentProfiles
        .filter((profile) => profile.enabled && profile.executable.trim())
        .map((profile) => ({
          id: `generic-${profile.id}`,
          title: t('commandCenter.agents.launchNamed', { name: profile.name }),
          command: profile.executable,
          detail: t('commandCenter.agents.genericDetail', {
            executable: profile.executable,
          }),
          sourceLabel: t('commandCenter.kinds.agent'),
        })),
    ];
  }, [agentIntegrations, genericAgentProfiles, t]);

  const agentRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      agentLaunchers.map((agent) => ({
        id: agent.id,
        kind: 'agent',
        title: agent.title,
        detail: [agent.detail, runAvailabilityNote].filter(Boolean).join(' · '),
        sourceLabel: agent.sourceLabel,
        disabledReason: insertDisabledReason,
        target: { type: 'command', command: agent.command },
      })),
    [agentLaunchers, insertDisabledReason, runAvailabilityNote],
  );

  useEffect(() => {
    setFileSearchRows([]);
    setFileSearchMessage(null);
    setFileSearchLoading(false);
    const query = quickOpenQuery.trim();
    const desktop = window.ezterminalDesktop;
    if (
      quickOpenMode !== 'all' ||
      !query ||
      !activeWorkspaceRoot ||
      !desktop ||
      typeof desktop.searchWorkspaceFiles !== 'function'
    ) {
      return;
    }

    let cancelled = false;
    let requestId: string | null = null;
    setFileSearchLoading(true);
    const timer = setTimeout(() => {
      fileSearchSequenceRef.current += 1;
      requestId = `quick-open-${Date.now()}-${fileSearchSequenceRef.current}`;
      void desktop
        .searchWorkspaceFiles({ requestId, root: activeWorkspaceRoot, query })
        .then((result) => {
          if (cancelled || result.requestId !== requestId) return;
          setFileSearchLoading(false);
          if (!result.ok) {
            if (result.error !== 'cancelled') setFileSearchMessage(result.message);
            return;
          }
          setFileSearchRows(
            result.matches.map((match) => ({
              id: match.relativePath,
              kind: 'file',
              title: match.basename,
              detail: match.relativePath,
              target: {
                type: 'file',
                path: workspaceFilePath(result.root, match.relativePath),
              },
            })),
          );
        })
        .catch(() => {
          if (!cancelled) {
            setFileSearchLoading(false);
            setFileSearchMessage(t('commandCenter.workspaceSearchFailed'));
          }
        });
    }, WORKSPACE_FILE_SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (requestId && typeof desktop.cancelWorkspaceFileSearch === 'function') {
        desktop.cancelWorkspaceFileSearch(requestId);
      }
    };
  }, [activeWorkspaceRoot, quickOpenMode, quickOpenQuery, t]);

  const localQuickOpenRows = useMemo<readonly AppQuickOpenRow[]>(
    () =>
      quickOpenMode === 'all'
        ? [
          ...paneRows,
          ...backgroundSessionRows,
          ...historyRows,
          ...quickCommandRows,
          ...actionRows,
          ...presetRows,
          ...agentRows,
        ]
        : [...historyRows, ...quickCommandRows, ...actionRows, ...presetRows, ...agentRows],
    [
      actionRows,
      agentRows,
      backgroundSessionRows,
      historyRows,
      paneRows,
      presetRows,
      quickCommandRows,
      quickOpenMode,
    ],
  );

  const quickOpenRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    const query = quickOpenQuery.trim();
    if (!query) return [];
    const localMatches = localQuickOpenRows.filter(
      (row) => subsequenceMatch(row.title, query) || Boolean(row.detail && subsequenceMatch(row.detail, query)),
    );
    return quickOpenMode === 'all' ? [...localMatches, ...fileSearchRows] : localMatches;
  }, [fileSearchRows, localQuickOpenRows, quickOpenMode, quickOpenQuery]);

  const quickOpenEmptyRows = useMemo<readonly AppQuickOpenRow[]>(() => {
    const recentHistory = historyRows.slice(0, 5).map((row) => ({
      ...row,
      groupLabel: t('commandCenter.groups.recentHistory'),
    }));
    const recentQuick = quickCommandRows.slice(0, 5).map((row) => ({
      ...row,
      groupLabel: t('commandCenter.groups.recentQuickCommands'),
    }));
    // Backgrounded sessions belong in the empty state, not behind a guessed
    // search term: something still running with no pane should be the first
    // thing the Command Center offers, not something you have to look for.
    return quickOpenMode === 'all'
      ? [
        ...paneRows,
        ...backgroundSessionRows,
        ...recentHistory,
        ...recentQuick,
        ...actionRows,
        ...presetRows,
        ...agentRows,
      ]
      : [...recentHistory, ...recentQuick, ...actionRows, ...presetRows, ...agentRows];
  }, [
    actionRows,
    agentRows,
    backgroundSessionRows,
    historyRows,
    paneRows,
    presetRows,
    quickCommandRows,
    quickOpenMode,
    t,
  ]);

  const loadQuickPreview = useCallback(
    async (path: string): Promise<void> => {
      quickPreviewSequenceRef.current += 1;
      const sequence = quickPreviewSequenceRef.current;
      const result = await window.ezterminal.readFilePreview(path).catch((): FilePreviewResult => ({
        ok: false,
        error: t('terminalFiles.previewLoadFailed'),
      }));
      if (sequence === quickPreviewSequenceRef.current) setQuickPreview({ path, result });
    },
    [t],
  );

  const closeQuickPreview = useCallback((): void => {
    quickPreviewSequenceRef.current += 1;
    setQuickPreview(null);
  }, []);

  const applyTextToActivePane = useCallback(
    (text: string, run: boolean): boolean => {
      const handle = activePanelId ? getPaneHandle(activePanelId) : undefined;
      if (!handle) {
        setQuickOpenActionMessage(t('commandCenter.paneFailure.unavailable'));
        return false;
      }
      const result = run ? handle.runText(text) : handle.insertText(text);
      const message = paneActionMessage(result);
      if (message) {
        setQuickOpenActionMessage(message);
        return false;
      }
      closeQuickOpen();
      return true;
    },
    [activePanelId, closeQuickOpen, paneActionMessage, t],
  );

  const onQuickOpenAction = useCallback(
    (row: QuickOpenRow, variant: QuickOpenActionVariant): void => {
      const target = (row as AppQuickOpenRow).target;
      setQuickOpenActionMessage(null);
      if (target.type === 'pane') {
        workbenchCoordinator.activatePanel(target.panelId);
        closeQuickOpen();
        return;
      }
      if (target.type === 'background-session') {
        // Same adoption path the session mirror uses for a session that appears
        // on another surface.
        workbenchCoordinator.openTerminal({ adoptSessionId: target.sessionId });
        closeQuickOpen();
        return;
      }
      if (target.type === 'file') {
        if (variant === 'shift-enter') {
          applyTextToActivePane(quoteEzArgument(target.path), false);
        } else if (variant === 'mod-enter') {
          setQuickOpenActionMessage(t('commandCenter.fileCannotRun'));
        } else {
          closeQuickOpen();
          void loadQuickPreview(target.path);
        }
        return;
      }
      if (target.type === 'command') {
        applyTextToActivePane(target.command, variant === 'mod-enter');
        return;
      }
      if (target.type === 'preset') {
        closeQuickOpen();
        void applyPreset(target.name);
        return;
      }

      closeQuickOpen();
      switch (target.action) {
        case 'new-tab':
          addTab();
          break;
        case 'split-right':
          splitActive('right');
          break;
        case 'split-down':
          splitActive('below');
          break;
        case 'cycle-theme':
          cycleTheme();
          break;
        case 'save-preset':
          openSavePresetDialog();
          break;
        case 'open-explorer':
          setSidebarDestination('explorer');
          break;
        case 'open-agents':
          setSidebarDestination('agents');
          break;
        case 'open-monitor':
          setSidebarDestination('monitor');
          break;
        case 'open-remote':
          setSidebarDestination('remote');
          break;
        case 'open-openclaw':
          if (openclawVisible) setSidebarDestination('openclaw');
          break;
        case 'open-settings':
          setSettingsCategoryRequest((current) => ({ category: 'general', id: current.id + 1 }));
          setSidebarDestination('settings');
          break;
        case 'toggle-locale': {
          const korean = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('ko');
          void updatePreferences({ locale: korean ? 'en' : 'ko' });
          break;
        }
      }
    },
    [
      addTab,
      applyPreset,
      applyTextToActivePane,
      closeQuickOpen,
      cycleTheme,
      i18n,
      loadQuickPreview,
      openclawVisible,
      openSavePresetDialog,
      splitActive,
      t,
      updatePreferences,
      workbenchCoordinator,
    ],
  );

  // OpenClaw chat overlay derivation (declared here since it depends on every
  // overlay flag above, several of which are declared later in the file than
  // its doc comment further up) — see that comment for the "why".
  const chatOverlayOpen =
    (!sidebarReflow && sidebarDestination !== null) ||
    presetsOpen ||
    quickOpenMode !== null ||
    quickPreview !== null ||
    closeDialog !== null ||
    auxiliaryCloseDialog !== null;

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      const api = event.api;
      popoutBehaviorRef.current?.dispose();
      popoutBehaviorRef.current = installDockviewPopoutBehavior(api, {
        onOpenFailed: () => pushToast({
          title: t('workspace.popoutFailed'),
          variant: 'danger',
        }),
        onPanelMovedAcrossWindows: (panelId) => {
          const pane = getPaneHandle(panelId);
          if (pane) return pane.focus();
          api.focus();
          return true;
        },
      });
      const attachment = workbenchCoordinator.attach(createDockviewWorkbenchAdapter(api));
      sessionMirroringConnectionRef.current?.();
      sessionMirroringConnectionRef.current = sessionMirroringCoordinator.connect();
      // Test seam: e2e drives programmatic panel moves through this handle. dockview's
      // mouse drag is native HTML5 DnD (not Playwright-drivable); panel.api.moveTo(...)
      // uses the identical move engine a drag invokes.
      (window as Window & { __ezDock?: DockviewApi }).__ezDock = api;

      // e2e seam: deterministically persist NOW (cancel the debounce, save,
      // await main's write chain) instead of polling the file from the test.
      (window as Window & { __ezLayoutFlush?: () => Promise<void> }).__ezLayoutFlush = () =>
        workbenchCoordinator.flushLayoutSave();

      void runLayoutTransaction(pickCapabilitySafeStartupLayout, {
        quarantineOnCorrupt: true,
        restoreBackupOnFailure: false,
      }).then(() => {
        // Attach the save listener only after the restore settled (B2/B3), and
        // only if this dockview instance is still the live one (StrictMode).
        if (!attachment.isCurrent()) return;
        attachment.enableLayoutPersistence();
        scheduleSave(); // persist the restored/initial state
        setLayoutReady(true);
      });
      void refreshPresets();
    },
    [
      pickCapabilitySafeStartupLayout,
      pushToast,
      refreshPresets,
      runLayoutTransaction,
      scheduleSave,
      sessionMirroringCoordinator,
      t,
      workbenchCoordinator,
    ],
  );

  // Ctrl+Tab is owned by the pane switcher in capture phase. Keeping this
  // listener separate from command shortcuts makes modifier-release commit
  // and blur cancellation deterministic and prevents the chord reaching PTY.
  useEffect(() => {
    // The DOM listener is the safe fallback for renderer hosts that do deliver
    // Ctrl+Tab. Electron/Chromium reserves it, so desktop also supplies the
    // equivalent data-free event through `before-input-event` + preload.
    const uninstallRendererBindings = installRecentPanelKeybindings(window, {
      isOpen: () => workbenchCoordinator.isRecentPanelSwitchOpen(),
      cycle: cycleRecentPanel,
      commit: commitRecentPanelSwitch,
      cancel: cancelRecentPanelSwitch,
    });
    const unsubscribeNativeInput = window.ezterminalDesktop?.onRecentPanelInput((event) => {
      if (event.type === 'cycle') cycleRecentPanel(event.reverse);
      else if (event.type === 'commit') commitRecentPanelSwitch();
      else cancelRecentPanelSwitch(event.restoreFocus);
    });
    return () => {
      uninstallRendererBindings();
      unsubscribeNativeInput?.();
    };
  }, [cancelRecentPanelSwitch, commitRecentPanelSwitch, cycleRecentPanel, workbenchCoordinator]);

  // Ctrl/Cmd+K is contextual: app chrome opens all Command Center results,
  // while xterm and the terminal composer retain readline kill-to-end-of-line.
  // Ctrl/Cmd+Shift+P remains the global fallback from every focus surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const commandCenterMode = commandCenterShortcutMode(e);
      if (commandCenterMode) {
        e.preventDefault();
        e.stopPropagation();
        openQuickOpen(commandCenterMode);
        return;
      }
      if (e.metaKey || e.ctrlKey || !e.altKey || !e.shiftKey) return;
      if (e.code === 'Equal') {
        e.preventDefault();
        e.stopPropagation();
        splitActive('right');
      } else if (e.code === 'Minus') {
        e.preventDefault();
        e.stopPropagation();
        splitActive('below');
      }
    };
    return addAppWindowEventListener('keydown', onKey as EventListener, true);
  }, [openQuickOpen, splitActive]);

  const quickCommandShelfValue = useMemo<QuickCommandShelfContextValue>(
    () => ({
      commands: quickCommands,
      onManage: () => openQuickOpen('commands'),
    }),
    [openQuickOpen, quickCommands],
  );

  const workspaceTabActionValue = useMemo<WorkspaceTabActionContextValue>(
    () => ({
      split: (panelId, direction) => openPanel({ referencePanel: panelId, direction }),
      titleChanged: scheduleSave,
    }),
    [openPanel, scheduleSave],
  );

  const projectReviewNavigationValue = useMemo<ProjectReviewNavigationContextValue>(
    () => ({ openHistoryReview: openSessionHistoryReview }),
    [openSessionHistoryReview],
  );

  const sidebarTitle: Record<SidebarDestination, string> = {
    explorer: t('rail.explorer'),
    agents: t('rail.agents'),
    monitor: t('rail.monitor'),
    remote: t('rail.remote'),
    openclaw: 'OpenClaw',
    settings: t('rail.settings'),
  };
  // Live sublabels. The shell has always had the slot; nothing filled it, so a
  // destination could only ever say its own name.
  const sidebarDescription: Partial<Record<SidebarDestination, string>> = {
    agents: agentSnapshot.items.length > 0
      ? t('agentHub.tracked', { value: agentSnapshot.items.length })
      : undefined,
    remote: remoteDesktopStatus?.controllerName
      ? t('statusBar.mirror', { name: remoteDesktopStatus.controllerName })
      : undefined,
  };
  const sidebarContent =
    sidebarDestination === 'explorer' ? (
      <ExplorerWorkbench
        activePanelId={activePanelId}
        onOpenTerminalAt={onOpenTerminalAt}
      />
    ) : sidebarDestination === 'agents' ? (
      <AgentHub
        snapshot={agentSnapshot}
        onFocusSession={focusAgentSession}
        onSendFollowup={(activityId, text) => window.ezterminal.sendAgentFollowup(activityId, text)}
        onDecideApproval={(activityId, approvalId, decision) =>
          window.ezterminal.decideAgentApproval(activityId, approvalId, decision)}
        onLoadDiff={(directory) => window.ezterminal.getGitDiff(directory)}
        onOpenProjectReview={openActivityReview}
        onReadGitStatus={(directory) => window.ezterminal.getGitStatus(directory)}
        onOpenHistorySession={openAgentHistorySession}
        onOpenHistoryReview={(session, project) => void openHistoryReview(session, project)}
        onOpenProjectDocument={openProjectDocument}
        activeProjectId={activeProjectId}
        onActiveProjectIdChange={setActiveProjectId}
        projectWorkspaceState={activeProjectId ? projectWorkspaceStates[activeProjectId] : undefined}
        onProjectWorkspaceStateChange={(state) => {
          if (!activeProjectId) return;
          setProjectWorkspaceStates((current) => ({ ...current, [activeProjectId]: state }));
        }}
        onLaunchAgent={launchAgent}
        onOpenAgentSettings={() => {
          setSettingsCategoryRequest((current) => ({ category: 'agents', id: current.id + 1 }));
          setSidebarDestination('settings');
        }}
        onClose={() => setSidebarDestination(null)}
      />
    ) : sidebarDestination === 'monitor' ? (
      <StatusPanel />
    ) : sidebarDestination === 'remote' ? (
      <RemotePanel />
    ) : sidebarDestination === 'openclaw' && openclawVisible ? (
      <OpenClawPanel onOpenChat={openOpenClawChat} />
    ) : sidebarDestination === 'settings' ? (
      <SettingsPanel
        requestedCategory={settingsCategoryRequest.category}
        categoryRequestId={settingsCategoryRequest.id}
        uiScale={uiScale}
        onChangeUiScale={changeUiScale}
        scrollback={scrollback}
        onChangeScrollback={changeScrollback}
        terminalRendererPreference={terminalRendererPreference}
        onChangeTerminalRendererPreference={changeTerminalRendererPreference}
        confirmRiskyPaneClose={confirmRiskyPaneClose}
        onChangeConfirmRiskyPaneClose={changeConfirmRiskyPaneClose}
        bootIntro={bootIntro}
        onChangeBootIntro={changeBootIntro}
        allowOsc52Clipboard={allowOsc52Clipboard}
        onChangeAllowOsc52Clipboard={changeAllowOsc52Clipboard}
        terminalPastePreferences={terminalPastePreferences}
        onChangeTerminalPastePreferences={changeTerminalPastePreferences}
        theme={theme}
        onSelectTheme={selectTheme}
        availableThemes={availableThemes}
        onImportTheme={onImportTheme}
        fontId={fontId}
        onSelectFont={onSelectFont}
        activeThemeEffects={activeThemeDef.effects ?? []}
        effectToggles={effectToggles}
        onToggleEffect={onToggleEffect}
        rollbar={rollbar}
        onChangeRollbar={onChangeRollbar}
        interference={interference}
        onChangeEffectParams={onChangeEffectParams}
        appUpdateController={appUpdateController}
      />
    ) : null;

  return (
    <main className="app">
      <AppHeader
        appVersion={rendererCapabilities.runtimeVersions()?.app ?? null}
        attentionCount={Math.max(attentionCount, unreadAgentIds.size)}
        commandCenterOpen={quickOpenMode !== null}
        effectIntensity={uiPreferences.effectIntensity}
        onNewTerminal={addTab}
        onOpenAttention={() => setAgentsOpen((open) => !open)}
        onOpenCommandCenter={() => openQuickOpen('all')}
        onOpenEffectSettings={() => {
          setSettingsCategoryRequest((current) => ({
            category: 'appearance',
            id: current.id + 1,
          }));
          setSidebarDestination('settings');
        }}
        onWorkspaceOpenChange={(open) => {
          setPresetsOpen(open);
          setSavingPreset(false);
          if (open) void refreshPresets();
        }}
        workspaceOpen={presetsOpen}
        workspaceMenu={
          presetsOpen ? (
            <WorkspaceMenu
              names={presetNames}
              nameDraft={presetNameDraft}
              saving={savingPreset}
              startupPreset={startupPreset}
              onNameDraftChange={setPresetNameDraft}
              onSetSaving={setSavingPreset}
              onSave={() => void saveCurrentAsPreset()}
              onApply={(name) => void applyPreset(name)}
              onToggleStartup={(name) => void toggleStartupPreset(name)}
              onDelete={(name) => void removePreset(name)}
              onSplitRight={() => {
                setPresetsOpen(false);
                splitActive('right');
              }}
              onSplitDown={() => {
                setPresetsOpen(false);
                splitActive('below');
              }}
            />
          ) : undefined
        }
      />

      {remoteDesktopStatus?.controllerName && (
        <RemoteControlBanner status={remoteDesktopStatus} />
      )}

      {crashInfo && (
        <div className="crash-banner" role="alert" data-testid="crash-banner">
          <span>{t(crashInfo.recovered ? 'app.shellRecovered' : 'app.shellCrashed')}</span>
          {crashInfo.logPath && <code className="crash-banner-path">{crashInfo.logPath}</code>}
          <button
            className="btn btn-split"
            onClick={() => setCrashInfo(null)}
            title={t('common.close')}
            aria-label={t('common.close')}
            data-testid="crash-banner-dismiss"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
      )}

      <div className="workbench-body">
        <ActivityRail
          active={sidebarDestination}
          attentionCount={attentionCount}
          updateAvailable={appUpdateAvailable}
          openclawVisible={openclawVisible}
          onSelect={(destination) => {
            if (destination === 'settings' && sidebarDestination !== 'settings') {
              setSettingsCategoryRequest((current) => ({
                category: 'general',
                id: current.id + 1,
              }));
            }
            setSidebarOpen(destination, (open) => !open);
          }}
        />
        {sidebarDestination && sidebarContent && (
          <SidebarShell
            key={sidebarDestination}
            destination={sidebarDestination}
            title={sidebarTitle[sidebarDestination]}
            description={sidebarDescription[sidebarDestination]}
            width={uiPreferences.sidebarWidth}
            overlayBelow={sidebarDestination === 'agents' && projectDrillActive ? 1024 : 1200}
            onWidthChange={(sidebarWidth) => {
              void updatePreferences({ sidebarWidth }).catch(() => undefined);
            }}
            onClose={() => setSidebarDestination(null)}
          >
            {sidebarContent}
          </SidebarShell>
        )}
        <div
          className="dock-host"
          data-project-layout={projectDrillActive ? (projectWide ? 'wide' : 'narrow') : undefined}
        >
          {/* Names the layout and puts splitting one click away. The other
              entry points stay; this is the one that is always visible. */}
          <WorkspaceBar
            presetName={appliedPreset}
            paneCount={paneCount}
            onApplyTwoByOne={() => applyLayoutPreset('two-by-one')}
            onApplyOnePlusTwo={() => applyLayoutPreset('one-plus-two')}
            onApplySingle={() => applyLayoutPreset('single')}
          />
          <SessionBindingContext.Provider value={sessionBindingValue}>
            <OpenClawOverlayContext.Provider value={chatOverlayOpen}>
              <AgentTabStatusContext.Provider value={agentTabStatuses}>
                <PaneApprovalContext.Provider value={paneApprovalValue}>
                <PaneCloseContext.Provider value={paneCloseContextValue}>
                  <WorkspaceTabActionContext.Provider value={workspaceTabActionValue}>
                    <QuickCommandShelfContext.Provider value={quickCommandShelfValue}>
                      <ProjectReviewNavigationContext.Provider value={projectReviewNavigationValue}>
                        <TerminalRuntimeContext.Provider value={terminalRuntimeOptions}>
                          <PresetMutationContext.Provider value={presetMutationValue}>
                            <DockviewReact
                              className="dockview-theme-dark ez-dock"
                              components={components}
                              defaultTabComponent={AgentAwareTab}
                              rightHeaderActionsComponent={PaneHeaderMeta}
                              onReady={onReady}
                              disableFloatingGroups
                              popoutUrl={auxiliaryPopoutUrl()}
                            />
                          </PresetMutationContext.Provider>
                        </TerminalRuntimeContext.Provider>
                      </ProjectReviewNavigationContext.Provider>
                    </QuickCommandShelfContext.Provider>
                  </WorkspaceTabActionContext.Provider>
                </PaneCloseContext.Provider>
                </PaneApprovalContext.Provider>
              </AgentTabStatusContext.Provider>
            </OpenClawOverlayContext.Provider>
          </SessionBindingContext.Provider>
          {closeDialog && (
            <RiskyCloseDialog
              title={closeDialog.title}
              description={closeDialog.description}
              details={closeDialog.details}
              confirmLabel={closeDialog.confirmLabel}
              alternateLabel={closeDialog.alternateLabel}
              onAlternate={closeDialog.onAlternate}
              onCancel={() => setCloseDialog(null)}
              onConfirm={closeDialog.onConfirm}
            />
          )}
          {auxiliaryCloseDialog && (
            <AuxiliaryCloseDialog
              requestId={auxiliaryCloseDialog.request.requestId}
              paneCount={auxiliaryCloseDialog.plan.items.length}
              riskyPanes={auxiliaryCloseDialog.plan.items
                .filter((candidate) => candidate.risk !== null)
                .map((candidate) => ({
                  panelId: candidate.panelId,
                  title: candidate.title,
                  risk: t(CLOSE_RISK_I18N_KEY[candidate.risk!]),
                }))}
              busy={auxiliaryCloseDialog.busy}
              onCancel={() => {
                if (auxiliaryCloseDialog.busy) return;
                setAuxiliaryCloseDialog(null);
                void window.ezterminalDesktop?.resolveAuxiliaryClose(
                  auxiliaryCloseDialog.request.requestId,
                  'cancel',
                );
              }}
              onConfirm={(choices) => {
                if (auxiliaryCloseDialog.busy) return;
                const pending = auxiliaryCloseDialog;
                setAuxiliaryCloseDialog({ ...pending, busy: true });
                void completeAuxiliaryClose(
                  pending.request,
                  pending.targetWindow,
                  pending.plan,
                  choices,
                );
              }}
            />
          )}
          {pendingPasteConfirmation && (
            <TerminalPasteWarningDialog
              risk={pendingPasteConfirmation.risk}
              onCancel={() => settlePasteConfirmation(false)}
              onConfirm={() => settlePasteConfirmation(true)}
            />
          )}
          <FileDropOverlay activePanelId={activePanelId} agentSessionIds={agentSessionIds} />
          {recentPanelSwitch && recentPanelItems.length > 0 && (
            <RecentPanelSwitcher items={recentPanelItems} selectedPanelId={recentPanelSwitch.selectedPanelId} />
          )}
        </div>
      </div>
      {/* Always-visible footer. Sits outside .workbench-body so it spans the
          rail and the dock rather than scrolling with either. */}
      <StatusBar
        attentionCount={attentionCount}
        remoteDesktop={remoteDesktopStatus}
        effectIntensity={uiPreferences.effectIntensity}
      />

      {quickOpenMode && (
        <QuickOpenModal
          mode={quickOpenMode}
          query={quickOpenQuery}
          onQueryChange={(query) => {
            setQuickOpenQuery(query);
            setQuickOpenActionMessage(null);
          }}
          rows={quickOpenRows}
          emptyRows={quickOpenEmptyRows}
          loading={fileSearchLoading}
          loadingLabel={t('commandCenter.searchingWorkspace')}
          noResultsMessage={t('commandCenter.noResults')}
          actionMessage={quickOpenActionMessage ?? fileSearchMessage}
          onAction={onQuickOpenAction}
          onClose={closeQuickOpen}
          quickCommandManager={quickCommandManager}
        />
      )}
      {quickPreview && (
        <RichFileViewerOverlay
          path={quickPreview.path}
          result={quickPreview.result}
          line={quickPreview.line}
          column={quickPreview.column}
          onClose={closeQuickPreview}
          onInsert={() => {
            applyTextToActivePane(quoteEzArgument(quickPreview.path), false);
          }}
          onRetry={() => void loadQuickPreview(quickPreview.path)}
          onOpen={() => void window.ezterminal.openFileInApp(quickPreview.path)}
          onReveal={() => void window.ezterminal.revealFileInExplorer(quickPreview.path)}
          openExternalHttpUrl={(url) => {
            void window.ezterminalDesktop?.openExternalHttpUrl(url);
          }}
        />
      )}
    </main>
  );
}
