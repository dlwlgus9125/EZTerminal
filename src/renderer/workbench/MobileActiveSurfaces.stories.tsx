import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useLayoutEffect, type ReactNode } from 'react';

import { MobileAgentFolderPicker } from '../../../mobile/src/MobileAgentFolderPicker';
import { MobileAgentHistorySheet } from '../../../mobile/src/MobileAgentHistorySheet';
import { MobileAgentView } from '../../../mobile/src/MobileAgentView';
import { MobileFileView } from '../../../mobile/src/MobileFileView';
import { MobileMoreSheet } from '../../../mobile/src/MobileMoreSheet';
import { MobileNavigationHistoryProvider } from '../../../mobile/src/MobileNavigationHistory';
import { MobileOpenClawView } from '../../../mobile/src/MobileOpenClawView';
import { MobileRemoteDesktopView } from '../../../mobile/src/MobileRemoteDesktopView';
import { MobileSessionSheet } from '../../../mobile/src/MobileSessionSheet';
import { MobileStatsView } from '../../../mobile/src/MobileStatsView';
import { MobileToastProvider } from '../../../mobile/src/MobileToast';
import { PairingScanner } from '../../../mobile/src/PairingScanner';
import { ThemeMenu } from '../../../mobile/src/ThemeMenu';
import type { DesktopPresentationAdapter, DesktopPresentationSnapshot } from '../../../mobile/src/remote-desktop-presentation-adapter';
import type { WsEzTerminalTransport } from '../../../mobile/src/transport/ws-ezterminal';
import type { AgentActivitySnapshot } from '../../shared/agent';
import type { AgentCoordinationSnapshot } from '../../shared/agent-coordination';
import type { AgentHistorySessionSummary, AgentProjectSummary } from '../../shared/agent-history';
import type { EzTerminalApi, SystemStatsSnapshot } from '../../shared/ipc';
import { AppI18nProvider } from '../i18n';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import './mobile-shell-story.css';

type ActiveMobileSurface =
  | 'agents'
  | 'agents-merge'
  | 'agents-overflow'
  | 'agents-offline'
  | 'files'
  | 'stats'
  | 'openclaw'
  | 'pc-control-ready'
  | 'pc-control-active'
  | 'pc-control-session-sheet'
  | 'pc-control-keyboard'
  | 'pc-control-reconnecting'
  | 'pc-control-unavailable'
  | 'more-sheet'
  | 'sessions-sheet'
  | 'theme-sheet'
  | 'pairing-scanner-unavailable'
  | 'agent-history-error'
  | 'agent-folder-picker';

interface MobileActiveSurfaceProps {
  readonly locale: 'en' | 'ko';
  readonly surface: ActiveMobileSurface;
}

const NOW = 1_785_200_000_000;

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
    { pid: 12_140, name: 'node.exe', cpuPct: 12.4, memBytes: 728_000_000 },
    { pid: 8_840, name: 'pwsh.exe', cpuPct: 7.8, memBytes: 196_000_000 },
  ],
  conns: [
    { proto: 'TCP', local: '100.86.12.4:45891', peer: '100.91.8.22:8765', state: 'ESTABLISHED', process: 'EZTerminal' },
  ],
};

const AGENTS: AgentActivitySnapshot = {
  revision: 2,
  items: [
    {
      id: 'agent-review',
      sessionId: 'session-review',
      provider: 'claude',
      cwd: 'C:/Workspace/ezterminal',
      state: 'blocked',
      status: 'blocked',
      stateSeq: 3,
      live: true,
      interactiveReady: true,
      stateSource: 'provider-hook',
      createdAt: NOW - 60_000,
      updatedAt: NOW - 20_000,
      approval: {
        approvalId: 'approval-review',
        toolName: 'PowerShell',
        command: 'pnpm test',
        risk: 'write',
        pending: true,
        requestedAt: NOW - 30_000,
        expiresAt: NOW + 300_000,
      },
    },
    {
      id: 'agent-working',
      sessionId: 'session-working',
      provider: 'codex',
      cwd: 'C:/Workspace/docs',
      state: 'working',
      status: 'working',
      stateSeq: 2,
      live: true,
      interactiveReady: true,
      stateSource: 'provider-hook',
      createdAt: NOW - 90_000,
      updatedAt: NOW - 20_000,
    },
  ],
};

const AGENT_COORDINATION: AgentCoordinationSnapshot = {
  revision: 4,
  activityRevision: AGENTS.revision,
  activities: AGENTS.items,
  projects: [],
  mergeRequests: [{
    requestId: 'merge-mobile-1',
    revision: 5,
    projectId: 'project-ezterminal',
    participantId: 'participant-working',
    activityId: 'agent-working',
    sourceWorkspaceId: 'workspace-working',
    sourceBranch: 'agent/mobile-review',
    sourceHead: '1'.repeat(40),
    targetBranch: 'main',
    targetHead: '2'.repeat(40),
    candidateHead: '3'.repeat(40),
    state: 'approval-required',
    validationConfigRevision: 2,
    validations: [{
      id: 'unit',
      name: 'Unit tests',
      status: 'passed',
      durationMs: 9_400,
      exitCode: 0,
    }],
    createdAt: NOW - 30_000,
    updatedAt: NOW - 10_000,
    expiresAt: NOW + 86_400_000,
  }],
};

const AGENT_PROJECTS: readonly AgentProjectSummary[] = [
  {
    projectId: 'project-ezterminal',
    name: 'EZTerminal',
    primaryRoot: 'C:/Workspace/ezterminal',
    additionalRoots: [],
    pinned: true,
    saved: true,
    sessionCount: 4,
    providers: ['codex', 'claude'],
    lastActiveAt: NOW - 20_000,
  },
  {
    projectId: 'project-mobile-shell',
    name: 'Mobile shell',
    primaryRoot: 'C:/Workspace/mobile-shell',
    additionalRoots: ['C:/Workspace/shared-ui'],
    pinned: false,
    saved: true,
    sessionCount: 2,
    providers: ['codex'],
    lastActiveAt: NOW - 120_000,
  },
  {
    projectId: 'project-release',
    name: 'Release validation',
    primaryRoot: 'D:/Projects/release-validation',
    additionalRoots: [],
    pinned: false,
    saved: true,
    sessionCount: 1,
    providers: ['claude'],
    lastActiveAt: NOW - 240_000,
  },
  {
    projectId: 'project-observed',
    name: 'Observed workspace',
    primaryRoot: 'D:/Projects/observed-workspace',
    additionalRoots: [],
    pinned: false,
    saved: false,
    sessionCount: 1,
    providers: ['codex'],
    lastActiveAt: NOW - 360_000,
  },
];

const HISTORY_SESSION: AgentHistorySessionSummary = {
  historyId: 'history-review',
  projectId: 'project-ezterminal',
  provider: 'codex',
  title: 'Remote recovery review',
  preview: 'Review the unavailable state and recovery action.',
  createdAt: NOW - 60_000,
  updatedAt: NOW,
  roots: ['C:/Workspace/ezterminal'],
  source: 'Codex',
};

const STORY_TRANSPORT = {
  connectedHost: '100.86.12.4',
  supportsAgentProjectManagement: true,
  listAgentProjects: async () => ({ items: AGENT_PROJECTS, nextCursor: null }),
  listAgentHistorySessions: async () => ({ items: [], nextCursor: null }),
  listFiles: async (path: string) => ({
    ok: true as const,
    path,
    parent: 'C:/Workspace',
    entries: [
      { name: 'src', kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: NOW },
      { name: 'docs', kind: 'dir' as const, isSymlink: false, size: 0, mtimeMs: NOW },
      { name: 'package.json', kind: 'file' as const, isSymlink: false, size: 3_842, mtimeMs: NOW },
      { name: 'README.md', kind: 'file' as const, isSymlink: false, size: 8_210, mtimeMs: NOW },
    ],
  }),
  listFileRoots: async () => ['C:/Workspace', 'D:/Projects'],
  readFilePreview: async () => ({ ok: false as const, error: 'Preview is not opened in this story.' }),
  createFolder: async () => ({ ok: true as const }),
  renameFile: async () => ({ ok: true as const }),
  trashFile: async () => ({ ok: true as const }),
  downloadFile: async () => new Uint8Array(),
  uploadFile: async () => ({ ok: true as const }),
  onOpenClawStatus: (listener: (status: { state: 'running'; version: string; port: number }) => void) => {
    queueMicrotask(() => listener({ state: 'running', version: '2026.8', port: 18_789 }));
    return () => undefined;
  },
  setOpenClawStatusSubscribed: () => undefined,
  onOpenClawLogLines: () => () => undefined,
  setOpenClawLogsSubscribed: () => undefined,
  runOpenClawLifecycle: async () => ({ ok: true }),
  getOpenClawConfig: async () => ({
    'agents.defaults.model': 'openai/gpt-5',
    'gateway.port': '18789',
  }),
  setOpenClawConfig: async () => ({ ok: true, restartRequired: false }),
  getOpenClawChatTicket: async () => ({ ticket: null, proxyPort: 0, token: null, reason: 'unavailable' }),
  decideManagedMerge: async () => ({ ok: true, value: AGENT_COORDINATION.mergeRequests[0]! }),
} as unknown as WsEzTerminalTransport;

const PC_UNAVAILABLE: DesktopPresentationSnapshot = {
  phase: 'error',
  detail: { kind: 'start-error', errorCode: 'SERVICE_UNAVAILABLE' },
  displays: [],
  selectedDisplayId: null,
  capabilities: null,
  status: null,
  clipboardFeedback: 'none',
  appliedView: null,
};

const PC_ACTIVE: DesktopPresentationSnapshot = {
  phase: 'active',
  detail: null,
  displays: [
    {
      id: 'primary',
      name: 'Studio display',
      width: 2_560,
      height: 1_440,
      rotationDegrees: 0,
      primary: true,
    },
    {
      id: 'secondary',
      name: 'Portrait display',
      width: 1_440,
      height: 2_560,
      rotationDegrees: 90,
      primary: false,
    },
  ],
  selectedDisplayId: 'primary',
  capabilities: {
    ctrlAltDelete: false,
    clipboardText: true,
    directTouch: true,
    multiMonitor: true,
    adaptiveViewport: true,
    adaptiveRegion: true,
    qualityPreferences: ['balanced', 'clarity', 'responsiveness'],
    clientVideoStatsV2: true,
  },
  status: {
    kind: 'desktop-control-status',
    sessionId: 'storybook-pc-control',
    state: 'active',
    qualityTier: 'high',
    qualityPreference: 'clarity',
    framesPerSecond: 30,
    targetFramesPerSecond: 30,
    decodedFramesPerSecond: 29.8,
    roundTripTimeMs: 24,
    packetLossPercent: 0.2,
    bitrateKbps: 7_420,
    streamWidth: 1_920,
    streamHeight: 1_080,
    clientDroppedFramePercent: 0.4,
    clientFreezeDurationMs: 0,
    captureBackend: 'dxgi',
    encoderBackend: 'media-foundation-hardware',
    appliedViewRevision: 1,
    sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
  },
  clipboardFeedback: 'none',
  appliedView: {
    revision: 1,
    sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
    frameWidth: 1_920,
    frameHeight: 1_080,
  },
};

const PC_RECONNECTING: DesktopPresentationSnapshot = {
  ...PC_ACTIVE,
  phase: 'reconnecting',
  status: PC_ACTIVE.status ? { ...PC_ACTIVE.status, state: 'reconnecting' } : null,
};

function staticPresentationAdapter(snapshot: DesktopPresentationSnapshot): DesktopPresentationAdapter {
  let listener: (() => void) | null = null;
  return {
    getSnapshot: () => snapshot,
    subscribe: (next) => {
      listener = next;
      queueMicrotask(next);
      return () => { listener = null; };
    },
    start: () => listener?.(),
    attachVideo: () => undefined,
    setViewport: () => undefined,
    setQualityPreference: () => true,
    resume: () => listener?.(),
    sendControl: () => true,
    sendPointer: () => true,
    selectDisplay: () => true,
    sendLocalClipboard: async () => undefined,
    copyRemoteClipboard: () => undefined,
    stop: () => undefined,
    dispose: () => undefined,
  };
}

function unavailablePresentationAdapter(): DesktopPresentationAdapter {
  return staticPresentationAdapter(PC_UNAVAILABLE);
}

function activePresentationAdapter(): DesktopPresentationAdapter {
  return staticPresentationAdapter(PC_ACTIVE);
}

function reconnectingPresentationAdapter(): DesktopPresentationAdapter {
  return staticPresentationAdapter(PC_RECONNECTING);
}

const unavailableCamera = async (): Promise<MediaStream> => {
  throw new Error('Camera unavailable in deterministic story');
};

function StoryApiBoundary({
  children,
  overrides,
}: {
  readonly children: ReactNode;
  readonly overrides: Partial<EzTerminalApi>;
}): JSX.Element {
  useLayoutEffect(() => {
    const hadOwnValue = Object.prototype.hasOwnProperty.call(window, 'ezterminal');
    const previous = window.ezterminal;
    const installed = { ...(previous ?? {}), ...overrides } as EzTerminalApi;
    Object.defineProperty(window, 'ezterminal', {
      configurable: true,
      value: installed,
    });
    return () => {
      // A child can still run passive cleanup after this boundary's layout
      // cleanup. Keep the installed adapter alive through that flush, while
      // avoiding clobbering an adapter installed by the next story.
      queueMicrotask(() => {
        if (window.ezterminal !== installed) return;
        if (hadOwnValue) Object.defineProperty(window, 'ezterminal', { configurable: true, value: previous });
        else Reflect.deleteProperty(window, 'ezterminal');
      });
    };
  }, [overrides]);
  return <>{children}</>;
}

function SurfaceFrame({ locale, children }: { readonly locale: 'en' | 'ko'; readonly children: ReactNode }): JSX.Element {
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileNavigationHistoryProvider>
        <MobileToastProvider>
          <div className="mobile-active-story">{children}</div>
        </MobileToastProvider>
      </MobileNavigationHistoryProvider>
    </AppI18nProvider>
  );
}

function MobileActiveSurface({ locale, surface }: MobileActiveSurfaceProps): JSX.Element {
  const close = (): void => undefined;
  let content: ReactNode;

  switch (surface) {
    case 'agents':
    case 'agents-merge':
    case 'agents-overflow':
    case 'agents-offline': {
      const overflow = surface === 'agents-overflow';
      content = (
        <MobileAgentView
          snapshot={AGENTS}
          coordinationSnapshot={surface === 'agents-merge' ? AGENT_COORDINATION : undefined}
          disconnected={surface === 'agents-offline'}
          currentTime={NOW}
          onBack={close}
          onFocusSession={close}
          onSendFollowup={async () => ({ ok: true })}
          onDecideApproval={async () => ({ ok: true })}
          transport={overflow || surface === 'agents-merge' ? STORY_TRANSPORT : undefined}
          onResumeHistory={overflow ? async () => undefined : undefined}
          onLaunchAgent={overflow ? async () => undefined : undefined}
        />
      );
      break;
    }
    case 'files':
      content = (
        <MobileFileView
          transport={STORY_TRANSPORT}
          initialPath="C:/Workspace/ezterminal"
          onClose={close}
          onOpenTerminalAt={close}
          onPastePath={close}
        />
      );
      break;
    case 'stats':
      content = (
        <StoryApiBoundary overrides={{
          setStatsPanelVisible: () => undefined,
          getStatsHistory: async () => [STATS],
          onStatsUpdate: () => () => undefined,
        }}>
          <MobileStatsView onClose={close} />
        </StoryApiBoundary>
      );
      break;
    case 'openclaw':
      content = <MobileOpenClawView transport={STORY_TRANSPORT} onClose={close} openclawAvailable />;
      break;
    case 'pc-control-ready':
    case 'pc-control-active':
    case 'pc-control-session-sheet':
    case 'pc-control-keyboard':
      content = (
        <MobileRemoteDesktopView
          transport={STORY_TRANSPORT}
          hostLabel="Studio workstation"
          onClose={close}
          presentationAdapterFactory={activePresentationAdapter}
        />
      );
      break;
    case 'pc-control-reconnecting':
      content = (
        <MobileRemoteDesktopView
          transport={STORY_TRANSPORT}
          hostLabel="Studio workstation"
          onClose={close}
          presentationAdapterFactory={reconnectingPresentationAdapter}
        />
      );
      break;
    case 'pc-control-unavailable':
      content = (
        <MobileRemoteDesktopView
          transport={STORY_TRANSPORT}
          hostLabel="Studio workstation"
          onClose={close}
          presentationAdapterFactory={unavailablePresentationAdapter}
        />
      );
      break;
    case 'more-sheet':
      content = (
        <MobileMoreSheet
          currentTheme="matrix"
          openclawVisible
          openclawState="running"
          onClose={close}
          onOpenSessions={close}
          onOpenFiles={close}
          onOpenStats={close}
          onOpenClaw={close}
          onOpenTheme={close}
          onOpenSettings={close}
        />
      );
      break;
    case 'sessions-sheet':
      content = (
        <MobileSessionSheet
          sessions={[
            { session: { sessionId: 'session-1', cwd: 'C:/Workspace/ezterminal' }, open: true },
            { session: { sessionId: 'session-2', cwd: 'C:/Workspace/docs' }, open: false },
          ]}
          activeSessionId="session-1"
          canCreate
          onClose={close}
          onSelect={close}
          onCreate={close}
        />
      );
      break;
    case 'theme-sheet':
      content = <ThemeMenu open current="matrix" onSelect={close} onClose={close} />;
      break;
    case 'pairing-scanner-unavailable':
      content = <PairingScanner onDetected={close} onClose={close} requestCamera={unavailableCamera} />;
      break;
    case 'agent-history-error':
      content = (
        <StoryApiBoundary overrides={{ readAgentHistory: async () => { throw new Error('offline'); } }}>
          <MobileAgentHistorySheet session={HISTORY_SESSION} onClose={close} onResume={async () => undefined} />
        </StoryApiBoundary>
      );
      break;
    case 'agent-folder-picker':
      content = (
        <MobileAgentFolderPicker
          transport={STORY_TRANSPORT}
          excludedRoots={['D:/Projects']}
          onClose={close}
          onSelect={close}
        />
      );
      break;
  }

  return <SurfaceFrame locale={locale}>{content}</SurfaceFrame>;
}

const meta = {
  title: 'Compositions/Mobile active surfaces',
  component: MobileActiveSurface,
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  args: { locale: 'en', surface: 'agents' },
} satisfies Meta<typeof MobileActiveSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Agents: Story = {};
export const AgentsManagedMerge: Story = { args: { surface: 'agents-merge' } };
export const AgentsOverflow: Story = { args: { surface: 'agents-overflow' } };
export const AgentsOffline: Story = { args: { surface: 'agents-offline' } };
export const Files: Story = { args: { surface: 'files' } };
export const Stats: Story = { args: { surface: 'stats' } };
export const OpenClaw: Story = { args: { surface: 'openclaw' } };
export const PcControlReady: Story = { args: { surface: 'pc-control-ready' } };
export const PcControlActive: Story = {
  args: { surface: 'pc-control-active' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('mobile-pc-start'));
    await waitFor(() => expect(canvas.getByTestId('mobile-pc-session-handle')).toBeVisible());
    await waitFor(() => expect(canvas.getByRole('application')).toHaveFocus());
  },
};
export const PcControlSessionSheet: Story = {
  args: { surface: 'pc-control-session-sheet' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('mobile-pc-start'));
    await userEvent.click(await canvas.findByTestId('mobile-pc-session-handle'));
    await waitFor(() => expect(canvas.getByTestId('mobile-pc-session-sheet')).toBeVisible());
  },
};
export const PcControlKeyboard: Story = {
  args: { surface: 'pc-control-keyboard' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('mobile-pc-start'));
    await userEvent.click(await canvas.findByTestId('mobile-pc-session-handle'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Show remote keyboard input' }));
    await waitFor(() => expect(canvas.getByRole('toolbar', { name: 'Special keys' })).toBeVisible());
  },
};
export const PcControlReconnecting: Story = {
  args: { surface: 'pc-control-reconnecting' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('mobile-pc-start'));
    await waitFor(() => expect(canvas.getByTestId('mobile-pc-state')).toHaveAttribute('data-phase', 'reconnecting'));
  },
};
export const PcControlUnavailable: Story = {
  args: { surface: 'pc-control-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('mobile-pc-start'));
    await waitFor(() => expect(canvas.getByTestId('mobile-pc-state')).toHaveAttribute('data-phase', 'error'));
  },
};
export const MoreSheet: Story = { args: { surface: 'more-sheet' } };
export const SessionsSheet: Story = { args: { surface: 'sessions-sheet' } };
export const ThemeSheet: Story = { args: { surface: 'theme-sheet' } };
export const PairingScannerUnavailable: Story = { args: { surface: 'pairing-scanner-unavailable' } };
export const AgentHistoryError: Story = { args: { surface: 'agent-history-error' } };
export const AgentFolderPicker: Story = { args: { surface: 'agent-folder-picker' } };
