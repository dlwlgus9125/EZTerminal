import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from 'react';

import type { AgentActivitySnapshot } from '../../shared/agent';
import type { AgentCoordinationSnapshot } from '../../shared/agent-coordination';
import { EMPTY_GIT_DIRECTORY_STATUS } from '../../shared/git-status';
import type { QuickCommand } from '../../shared/quick-command';
import { AgentHub } from '../AgentHub';
import { BootIntroOverlay } from '../BootIntroOverlay';
import { FileExplorerPanel } from '../FileExplorerPanel';
import { AppI18nProvider, useAppTranslation } from '../i18n';
import '../index.css';
import { OpenClawChatPanel } from '../OpenClawChatPanel';
import { OpenClawPanel } from '../OpenClawPanel';
import { PaneHeaderMeta } from '../PaneHeaderMeta';
import { QuickOpenModal } from '../QuickOpenModal';
import { StatusPanel } from '../StatusPanel';
import { TerminalPane } from '../TerminalPane';
import { ToastProvider } from '../ui';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { ActivityRail } from './ActivityRail';
import { AppHeader } from './AppHeader';
import { RemotePanel } from './RemotePanel';
import { SidebarShell } from './SidebarShell';
import { StatusBar } from './StatusBar';
import type { SidebarDestination } from './types';
import { WorkspaceBar } from './WorkspaceBar';
import { WorkspaceTab } from '../WorkspaceTab';
import { DEFAULT_TERMINAL_RUNTIME_OPTIONS } from '../xterm-runtime';
import './workbench.css';
import {
  EN_CAPABILITIES,
  HANDOFF_AGENT_SESSION_ACCESS,
  KO_CAPABILITIES,
  type Locale,
  NOW,
  PairingDialogFixture,
  PasteWarningFixture,
  ProductBootFixture,
  providerSettingsCapabilities,
  type ProviderSettingsScenario,
  READ_STORY_TIME,
  REMOTE_DESKTOP_API,
  REMOTE_STATUS,
  RiskyCloseFixture,
  SettingsFixture,
  type ScheduleSettingsScenario,
  useCommandCenterStoryRows,
} from '../shell/tool-screen-fixtures';

function LocaleFrame({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const locale: Locale = document.documentElement.lang === 'ko' ? 'ko' : 'en';
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <div className="desktop-handoff-story" lang={locale}>{children}</div>
    </AppI18nProvider>
  );
}

function WorkbenchFrame({
  canvas,
  destination = null,
  sidebar,
}: {
  readonly canvas?: ReactNode;
  readonly destination?: SidebarDestination | null;
  readonly sidebar?: ReactNode;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const locale: Locale = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('ko')
    ? 'ko'
    : 'en';
  const capabilities = locale === 'en' ? EN_CAPABILITIES : KO_CAPABILITIES;
  return (
    <DesktopUiPreferencesProvider capabilities={capabilities}>
      <main className="app desktop-handoff-workbench">
        <AppHeader
          appVersion="1.0.30"
          attentionCount={2}
          commandCenterOpen={false}
          effectIntensity={7}
          onNewTerminal={() => undefined}
          onOpenAttention={() => undefined}
          onOpenCommandCenter={() => undefined}
          onOpenEffectSettings={() => undefined}
          onWorkspaceOpenChange={() => undefined}
          workspaceOpen={false}
        />
        <div className="workbench-body">
          <ActivityRail
            active={destination}
            attentionCount={2}
            openclawVisible
            onSelect={() => undefined}
          />
          {destination && sidebar && (
            <SidebarShell
              destination={destination}
              title={{
                explorer: t('rail.explorer'),
                agents: t('rail.agents'),
                monitor: t('rail.monitor'),
                remote: t('rail.remote'),
                openclaw: t('rail.openClaw'),
                settings: t('rail.settings'),
              }[destination]}
              width={380}
              onClose={() => undefined}
              onWidthChange={() => undefined}
            >
              {sidebar}
            </SidebarShell>
          )}
          <section className="desktop-handoff-workbench__canvas">
            <WorkspaceBar
              presetName="Agent Desk"
              paneCount={3}
              onApplyTwoByOne={() => undefined}
              onApplyOnePlusTwo={() => undefined}
              onApplySingle={() => undefined}
            />
            {canvas ?? <TerminalDockFixture />}
          </section>
        </div>
        <StatusBar attentionCount={2} remoteDesktop={REMOTE_STATUS} effectIntensity={7} />
      </main>
    </DesktopUiPreferencesProvider>
  );
}

const AGENTS: AgentActivitySnapshot = {
  revision: 4,
  items: [
    {
      id: 'claude-release',
      sessionId: 'session-2',
      provider: 'claude',
      cwd: 'C:\\Working\\EZTerminal',
      state: 'blocked',
      status: 'blocked',
      stateSeq: 3,
      live: true,
      interactiveReady: true,
      stateSource: 'provider-hook',
      createdAt: NOW - 184_000,
      updatedAt: NOW,
      approval: {
        approvalId: 'approval-handoff',
        toolName: 'Bash',
        command: 'pnpm test:storybook',
        risk: 'write',
        pending: true,
        requestedAt: NOW,
        expiresAt: NOW + 240_000,
      },
    },
    {
      id: 'codex-audit',
      sessionId: 'session-3',
      provider: 'codex',
      cwd: 'C:\\Working\\EZTerminal\\src',
      state: 'working',
      status: 'working',
      stateSeq: 2,
      live: true,
      interactiveReady: true,
      stateSource: 'provider-hook',
      createdAt: NOW - 412_000,
      updatedAt: NOW - 8_000,
    },
  ],
};

const AGENT_COORDINATION: AgentCoordinationSnapshot = {
  revision: 7,
  activityRevision: AGENTS.revision,
  activities: AGENTS.items.map((item) => ({
    ...item,
    projectId: 'project-ezterminal',
    rootId: 'root-ezterminal',
    workspaceId: item.id === 'claude-release' ? 'workspace-review' : 'workspace-build',
    participant: {
      participantId: item.id === 'claude-release' ? 'participant-review' : 'participant-build',
      projectId: 'project-ezterminal',
      rootId: 'root-ezterminal',
      workspaceId: item.id === 'claude-release' ? 'workspace-review' : 'workspace-build',
      worktreeId: item.id === 'claude-release' ? 'worktree-review' : 'worktree-build',
      alias: item.id === 'claude-release' ? 'Reviewer' : 'Builder',
      role: item.id === 'claude-release' ? 'release review' : 'implementation',
      task: item.id === 'claude-release' ? 'Review validation evidence' : 'Finish Agent coordination',
    },
  })),
  projects: [{
    projectId: 'project-ezterminal',
    goal: 'Ship safe human-led collaboration between Codex and Claude',
    defaultTargetBranch: 'main',
    validationCommands: [{
      id: 'unit',
      name: 'Unit tests',
      command: 'pnpm test:unit',
      timeoutMs: 600_000,
    }],
    configRevision: 3,
    counts: {
      starting: 0,
      working: 1,
      blocked: 1,
      done: 0,
      idle: 0,
      error: 0,
      unknown: 0,
    },
    participants: [
      {
        participantId: 'participant-review',
        projectId: 'project-ezterminal',
        activityId: 'claude-release',
        sessionId: 'session-2',
        rootId: 'root-ezterminal',
        workspaceId: 'workspace-review',
        worktreeId: 'worktree-review',
        alias: 'Reviewer',
        role: 'release review',
        task: 'Review validation evidence',
        provider: 'claude',
        joined: true,
        joinedAt: NOW - 184_000,
        updatedAt: NOW,
      },
      {
        participantId: 'participant-build',
        projectId: 'project-ezterminal',
        activityId: 'codex-audit',
        sessionId: 'session-3',
        rootId: 'root-ezterminal',
        workspaceId: 'workspace-build',
        worktreeId: 'worktree-build',
        alias: 'Builder',
        role: 'implementation',
        task: 'Finish Agent coordination',
        provider: 'codex',
        joined: true,
        joinedAt: NOW - 412_000,
        updatedAt: NOW - 8_000,
      },
    ],
    pendingMergeCount: 1,
  }],
  mergeRequests: [{
    requestId: 'merge-review-1',
    revision: 6,
    projectId: 'project-ezterminal',
    participantId: 'participant-build',
    activityId: 'codex-audit',
    sourceWorkspaceId: 'workspace-build',
    sourceBranch: 'agent/coordination',
    sourceHead: '1'.repeat(40),
    targetBranch: 'main',
    targetHead: '2'.repeat(40),
    candidateHead: '3'.repeat(40),
    state: 'approval-required',
    validationConfigRevision: 3,
    validations: [{
      id: 'unit',
      name: 'Unit tests',
      status: 'passed',
      startedAt: NOW - 18_000,
      finishedAt: NOW - 8_000,
      durationMs: 10_000,
      exitCode: 0,
    }],
    createdAt: NOW - 30_000,
    updatedAt: NOW - 8_000,
    expiresAt: NOW + 86_400_000,
  }],
};

function AgentHubFixture(): JSX.Element {
  return (
    <AgentHub
      snapshot={AGENTS}
      daemonAgentSessionAccess={HANDOFF_AGENT_SESSION_ACCESS}
      currentTime={NOW}
      onFocusSession={() => undefined}
      onSendFollowup={async () => ({ ok: true })}
      onDecideApproval={async () => ({ ok: true })}
      onLoadDiff={async () => ({
        ok: true,
        text: '+ deterministic diff',
        truncated: false,
        omissions: [],
      })}
      onReadGitStatus={async () => EMPTY_GIT_DIRECTORY_STATUS}
      onLaunchAgent={() => undefined}
      onOpenAgentSettings={() => undefined}
    />
  );
}

const STORY_TERMINAL_API = {
  openSessionSurface: async (surfaceId: string, intent: { kind: string; cwd?: string; sessionId?: string }) => ({
    ok: true as const,
    binding: {
      surfaceId,
      bindingId: `binding:${surfaceId}`,
      role: intent.kind === 'create' ? 'owner' as const : 'adopted' as const,
      session: {
        sessionId: intent.sessionId ?? `handoff-${intent.cwd ?? 'terminal'}`,
        cwd: intent.cwd ?? 'C:\\Working\\EZTerminal',
        createdAt: NOW,
      },
    },
  }),
  prepareSessionSurfaceClose: async () => ({
    ok: true as const,
    prepared: { closeToken: 'story-close', items: [] },
  }),
  commitSessionSurfaceClose: async () => ({ ok: true as const, keptSessionIds: [] }),
  releaseSessionSurface: async () => ({ ok: true as const }),
  terminateSessionGuarded: async () => ({ ok: true as const }),
  listSessions: async () => [],
  listRuns: async () => [],
  onRunStarted: () => () => undefined,
  onSessionDead: () => () => undefined,
  onSessionRecovered: () => () => undefined,
  runCommand: async () => undefined,
  attachRun: async () => undefined,
} as unknown as Window['ezterminal'];

function StoryTerminalRuntime({ children }: { readonly children: ReactNode }): JSX.Element {
  useLayoutEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(window, 'ezterminal');
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: STORY_TERMINAL_API,
    });
    return () => {
      if (previous) {
        Object.defineProperty(window, 'ezterminal', previous);
      } else {
        Reflect.deleteProperty(window, 'ezterminal');
      }
    };
  }, []);

  return <>{children}</>;
}

const STORY_QUICK_COMMANDS: readonly QuickCommand[] = [
  {
    id: '3b30786c-98f9-4dc2-826f-3ec8285e7062',
    name: 'Git status',
    command: 'git status --short',
    description: 'Inspect the current working tree',
    createdAt: '2026-07-28T04:00:00.000Z',
    updatedAt: '2026-07-28T04:00:00.000Z',
  },
  {
    id: 'b926d9b2-4813-4a80-a387-76f5074c54c9',
    name: 'Unit tests',
    command: 'pnpm test:unit',
    description: 'Run the desktop unit suite',
    createdAt: '2026-07-28T04:01:00.000Z',
    updatedAt: '2026-07-28T04:01:00.000Z',
  },
];

function TerminalDockPanel(props: IDockviewPanelProps): JSX.Element {
  const cwd = typeof props.params?.cwd === 'string'
    ? props.params.cwd
    : 'C:\\Working\\EZTerminal';
  const approval = props.api.id === 'handoff-claude'
    ? AGENTS.items.find((item) => item.id === 'claude-release')?.approval
    : undefined;
  return (
    <TerminalPane
      panelId={props.api.id}
      paneInstanceToken={props.api}
      initialCwd={cwd}
      mountSessionPane={(panelId, _instanceToken, initialCwd) => ({
        surfaceId: `story:${panelId}`,
        intent: { kind: 'create', cwd: initialCwd },
        bind: () => true,
        dispose: () => undefined,
      })}
      terminalRuntimeOptions={DEFAULT_TERMINAL_RUNTIME_OPTIONS}
      quickCommands={STORY_QUICK_COMMANDS}
      onManageQuickCommands={() => undefined}
      pendingApproval={approval ? { activityId: 'claude-release', approval } : undefined}
      onDecideApproval={async () => ({ ok: true })}
    />
  );
}

function StoryWorkspaceTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const status = props.api.id === 'handoff-claude'
    ? 'blocked'
    : props.api.id === 'handoff-codex'
      ? 'working'
      : undefined;
  const provider = props.api.id === 'handoff-claude'
    ? 'claude' as const
    : props.api.id === 'handoff-codex'
      ? 'codex' as const
      : undefined;
  return (
    <WorkspaceTab
      {...props}
      status={status}
      provider={provider}
      providerLabel={provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : undefined}
      requestClose={(close) => close()}
      onSplit={() => undefined}
      onMoveToNewWindow={() => undefined}
      onMoveToMainWindow={() => undefined}
      onTitleChanged={() => undefined}
    />
  );
}

const TERMINAL_DOCK_COMPONENTS = {
  terminal: TerminalDockPanel,
};

function TerminalDockFixture(): JSX.Element {
  const { t } = useAppTranslation();
  const onReady = useCallback((event: DockviewReadyEvent): void => {
    if (event.api.getPanel('handoff-powershell')) return;
    event.api.addPanel({
      id: 'handoff-powershell',
      component: 'terminal',
      title: 'PowerShell',
      params: { cwd: 'C:\\Working\\EZTerminal' },
    });
    event.api.addPanel({
      id: 'handoff-claude',
      component: 'terminal',
      title: 'Claude Code',
      params: { cwd: 'C:\\Working\\EZTerminal\\src\\renderer' },
      position: { referencePanel: 'handoff-powershell', direction: 'right' },
    });
    event.api.addPanel({
      id: 'handoff-codex',
      component: 'terminal',
      title: 'Codex',
      params: { cwd: 'C:\\Working\\EZTerminal' },
      position: { referencePanel: 'handoff-claude', direction: 'below' },
    });
  }, []);

  return (
    <StoryTerminalRuntime>
      <div
        className="desktop-handoff-dock"
        data-testid="desktop-handoff-terminal-dock"
        role="region"
        aria-label={t('workspace.currentLabel')}
      >
        <DockviewReact
          className="dockview-theme-dark ez-dock"
          components={TERMINAL_DOCK_COMPONENTS}
          defaultTabComponent={StoryWorkspaceTab}
          rightHeaderActionsComponent={PaneHeaderMeta}
          onReady={onReady}
          disableFloatingGroups
        />
      </div>
    </StoryTerminalRuntime>
  );
}

function AgentCoordinationFixture(): JSX.Element {
  return (
    <AgentHub
      snapshot={AGENTS}
      daemonAgentSessionAccess={HANDOFF_AGENT_SESSION_ACCESS}
      coordinationSnapshot={AGENT_COORDINATION}
      currentTime={NOW}
      onFocusSession={() => undefined}
      onSendFollowup={async () => ({ ok: true })}
      onDecideApproval={async () => ({ ok: true })}
      onLoadDiff={async () => ({ ok: true, text: '+ working tree diff', truncated: false, omissions: [] })}
      onLoadManagedMergeDiff={async () => ({
        ok: true,
        text: '+ immutable candidate diff',
        truncated: false,
        omissions: [],
      })}
      onReadGitStatus={async () => EMPTY_GIT_DIRECTORY_STATUS}
      onDecideManagedMerge={async () => ({ ok: true, value: AGENT_COORDINATION.mergeRequests[0]! })}
      onLaunchAgent={() => undefined}
      onOpenAgentSettings={() => undefined}
    />
  );
}

function ProjectTerminalDockFixture(): JSX.Element {
  const { t } = useAppTranslation();
  const onReady = useCallback((event: DockviewReadyEvent): void => {
    if (event.api.getPanel('handoff-powershell')) return;
    const projectSession = {
      projectId: 'handoff-project',
      projectName: 'EZTerminal',
      titleMode: 'generated' as const,
    };
    const terminal = event.api.addPanel({
      id: 'handoff-powershell',
      component: 'terminal',
      title: 'EZTerminal',
      params: { projectSession },
    });
    terminal.api.updateParameters({ projectSession });
    const claude = event.api.addPanel({
      id: 'handoff-claude',
      component: 'terminal',
      title: 'EZTerminal',
      params: { projectSession },
      position: { referencePanel: 'handoff-powershell', direction: 'right' },
    });
    claude.api.updateParameters({ projectSession });
    const codex = event.api.addPanel({
      id: 'handoff-codex',
      component: 'terminal',
      title: 'EZTerminal',
      params: { projectSession },
      position: { referencePanel: 'handoff-claude', direction: 'below' },
    });
    codex.api.updateParameters({ projectSession });
  }, []);

  return (
    <StoryTerminalRuntime>
      <div
        className="desktop-handoff-dock"
        data-testid="desktop-handoff-project-terminal-dock"
        role="region"
        aria-label={t('workspace.currentLabel')}
      >
        <DockviewReact
          className="dockview-theme-dark ez-dock"
          components={TERMINAL_DOCK_COMPONENTS}
          defaultTabComponent={StoryWorkspaceTab}
          rightHeaderActionsComponent={PaneHeaderMeta}
          onReady={onReady}
          disableFloatingGroups
        />
      </div>
    </StoryTerminalRuntime>
  );
}

function OpenClawDockPanel(props: IDockviewPanelProps): JSX.Element {
  return <OpenClawChatPanel {...props} capabilities={KO_CAPABILITIES} />;
}

const OPENCLAW_DOCK_COMPONENTS = {
  'openclaw-chat': OpenClawDockPanel,
};

function OpenClawDockFixture(): JSX.Element {
  const onReady = useCallback((event: DockviewReadyEvent): void => {
    if (event.api.getPanel('handoff-openclaw-chat')) return;
    event.api.addPanel({
      id: 'handoff-openclaw-chat',
      component: 'openclaw-chat',
      title: 'OpenClaw Chat',
    });
  }, []);
  return (
    <div className="desktop-handoff-dock" data-testid="desktop-handoff-dock">
      <DockviewReact
        className="dockview-theme-dark ez-dock"
        components={OPENCLAW_DOCK_COMPONENTS}
        onReady={onReady}
      />
    </div>
  );
}

function CommandCenterFixture(): JSX.Element {
  const rows = useCommandCenterStoryRows();
  return (
    <>
      <WorkbenchFrame />
      <QuickOpenModal
        mode="all"
        query=""
        onQueryChange={() => undefined}
        rows={rows}
        emptyRows={rows}
        onAction={() => undefined}
        onClose={() => undefined}
      />
    </>
  );
}

const meta = {
  title: 'Compositions/Desktop Handoff',
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Boot: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame destination="agents" sidebar={<AgentHubFixture />} />
      <BootIntroOverlay preview />
    </LocaleFrame>
  ),
};

export const BootReducedMotionBehavior: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame destination="agents" sidebar={<AgentHubFixture />} />
      <ProductBootFixture />
    </LocaleFrame>
  ),
};

export const WorkbenchAgentHub: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="agents"
        sidebar={<AgentHubFixture />}
      />
    </LocaleFrame>
  ),
};

export const AgentCoordination: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame destination="agents" sidebar={<AgentCoordinationFixture />} />
    </LocaleFrame>
  ),
};

export const ProjectSessionTabs: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame canvas={<ProjectTerminalDockFixture />} />
    </LocaleFrame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dock = await canvas.findByTestId('desktop-handoff-project-terminal-dock');
    const badges = await within(dock).findAllByText(/^(Terminal|Claude|Codex)$/u, {
      selector: '.project-session-tab__badge',
    });
    await expect(badges.map((badge) => badge.textContent).sort())
      .toEqual(['Claude', 'Codex', 'Terminal']);
    await expect([...dock.querySelectorAll('.project-session-tab__label')]
      .map((label) => label.textContent)).toEqual(['EZTerminal', 'EZTerminal', 'EZTerminal']);
  },
};

export const CommandCenter: Story = {
  render: () => (
    <LocaleFrame>
      <CommandCenterFixture />
    </LocaleFrame>
  ),
};

export const Monitor: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="monitor"
        sidebar={<StatusPanel capabilities={KO_CAPABILITIES} />}
      />
    </LocaleFrame>
  ),
};

export const Remote: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="remote"
        sidebar={
          <RemotePanel
            capabilities={KO_CAPABILITIES}
            desktopApi={REMOTE_DESKTOP_API}
            currentTime={NOW}
          />
        }
      />
    </LocaleFrame>
  ),
};

export const PairingQr: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="remote"
        sidebar={(
          <>
            <RemotePanel
              capabilities={KO_CAPABILITIES}
              desktopApi={REMOTE_DESKTOP_API}
              currentTime={NOW}
            />
            <PairingDialogFixture redeemed={false} />
          </>
        )}
      />
    </LocaleFrame>
  ),
};

export const PairingDetected: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="remote"
        sidebar={(
          <>
            <RemotePanel
              capabilities={KO_CAPABILITIES}
              desktopApi={REMOTE_DESKTOP_API}
              currentTime={NOW}
            />
            <PairingDialogFixture redeemed />
          </>
        )}
      />
    </LocaleFrame>
  ),
};

export const OpenclawConsole: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="openclaw"
        sidebar={(
          <OpenClawPanel
            onOpenChat={() => undefined}
            capabilities={KO_CAPABILITIES}
            readCurrentTime={READ_STORY_TIME}
          />
        )}
      />
    </LocaleFrame>
  ),
};

export const OpenclawChat: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="openclaw"
        sidebar={(
          <OpenClawPanel
            onOpenChat={() => undefined}
            capabilities={KO_CAPABILITIES}
            readCurrentTime={READ_STORY_TIME}
          />
        )}
        canvas={<OpenClawDockFixture />}
      />
    </LocaleFrame>
  ),
};

export const PasteWarning: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="agents"
        sidebar={<AgentHubFixture />}
      />
      <PasteWarningFixture />
    </LocaleFrame>
  ),
};

export const RiskyClose: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame destination="agents" sidebar={<AgentHubFixture />} />
      <RiskyCloseFixture />
    </LocaleFrame>
  ),
};

export const Settings: Story = {
  render: () => (
    <LocaleFrame>
      <WorkbenchFrame
        destination="settings"
        sidebar={<SettingsFixture />}
      />
    </LocaleFrame>
  ),
};

function ProviderSettingsStory({
  scenario,
  scheduleScenario = 'empty',
}: {
  readonly scenario: ProviderSettingsScenario;
  readonly scheduleScenario?: ScheduleSettingsScenario;
}): JSX.Element {
  useEffect(() => {
    if (scheduleScenario === 'empty') return undefined;
    const frame = requestAnimationFrame(() => {
      document.querySelector('.schedule-settings')?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [scheduleScenario]);

  return (
    <LocaleFrame>
      <WorkbenchFrame
        destination="settings"
        sidebar={(
          <SettingsFixture
            requestedCategory="agents"
            capabilities={providerSettingsCapabilities(scenario, scheduleScenario)}
          />
        )}
      />
    </LocaleFrame>
  );
}

export const ProviderSettingsMissing: Story = {
  render: () => <ProviderSettingsStory scenario="missing" />,
};

export const ProviderSettingsReview: Story = {
  render: () => <ProviderSettingsStory scenario="review" />,
};

export const ProviderSettingsClaudeApproval: Story = {
  render: () => <ProviderSettingsStory scenario="claude-approval" />,
};

export const ProviderSettingsReady: Story = {
  render: () => <ProviderSettingsStory scenario="ready" />,
};

export const ProviderSettingsError: Story = {
  render: () => <ProviderSettingsStory scenario="error" />,
};

export const ScheduleSettingsEmpty: Story = {
  render: () => <ProviderSettingsStory scenario="ready" scheduleScenario="empty-ready" />,
};

export const ScheduleSettingsReady: Story = {
  render: () => <ProviderSettingsStory scenario="ready" scheduleScenario="ready" />,
};

export const ScheduleSettingsRuntimeRequired: Story = {
  render: () => <ProviderSettingsStory scenario="ready" scheduleScenario="runtime-required" />,
};

export const ScheduleSettingsError: Story = {
  render: () => <ProviderSettingsStory scenario="ready" scheduleScenario="error" />,
};

export const EnglishWorkbench: Story = {
  render: () => (
    <LocaleFrame>
      <ToastProvider>
        <WorkbenchFrame
          destination="settings"
          sidebar={<SettingsFixture />}
        />
      </ToastProvider>
    </LocaleFrame>
  ),
};

export const ExplorerBreadcrumb: Story = {
  render: () => (
    <LocaleFrame>
      <ToastProvider>
        <WorkbenchFrame
          destination="explorer"
          sidebar={
            <FileExplorerPanel
              activePanelId={null}
              onOpenTerminalAt={() => undefined}
              capabilities={EN_CAPABILITIES}
            />
          }
        />
      </ToastProvider>
    </LocaleFrame>
  ),
};
