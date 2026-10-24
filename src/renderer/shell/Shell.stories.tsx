import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { AppI18nProvider } from '../i18n';
import { LiveList, type ShellTool } from './LiveList';
import { ProjectBoard } from './ProjectBoard';
import { ShellTopBar } from './ShellTopBar';
import { projectTabs } from './navigation-store';
import { shellSnapshot, shellWorkflow } from './shell-fixtures';
import { otherProjects, projectConversations, projectFlows, waitingItems } from './shell-model';
import { useSidebarReflow } from '../workbench/use-sidebar-overlay';
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
    { id: 'explorer', label: ko ? '파일' : 'Files', glyph: 'file', testId: 'btn-toggle-files' },
    { id: 'monitor', label: ko ? '모니터' : 'Monitor', glyph: 'mon', testId: 'btn-toggle-stats' },
    { id: 'openclaw', label: 'OpenClaw', glyph: 'claw', testId: 'btn-toggle-openclaw' },
    { id: 'remote', label: ko ? '원격 · 폰' : 'Remote · phone', glyph: 'phone', testId: 'rail-remote' },
    { id: 'settings', label: ko ? '설정' : 'Settings', glyph: 'set', testId: 'shell-tool-settings' },
  ];
}

interface ShellStoryArgs {
  readonly mode: 'board' | 'work';
  readonly project: 'p-ez' | null;
  readonly waiting: boolean;
  /** Fill the viewport instead of the fixed 1440×900 frame (approved 2.0 reference stories). */
  readonly fluid?: boolean;
  readonly onDecide: (approvalId: string, decision: 'allow' | 'deny') => void;
  readonly onOpenConversation: (sessionId: string) => void;
}

function ShellStory({ args, locale }: { readonly args: ShellStoryArgs; readonly locale: 'ko' | 'en' }): JSX.Element {
  // The app folds the work list to a strip below 1100px; a fluid reference follows the same rule.
  const workListRoom = useSidebarReflow('(min-width: 1100px)');
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
      <div className="ez-shell" style={args.fluid ? { width: '100vw', height: '100vh' } : { width: 1440, height: 900 }} data-testid="shell-story">
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
            changes={projectId ? { branch: 'main', files: 4, added: 107, removed: 12, worktrees: 0, availability: 'ready', truncated: false } : null}
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
              folded={Boolean(args.fluid) && !workListRoom}
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
              onInbox={() => undefined}
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

/**
 * Approved 2.0 references (docs/ux/reference/2.0/manifest.json). They pin neither
 * locale nor theme, so the reference checker can render them in both languages,
 * and they fill the viewport so every checked size is a real layout.
 */
export const BoardReference: Story = {
  args: { fluid: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId('shell-need')).toHaveLength(2);
    await expect(canvas.getAllByTestId('shell-conversation-card')).toHaveLength(4);
    await expect(canvas.getByTestId('shell-flow-card')).toHaveTextContent('#4');
  },
};

export const WorkModeReference: Story = {
  args: { mode: 'work', fluid: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('shell-top-waits')).toHaveTextContent('2');
    // A column from 1100px, a folded strip below — the same rule as the app.
    if (window.matchMedia('(min-width: 1100px)').matches) {
      await expect(canvas.getAllByTestId('shell-live-row')[0]).toHaveAttribute('aria-current', 'true');
    } else {
      await expect(canvas.getByTestId('shell-live-strip')).toBeVisible();
    }
  },
};
