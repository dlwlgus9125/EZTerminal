import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { AppI18nProvider } from '../i18n';
import { LiveList, type ShellTool } from './LiveList';
import { ProjectBoard } from './ProjectBoard';
import { ShellTopBar } from './ShellTopBar';
import { projectTabs } from './navigation-store';
import { shellSnapshot, shellWorkflow } from './shell-fixtures';
import { otherProjects, projectConversations, projectFlows, waitingItems } from './shell-model';
import '../index.css';
import '../structured-agent.css';
import './shell.css';

/**
 * The Board + Desk shell on story data (shell-fixtures): the approved prototype's
 * top bar, project board and live list, now product components on product tokens.
 */
const PROJECTS = [
  { projectId: 'p-ez', name: 'EZTerminal', pinned: true, lastActiveAt: '2026-10-24T09:29:00.000Z' },
  { projectId: 'p-garnet', name: 'Garnet', pinned: false, lastActiveAt: '2026-10-24T08:00:00.000Z' },
  { projectId: 'p-kestrel', name: 'Kestrel', pinned: false, lastActiveAt: '2026-10-24T09:00:00.000Z' },
  { projectId: 'p-cobalt', name: 'Cobalt', pinned: false, lastActiveAt: '2026-10-20T09:00:00.000Z' },
];
const TERMINALS = [{ panelId: 'tab-1', title: 'PowerShell · main', detail: 'PS <WORKSPACE>\\EZTerminal> git status' }];

function tools(ko: boolean): ShellTool[] {
  return [
    { id: 'explorer', label: ko ? '파일' : 'Files', glyph: 'file' },
    { id: 'monitor', label: ko ? '모니터' : 'Monitor', glyph: 'mon' },
    { id: 'openclaw', label: 'OpenClaw', glyph: 'claw' },
    { id: 'remote', label: ko ? '원격 · 폰' : 'Remote · phone', glyph: 'phone' },
    { id: 'settings', label: ko ? '설정' : 'Settings', glyph: 'set' },
  ];
}

interface ShellStoryArgs {
  readonly mode: 'board' | 'work';
  readonly project: 'p-ez' | null;
  readonly waiting: boolean;
  readonly onDecide: (approvalId: string, decision: 'allow' | 'deny') => void;
  readonly onOpenConversation: (sessionId: string) => void;
}

function ShellStory({ args, locale }: { readonly args: ShellStoryArgs; readonly locale: 'ko' | 'en' }): JSX.Element {
  const snapshot = shellSnapshot({ waiting: args.waiting });
  const projectId = args.project;
  const conversations = projectId ? projectConversations(snapshot, projectId) : [];
  const waiting = projectId ? waitingItems(snapshot, projectId) : [];
  const flows = projectId ? projectFlows(shellWorkflow()) : [];
  const others = otherProjects(snapshot, projectId);
  const all = waitingItems(snapshot);
  const waitingByProject: Record<string, number> = {};
  for (const item of all) {
    const owner = snapshot.sessions.find((session) => session.id === item.sessionId)?.projectId;
    if (owner) waitingByProject[owner] = (waitingByProject[owner] ?? 0) + 1;
  }
  const ko = locale === 'ko';
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <div className="ez-shell" style={{ width: 1440, height: 900 }} data-testid="shell-story">
        <ShellTopBar
          mode={args.mode}
          projects={projectTabs(PROJECTS, projectId, 4)}
          selectedProjectId={projectId}
          waitingByProject={waitingByProject}
          stoppedProjects={new Set(['p-kestrel'])}
          waitingTotal={all.length}
          host={{ label: ko ? '작업 PC · 원격 켜짐' : 'This PC · remote on', tone: 'on' }}
          onSelectProject={() => undefined}
          onAddProject={() => undefined}
          onWaits={() => undefined}
          onFind={() => undefined}
          onHost={() => undefined}
          onSettings={() => undefined}
        />
        {args.mode === 'board' ? (
          <ProjectBoard
            project={projectId ? { name: 'EZTerminal', path: '<WORKSPACE>\\EZTerminal · main' } : null}
            flows={flows}
            conversations={conversations}
            terminals={TERMINALS}
            waiting={waiting}
            others={others}
            startBar={<div className="structured-agent-composer__input-row"><span className="ez-shell-muted">{ko ? '원하는 작업을 입력하세요…' : 'Describe the task…'}</span></div>}
            onOpenConversation={args.onOpenConversation}
            onOpenFlow={() => undefined}
            onNewFlow={() => undefined}
            onOpenTerminal={() => undefined}
            onNewTerminal={() => undefined}
            onDecide={async (item, decision) => { args.onDecide(item.approvalId, decision); return { ok: true }; }}
            onOtherProject={() => undefined}
            onFiles={() => undefined}
            onWorktree={() => undefined}
            onProjectSettings={() => undefined}
            onAddProject={() => undefined}
          />
        ) : (
          <div style={{ display: 'flex', flex: '1 1 auto', minHeight: 0 }}>
            <LiveList
              projectName="EZTerminal"
              projectDetail="main"
              conversations={conversations}
              waiting={waiting}
              flows={flows}
              terminals={TERMINALS}
              focus="s-notify"
              others={others}
              tools={tools(ko)}
              activeTool={null}
              onBoard={() => undefined}
              onOpenConversation={args.onOpenConversation}
              onNewConversation={() => undefined}
              onOpenWaiting={(item) => args.onOpenConversation(item.sessionId)}
              onOpenFlow={() => undefined}
              onOpenTerminal={() => undefined}
              onNewTerminal={() => undefined}
              onAllConversations={() => undefined}
              onOtherProject={() => undefined}
              onTool={() => undefined}
            />
            <div style={{ flex: 1 }} aria-hidden="true" />
          </div>
        )}
      </div>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Shell 2.0',
  parameters: { layout: 'fullscreen' },
  args: { mode: 'board', project: 'p-ez', waiting: true, onDecide: fn(), onOpenConversation: fn() },
  render: (args, context) => <ShellStory args={args} locale={context.globals.locale === 'en' ? 'en' : 'ko'} />,
} satisfies Meta<ShellStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = {
  globals: { locale: 'ko', theme: 'matrix' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId('shell-need')).toHaveLength(2);
    await expect(canvas.getAllByTestId('shell-conversation-card')).toHaveLength(4);
    await expect(canvas.getByTestId('shell-flow-card')).toHaveTextContent('실행 #4');
    await userEvent.click(canvas.getByTestId('shell-need-allow'));
    await expect(args.onDecide).toHaveBeenCalledWith('a-command', 'allow');
    await userEvent.click(canvas.getAllByTestId('shell-conversation-card')[0]!);
    await expect(args.onOpenConversation).toHaveBeenCalledWith('s-notify');
  },
};

export const BoardDark: Story = { globals: { locale: 'ko', theme: 'dark' } };
export const BoardLight: Story = { globals: { locale: 'ko', theme: 'light' } };
export const BoardHighContrast: Story = { globals: { locale: 'ko', theme: 'high-contrast' } };
export const BoardEnglish: Story = { globals: { locale: 'en', theme: 'matrix' } };
export const BoardNothingWaiting: Story = { globals: { locale: 'ko', theme: 'matrix' }, args: { waiting: false } };

export const BoardWithoutProject: Story = {
  globals: { locale: 'ko', theme: 'matrix' },
  args: { project: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('shell-board-add-project')).toBeVisible();
  },
};

export const WorkMode: Story = {
  globals: { locale: 'ko', theme: 'matrix' },
  args: { mode: 'work' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('shell-top-waits')).toHaveTextContent('기다리는 것 2');
    const rows = canvas.getAllByTestId('shell-live-row');
    await expect(rows[0]).toHaveAttribute('aria-current', 'true');
    await userEvent.click(rows[1]!);
    await expect(args.onOpenConversation).toHaveBeenCalledWith('s-pdf');
  },
};
