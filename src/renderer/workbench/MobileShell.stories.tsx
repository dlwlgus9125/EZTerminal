import { Bot, Ellipsis, Files, List, Play, Plus } from "lucide-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { MobileWorkbenchCoordinator } from "../../../mobile/src/MobileWorkbenchCoordinator";
import { AppI18nProvider } from "../i18n";
import { Button, Field, Input, Select, Status } from "../ui";
import "../../../mobile/src/workbench.css";
import "./mobile-shell-story.css";

type Locale = "en" | "ko";

interface MobileShellStoryProps {
  readonly locale: Locale;
  readonly page: "terminal" | "settings";
}

const COPY = {
  en: {
    agents: "Agents",
    command: "Command",
    connected: "Connected",
    files: "Files",
    language: "Language",
    more: "More actions",
    newTerminal: "New terminal",
    output:
      "PS C:\\Workspace> git status\nOn branch main\nYour branch is up to date.",
    placeholder: "Enter a command",
    run: "Run",
    sessions: "Sessions",
    settings: "Settings",
    terminal: "PowerShell 1",
    theme: "Theme",
    local: "local",
  },
  ko: {
    agents: "에이전트",
    command: "명령어",
    connected: "연결됨",
    files: "파일",
    language: "언어",
    more: "추가 작업",
    newTerminal: "새 터미널",
    output:
      "PS C:\\작업공간> git status\n현재 브랜치: main\n원격 브랜치와 같은 상태입니다.",
    placeholder: "명령어를 입력하세요",
    run: "실행",
    sessions: "세션",
    settings: "설정",
    terminal: "PowerShell 1",
    theme: "테마",
    local: "로컬",
  },
} as const;

function MobileTerminal({ locale }: { readonly locale: Locale }): JSX.Element {
  const copy = COPY[locale];
  return (
    <main
      className="mobile-workspace mobile-story-workspace"
      data-testid="mobile-workspace"
    >
      <header className="workspace-header">
        <div
          className="tab-strip mobile-story-tabs"
          role="tablist"
          aria-label={copy.sessions}
        >
          <button type="button" role="tab" aria-selected="true">
            {copy.terminal}
          </button>
        </div>
        <Button
          className="btn workspace-new-tab-btn"
          variant="primary"
          leadingIcon={<Plus />}
          aria-label={copy.newTerminal}
        >
          <span className="workspace-action-label">{copy.newTerminal}</span>
        </Button>
        <Button
          className="btn workspace-menu-btn workspace-wide-action"
          variant="ghost"
          leadingIcon={<List />}
        >
          <span className="workspace-action-label">{copy.sessions}</span>
        </Button>
        <Button
          className="btn files-btn workspace-wide-action"
          variant="ghost"
          leadingIcon={<Files />}
        >
          <span className="workspace-action-label">{copy.files}</span>
        </Button>
        <Button
          className="btn agents-btn"
          variant="ghost"
          leadingIcon={<Bot />}
          aria-label={copy.agents}
        >
          <span className="workspace-action-label">{copy.agents}</span>
        </Button>
        <Button
          className="btn workspace-more-btn"
          variant="ghost"
          leadingIcon={<Ellipsis />}
          aria-label={copy.more}
        >
          <span className="mobile-story-visually-hidden">{copy.more}</span>
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
        <form
          className="mobile-story-command"
          onSubmit={(event) => event.preventDefault()}
        >
          <Field label={copy.command} labelHidden>
            <Input placeholder={copy.placeholder} />
          </Field>
          <Button type="submit" variant="primary" leadingIcon={<Play />}>
            {copy.run}
          </Button>
        </form>
      </section>
    </main>
  );
}

function MobileSettingsPage({
  locale,
}: {
  readonly locale: Locale;
}): JSX.Element {
  const copy = COPY[locale];
  return (
    <article className="mobile-story-page">
      <header>
        <h1>{copy.settings}</h1>
        <Status variant="success">{copy.connected}</Status>
      </header>
      <Field label={copy.language}>
        <Select defaultValue={locale}>
          <option value="ko">한국어</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <Field label={copy.theme}>
        <Select defaultValue="matrix">
          <option value="matrix">Matrix</option>
          <option value="dark">Dark</option>
        </Select>
      </Field>
      <Button fullWidth>
        {locale === "ko" ? "터미널로 돌아가기" : "Back to terminal"}
      </Button>
    </article>
  );
}

function MobileShellStory({
  locale,
  page,
}: MobileShellStoryProps): JSX.Element {
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <MobileWorkbenchCoordinator
        terminal={<MobileTerminal locale={locale} />}
        page={
          page === "settings" ? (
            <MobileSettingsPage locale={locale} />
          ) : undefined
        }
        onRequestTerminal={() => undefined}
      />
    </AppI18nProvider>
  );
}

const meta = {
  title: "Compositions/Mobile workbench shell",
  component: MobileShellStory,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
  args: {
    locale: "en",
    page: "terminal",
  },
} satisfies Meta<typeof MobileShellStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TerminalEnglish: Story = {};

export const TerminalKorean: Story = {
  args: { locale: "ko" },
  globals: { locale: "ko" },
};

export const SettingsPageKorean: Story = {
  args: { locale: "ko", page: "settings" },
  globals: { locale: "ko" },
};

export const SettingsPageEnglish: Story = {
  args: { locale: "en", page: "settings" },
  globals: { locale: "en" },
};
