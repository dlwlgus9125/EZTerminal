import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { DaemonApproval, DaemonTranscriptItem } from '../../shared/daemon-protocol';
import type { FilePreviewResult } from '../../shared/file-preview';
import type { GitDiffResult, GitDirectoryStatus } from '../../shared/git-status';
import { buildChatModel } from '../chat/model/build-chat-model';
import { HighlighterProvider } from '../chat/markdown/HighlighterProvider';
import claudeEditCreate from '../chat/fixtures/claude-edit-create.json';
import claudePlanMode from '../chat/fixtures/claude-plan-mode.json';
import claudeTodoEnabled from '../chat/fixtures/claude-todo-enabled.json';
import codexEditCreate from '../chat/fixtures/codex-edit-create.json';
import legacyClaudeEditCreate from '../chat/fixtures/legacy/claude-edit-create.json';
import { AppI18nProvider } from '../i18n';
import { ConversationResults } from './ConversationResults';
import type { ResultsChild, ResultsSection, ResultsSource } from './results-source-store';
import type { ResultsServices } from './results-services';
import '../index.css';
import '../structured-agent.css';

/**
 * The Results tab beside a conversation, fed by transcripts recorded from real
 * Claude and Codex sessions (replay goldens). The services stand in for the
 * host: file reads return the recorded files' contents, Git returns a diff.
 */

interface Golden {
  readonly provider: string;
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals: readonly DaemonApproval[];
}

const ROOT = '<WORKSPACE>';

const FILES: Readonly<Record<string, string>> = {
  'src/app.ts': "export function greetUser(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nexport function main(): void {\n  console.log(greetUser('world'));\n}\n",
  'notes.md': '# Notes\n\nRenamed `greet` to `greetUser`.\n\n- Callers updated in `src/app.ts`\n- No behaviour change\n',
  'README.md': '# demo-app\n\nA tiny app used to record agent sessions.\n',
};

const GIT_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index fef424b..37706b6 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,7 +1,7 @@',
  '-export function greet(name: string): string {',
  '+export function greetUser(name: string): string {',
  '   return `Hello, ${name}!`;',
  ' }',
  ' ',
  ' export function main(): void {',
  "-  console.log(greet('world'));",
  "+  console.log(greetUser('world'));",
  ' }',
  'diff --git a/package-lock.json b/package-lock.json',
  'index 1111111..2222222 100644',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -10,3 +10,3 @@',
  '   "name": "demo-app",',
  '-  "version": "1.0.0",',
  '+  "version": "1.0.1",',
  '   "lockfileVersion": 3',
  '',
].join('\n');

function relative(path: string): string {
  return path.replace(/<WORKSPACE>[\\/]+/gu, '').replace(/\\/gu, '/');
}

function services(git: 'ready' | 'not-a-repository' = 'ready'): ResultsServices {
  return {
    getGitStatus: fn(async (): Promise<GitDirectoryStatus> => (git === 'ready'
      ? { availability: 'ready', tracked: true, branch: 'agent/rename-greet', changes: [], truncated: false }
      : { availability: 'not-a-repository', tracked: false, changes: [], truncated: false })),
    getGitDiff: fn(async (): Promise<GitDiffResult> => (git === 'ready' ? { ok: true, text: GIT_DIFF, truncated: false, omissions: [] } : { ok: false, error: 'not-a-repository' })),
    readFilePreview: fn(async (path: string): Promise<FilePreviewResult> => {
      const content = FILES[relative(path)];
      if (content === undefined) return { ok: false, error: `ENOENT: no such file, open '${path}'` };
      const markdown = path.endsWith('.md');
      return { ok: true, kind: 'text', name: relative(path).split('/').at(-1)!, mime: markdown ? 'text/markdown' : 'text/plain', content, truncated: false, fileSize: content.length };
    }),
    openFileInApp: fn(async () => undefined),
    openExternalHttpUrl: fn(),
  };
}

const CHILDREN: readonly ResultsChild[] = [
  { sessionId: 'child-1', title: 'Explore: find callers of greet', providerLabel: 'Claude', state: 'done' },
  { sessionId: 'child-2', title: 'Review the rename', providerLabel: 'Codex', state: 'working' },
];

interface Args {
  readonly golden: Golden;
  readonly section?: ResultsSection;
  readonly locale?: 'ko' | 'en';
  readonly width?: number;
  readonly git?: 'ready' | 'not-a-repository';
  readonly floor?: number;
  readonly children?: readonly ResultsChild[];
  readonly draft?: 'ok' | 'history';
  readonly title?: string;
  readonly insertIntoDraft?: (text: string) => void;
}

let storySequence = 0;

function Results({ golden, section = 'changes', locale = 'ko', width = 520, git = 'ready', floor = 0, children = [], draft = 'ok', title = '인사 함수 이름 바꾸기', insertIntoDraft }: Args): JSX.Element {
  // One identity per mounted story: re-renders must not look like a new navigation.
  const [sequence] = useState(() => { storySequence += 1; return storySequence; });
  const [hostServices] = useState(() => services(git));
  const items = golden.items;
  const model = buildChatModel({ items, approvals: golden.approvals });
  const source: ResultsSource & { sessionId: string } = {
    ownerPanelId: `agent-session-story-${String(sequence)}`,
    sessionId: items[0]?.sessionId ?? 'story',
    title,
    providerLabel: golden.provider === 'claude' ? 'Claude' : 'Codex',
    workspaceRoot: ROOT,
    items,
    model,
    children,
    transcriptFloor: floor,
    loaded: true,
    baselineSequence: 0,
    historyOnly: draft === 'history',
    turnActive: false,
    ...(floor > 0 ? { readTranscriptPage: async () => [] } : {}),
    openRelatedSession: fn(),
    openProjectFiles: fn(),
    focusDecision: fn(),
    ...(draft === 'ok' ? { insertIntoDraft: insertIntoDraft ?? fn() } : { draftUnavailable: 'history' as const }),
  };
  const [navigation] = useState(() => ({ sequence, section }));
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <HighlighterProvider>
        <div style={{ width, height: '100vh', display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--ui-border-subtle)' }}>
          <ConversationResults
            source={source}
            services={hostServices}
            navigation={navigation}
          />
        </div>
      </HighlighterProvider>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Agents/Results tab',
  component: Results,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Results>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChangesClaude: Story = {
  args: { golden: claudeEditCreate as unknown as Golden },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Real SDK hunks: the new line 1 carries its file line number.
    const [patch] = await canvas.findAllByRole('group', { name: /app\.ts · 변경 1\/2/u });
    await expect(within(patch!).getAllByRole('button')[0]).toHaveTextContent('@@ -1,4 +1,4 @@');
    await expect(within(patch!).getByRole('button', { name: '1번 줄, 추가: export function greetUser(name: string): string {' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /^notes.md/u })).toBeInTheDocument();
  },
};

export const ChangesCodex: Story = {
  args: { golden: codexEditCreate as unknown as Golden, locale: 'en', title: 'Rename greet' },
};

export const CommentIntoDraft: Story = {
  args: { golden: claudeEditCreate as unknown as Golden, insertIntoDraft: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const [patch] = await canvas.findAllByRole('group', { name: /app\.ts · 변경 1\/2/u });
    const lines = within(patch!).getAllByRole('button');
    await userEvent.click(lines[2]!);
    await userEvent.click(canvas.getByRole('button', { name: '의견 추가' }));
    await userEvent.type(canvas.getByRole('textbox'), '이름은 greetPerson이 더 좋겠어요');
    await userEvent.click(canvas.getByRole('button', { name: '의견 추가' }));
    const insert = await canvas.findByRole('button', { name: /입력창에 넣기/u });
    await userEvent.click(insert);
    await waitFor(() => expect(args.insertIntoDraft).toHaveBeenCalledTimes(1));
    const text = (args.insertIntoDraft as ReturnType<typeof fn>).mock.calls[0]![0] as string;
    await expect(text).toContain('검토 의견 (1)');
    await expect(text).toContain('app.ts:1 — 이름은 greetPerson이 더 좋겠어요');
    await expect(canvas.getByRole('status')).toHaveTextContent('전송하지 않았습니다');
  },
};

export const WorkingFolderGit: Story = {
  args: { golden: claudeEditCreate as unknown as Golden },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: '변경 범위' }), 'git');
    await expect(await canvas.findByRole('button', { name: /^package-lock.json/u })).toBeInTheDocument();
    await expect(canvas.getByText(/브랜치 agent\/rename-greet/u)).toBeInTheDocument();
  },
};

export const WorkingFolderNotRepository: Story = {
  args: { golden: claudeEditCreate as unknown as Golden, git: 'not-a-repository' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: '변경 범위' }), 'git');
    await expect(await canvas.findByText('이 작업 폴더는 Git 저장소가 아닙니다.')).toBeInTheDocument();
  },
};

export const LegacyFragment: Story = {
  args: { golden: legacyClaudeEditCreate as unknown as Golden, title: '이전 기록' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText('부분 기록 · 줄 번호 없음')).toBeInTheDocument();
  },
};

export const EarlierNotLoaded: Story = {
  args: { golden: claudeEditCreate as unknown as Golden, floor: 1_840 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: '변경 범위' }), 'all');
    await expect(await canvas.findByRole('button', { name: '이전 변경 읽기' })).toBeInTheDocument();
  },
};

export const HistoryReadOnly: Story = {
  args: { golden: codexEditCreate as unknown as Golden, draft: 'history' },
};

export const FilesMarkdown: Story = {
  args: { golden: claudeEditCreate as unknown as Golden, section: 'files' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Notes' })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: '원본' }));
    await expect(await canvas.findByText('# Notes')).toBeInTheDocument();
  },
};

export const FilesCode: Story = {
  args: { golden: codexEditCreate as unknown as Golden, section: 'files', locale: 'en' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /src[\\/]app\.ts/u }));
    await expect(await canvas.findByText(/greetUser\('world'\)/u)).toBeInTheDocument();
  },
};

export const SummaryPlan: Story = {
  args: { golden: claudePlanMode as unknown as Golden, section: 'summary', children: CHILDREN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('region', { name: '계획' })).toBeInTheDocument();
    await expect(canvas.getByRole('region', { name: '하위 AI' })).toBeInTheDocument();
  },
};

export const SummaryTasks: Story = {
  args: { golden: claudeTodoEnabled as unknown as Golden, section: 'summary', locale: 'en' },
};

export const EmptyConversation: Story = {
  args: { golden: { provider: 'codex', items: [], approvals: [] }, title: '새 대화' },
};

export const NarrowPane: Story = {
  args: { golden: claudeEditCreate as unknown as Golden, width: 360 },
};
