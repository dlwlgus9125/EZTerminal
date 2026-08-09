import type { Meta, StoryObj } from '@storybook/react-vite';
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
      app: '1.0.27',
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
      setChatVisible: () => true,
      openChat: () => true,
      closeChat: () => true,
      reloadChat: () => true,
      setChatBounds: () => true,
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
          appVersion="1.0.27"
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
      status: 'blocked',
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
      status: 'working',
      createdAt: NOW - 412_000,
      updatedAt: NOW - 8_000,
    },
  ],
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
  return (
    <WorkspaceTab
      {...props}
      status={status}
      requestClose={(close) => close()}
      onSplit={() => undefined}
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
}: {
  readonly capabilities?: CapabilityAccess;
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
      requestedCategory="appearance"
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
