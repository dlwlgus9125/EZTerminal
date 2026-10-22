import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, type ReactNode } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { ChatStateSnapshot } from '../shared/chat-state';
import type { ConversationFolders } from '../shared/conversation-folders';
import type { ConversationHistoryClient } from '../shared/conversation-history';
import { DAEMON_PROTOCOL_VERSION, type DaemonSnapshot, type DaemonTranscriptItem } from '../shared/daemon-protocol';
import type { ChatStateAccess } from './chat-recovery';
import { ConversationStartPanel } from './ConversationStartPanel';
import { AppI18nProvider } from './i18n';
import { StructuredAgentSessionPanel, type StructuredAgentSessionPanelProps } from './StructuredAgentSession';
import './index.css';
import './structured-agent.css';
import './session-start.css';
import './conversation-history.css';

/**
 * Responsive draft: a conversation that also works in the project's other registered folders.
 * The folders are a composer setting next to model and access. Production components with
 * fixture data; nothing here reads the disk or starts an AI.
 */

const NOW = '2026-10-22T09:30:00.000Z';
const MAIN = 'C:\\Working\\EZTerminal';
const SHARED = 'C:\\Working\\shared-ui';
const DOCS = 'C:\\Working\\EZTerminal-docs';
const WORKTREE = 'C:\\Working\\EZTerminal-worktrees\\multi-root';

function item(id: string, sequence: number, kind: DaemonTranscriptItem['kind'], text: string): DaemonTranscriptItem {
  return { id, sessionId: 'folders-demo', turnId: 'turn-demo', sequence, kind, text, isDelta: false, isSensitive: false, createdAt: NOW };
}

const conversation: readonly DaemonTranscriptItem[] = [
  item('user', 1, 'user-message', 'shared-ui의 Button 토큰을 EZTerminal 설정 화면에도 맞춰 줘.'),
  item('answer', 2, 'assistant-message', 'shared-ui의 `tokens/button.ts`를 읽었습니다. EZTerminal의 설정 화면 버튼 세 곳을 같은 토큰으로 바꾸겠습니다.'),
];

const twoFolders: ConversationFolders = { primary: MAIN, additional: [SHARED, DOCS], missing: [] };
const threeFolders: ConversationFolders = { primary: MAIN, additional: [SHARED, DOCS, 'C:\\Working\\ezterminal-site'], missing: [] };
const longFolders: ConversationFolders = {
  primary: MAIN,
  additional: [
    'C:\\Users\\dlwlg\\Documents\\Projects\\company-design-system-tokens-and-guidelines',
    'D:\\Shared\\Team Drive\\2026 상반기 출시 준비 자료\\릴리스 노트 초안',
  ],
  missing: [],
};
const worktreeFolders: ConversationFolders = { primary: WORKTREE, additional: [SHARED, DOCS], missing: [] };
const missingFolder: ConversationFolders = { primary: MAIN, additional: [SHARED], missing: ['E:\\Archive\\old-assets'] };

const base: StructuredAgentSessionPanelProps = {
  sessionId: 'folders-demo',
  title: '설정 화면 버튼 토큰 맞추기',
  providerId: 'codex',
  providerLabel: 'Codex',
  workspace: { id: 'workspace-main', label: 'EZTerminal', kind: 'local', path: MAIN },
  folders: twoFolders,
  onEditProject: fn(),
  model: 'gpt-6-astra',
  modelOptions: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }],
  permissionPreset: 'standard',
  state: 'idle',
  items: conversation,
  onSend: fn(async () => ({ ok: true as const })),
  onChangeSettings: fn(async () => ({ ok: true as const })),
};

function Frame({ width, height = 560, locale = 'ko', children }: {
  readonly width: number | string;
  readonly height?: number | string;
  readonly locale?: 'ko' | 'en';
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <div style={{ width, height, display: 'flex' }}>{children}</div>
    </AppI18nProvider>
  );
}

const openFolders = async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
  await userEvent.click(await within(canvasElement).findByTestId('structured-agent-folders'));
  await expect(await within(canvasElement).findByRole('menu', { name: /작업 위치|Working folder/u })).toBeVisible();
};

const meta = {
  title: 'Agents/Conversation folders',
  component: StructuredAgentSessionPanel,
  parameters: { layout: 'centered', a11y: { test: 'error' } },
  args: base,
  render: (args) => <Frame width={1040}><StructuredAgentSessionPanel {...args} /></Frame>,
} satisfies Meta<typeof StructuredAgentSessionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Wide window: the folder setting sits with the other settings under the message box; the header keeps title and state. */
export const Wide: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('structured-agent-folders')).toHaveAccessibleName('작업 위치: EZTerminal, 함께 보는 폴더 2개');
    await expect(canvasElement.querySelector('.structured-agent-session-header__identity p')).toBeNull();
  },
};

/** A started conversation: the working folder is fixed; the menu lists the folders and leads to the project editor. */
export const WideOpen: Story = { play: openFolders };

export const WideEnglishOpen: Story = {
  render: (args) => <Frame width={1040} locale="en"><StructuredAgentSessionPanel {...args} /></Frame>,
  play: openFolders,
};

export const MediumThreeFolders: Story = {
  args: { folders: threeFolders },
  render: (args) => <Frame width={760}><StructuredAgentSessionPanel {...args} /></Frame>,
  play: openFolders,
};

export const LongFolderNames: Story = {
  args: { folders: longFolders },
  render: (args) => <Frame width={760}><StructuredAgentSessionPanel {...args} /></Frame>,
  play: openFolders,
};

/** A worktree conversation: its source folder (EZTerminal) is not listed, the worktree replaces it. */
export const WorktreeOpen: Story = {
  args: { workspace: { id: 'workspace-tree', label: 'agent/multi-root', kind: 'worktree', path: WORKTREE }, folders: worktreeFolders },
  play: openFolders,
};

/** A registered folder that is gone is said so, and left out of the conversation. */
export const MissingFolderOpen: Story = {
  args: { folders: missingFolder },
  play: openFolders,
};

/** One-folder project: the setting names the working folder, with no count. */
export const SingleFolderOpen: Story = {
  args: { folders: { primary: MAIN, additional: [], missing: [] } },
  play: openFolders,
};

/** Split pane under 600px: like the other settings the name goes; the icon and the count stay. */
export const NarrowPane: Story = {
  render: (args) => <Frame width={520}><StructuredAgentSessionPanel {...args} /></Frame>,
};

export const NarrowPaneOpen: Story = {
  render: (args) => <Frame width={520}><StructuredAgentSessionPanel {...args} /></Frame>,
  play: openFolders,
};

/** Android keeps its header and settings as they are in this release. */
export const MobileUnchanged: Story = {
  args: { variant: 'mobile' },
  parameters: { layout: 'fullscreen' },
  render: (args) => <Frame width="min(100vw, 390px)" height="min(100vh, 844px)"><StructuredAgentSessionPanel {...args} /></Frame>,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByTestId('structured-agent-folders')).toBeNull();
  },
};

/* New conversation: the working folder is chosen from the same setting. */

const workspaces = [
  { id: 'ws-main', name: 'EZTerminal', kind: 'local' as const, rootPath: MAIN },
  { id: 'ws-shared', name: 'shared-ui', kind: 'local' as const, rootPath: SHARED },
  { id: 'ws-docs', name: 'EZTerminal-docs', kind: 'local' as const, rootPath: DOCS },
];

const startSnapshot: DaemonSnapshot = {
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  revision: 1,
  eventSequence: 1,
  generatedAt: NOW,
  runtime: { keepRunning: false, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
  projects: [{ id: 'project-folders', name: 'EZTerminal', rootPath: MAIN, source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
  workspaces: workspaces.map((workspace) => ({ ...workspace, projectId: 'project-folders', revision: 1, createdAt: NOW, updatedAt: NOW })),
  sessions: [],
  agents: [],
  agentRelations: [],
  turns: [],
  transcriptHeads: [],
  approvals: [],
  providers: [{
    id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '0.163.0',
    argv: [], environmentVariableNames: [], capabilities: ['model:gpt-6-astra', 'model:gpt-6-sol'], enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
  }, {
    id: 'claude', displayName: 'Claude', protocol: 'claude-agent-sdk', executablePath: 'claude', executableVersion: '2.1.289',
    argv: [], environmentVariableNames: [], capabilities: ['model:claude-opus-5-5'], enabled: true, health: 'ready', revision: 1, createdAt: NOW, updatedAt: NOW,
  }, {
    id: 'pi', displayName: 'Pi', protocol: 'pi-rpc', executablePath: 'pi', executableVersion: '0.9.0',
    argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'unavailable', healthDetail: 'PC에서 Pi를 설치하면 쓸 수 있습니다.', revision: 1, createdAt: NOW, updatedAt: NOW,
  }],
  schedules: [],
  heartbeats: [],
} as DaemonSnapshot;

/** Every registered folder except the chosen working folder comes along. */
function foldersFor(workspaceId: string): ConversationFolders | undefined {
  const chosen = workspaces.find((workspace) => workspace.id === workspaceId);
  if (!chosen) return undefined;
  return { primary: chosen.rootPath, additional: workspaces.filter((workspace) => workspace !== chosen).map((workspace) => workspace.rootPath), missing: [] };
}

function StartStory({ width }: { readonly width: number }): JSX.Element {
  const storage = useMemo<ChatStateAccess>(() => {
    const records = new Map<string, ChatStateSnapshot>();
    return {
      chatStateRead: async (scope) => ({ ok: true, snapshot: records.get(scope.sessionId) ?? { version: 2, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null } }),
      chatStateWrite: async (scope, request) => {
        const snapshot: ChatStateSnapshot = { version: 2, scope, revision: request.expectedRevision + 1, state: request.state, updatedAt: null };
        records.set(scope.sessionId, snapshot);
        return { ok: true, snapshot };
      },
    };
  }, []);
  const access = useMemo(() => ({
    history: {} as ConversationHistoryClient,
    getSnapshot: async () => startSnapshot,
    sendCommand: async () => null,
    principal: { kind: 'desktop' as const, id: 'story' },
  }), []);
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      {/* A block frame like the dock panel: the start form fills its width. */}
      <div style={{ width, height: 620 }}>
        <ConversationStartPanel identity={`folders-start-${width}`} projectId="project-folders" workspaceId="ws-main"
          snapshot={startSnapshot} access={access} storage={storage} workspaceFolders={foldersFor} onEditProject={fn()} onStarted={() => undefined} />
      </div>
    </AppI18nProvider>
  );
}

/** New conversation: the working folder is chosen from the folder setting; no separate select above. */
export const NewConversationWide: Story = {
  render: () => <StartStory width={1040} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByTestId('structured-agent-folders')).toHaveAccessibleName('작업 위치: EZTerminal, 함께 보는 폴더 2개');
    await expect(canvas.queryByRole('combobox', { name: '대화 작업 위치' })).toBeNull();
    await expect(canvas.queryByRole('combobox', { name: '대화 AI' })).toBeNull();
  },
};

/** The AI is chosen at the top of the model setting; its models follow below. */
export const NewConversationAiOpen: Story = {
  render: () => <StartStory width={1040} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('structured-agent-live-model'));
    const menu = await within(canvasElement).findByRole('menu');
    await expect(within(menu).getByRole('menuitemradio', { name: /Codex/u })).toHaveAttribute('aria-checked', 'true');
    await expect(within(menu).getByRole('menuitemradio', { name: /Pi/u })).toBeDisabled();
  },
};

/** Choosing Claude switches the AI; the model starts at Claude's default. */
export const NewConversationAiSwitched: Story = {
  render: () => <StartStory width={1040} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('structured-agent-live-model'));
    await userEvent.click(await canvas.findByRole('menuitemradio', { name: /Claude/u }));
    await expect(await canvas.findByTestId('structured-agent-live-model')).toHaveAccessibleName('Claude 모델: 기본 모델');
  },
};

export const NewConversationWideOpen: Story = {
  render: () => <StartStory width={1040} />,
  play: openFolders,
};

/** Choosing shared-ui makes it the working folder; EZTerminal then comes along instead. */
export const NewConversationSwitched: Story = {
  render: () => <StartStory width={1040} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('structured-agent-folders'));
    await userEvent.click(await canvas.findByRole('menuitemradio', { name: /shared-ui/u }));
    await expect(await canvas.findByTestId('structured-agent-folders')).toHaveAccessibleName('작업 위치: shared-ui, 함께 보는 폴더 2개');
    await openFolders({ canvasElement });
  },
};

export const NewConversationNarrow: Story = {
  render: () => <StartStory width={520} />,
};
