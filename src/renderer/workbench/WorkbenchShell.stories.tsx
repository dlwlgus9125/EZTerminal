import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { mergeEffectProfileToggles, type EffectProfileId } from "../effect-profiles";
import { applyEffects, type EffectId } from "../effects";
import { AppI18nProvider } from "../i18n";
import { Button, EmptyState, ErrorState, LoadingState, Status } from "../ui";
import { ActivityRail } from "./ActivityRail";
import { AppHeader } from "./AppHeader";
import { SidebarShell } from "./SidebarShell";
import type { SidebarDestination } from "./types";
import "../index.css";
import "./workbench.css";

const MATRIX_STORY_EFFECTS = [
  "scanlines",
  "phosphor-glow",
  "crt-rollbar",
  "scanline-scroll",
  "flicker",
  "jitter-burst",
  "micro-jitter",
  "static-noise",
] as const satisfies readonly EffectId[];

type PanelState = "content" | "loading" | "empty" | "error";

interface WorkbenchShellStoryProps {
  readonly initialDestination: SidebarDestination | null;
  readonly locale: "en" | "ko";
  readonly panelState: PanelState;
}

const COPY = {
  en: {
    canvasLabel: "Terminal workspace",
    connected: "Connected",
    description: "Local PowerShell session",
    emptyDescription: "Open a folder to populate the explorer.",
    emptyTitle: "No workspace folder",
    errorDescription: "The workspace folder could not be read.",
    errorTitle: "Explorer unavailable",
    loading: "Loading explorer",
    loadingDescription: "Reading workspace contents",
    openFolder: "Open folder",
    panelDescription: "Workspace files and recent locations",
    panelTitle: "Explorer",
    retry: "Retry",
  },
  ko: {
    canvasLabel: "터미널 작업 공간",
    connected: "연결됨",
    description: "로컬 PowerShell 세션",
    emptyDescription: "탐색기를 채우려면 폴더를 여세요.",
    emptyTitle: "열린 작업 폴더 없음",
    errorDescription: "작업 폴더를 읽을 수 없습니다.",
    errorTitle: "탐색기를 사용할 수 없음",
    loading: "탐색기 불러오는 중",
    loadingDescription: "작업 공간 파일을 읽고 있습니다.",
    openFolder: "폴더 열기",
    panelDescription: "작업 공간 파일과 최근 위치",
    panelTitle: "탐색기",
    retry: "다시 시도",
  },
} as const;

function SidebarBody({
  locale,
  state,
}: {
  readonly locale: "en" | "ko";
  readonly state: PanelState;
}): JSX.Element {
  const copy = COPY[locale];
  if (state === "loading") {
    return (
      <LoadingState
        label={copy.loading}
        description={copy.loadingDescription}
      />
    );
  }
  if (state === "empty") {
    return (
      <EmptyState
        title={copy.emptyTitle}
        description={copy.emptyDescription}
        action={<Button variant="primary">{copy.openFolder}</Button>}
      />
    );
  }
  if (state === "error") {
    return (
      <ErrorState
        title={copy.errorTitle}
        description={copy.errorDescription}
        action={<Button>{copy.retry}</Button>}
      />
    );
  }
  return (
    <nav className="ez-story-explorer" aria-label={copy.panelTitle}>
      <Button variant="ghost">src</Button>
      <Button variant="ghost">mobile</Button>
      <Button variant="ghost">package.json</Button>
      <Button variant="ghost">README.md</Button>
    </nav>
  );
}

function WorkbenchShellStory({
  initialDestination,
  locale,
  panelState,
}: WorkbenchShellStoryProps): JSX.Element {
  const [destination, setDestination] = useState<SidebarDestination | null>(
    initialDestination,
  );
  const [effectProfile, setEffectProfile] = useState<EffectProfileId>("crt-signature");
  const matrixTheme = document.documentElement.dataset.theme === "matrix";
  useEffect(() => {
    if (!matrixTheme) {
      applyEffects(new Set());
      return;
    }
    const toggles = mergeEffectProfileToggles({ effects: MATRIX_STORY_EFFECTS }, {}, effectProfile);
    applyEffects(
      new Set(
        Object.entries(toggles)
          .filter(([, enabled]) => enabled)
          .map(([id]) => id as EffectId),
      ),
    );
    return () => applyEffects(new Set());
  }, [effectProfile, matrixTheme]);
  const copy = COPY[locale];
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <main className="ez-story-workbench" lang={locale}>
        <AppHeader
          attentionCount={3}
          activeThemeEffects={matrixTheme ? MATRIX_STORY_EFFECTS : []}
          commandCenterOpen={false}
          effectProfile={matrixTheme ? effectProfile : "clean"}
          motionEffectsRequested={
            matrixTheme && (effectProfile === "crt-signature" || effectProfile === "full-crt")
          }
          onNewTerminal={() => undefined}
          onOpenAttention={() => setDestination("agents")}
          onOpenCommandCenter={() => undefined}
          onOpenEffectSettings={() => setDestination("settings")}
          onSelectEffectProfile={setEffectProfile}
          onWorkspaceOpenChange={() => undefined}
          workspaceOpen={false}
        />
        <div className="workbench-body">
          <ActivityRail
            active={destination}
            attentionCount={3}
            openclawVisible
            onSelect={(next) =>
              setDestination((current) => (current === next ? null : next))
            }
          />
          {destination && (
            <SidebarShell
              destination={destination}
              title={copy.panelTitle}
              description={copy.panelDescription}
              width={320}
              onClose={() => setDestination(null)}
              onWidthChange={() => undefined}
            >
              <SidebarBody locale={locale} state={panelState} />
            </SidebarShell>
          )}
          <section
            className="ez-story-workbench__canvas"
            aria-label={copy.canvasLabel}
          >
            <header className="ez-story-workbench__session">
              <div>
                <h1>PowerShell</h1>
                <p>{copy.description}</p>
              </div>
              <Status variant="success">{copy.connected}</Status>
            </header>
            <pre className="ez-story-workbench__terminal">
              {
                "PS C:\\Workspace> git status\nOn branch ui/workbench-redesign\nready"
              }
            </pre>
          </section>
        </div>
      </main>
    </AppI18nProvider>
  );
}

const meta = {
  title: "Compositions/Workbench shell",
  component: WorkbenchShellStory,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
  args: {
    initialDestination: "explorer",
    locale: "en",
    panelState: "content",
  },
} satisfies Meta<typeof WorkbenchShellStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SidebarOpen: Story = {};

export const SidebarOpenKorean: Story = {
  args: { locale: "ko" },
  globals: { locale: "ko" },
};

export const SidebarClosedKorean: Story = {
  args: { initialDestination: null, locale: "ko" },
};

export const SidebarLoadingKorean: Story = {
  args: { locale: "ko", panelState: "loading" },
};

export const SidebarEmpty: Story = {
  args: { panelState: "empty" },
};

export const SidebarEmptyKorean: Story = {
  args: { locale: "ko", panelState: "empty" },
  globals: { locale: "ko" },
};

export const SidebarError: Story = {
  args: { panelState: "error" },
};

export const SidebarErrorKorean: Story = {
  args: { locale: "ko", panelState: "error" },
  globals: { locale: "ko" },
};
