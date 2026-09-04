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
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import type { AgentActivitySnapshot } from '../../shared/agent';
import type { AgentCoordinationSnapshot } from '../../shared/agent-coordination';
import type { ClaudeProviderEnablement, ProviderInspection } from '../../shared/daemon-provider';
import type { DaemonProvider, DaemonSnapshot } from '../../shared/daemon-protocol';
import { EMPTY_GIT_DIRECTORY_STATUS } from '../../shared/git-status';
import type { RemoteDesktopHostStatus, SystemStatsSnapshot } from '../../shared/ipc';
import { PAIRING_CODE_TTL_MS } from '../../shared/pairing';
import type { QuickCommand } from '../../shared/quick-command';
import { DEFAULT_TERMINAL_PASTE_PREFERENCES } from '../../shared/terminal-clipboard';
import { DEFAULT_UI_PREFERENCES } from '../../shared/ui-preferences';
import { AgentHub } from '../AgentHub';
import { BootIntroOverlay } from '../BootIntroOverlay';
import { type CapabilityAccess, rendererCapabilities } from '../capability-access';
import { buildCommandCenterActionRows } from '../command-center-actions';
import { DEFAULT_INTERFERENCE_PARAMS, DEFAULT_ROLLBAR_PARAMS } from '../effect-params';
import { FileExplorerPanel } from '../FileExplorerPanel';
import { AppI18nProvider, useAppTranslation } from '../i18n';
import '../index.css';
import { OpenClawChatPanel } from '../OpenClawChatPanel';
import { OpenClawPanel } from '../OpenClawPanel';
import { PairingQrDialog } from '../PairingQrDialog';
import { PaneHeaderMeta } from '../PaneHeaderMeta';
import { QuickOpenModal } from '../QuickOpenModal';
import type { QuickOpenRow } from '../QuickOpenModal';
import { RiskyCloseDialog } from '../RiskyCloseDialog';
import { SettingsPanel } from '../SettingsPanel';
import { StatusPanel } from '../StatusPanel';
import { TerminalPane } from '../TerminalPane';
import { TerminalPasteWarningDialog } from '../TerminalPasteWarningDialog';
import { listThemes } from '../themes';
import { ToastProvider } from '../ui';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { ActivityRail } from './ActivityRail';
import { AppHeader } from './AppHeader';
import { RemotePanel, type RemotePanelDesktopApi } from './RemotePanel';
import { SidebarShell } from './SidebarShell';
import { StatusBar } from './StatusBar';
import type { SidebarDestination } from './types';
import { WorkspaceBar } from './WorkspaceBar';
import { WorkspaceTab } from '../WorkspaceTab';
import { DEFAULT_TERMINAL_RUNTIME_OPTIONS } from '../xterm-runtime';
import './workbench.css';

type Locale = 'en' | 'ko';

const NOW = 1_785_200_000_000;
const READ_STORY_TIME = (): number => NOW;
const REMOTE_STATUS: RemoteDesktopHostStatus = {
  state: 'active',
  service: 'ready',
  controllerName: 'Pixel 9 Pro',
  connectedAt: NOW - 152_000,
  localAddress: '100.86.12.4',
  peerAddress: '100.91.8.22',
  framesPerSecond: 58,
  roundTripTimeMs: 24,
  bitrateKbps: 8_400,
  qualityTier: 'balanced',
  errorCode: null,
};

const STATS: SystemStatsSnapshot = {
  at: NOW,
  cpu: { loadPct: 37, cores: [22, 48, 31, 45, 19, 53, 27, 42] },
  mem: { usedBytes: 18_790_000_000, totalBytes: 34_360_000_000 },
  memDetail: {
    availableBytes: 15_570_000_000,
    cachedBytes: 6_430_000_000,
    swapUsedBytes: 1_100_000_000,
    swapTotalBytes: 8_590_000_000,
  },
  net: { iface: 'Tailscale', rxSec: 1_420_000, txSec: 740_000 },
  disks: [{ mount: 'C:', usedBytes: 402_000_000_000, sizeBytes: 1_000_000_000_000 }],
  procs: [
    { pid: 12140, name: 'node.exe', cpuPct: 12.4, memBytes: 728_000_000 },
    { pid: 8840, name: 'pwsh.exe', cpuPct: 7.8, memBytes: 196_000_000 },
  ],
  conns: [
    { proto: 'TCP', local: '100.86.12.4:45891', peer: '100.91.8.22:8765', state: 'ESTABLISHED', process: 'EZTerminal' },
  ],
};

function storyCapabilities(locale: Locale = 'ko'): CapabilityAccess {
  const preferences = { ...DEFAULT_UI_PREFERENCES, locale };
  return {
    ...rendererCapabilities,
    snapshot: () => ({ core: 'available', desktop: 'available' }),
    runtimeVersions: () => ({
      app: '1.0.30',
      protocol: 3,
      buildSha: 'handoff',
      electron: '38',
      chrome: '140',
      node: '22',
    }),
    agentIntegrations: {
      load: async () => ({
        integrations: [
          { provider: 'claude', configPath: '.claude/settings.json', enabled: true, drift: false, needsTrust: false, blockers: [] },
          { provider: 'codex', configPath: '.codex/config.toml', enabled: false, drift: false, needsTrust: false, blockers: ['Decision hook unavailable'] },
        ],
        settings: {
          schemaVersion: 2,
          approvalGate: true,
          notifications: { waiting: true, blocked: true, error: true },
          genericProfiles: [],
        },
      }),
      setEnabled: async () => null,
      saveSettings: async (settings) => settings,
    },
    openClaw: {
      ...rendererCapabilities.openClaw,
      observeDrawer: (observer) => {
        observer.onStatus({ state: 'running', version: '2026.7.4', port: 18_789 });
        observer.onLog({ time: new Date(NOW - 2_000).toISOString(), level: 'info', message: 'gateway ready on ws://127.0.0.1:18789' });
        observer.onLog({ time: new Date(NOW - 1_000).toISOString(), level: 'info', message: 'channel telegram connected' });
        return () => undefined;
      },
      observeChat: (observer) => {
        observer.onStatus({ state: 'running', version: '2026.7.4', port: 18_789 });
        observer.onViewState({ hasError: false, loading: true });
        return () => undefined;
      },
      observeVisibility: (onVisibility) => {
        onVisibility({ mode: 'auto', visible: true });
        return () => undefined;
      },
      getStatus: async () => ({ state: 'running', version: '2026.7.4', port: 18_789 }),
      runLifecycle: async () => ({ ok: true }),
      runAutostart: async () => ({ ok: true }),
      listSessions: async () => [
        {
          key: 'telegram:release',
          sessionId: 'oc-1',
          status: 'working',
          model: 'claude-sonnet-4',
          updatedAt: NOW,
          hasActiveRun: true,
          lastChannel: 'telegram',
          totalTokens: 18_420,
        },
      ],
      getConfig: async () => ({ 'agents.defaults.model': 'claude-sonnet-4', 'gateway.port': '18789' }),
      setConfig: async () => ({ ok: true, restartRequired: true }),
      getMode: async () => 'auto',
      setMode: async () => true,
      setChatSurface: () => true,
      openChat: () => true,
      reloadChat: () => true,
      openChatExternal: async () => true,
    },
    remoteDesktop: {
      observe: (onStatus) => {
        onStatus(REMOTE_STATUS);
        return () => undefined;
      },
      disconnect: async () => true,
    },
    remoteRuntime: {
      observe: (observer) => {
        observer.onStatus({ desiredEnabled: true, state: 'running', port: 8_765, errorCode: null, error: null });
        observer.onSecurity({ state: 'ready', error: null });
        return () => undefined;
      },
      setEnabled: async (enabled) => ({
        desiredEnabled: enabled,
        state: enabled ? 'running' : 'off',
        port: 8_765,
        errorCode: null,
        error: null,
      }),
      retry: async () => ({ desiredEnabled: true, state: 'running', port: 8_765, errorCode: null, error: null }),
    },
    remotePairing: {
      observe: (observer) => {
        observer.onConnectionInfo({ urls: ['ws://100.86.12.4:8765'], port: 8_765 });
        observer.onSecurity({ state: 'ready', error: null });
        observer.onToken('not-rendered');
        observer.onRuntime({ desiredEnabled: true, state: 'running', port: 8_765, errorCode: null, error: null });
        return () => undefined;
      },
      rotateToken: async () => 'not-rendered',
    },
    systemStatus: {
      observe: (observer) => {
        observer.onSeed([{ ...STATS, at: NOW - 2_000 }, { ...STATS, at: NOW - 1_000 }, STATS]);
        return () => undefined;
      },
      capturePackets: () => () => undefined,
    },
    sshForwards: {
      list: async () => [],
      stop: async () => ({ ok: true, forwards: [] }),
    },
    uiPreferences: {
      load: async () => preferences,
      save: async (patch) => ({ ...preferences, ...patch }),
      refreshNativeMenuLocale: async () => true,
    },
    files: {
      list: async () => ({
        ok: true,
        path: 'C:\\Working\\EZTerminal',
        parent: 'C:\\Working',
        entries: [
          { name: 'src', kind: 'dir', isSymlink: false, size: 0, mtimeMs: NOW },
          { name: 'App.tsx', kind: 'file', isSymlink: false, size: 98_240, mtimeMs: NOW },
          { name: 'App.spec.tsx', kind: 'file', isSymlink: false, size: 22_840, mtimeMs: NOW },
          { name: 'package.json', kind: 'file', isSymlink: false, size: 4_820, mtimeMs: NOW },
          { name: 'README.md', kind: 'file', isSymlink: false, size: 6_410, mtimeMs: NOW },
          { name: 'terminal-preview.svg', kind: 'file', isSymlink: false, size: 12_400, mtimeMs: NOW },
          { name: 'NOTICE', kind: 'file', isSymlink: false, size: 980, mtimeMs: NOW },
        ],
      }),
      listRoots: async () => ['C:\\'],
      preview: async (path) => ({
        ok: true,
        kind: 'text',
        name: path.split(/[\\/]/u).at(-1) ?? 'file',
        mime: 'text/plain',
        content: 'deterministic handoff preview',
        truncated: false,
        fileSize: 29,
      }),
      createFolder: async () => ({ ok: true }),
      rename: async () => ({ ok: true }),
      trash: async () => ({ ok: true }),
      openInApp: async () => undefined,
      reveal: async () => undefined,
      pathForDrop: () => null,
      openExternalHttpUrl: async () => true,
      gitStatus: async () => ({
        availability: 'ready',
        tracked: true,
        branch: 'feat/handoff-completion',
        truncated: false,
        changes: [
          { path: 'App.tsx', kind: 'modified', added: 18, removed: 6 },
          { path: 'App.spec.tsx', kind: 'untracked' },
        ],
      }),
    },
  };
}

const EN_CAPABILITIES = storyCapabilities('en');
const KO_CAPABILITIES = storyCapabilities('ko');

type ProviderSettingsScenario = 'missing' | 'review' | 'claude-approval' | 'ready' | 'error';

function providerStoryInspection(
  providerId: 'codex' | 'claude',
  available: boolean,
): ProviderInspection {
  return {
    reviewDigest: `${providerId}-${available ? 'available' : 'unavailable'}-handoff-digest`,
    probe: {
      providerId,
      displayName: providerId === 'codex' ? 'Codex' : 'Claude Agent',
      protocol: providerId === 'codex' ? 'codex-app-server' : 'claude-agent-sdk',
      available,
      executablePath: available
        ? `C:\\Users\\operator\\AppData\\Local\\Programs\\${providerId}\\${providerId}.exe`
        : 'unavailable',
      executableVersion: available ? (providerId === 'codex' ? '0.45.0' : '1.0.112') : 'unavailable',
      argv: providerId === 'codex'
        ? ['app-server']
        : ['--output-format', 'stream-json', '--input-format', 'stream-json'],
      environmentVariableNames: providerId === 'codex'
        ? ['PATH', 'CODEX_HOME']
        : ['PATH', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK'],
      capabilities: ['create', 'resume', 'interrupt', 'model-change', 'approvals'],
      reviewNotices: providerId === 'claude' ? [{
        id: 'anthropic-commercial-terms',
        level: 'required',
        title: 'Anthropic commercial terms',
        message: 'Review and accept the applicable terms and commercial-use requirements.',
        url: 'https://www.anthropic.com/legal/commercial-terms',
      }, {
        id: 'anthropic-third-party-claude-ai',
        level: 'required',
        title: 'Third-party claude.ai access',
        message: 'Prior Anthropic approval is required for a third-party product to use claude.ai login or subscription rate limits.',
        url: 'https://code.claude.com/docs/en/agent-sdk/overview',
      }] : [],
      ...(!available ? {
        unavailableReason: providerId === 'claude'
          ? 'CLAUDE_PROVIDER_DISABLED: Claude Agent is disabled until its requirements are accepted.'
          : 'CODEX_EXECUTABLE_NOT_FOUND: Install Codex and check again.',
      } : {}),
    },
  };
}

function providerStoryRecord(
  inspection: ProviderInspection,
  health: DaemonProvider['health'] = 'ready',
): DaemonProvider {
  const probe = inspection.probe;
  return {
    id: probe.providerId,
    displayName: probe.displayName,
    protocol: probe.protocol,
    executablePath: probe.executablePath,
    executableVersion: probe.executableVersion,
    argv: probe.argv,
    environmentVariableNames: probe.environmentVariableNames,
    capabilities: probe.capabilities,
    enabled: true,
    health,
    ...(health === 'error' ? { healthDetail: 'The provider process exited during its health check.' } : {}),
    revision: 2,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function providerSettingsCapabilities(scenario: ProviderSettingsScenario): CapabilityAccess {
  const codex = providerStoryInspection('codex', scenario !== 'missing');
  const claudeAvailable = scenario === 'ready' || scenario === 'error';
  const claude = providerStoryInspection('claude', claudeAvailable);
  const providers: readonly DaemonProvider[] = scenario === 'ready'
    ? [providerStoryRecord(codex), providerStoryRecord(claude)]
    : scenario === 'error'
      ? [providerStoryRecord(codex, 'error')]
      : scenario === 'claude-approval'
        ? [providerStoryRecord(codex)]
        : [];
  const daemonSnapshot: DaemonSnapshot = {
    protocolVersion: 12,
    revision: 18,
    eventSequence: 42,
    generatedAt: new Date(NOW).toISOString(),
    runtime: {
      keepRunning: true,
      startAtLogin: false,
      orchestrationToolsEnabled: scenario === 'ready',
      browserEnabled: false,
    },
    projects: [],
    workspaces: [],
    sessions: [],
    agents: [],
    agentRelations: [],
    turns: [],
    transcriptHeads: [],
    approvals: [],
    providers,
    schedules: [],
    heartbeats: [],
  };
  const claudeEnablement: ClaudeProviderEnablement = scenario === 'ready' || scenario === 'error'
    ? {
        enabled: true,
        termsAccepted: true,
        commercialUseApproved: true,
        authenticationPath: 'api-key-environment',
        anthropicThirdPartyApproval: false,
      }
    : {
        enabled: false,
        termsAccepted: scenario === 'claude-approval',
        commercialUseApproved: scenario === 'claude-approval',
        authenticationPath: scenario === 'claude-approval'
          ? 'existing-claude-ai-login'
          : 'existing-cli-environment',
        anthropicThirdPartyApproval: false,
      };
  return {
    ...EN_CAPABILITIES,
    structuredProviders: {
      inspect: async (providerId) => {
        if (scenario === 'error' && providerId === 'claude') {
          return { ok: false, code: 'provider-operation-failed', message: 'Claude Agent inspection timed out.' };
        }
        return { ok: true, value: providerId === 'codex' ? codex : claude };
      },
      listModels: async () => ({ ok: true, value: [] }),
      getClaudeEnablement: async () => ({ ok: true, value: claudeEnablement }),
      setClaudeEnablement: async (value) => ({ ok: true, value }),
    },
    daemon: {
      getSnapshot: async () => daemonSnapshot,
      sendCommand: async (command) => ({
        ok: false,
        status: 'rejected',
        commandId: command.commandId,
        revision: daemonSnapshot.revision,
        error: { code: 'invalid-state', message: 'Static Storybook fixture', retryable: false },
      }),
      getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
    },
  };
}
const REMOTE_DESKTOP_API: RemotePanelDesktopApi = {
  getPairingCode: async () => ({ code: '7C2F-91KD', expiresAt: NOW + PAIRING_CODE_TTL_MS }),
  issuePairingCode: async () => ({ code: '7C2F-91KD', expiresAt: NOW + PAIRING_CODE_TTL_MS }),
  listRemoteDevices: async () => [{
    clientId: 'pixel-9-pro',
    clientName: 'Pixel 9 Pro',
    platform: 'android',
    connected: true,
    lastSeenAt: NOW,
  }],
  onPairingCodeChanged: () => () => undefined,
  onPairingRedeemed: () => () => undefined,
};

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
  const { t } = useAppTranslation();
  const rows = useMemo<readonly QuickOpenRow[]>(() => [
    {
      id: 'handoff-pane',
      kind: 'pane',
      title: 'PowerShell',
      detail: 'C:\\Working\\EZTerminal',
    },
    {
      id: 'handoff-background',
      kind: 'background-session',
      title: 'pnpm test:storybook',
      detail: t('commandCenter.kinds.background-session'),
    },
    {
      id: 'handoff-file',
      kind: 'file',
      title: 'src/renderer/App.tsx',
      detail: 'C:\\Working\\EZTerminal\\src\\renderer\\App.tsx',
    },
    {
      id: 'handoff-history',
      kind: 'history',
      title: 'git status --short',
      detail: t('commandCenter.kinds.history'),
    },
    {
      id: 'handoff-quick-command',
      kind: 'quick-command',
      title: t('quickCommands.title'),
      detail: 'pnpm test:unit',
    },
    {
      id: 'handoff-preset',
      kind: 'preset',
      title: t('workspace.layoutOnePlusTwo'),
      detail: t('workspace.layoutOnePlusTwoDescription'),
    },
    {
      id: 'handoff-agent',
      kind: 'agent',
      title: 'Claude Code',
      detail: t('rail.agents'),
      sourceLabel: 'Claude',
    },
    ...buildCommandCenterActionRows(t, true),
  ], [t]);
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

function SettingsFixture({
  capabilities,
  requestedCategory = 'appearance',
}: {
  readonly capabilities?: CapabilityAccess;
  readonly requestedCategory?: 'appearance' | 'agents';
}): JSX.Element {
  const globalTheme = (
    ['matrix', 'dark', 'light', 'high-contrast'] as const
  ).find((candidate) => candidate === document.documentElement.dataset.theme) ?? 'matrix';
  const locale: Locale = document.documentElement.lang === 'ko' ? 'ko' : 'en';
  const resolvedCapabilities = capabilities ?? (locale === 'ko' ? KO_CAPABILITIES : EN_CAPABILITIES);
  const [theme, setTheme] = useState<'matrix' | 'dark' | 'light' | 'high-contrast'>(globalTheme);
  const [boot, setBoot] = useState(true);
  const [toggles, setToggles] = useState<Record<string, boolean>>({
    scanlines: true,
    'phosphor-glow': true,
    'crt-rollbar': true,
  });
  const availableThemes = listThemes();
  const activeThemeEffects = availableThemes.find((candidate) => candidate.id === theme)?.effects ?? [];
  const uiScale = Number(document.documentElement.dataset.uiScale) === 150 ? 150 : 100;

  useEffect(() => setTheme(globalTheme), [globalTheme]);

  return (
    <SettingsPanel
      requestedCategory={requestedCategory}
      uiScale={uiScale}
      onChangeUiScale={() => undefined}
      scrollback={10_000}
      onChangeScrollback={() => undefined}
      terminalRendererPreference="auto"
      onChangeTerminalRendererPreference={() => undefined}
      confirmRiskyPaneClose
      onChangeConfirmRiskyPaneClose={() => undefined}
      bootIntro={boot}
      onChangeBootIntro={setBoot}
      allowOsc52Clipboard={false}
      onChangeAllowOsc52Clipboard={() => undefined}
      terminalPastePreferences={DEFAULT_TERMINAL_PASTE_PREFERENCES}
      onChangeTerminalPastePreferences={() => undefined}
      theme={theme}
      onSelectTheme={(next) => setTheme(next as typeof theme)}
      availableThemes={availableThemes}
      onImportTheme={async () => ({ ok: true })}
      fontId="share-tech-mono"
      onSelectFont={() => undefined}
      activeThemeEffects={activeThemeEffects}
      effectToggles={toggles}
      onToggleEffect={(id, on) => setToggles((current) => ({ ...current, [id]: on }))}
      rollbar={DEFAULT_ROLLBAR_PARAMS}
      onChangeRollbar={() => undefined}
      interference={DEFAULT_INTERFERENCE_PARAMS}
      onChangeEffectParams={() => undefined}
      capabilities={resolvedCapabilities}
    />
  );
}

function useDialogInvokerFocus(): RefObject<HTMLButtonElement> {
  const invokerRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    invokerRef.current?.focus();
  }, []);
  return invokerRef;
}

function PairingDialogFixture({ redeemed }: { readonly redeemed: boolean }): JSX.Element {
  const [open, setOpen] = useState(true);
  const invokerRef = useDialogInvokerFocus();
  const { t } = useAppTranslation();
  return (
    <>
      <button
        ref={invokerRef}
        className="desktop-handoff-dialog-invoker"
        data-testid="desktop-handoff-dialog-invoker"
        type="button"
        onClick={() => setOpen(true)}
      >
        {t('pairing.title')}
      </button>
      <PairingQrDialog
        open={open}
        onOpenChange={setOpen}
        endpoint="ws://100.86.12.4:8765"
        code={{ code: '7C2F-91KD', expiresAt: NOW + PAIRING_CODE_TTL_MS }}
        currentTime={NOW}
        redeemed={redeemed}
        issuing={false}
        issueFailed={false}
        onIssue={() => undefined}
      />
    </>
  );
}

function PasteWarningFixture(): JSX.Element {
  const [open, setOpen] = useState(true);
  const invokerRef = useDialogInvokerFocus();
  const { t } = useAppTranslation();
  return (
    <>
      <button
        ref={invokerRef}
        className="desktop-handoff-dialog-invoker"
        data-testid="desktop-handoff-dialog-invoker"
        type="button"
        onClick={() => setOpen(true)}
      >
        {t('terminalPasteWarning.title')}
      </button>
      {open && (
        <TerminalPasteWarningDialog
          risk={{ multiline: true, large: true, lineCount: 18, byteLength: 8_420, shouldWarn: true }}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      )}
    </>
  );
}

function RiskyCloseFixture(): JSX.Element {
  const [open, setOpen] = useState(true);
  const invokerRef = useDialogInvokerFocus();
  const { t } = useAppTranslation();
  const runningCommand = t('safetyDialog.risks.runningCommand');
  const activeAgent = t('safetyDialog.risks.activeAgent');
  return (
    <>
      <button
        ref={invokerRef}
        className="desktop-handoff-dialog-invoker"
        data-testid="desktop-handoff-dialog-invoker"
        type="button"
        onClick={() => setOpen(true)}
      >
        {t('safetyDialog.closeActiveTitle')}
      </button>
      {open && (
        <RiskyCloseDialog
          title={t('safetyDialog.closeActiveTitle')}
          description={t('safetyDialog.closeActiveDescription', {
            risk: `${runningCommand}, ${activeAgent}`,
          })}
          details={[
            t('safetyDialog.riskCount', { count: 1, risk: runningCommand }),
            t('safetyDialog.riskCount', { count: 1, risk: activeAgent }),
          ]}
          confirmLabel={t('safetyDialog.closeTerminal')}
          alternateLabel={t('safetyDialog.keepInBackground')}
          onAlternate={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ProductBootFixture(): JSX.Element {
  useLayoutEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(window, 'ezterminalDesktop');
    const current = window.ezterminalDesktop;
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        ...(current ?? {}),
        getBootIntro: async () => true,
      },
    });
    return () => {
      if (previous) Object.defineProperty(window, 'ezterminalDesktop', previous);
      else Reflect.deleteProperty(window, 'ezterminalDesktop');
    };
  }, []);
  return <BootIntroOverlay />;
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
}: {
  readonly scenario: ProviderSettingsScenario;
}): JSX.Element {
  return (
    <LocaleFrame>
      <WorkbenchFrame
        destination="settings"
        sidebar={(
          <SettingsFixture
            requestedCategory="agents"
            capabilities={providerSettingsCapabilities(scenario)}
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
