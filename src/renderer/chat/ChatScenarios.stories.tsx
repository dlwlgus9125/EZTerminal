import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import type { ApprovalRequest } from '../../shared/approval-request';
import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../shared/daemon-protocol';
import { AppI18nProvider } from '../i18n';
import { StructuredAgentSessionPanel } from '../StructuredAgentSession';
import { HighlighterProvider } from './markdown/HighlighterProvider';
import claudeApprovalDeny from './fixtures/claude-approval-deny.json';
import claudeAskQuestion from './fixtures/claude-ask-question.json';
import claudeEditCreate from './fixtures/claude-edit-create.json';
import claudeMarkdown from './fixtures/claude-markdown.json';
import claudePlanMode from './fixtures/claude-plan-mode.json';
import claudeReadSearch from './fixtures/claude-read-search.json';
import claudeTodoEnabled from './fixtures/claude-todo-enabled.json';
import codexCommandOkFail from './fixtures/codex-command-ok-fail.json';
import codexEditCreate from './fixtures/codex-edit-create.json';
import codexMarkdown from './fixtures/codex-markdown.json';
import codexWeb from './fixtures/codex-web.json';
import '../index.css';
import '../structured-agent.css';

/**
 * Production chat panel rendering transcripts recorded from real Codex and
 * Claude sessions (test/fixtures/provider-capture → replay goldens). Nothing
 * here starts a provider; the data is exactly what the adapters produced.
 */

interface Golden {
  readonly provider: string;
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals: readonly DaemonApproval[];
}

const STARTED = '2026-10-15T09:30:00.000Z';
const STORY_FILES = ['README.md', 'package.json', 'src/app.ts', 'src/auth/useLogin.ts', 'src/auth/LoginForm.tsx', 'notes.md'];
const FINISHED = '2026-10-15T09:30:42.000Z';

function turnsOf(items: readonly DaemonTranscriptItem[], state: DaemonTurn['state']): DaemonTurn[] {
  const ids = [...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : [])))];
  return ids.map((id) => ({
    id, sessionId: items[0]?.sessionId ?? 'session', commandId: `command-${id}`, state,
    // A running turn started 37s ago so its timer reads like a real one.
    ...(state === 'working' || state === 'blocked'
      ? { startedAt: new Date(Date.now() - 37_000).toISOString() }
      : { startedAt: STARTED, finishedAt: FINISHED }),
    revision: 1, createdAt: STARTED, updatedAt: FINISHED,
  }));
}

function cutBefore(items: readonly DaemonTranscriptItem[], predicate: (item: DaemonTranscriptItem) => boolean): DaemonTranscriptItem[] {
  const index = items.findIndex(predicate);
  return index < 0 ? [...items] : items.slice(0, index);
}

function toolInput(items: readonly DaemonTranscriptItem[], name: string): Record<string, unknown> | undefined {
  const call = items.find((item) => item.kind === 'tool-call' && item.text.startsWith(`${name}\n`));
  if (!call) return undefined;
  try { return JSON.parse(call.text.slice(name.length + 1)) as Record<string, unknown>; } catch { return undefined; }
}

function pendingApproval(golden: Golden, request: ApprovalRequest, title: string, risk: DaemonApproval['risk']): DaemonApproval {
  const base = golden.approvals[0];
  return {
    id: base?.id ?? 'approval-story', sessionId: golden.items[0]!.sessionId, ...(base?.turnId ? { turnId: base.turnId } : {}),
    providerRequestId: base?.providerRequestId ?? 'request-story', risk, title, state: 'pending', request,
    revision: 1, createdAt: STARTED, updatedAt: STARTED,
  };
}

interface ScenarioArgs {
  readonly golden: Golden;
  readonly items?: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  readonly turnState?: DaemonTurn['state'];
  readonly state?: 'idle' | 'working' | 'blocked';
  readonly skin: 'bubble' | 'cli';
  readonly locale?: 'ko' | 'en';
}

function Scenario({ golden, items, approvals, turnState = 'completed', state = 'idle', skin, locale = 'ko' }: ScenarioArgs): JSX.Element {
  const shown = items ?? golden.items;
  const claude = golden.provider === 'claude';
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <HighlighterProvider>
      <div style={{ width: '100vw', height: '100vh', display: 'flex' }}>
        <StructuredAgentSessionPanel
          sessionId={`story-${golden.provider}`}
          title={claude ? '로그인 재시도 표시 수정' : 'Codex 작업'}
          providerId={golden.provider}
          providerLabel={claude ? 'Claude' : 'Codex'}
          workspace={{ id: 'main', label: 'demo-app', kind: 'local', path: '<WORKSPACE>' }}
          model={claude ? 'opus' : 'gpt-6-astra'}
          modelOptions={claude ? [{ id: 'opus', label: 'Opus' }] : [{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }]}
          permissionPreset="standard"
          state={state}
          items={shown}
          approvals={approvals ?? golden.approvals}
          turns={turnsOf(shown, turnState)}
          approvalResponses
          skin={skin}
          onSend={fn(async () => ({ ok: true as const }))}
          onInterruptAndSend={fn(async () => ({ ok: true as const }))}
          onChangeSettings={fn(async () => ({ ok: true as const }))}
          onResolveApproval={fn(async () => ({ ok: true as const }))}
          onOpenLink={fn()}
          onCancel={fn(async () => ({ ok: true as const }))}
          effortSupported
          reasoningEffort="high"
          supportsMessageContext
          fileSearch={async (query) => STORY_FILES.filter((file) => file.toLowerCase().includes(query.toLowerCase()))}
        />
      </div>
      </HighlighterProvider>
    </AppI18nProvider>
  );
}

const meta = {
  title: 'Chat/Scenarios',
  component: Scenario,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
} satisfies Meta<typeof Scenario>;

export default meta;
type Story = StoryObj<typeof meta>;

const askGolden = claudeAskQuestion as unknown as Golden;
const askInput = toolInput(askGolden.items, 'AskUserQuestion');
const askItems = cutBefore(askGolden.items, (item) => item.kind === 'approval' || item.kind === 'tool-result');
const askApproval = pendingApproval(askGolden, {
  v: 1, kind: 'question', callId: 'ask',
  questions: ((askInput?.questions as { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] }[] | undefined) ?? [])
    .map((question) => ({ question: question.question, ...(question.header ? { header: question.header } : {}), multiSelect: Boolean(question.multiSelect), options: question.options })),
}, 'Answer a question', 'read');

const planGolden = claudePlanMode as unknown as Golden;
const planInput = toolInput(planGolden.items, 'ExitPlanMode');
const planItems = cutBefore(planGolden.items, (item) => item.kind === 'approval');
const planApproval = pendingApproval(planGolden, {
  v: 1, kind: 'plan', markdown: String(planInput?.plan ?? ''), ...(typeof planInput?.planFilePath === 'string' ? { filePath: planInput.planFilePath } : {}),
}, 'Approve plan', 'write');

const denyGolden = claudeApprovalDeny as unknown as Golden;
const denyInput = toolInput(denyGolden.items, 'PowerShell');
const denyItems = cutBefore(denyGolden.items, (item) => item.kind === 'approval');
const denyApproval = pendingApproval(denyGolden, {
  v: 1, kind: 'command', command: String(denyInput?.command ?? ''), cwd: '<WORKSPACE>',
}, 'Run command', 'danger');

const editGolden = claudeEditCreate as unknown as Golden;
const editInput = toolInput(editGolden.items, 'Edit');
const editItems = cutBefore(editGolden.items, (item) => item.kind === 'approval');
const editApproval = pendingApproval(editGolden, {
  v: 1, kind: 'file-change', files: [{
    path: String(editInput?.file_path ?? 'src/app.ts'), kind: 'update',
    diff: `${String(editInput?.old_string ?? '').split('\n').map((line) => `-${line}`).join('\n')}\n${String(editInput?.new_string ?? '').split('\n').map((line) => `+${line}`).join('\n')}`,
  }],
}, 'Edit app.ts', 'write');

const streamingGolden = codexMarkdown as unknown as Golden;
const streamingItems = (() => {
  const deltas = streamingGolden.items.filter((item) => item.kind === 'assistant-message' && item.isDelta);
  const cut = deltas[Math.floor(deltas.length * 0.55)];
  return streamingGolden.items.filter((item) => item.sequence <= (cut?.sequence ?? 0) && item.kind !== 'notice' && !(item.kind === 'assistant-message' && !item.isDelta && item.sequence > 3));
})();

export const ReadSearchBubble: Story = { args: { golden: claudeReadSearch as unknown as Golden, skin: 'bubble' } };
export const ReadSearchCli: Story = { args: { golden: claudeReadSearch as unknown as Golden, skin: 'cli' } };
export const CommandsBubble: Story = { args: { golden: codexCommandOkFail as unknown as Golden, skin: 'bubble' } };
export const CommandsCli: Story = { args: { golden: codexCommandOkFail as unknown as Golden, skin: 'cli' } };
export const EditsBubble: Story = { args: { golden: editGolden, skin: 'bubble' } };
export const EditsCli: Story = { args: { golden: editGolden, skin: 'cli' } };
export const CodexEditsBubble: Story = { args: { golden: codexEditCreate as unknown as Golden, skin: 'bubble' } };
export const WebBubble: Story = { args: { golden: codexWeb as unknown as Golden, skin: 'bubble' } };
export const TasksBubble: Story = { args: { golden: claudeTodoEnabled as unknown as Golden, skin: 'bubble' } };
export const TasksCli: Story = { args: { golden: claudeTodoEnabled as unknown as Golden, skin: 'cli' } };
export const MarkdownBubble: Story = { args: { golden: claudeMarkdown as unknown as Golden, skin: 'bubble' } };
export const MarkdownCli: Story = { args: { golden: claudeMarkdown as unknown as Golden, skin: 'cli' } };
export const StreamingBubble: Story = { args: { golden: streamingGolden, items: streamingItems, turnState: 'working', state: 'working', skin: 'bubble' } };
export const StreamingCli: Story = { args: { golden: streamingGolden, items: streamingItems, turnState: 'working', state: 'working', skin: 'cli' } };
export const QuestionPendingBubble: Story = { args: { golden: askGolden, items: askItems, approvals: [askApproval], turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const QuestionPendingCli: Story = { args: { golden: askGolden, items: askItems, approvals: [askApproval], turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const PlanPendingBubble: Story = { args: { golden: planGolden, items: planItems, approvals: [planApproval], turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const CommandPendingBubble: Story = { args: { golden: denyGolden, items: denyItems, approvals: [denyApproval], turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const CommandPendingCli: Story = { args: { golden: denyGolden, items: denyItems, approvals: [denyApproval], turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const EditPendingBubble: Story = { args: { golden: editGolden, items: editItems, approvals: [editApproval], turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const DeniedBubble: Story = { args: { golden: denyGolden, skin: 'bubble' } };
export const EnglishCommandsBubble: Story = { args: { golden: codexCommandOkFail as unknown as Golden, skin: 'bubble', locale: 'en' } };
