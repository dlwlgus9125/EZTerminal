import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { MobileDaemonNavigator } from '../../../mobile/src/MobileDaemonNavigator';
import { MobilePlanningNavigator } from '../../../mobile/src/MobilePlanningNavigator';
/** The roots this story switches between (the shell itself has no tab bar since I4). */
type MobileShellTab = 'home' | 'tasks' | 'agents' | 'terminal';
import { MobileWorkbenchCoordinator } from '../../../mobile/src/MobileWorkbenchCoordinator';
import type { WsEzTerminalTransport } from '../../../mobile/src/transport/ws-ezterminal';
import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import { AppI18nProvider } from '../i18n';
import '../mobile-shared.css';
import '../../../mobile/src/mobile.css';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import '../../../mobile/src/mobile-v2.css';

const NOW = '2026-10-13T00:00:00.000Z';
const snapshot: DaemonSnapshot = {
  protocolVersion: 12, revision: 1, eventSequence: 1, generatedAt: NOW,
  runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{ id: 'project', name: 'EZTerminal 2.0', rootPath: 'C:/Working/EZTerminal', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
  workspaces: [{ id: 'workspace', projectId: 'project', name: 'Main checkout', rootPath: 'C:/Working/EZTerminal', kind: 'local', revision: 1, createdAt: NOW, updatedAt: NOW }],
  sessions: [{ id: 'conversation', projectId: 'project', workspaceId: 'workspace', title: 'Android navigation review', source: 'structured', kind: 'agent', state: 'idle', revision: 1, createdAt: NOW, updatedAt: NOW }],
  agents: [], agentRelations: [], turns: [], transcriptHeads: [], approvals: [], providers: [], schedules: [], heartbeats: [],
};
const transport = {
  getDaemonSnapshot: async () => snapshot,
  getPlanningSnapshot: async () => ({ ok: false as const, error: 'unavailable' as const, message: 'Story fixture: no host is connected.' }),
  executePlanningCommand: async () => ({ ok: false as const, error: 'unavailable' as const, message: 'Story fixture: no commands are sent.' }),
  getRemoteToken: async () => 'storybook-fixture',
  getPlanningExecutionSnapshot: async () => ({ ok: false as const, error: 'unavailable', message: 'Story fixture: no host is connected.' }),
  executePlanningRun: async () => ({ ok: false as const, error: 'unavailable', message: 'Story fixture: no commands are sent.' }),
  listDaemonProviderModels: async () => ({ ok: false as const, code: 'provider-operation-failed', message: 'Story fixture: no provider is connected.' }),
  executeProjectArchive: async () => ({ ok: false as const, error: 'unavailable' as const, message: 'Story fixture: no file operations are available.' }),
  executePlanningAsset: async () => ({ ok: false as const, message: 'Story fixture: no host assets are available.' }),
  planningAiRequest: async () => ({ ok: false as const, error: 'unavailable' as const, message: 'Story fixture: no AI requests are sent.' }),
  uploadFile: async () => { throw new Error('Story fixture: uploads are unavailable.'); },
  downloadFile: async () => { throw new Error('Story fixture: downloads are unavailable.'); },
  readPlanningResult: async () => ({ ok: false as const, message: 'Story fixture: no results are stored.' }),
} as Pick<WsEzTerminalTransport, 'getDaemonSnapshot' | 'getPlanningSnapshot' | 'executePlanningCommand' | 'getRemoteToken' | 'getPlanningExecutionSnapshot' | 'executePlanningRun' | 'listDaemonProviderModels' | 'executeProjectArchive' | 'executePlanningAsset' | 'uploadFile' | 'downloadFile' | 'planningAiRequest' | 'readPlanningResult'>;

function MobileV2Story({ initial = 'home', locale = 'ko', offline = false }: { initial?: MobileShellTab; locale?: 'ko' | 'en'; offline?: boolean }): JSX.Element {
  const [tab, setTab] = useState<MobileShellTab>('terminal');
  useEffect(() => { const timer = setTimeout(() => setTab(initial), 0); return () => clearTimeout(timer); }, [initial]);
  const [projectId, setProjectId] = useState<string | null>(null);
  return <AppI18nProvider locale={locale} languages={[locale]}><div style={{ width: '100vw', height: '100vh' }}>
    <MobileWorkbenchCoordinator terminal={<div role="region" aria-label="Terminal story fixture" />} terminalActive={tab === 'terminal'} destinationActive={false} tabRootActive={tab !== 'terminal'} onRequestTabRoot={() => setTab('terminal')}
      page={tab === 'agents' ? <main className="mob-page"><MobileDaemonNavigator state={{ status: offline ? 'recovering' : 'ready', snapshot }} flatConversations projectFilter={projectId} onProjectFilterChange={setProjectId} onRetry={() => undefined} onSelectSession={() => undefined} /></main>
        : tab !== 'terminal' ? <MobilePlanningNavigator state={{ status: offline ? 'recovering' : 'ready', snapshot }} connected={!offline} transport={transport} mode={tab === 'tasks' ? 'tasks' : 'projects'} projectId={projectId} onSelectProject={setProjectId} onOpenChat={() => setTab('agents')} onOpenPcControl={() => undefined} onOpenTerminal={() => setTab('terminal')} /> : undefined}
    />
  </div></AppI18nProvider>;
}
const meta = { title: 'Workbench/Mobile v2', component: MobileV2Story, parameters: { layout: 'fullscreen', a11y: { test: 'error' } } } satisfies Meta<typeof MobileV2Story>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Projects: Story = { args: { locale: 'ko' } };
export const Tasks: Story = { args: { initial: 'tasks', locale: 'ko' } };
export const Conversations: Story = { args: { initial: 'agents', locale: 'ko' } };
export const ConversationsEnglish: Story = { args: { initial: 'agents', locale: 'en' } };
export const OfflineProjects: Story = { args: { locale: 'en', offline: true } };
