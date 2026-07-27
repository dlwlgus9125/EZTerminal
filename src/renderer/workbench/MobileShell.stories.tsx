import { ArrowLeft, List, Play, Plus } from 'lucide-react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConnectScreen } from '../../../mobile/src/ConnectScreen';
import { MobileRemoteHub } from '../../../mobile/src/MobileRemoteHub';
import { MobileSettingsView } from '../../../mobile/src/MobileSettingsView';
import { MobileWorkbenchCoordinator } from '../../../mobile/src/MobileWorkbenchCoordinator';
import { AppI18nProvider } from '../i18n';
import { Button, Field, IconButton, Input, Status } from '../ui';
import '../../../mobile/src/workbench.css';
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
      <header className="workspace-header">
        <IconButton icon={ArrowLeft} size="sm" aria-label={copy.back} data-testid="workspace-hub-btn" />
        <div className="tab-strip mobile-story-tabs" role="tablist" aria-label={copy.sessions}>
          <button type="button" role="tab" aria-selected="true">{copy.terminal}</button>
        </div>
        <Button
          className="workspace-new-tab-btn"
          variant="secondary"
          size="sm"
          leadingIcon={<Plus />}
          aria-label={copy.newTerminal}
        >
          <span className="workspace-action-label">{copy.newTerminal}</span>
        </Button>
        <Button
          className="workspace-menu-btn"
          variant="secondary"
          size="sm"
          leadingIcon={<List />}
          aria-label={copy.sessions}
        >
          <span className="workspace-action-label">{copy.sessions}</span>
        </Button>
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

function HubFixture(): JSX.Element {
  return (
    <MobileRemoteHub
      connected
      connectionUrl="ws://100.64.0.10:7420"
      desktopControlSupported
      sessionCount={3}
      agentAttention={2}
      openclawVisible
      openclawState="running"
      currentTheme="matrix"
      onOpenPcControl={() => undefined}
      onOpenTerminal={() => undefined}
      onOpenSessions={() => undefined}
      onOpenAgents={() => undefined}
      onOpenFiles={() => undefined}
      onOpenStats={() => undefined}
      onOpenAppearance={() => undefined}
      onOpenClaw={() => undefined}
      onOpenSettings={() => undefined}
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
  const currentPage = hubActive ? <HubFixture /> : page === 'settings' ? <SettingsFixture /> : undefined;
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileWorkbenchCoordinator
        terminal={<MobileTerminal locale={locale} />}
        page={currentPage}
        terminalActive={terminalActive}
        destinationActive={!hubActive}
        onRequestRoot={() => undefined}
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
