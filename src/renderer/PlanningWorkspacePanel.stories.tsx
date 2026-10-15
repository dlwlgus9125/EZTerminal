import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { PlanningSnapshot } from "../shared/planning";
import { AppI18nProvider } from "./i18n";
import { PlanningWorkspacePanel } from "./PlanningWorkspacePanel";
import "./index.css";

const snapshot: PlanningSnapshot = {
  schemaVersion: 1,
  projectId: "project-story",
  revision: 4,
  draft: {
    id: "draft-story",
    items: [
      {
        id: "requirement-chat",
        revision: 1,
        title: "한 곳에서 이어지는 대화",
        kind: "requirement",
        body: "프로젝트의 대화를 작업공간과 관계없이 한 목록에서 탐색한다. 말풍선과 CLI 스킨은 같은 메시지를 표시한다.",
        acceptance: [
          "스킨을 바꿔도 메시지와 입력이 유지된다.",
          "기존 터미널 세션이 계속 실행된다.",
        ],
        status: "ready",
      },
      {
        id: "feature-skin",
        revision: 2,
        title: "CLI 대화 스킨",
        kind: "feature",
        body: "메시지를 연속된 콘솔 로그처럼 배치하고 첨부, 인용, 승인과 전송 상태를 유지한다.",
        acceptance: ["사용자와 AI 메시지를 명확하게 구분한다."],
        status: "draft",
      },
      {
        id: "flow-start",
        revision: 3,
        title: "프로젝트에서 첫 대화 시작",
        kind: "flow",
        body: "프로젝트 선택 → 새 대화 → 모델 확인 → 전송",
        acceptance: [],
        status: "review-needed",
      },
    ],
    links: [],
    scenes: [],
    components: [],
    profiles: [],
    tasks: [],
    assets: [],
  },
  baselines: [],
  history: [],
  profileProposals: [],
};
const meta: Meta<typeof PlanningWorkspacePanel> = {
  title: "Production/Planning/Project workspace",
  component: PlanningWorkspacePanel,
  parameters: { layout: "fullscreen" },
  args: {
    projectId: snapshot.projectId,
    projectName: "EZTerminal 2.0",
    access: {
      getPlanningSnapshot: async () => ({ ok: true, snapshot }),
      executePlanningCommand: async () => ({
        ok: false,
        error: "unavailable",
        message: "Story preview does not write to the project.",
      }),
    },
    onNewConversation: fn(),
    onOpenTerminal: fn(),
    onOpenFiles: fn(),
    onOpenConversation: fn(),
    onBack: fn(),
    conversations: [
      {
        id: "chat-plan",
        title: "기획과 설계를 검토해줘",
        providerLabel: "Codex",
        workspaceLabel: "기본 작업공간",
        status: "idle",
      },
      {
        id: "chat-build",
        title: "대화 스킨 구현",
        providerLabel: "Claude Code",
        workspaceLabel: "feat/chat-skin",
        status: "working",
      },
    ],
  },
  decorators: [
    (Story) => (
      <AppI18nProvider locale="ko" languages={["ko"]}>
        <div style={{ width: "100%", height: "100vh" }}>
          <Story />
        </div>
      </AppI18nProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
export const Planning: Story = { args: { initialSection: "planning" } };
export const Conversations: Story = { args: { initialSection: "chat" } };
export const Review: Story = { args: { initialSection: "review" } };
export const EmptyProject: Story = {
  args: {
    access: {
      getPlanningSnapshot: async () => ({
        ok: true,
        snapshot: {
          ...snapshot,
          revision: 0,
          draft: { ...snapshot.draft, items: [] },
        },
      }),
      executePlanningCommand: meta.args!.access!.executePlanningCommand,
    },
  },
};
export const MobilePlanning: Story = {
  args: { initialSection: "planning", mobile: true },
  decorators: [
    (Story) => (
      <div style={{ width: "min(100vw, 390px)", height: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};
export const Offline: Story = {
  args: {
    access: {
      getPlanningSnapshot: async () => ({
        ok: false,
        error: "unavailable",
        message:
          "PC에 연결할 수 없습니다. 연결 상태를 확인하고 다시 불러오세요.",
      }),
      executePlanningCommand: meta.args!.access!.executePlanningCommand,
    },
  },
};
