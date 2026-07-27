import { ChevronLeft, ChevronsUpDown, Play, Plus } from 'lucide-react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import type { AgentActivitySnapshot } from '../../shared/agent';
import { ConnectScreen } from '../../../mobile/src/ConnectScreen';
import { MobileHomeView } from '../../../mobile/src/MobileHomeView';
import { MobileSettingsView } from '../../../mobile/src/MobileSettingsView';
import { MobileTabBar } from '../../../mobile/src/MobileTabBar';
import { MobileWorkbenchCoordinator } from '../../../mobile/src/MobileWorkbenchCoordinator';
import { AppI18nProvider } from '../i18n';
import { Button, Field, Input, Status } from '../ui';
import '../../../mobile/src/workbench.css';
import '../../../mobile/src/mobile-shell.css';
import './mobile-shell-story.css';

type Locale = 'en' | 'ko';
type StoryPage = 'connect' | 'hub' | 'terminal' | 'settings';

interface MobileShellStoryProps {
  readonly locale: Locale;
  readonly page: StoryPage;
}

const COPY = {
  en: {
    back: 'Back to hub',
    command: 'Command',
    connected: 'Connected',
    newTerminal: 'New terminal',
    output: 'PS C:\\Workspace> git status\nOn branch main\nYour branch is up to date.',
    placeholder: 'Enter a command',
    run: 'Run',
    sessions: 'Sessions',
    terminal: 'PowerShell 1',
    local: 'local',
  },
  ko: {
    back: '허브로 돌아가기',
    command: '명령어',
    connected: '연결됨',
    newTerminal: '새 터미널',
    output: 'PS C:\\작업공간> git status\n현재 브랜치: main\n원격 브랜치와 같은 상태입니다.',
    placeholder: '명령어를 입력하세요',
    run: '실행',
    sessions: '세션',
    terminal: 'PowerShell 1',
    local: '로컬',
  },
} as const;

function MobileTerminal({ locale }: { readonly locale: Locale }): JSX.Element {
  const copy = COPY[locale];
  return (
    <main className="mobile-workspace mobile-story-workspace" data-testid="mobile-workspace">
      <header className="mob-term-head">
        <button type="button" className="mob-icon-btn" aria-label={copy.back} data-testid="workspace-hub-btn">
          <ChevronLeft aria-hidden="true" />
        </button>
        <button type="button" className="mob-term-head__session" aria-label={copy.sessions} data-testid="menu-btn">
          <span className="mob-dot mob-dot--live" aria-hidden="true" />
          <span className="mob-term-head__label">{copy.terminal}</span>
          <ChevronsUpDown aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mob-icon-btn mob-icon-btn--accent"
          aria-label={copy.newTerminal}
          data-testid="tab-add-btn"
        >
          <Plus aria-hidden="true" />
        </button>
      </header>
      <section className="mobile-story-terminal" aria-label={copy.terminal}>
        <header className="mobile-story-session-header">
          <div>
            <h1>{copy.terminal}</h1>
            <p>PowerShell · {copy.local}</p>
          </div>
          <Status variant="success">{copy.connected}</Status>
        </header>
        <pre>{copy.output}</pre>
        <form className="mobile-story-command" onSubmit={(event) => event.preventDefault()}>
          <Field label={copy.command} labelHidden>
            <Input placeholder={copy.placeholder} />
          </Field>
          <Button type="submit" variant="primary" leadingIcon={<Play />}>{copy.run}</Button>
        </form>
      </section>
    </main>
  );
}

const STORY_AGENTS: AgentActivitySnapshot = {
  revision: 1,
  items: [
    {
      id: 'agent-1',
      sessionId: 'session-1',
      provider: 'claude',
      cwd: 'C:/Workspace/ezterminal',
      status: 'blocked',
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'agent-2',
      sessionId: 'session-2',
      provider: 'codex',
      cwd: 'C:/Workspace/docs',
      status: 'working',
      createdAt: 0,
      updatedAt: 0,
    },
  ],
};

const STORY_SESSIONS = [
  { session: { sessionId: 'session-1', cwd: 'C:/Workspace/ezterminal' }, open: true },
  { session: { sessionId: 'session-2', cwd: 'C:/Workspace/docs' }, open: false },
  { session: { sessionId: 'session-3', cwd: 'C:/Workspace/scratch' }, open: false },
];

function HomeFixture(): JSX.Element {
  return (
    <MobileHomeView
      connected
      connectionUrl="ws://100.64.0.10:7420"
      desktopControlSupported
      sessions={STORY_SESSIONS}
      activeSessionId="session-1"
      agentSnapshot={STORY_AGENTS}
      agentAttention={1}
      openclawVisible
      openclawState="running"
      onOpenPcControl={() => undefined}
      onOpenSession={() => undefined}
      onOpenTerminal={() => undefined}
      onOpenAgents={() => undefined}
      onOpenClaw={() => undefined}
    />
  );
}

function SettingsFixture(): JSX.Element {
  return (
    <MobileSettingsView
      connectionUrl="ws://100.64.0.10:7420"
      onClose={() => undefined}
      onDisconnect={() => undefined}
      openclawMode="auto"
      onOpenClawModeChange={() => undefined}
      currentTheme="matrix"
      onOpenTheme={() => undefined}
    />
  );
}

function MobileShellStory({ locale, page }: MobileShellStoryProps): JSX.Element {
  if (page === 'connect') {
    return (
      <AppI18nProvider locale={locale} languages={[locale]}>
        <ConnectScreen
          saved={null}
          connecting={false}
          failed={false}
          onConnect={() => undefined}
        />
      </AppI18nProvider>
    );
  }

  const hubActive = page === 'hub';
  const terminalActive = page === 'terminal';
  const currentPage = hubActive ? <HomeFixture /> : page === 'settings' ? <SettingsFixture /> : undefined;
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileWorkbenchCoordinator
        terminal={<MobileTerminal locale={locale} />}
        page={currentPage}
        navigation={(
          <MobileTabBar
            tab={terminalActive ? 'terminal' : 'home'}
            agentAttention={1}
            onSelectTab={() => undefined}
            onOpenPcControl={() => undefined}
            onOpenMore={() => undefined}
            onOpenSettings={() => undefined}
          />
        )}
        terminalActive={terminalActive}
        destinationActive={page === 'settings'}
        tabRootActive={terminalActive}
        onRequestRoot={() => undefined}
        onRequestTabRoot={() => undefined}
      />
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Compositions/Mobile workbench shell',
  component: MobileShellStory,
  parameters: {
    a11y: { test: 'error' },
    layout: 'fullscreen',
  },
  args: {
    locale: 'en',
    page: 'hub',
  },
} satisfies Meta<typeof MobileShellStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HubEnglish: Story = {};

export const HubKorean: Story = {
  args: { locale: 'ko' },
  globals: { locale: 'ko' },
};

export const ConnectEnglish: Story = {
  args: { page: 'connect' },
};

export const ConnectKorean: Story = {
  args: { locale: 'ko', page: 'connect' },
  globals: { locale: 'ko' },
};

export const TerminalEnglish: Story = {
  args: { page: 'terminal' },
};

export const TerminalKorean: Story = {
  args: { locale: 'ko', page: 'terminal' },
  globals: { locale: 'ko' },
};

export const SettingsPageKorean: Story = {
  args: { locale: 'ko', page: 'settings' },
  globals: { locale: 'ko' },
};

export const SettingsPageEnglish: Story = {
  args: { locale: 'en', page: 'settings' },
  globals: { locale: 'en' },
};
