import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useCallback, useState, type ReactNode } from 'react';

import { BootIntroOverlay } from '../BootIntroOverlay';
import { FileExplorerPanel } from '../FileExplorerPanel';
import { AppI18nProvider, useAppTranslation } from '../i18n';
import { OpenClawChatPanel } from '../OpenClawChatPanel';
import { OpenClawPanel } from '../OpenClawPanel';
import { QuickOpenModal } from '../QuickOpenModal';
import { StatusPanel } from '../StatusPanel';
import { ToastProvider } from '../ui';
import { DialogPortalContext } from '../ui/Dialog';
import { DesktopUiPreferencesProvider } from '../ui-preferences';
import { RemotePanel } from '../workbench/RemotePanel';
import { SidebarShell } from '../workbench/SidebarShell';
import type { SidebarDestination } from '../workbench/types';
import { useSidebarReflow } from '../workbench/use-sidebar-overlay';
import { LiveList, type ShellTool } from './LiveList';
import { projectTabs } from './navigation-store';
import { ShellTopBar } from './ShellTopBar';
import { shellSnapshot, shellWorkflow } from './shell-fixtures';
import { otherProjects, projectConversations, projectFlows, waitingItems } from './shell-model';
import {
  EN_CAPABILITIES,
  KO_CAPABILITIES,
  NOW,
  PairingDialogFixture,
  PasteWarningFixture,
  READ_STORY_TIME,
  REMOTE_DESKTOP_API,
  RiskyCloseFixture,
  SettingsFixture,
  useCommandCenterStoryRows,
} from './tool-screen-fixtures';
import '../index.css';
import '../structured-agent.css';
import '../workbench/workbench.css';
import './shell.css';

/**
 * The desktop tool screens inside the 2.0 shell: work mode with the work list, the tool open in the
 * real SidebarShell, dialogs over the same frame. Production components on story data
 * (tool-screen-fixtures); the `…Reference` stories are the I5 review and approval references.
 */
const PROJECTS = [
  { projectId: 'p-ez', name: 'EZTerminal', pinned: true, lastActiveAt: '2026-10-24T09:29:00.000Z' },
  { projectId: 'p-garnet', name: 'Garnet', pinned: false, lastActiveAt: '2026-10-24T08:00:00.000Z' },
];
const TERMINALS = [{ panelId: 'tab-1', title: 'PowerShell · main', detail: 'PS <WORKSPACE>\\EZTerminal> git status' }];

function tools(ko: boolean): ShellTool[] {
  return [
    { id: 'explorer', label: ko ? '파일' : 'Files', glyph: 'file', testId: 'btn-toggle-files' },
    { id: 'monitor', label: ko ? '모니터' : 'Monitor', glyph: 'mon', testId: 'btn-toggle-stats' },
    { id: 'openclaw', label: 'OpenClaw', glyph: 'claw', testId: 'btn-toggle-openclaw' },
    { id: 'remote', label: ko ? '원격 · 폰' : 'Remote · phone', glyph: 'phone', testId: 'rail-remote' },
    { id: 'settings', label: ko ? '설정' : 'Settings', glyph: 'set', testId: 'shell-tool-settings' },
  ];
}

function useStoryLocale(): 'ko' | 'en' {
  const { i18n } = useAppTranslation();
  return (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Work mode as the app draws it: top bar, then the work list, the open tool and the dock. */
function ToolFrame({ destination = null, sidebar, canvas }: {
  readonly destination?: SidebarDestination | null;
  readonly sidebar?: ReactNode;
  readonly canvas?: ReactNode;
}): JSX.Element {
  const { t } = useAppTranslation();
  const locale = useStoryLocale();
  const ko = locale === 'ko';
  const workListRoom = useSidebarReflow('(min-width: 1100px)');
  const snapshot = shellSnapshot({ waiting: true });
  const all = waitingItems(snapshot);
  const title: Record<SidebarDestination, string> = {
    explorer: t('rail.explorer'),
    agents: ko ? '받은 요청' : 'Inbox',
    monitor: t('rail.monitor'),
    remote: t('rail.remote'),
    openclaw: 'OpenClaw',
    settings: t('rail.settings'),
  };
  const activeTool = destination === 'agents' ? null : destination;
  return (
    <DesktopUiPreferencesProvider capabilities={ko ? KO_CAPABILITIES : EN_CAPABILITIES}>
      <main className="app ez-shell" data-shell-mode="work" style={{ width: '100vw', height: '100vh' }} data-testid="tool-screen-frame">
        <ShellTopBar
          mode="work"
          projects={projectTabs(PROJECTS, 'p-ez', 4)}
          selectedProjectId="p-ez"
          waitingByProject={{ 'p-ez': all.length }}
          stoppedProjects={new Set()}
          waitingTotal={all.length}
          host={{ label: ko ? '작업 PC · 원격 켜짐' : 'This PC · remote on', tone: 'on' }}
          settingsActive={destination === 'settings'}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          onAllProjects={() => undefined}
          onWaits={() => undefined}
          onFind={() => undefined}
          onHost={() => undefined}
          onSettings={() => undefined}
        />
        <div className="workbench-body" data-shell-mode="work" data-live={workListRoom ? 'list' : 'strip'}>
          <LiveList
            folded={!workListRoom}
            projectName="EZTerminal"
            projectDetail="main"
            conversations={projectConversations(snapshot, 'p-ez')}
            waiting={waitingItems(snapshot, 'p-ez')}
            flows={projectFlows(shellWorkflow())}
            terminals={TERMINALS}
            focus="s-notify"
            others={otherProjects(snapshot, 'p-ez')}
            tools={tools(ko)}
            activeTool={activeTool}
            onBoard={() => undefined}
            onOpenConversation={() => undefined}
            onNewConversation={() => undefined}
            onOpenWaiting={() => undefined}
            onInbox={() => undefined}
            onOpenFlow={() => undefined}
            onOpenTerminal={() => undefined}
            onNewTerminal={() => undefined}
            onAllConversations={() => undefined}
            onOtherProject={() => undefined}
            onTool={() => undefined}
          />
          {destination && sidebar && (
            <SidebarShell
              destination={destination}
              title={title[destination]}
              width={380}
              overlayBelow={destination === 'agents' ? 1024 : 1200}
              onClose={() => undefined}
              onWidthChange={() => undefined}
            >
              {sidebar}
            </SidebarShell>
          )}
          <div style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', minWidth: 0, minHeight: 0 }} data-testid="tool-screen-dock">{canvas}</div>
        </div>
      </main>
    </DesktopUiPreferencesProvider>
  );
}

function LocaleFrame({ children }: { readonly children: ReactNode }): JSX.Element {
  const locale: 'ko' | 'en' = document.documentElement.lang === 'ko' ? 'ko' : 'en';
  // Dialogs open inside the story root, so the reference checker's keyboard walk stays on the surface.
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <ToastProvider>
        {portal && <DialogPortalContext.Provider value={portal}>{children}</DialogPortalContext.Provider>}
        <div ref={setPortal} />
      </ToastProvider>
    </AppI18nProvider>
  );
}

function OpenClawChatDockPanel(props: IDockviewPanelProps): JSX.Element {
  return <OpenClawChatPanel {...props} capabilities={KO_CAPABILITIES} />;
}

const OPENCLAW_DOCK_COMPONENTS = { 'openclaw-chat': OpenClawChatDockPanel };

function OpenClawChatDock(): JSX.Element {
  const onReady = useCallback((event: DockviewReadyEvent): void => {
    if (event.api.getPanel('tool-screen-openclaw-chat')) return;
    event.api.addPanel({ id: 'tool-screen-openclaw-chat', component: 'openclaw-chat', title: 'OpenClaw Chat' });
  }, []);
  return (
    <div style={{ flex: '1 1 auto', minHeight: 0 }} data-testid="tool-screen-openclaw-dock">
      <DockviewReact className="dockview-theme-dark ez-dock" components={OPENCLAW_DOCK_COMPONENTS} onReady={onReady} />
    </div>
  );
}

function CommandCenterScreen(): JSX.Element {
  const rows = useCommandCenterStoryRows();
  return (
    <>
      <ToolFrame />
      <QuickOpenModal mode="all" query="" onQueryChange={() => undefined} rows={rows} emptyRows={rows} onAction={() => undefined} onClose={() => undefined} />
    </>
  );
}

function RemoteScreen({ pairing }: { readonly pairing?: 'qr' | 'detected' }): JSX.Element {
  const locale = useStoryLocale();
  return (
    <ToolFrame
      destination="remote"
      sidebar={(
        <>
          <RemotePanel capabilities={locale === 'ko' ? KO_CAPABILITIES : EN_CAPABILITIES} desktopApi={REMOTE_DESKTOP_API} currentTime={NOW} />
          {pairing && <PairingDialogFixture redeemed={pairing === 'detected'} />}
        </>
      )}
    />
  );
}

const meta = {
  title: 'Production/Desk/Tool screens',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const SettingsReference: Story = {
  render: () => <LocaleFrame><ToolFrame destination="settings" sidebar={<SettingsFixture />} /></LocaleFrame>,
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement).findByTestId('settings-panel');
    // Dialogs and the sidebar fade in: wait until the element is shown.
    await waitFor(() => expect(target).toBeVisible(), { timeout: 5_000 });
  },
};

export const MonitorReference: Story = {
  render: () => {
    function Monitor(): JSX.Element {
      const locale = useStoryLocale();
      return <ToolFrame destination="monitor" sidebar={<StatusPanel capabilities={locale === 'ko' ? KO_CAPABILITIES : EN_CAPABILITIES} />} />;
    }
    return <LocaleFrame><Monitor /></LocaleFrame>;
  },
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement).findByTestId('status-section-cpu');
    // Dialogs and the sidebar fade in: wait until the element is shown.
    await waitFor(() => expect(target).toBeVisible(), { timeout: 5_000 });
  },
};

export const RemoteReference: Story = {
  render: () => <LocaleFrame><RemoteScreen /></LocaleFrame>,
};

export const PairingQrReference: Story = {
  render: () => <LocaleFrame><RemoteScreen pairing="qr" /></LocaleFrame>,
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement.ownerDocument.body).findByTestId('pairing-qr-symbol');
    // Dialogs and the sidebar fade in: wait until the element is shown.
    await waitFor(() => expect(target).toBeVisible(), { timeout: 5_000 });
  },
};

export const PairingDetectedReference: Story = {
  render: () => <LocaleFrame><RemoteScreen pairing="detected" /></LocaleFrame>,
};

export const OpenClawConsoleReference: Story = {
  render: () => {
    function Console(): JSX.Element {
      const locale = useStoryLocale();
      return <ToolFrame destination="openclaw" sidebar={<OpenClawPanel onOpenChat={() => undefined} capabilities={locale === 'ko' ? KO_CAPABILITIES : EN_CAPABILITIES} readCurrentTime={READ_STORY_TIME} />} />;
    }
    return <LocaleFrame><Console /></LocaleFrame>;
  },
};

export const OpenClawChatReference: Story = {
  render: () => {
    function Chat(): JSX.Element {
      const locale = useStoryLocale();
      return (
        <ToolFrame
          destination="openclaw"
          sidebar={<OpenClawPanel onOpenChat={() => undefined} capabilities={locale === 'ko' ? KO_CAPABILITIES : EN_CAPABILITIES} readCurrentTime={READ_STORY_TIME} />}
          canvas={<OpenClawChatDock />}
        />
      );
    }
    return <LocaleFrame><Chat /></LocaleFrame>;
  },
};

export const FilesReference: Story = {
  render: () => {
    function Files(): JSX.Element {
      const locale = useStoryLocale();
      return <ToolFrame destination="explorer" sidebar={<FileExplorerPanel activePanelId={null} onOpenTerminalAt={() => undefined} capabilities={locale === 'ko' ? KO_CAPABILITIES : EN_CAPABILITIES} />} />;
    }
    return <LocaleFrame><Files /></LocaleFrame>;
  },
  play: async ({ canvasElement }) => {
    const target = await within(canvasElement).findByTestId('file-list');
    // Dialogs and the sidebar fade in: wait until the element is shown.
    await waitFor(() => expect(target).toBeVisible(), { timeout: 5_000 });
  },
};

export const CommandCenterReference: Story = {
  render: () => <LocaleFrame><CommandCenterScreen /></LocaleFrame>,
};

export const BootReference: Story = {
  render: () => <LocaleFrame><ToolFrame /><BootIntroOverlay preview /></LocaleFrame>,
};

export const PasteWarningReference: Story = {
  render: () => <LocaleFrame><ToolFrame /><PasteWarningFixture /></LocaleFrame>,
};

export const RiskyCloseReference: Story = {
  render: () => <LocaleFrame><ToolFrame /><RiskyCloseFixture /></LocaleFrame>,
};
