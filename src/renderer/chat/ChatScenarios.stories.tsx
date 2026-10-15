import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn } from '../../shared/daemon-protocol';
import { AppI18nProvider } from '../i18n';
import type { AgentCapabilitiesClient } from '../../shared/agent-capabilities';
import { StructuredAgentHeartbeat } from '../StructuredAgentHeartbeat';
import { StructuredAgentSessionPanel } from '../StructuredAgentSession';
import { HighlighterProvider } from './markdown/HighlighterProvider';
import claudeApprovalDeny from './fixtures/claude-approval-deny.json';
import claudeInterrupt from './fixtures/claude-interrupt.json';
import claudeAskQuestion from './fixtures/claude-ask-question.json';
import claudeEditCreate from './fixtures/claude-edit-create.json';
import claudeMarkdown from './fixtures/claude-markdown.json';
import claudePlanMode from './fixtures/claude-plan-mode.json';
import claudeReadSearch from './fixtures/claude-read-search.json';
import claudeTodoEnabled from './fixtures/claude-todo-enabled.json';
import codexApprovalDeny from './fixtures/codex-approval-deny.json';
import codexCommandOkFail from './fixtures/codex-command-ok-fail.json';
import codexEditCreate from './fixtures/codex-edit-create.json';
import codexFileApproval from './fixtures/codex-file-approval.json';
import codexInterrupt from './fixtures/codex-interrupt.json';
import codexMarkdown from './fixtures/codex-markdown.json';
import codexWeb from './fixtures/codex-web.json';
import legacyClaudeEditCreate from './fixtures/legacy/claude-edit-create.json';
import legacyCodexCommandOkFail from './fixtures/legacy/codex-command-ok-fail.json';
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

/** The recorded approval, still pending, with the transcript cut where it was asked. */
function pendingScenario(golden: Golden, index = 0): { readonly items: DaemonTranscriptItem[]; readonly approvals: DaemonApproval[] } {
  const recorded = golden.approvals[index]!;
  const callId = recorded.request?.callId;
  const items = cutBefore(golden.items, (item) => item.kind === 'approval'
    || (item.kind === 'tool-result' && callId !== undefined && (item.payload as { callId?: string } | undefined)?.callId === callId));
  return { items, approvals: [{ ...recorded, state: 'pending' }] };
}

/** An old host: no payloads and no structured approval requests, only text. */
function legacyHost(golden: Golden): Golden {
  return { ...golden, approvals: golden.approvals.map((approval) => Object.fromEntries(Object.entries(approval).filter(([key]) => key !== 'request')) as unknown as DaemonApproval) };
}

/** Extension discovery answered by the host, so the header shows "Extensions N". */
function capabilityClient(providerId: 'codex' | 'claude'): AgentCapabilitiesClient {
  return {
    list: async () => ({ ok: true as const, value: {
      providerId, workspaceId: 'main', workspaceRoot: '<WORKSPACE>', hostId: 'Development PC', revision: 'a'.repeat(64),
      observedAt: STARTED, canManage: false, application: 'new-session' as const, models: [], actions: [], issues: [],
      items: [
        { id: 'review', kind: 'skill' as const, name: 'review', description: 'Review the changes', enabled: true, invocation: providerId === 'claude' ? '/review' : '$review', actions: [] },
        { id: 'docs', kind: 'skill' as const, name: 'docs', description: 'Write documentation', enabled: true, invocation: providerId === 'claude' ? '/docs' : '$docs', actions: [] },
      ],
    } }),
    manage: async () => ({ ok: false as const, message: 'Not in stories' }),
  } as unknown as AgentCapabilitiesClient;
}

interface ScenarioArgs {
  readonly golden: Golden;
  readonly items?: readonly DaemonTranscriptItem[];
  readonly approvals?: readonly DaemonApproval[];
  readonly turnState?: DaemonTurn['state'];
  readonly state?: 'idle' | 'working' | 'blocked';
  readonly skin: 'bubble' | 'cli';
  readonly locale?: 'ko' | 'en';
  readonly heartbeatActive?: boolean;
}

function Scenario({ golden, items, approvals, turnState = 'completed', state = 'idle', skin, locale = 'ko', heartbeatActive = false }: ScenarioArgs): JSX.Element {
  const shown = items ?? golden.items;
  const claude = golden.provider === 'claude';
  return (
    <AppI18nProvider locale={locale} languages={[locale]}>
      <HighlighterProvider>
      <div style={{ width: '100vw', height: '100vh', display: 'flex' }}>
        <StructuredAgentSessionPanel
          sessionId={golden.items[0]?.sessionId ?? `story-${golden.provider}`}
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
          onArchive={fn(async () => ({ ok: true as const }))}
          onOpenHistory={fn()}
          capabilityClient={capabilityClient(claude ? 'claude' : 'codex')}
          heartbeatActive={heartbeatActive}
          heartbeatControl={(
            <StructuredAgentHeartbeat defaultOpen sessionId="story" automationReady
              onSave={fn(async () => ({ ok: true as const }))} onRunNow={fn(async () => ({ ok: true as const }))}
              onEnableHost={fn(async () => ({ ok: true as const }))} />
          )}
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
const ask = pendingScenario(askGolden);
const planGolden = claudePlanMode as unknown as Golden;
const plan = pendingScenario(planGolden);
const denyGolden = claudeApprovalDeny as unknown as Golden;
const deny = pendingScenario(denyGolden);
const editGolden = claudeEditCreate as unknown as Golden;
const edit = pendingScenario(editGolden);
const codexFileGolden = codexFileApproval as unknown as Golden;
const codexFile = pendingScenario(codexFileGolden);
const codexDenyGolden = codexApprovalDeny as unknown as Golden;
const codexDeny = pendingScenario(codexDenyGolden);

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
export const QuestionPendingBubble: Story = { args: { golden: askGolden, ...ask, turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const QuestionPendingCli: Story = { args: { golden: askGolden, ...ask, turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const PlanPendingBubble: Story = { args: { golden: planGolden, ...plan, turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const PlanPendingCli: Story = { args: { golden: planGolden, ...plan, turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const CommandPendingBubble: Story = { args: { golden: denyGolden, ...deny, turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const CommandPendingCli: Story = { args: { golden: denyGolden, ...deny, turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const EditPendingBubble: Story = { args: { golden: editGolden, ...edit, turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const EditPendingCli: Story = { args: { golden: editGolden, ...edit, turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const CodexFilePendingBubble: Story = { args: { golden: codexFileGolden, ...codexFile, turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const CodexCommandPendingBubble: Story = { args: { golden: codexDenyGolden, ...codexDeny, turnState: 'blocked', state: 'blocked', skin: 'bubble' } };
export const CodexCommandPendingCli: Story = { args: { golden: codexDenyGolden, ...codexDeny, turnState: 'blocked', state: 'blocked', skin: 'cli' } };
export const CodexDeniedBubble: Story = { args: { golden: codexDenyGolden, skin: 'bubble' } };
export const InterruptBubble: Story = { args: { golden: claudeInterrupt as unknown as Golden, turnState: 'interrupted', skin: 'bubble' } };
export const InterruptCli: Story = { args: { golden: claudeInterrupt as unknown as Golden, turnState: 'interrupted', skin: 'cli' } };
export const CodexInterruptBubble: Story = { args: { golden: codexInterrupt as unknown as Golden, turnState: 'interrupted', skin: 'bubble' } };
/** Conversations stored before payloads, or served by an old host, decode from text alone. */
export const LegacyHostBubble: Story = { args: { golden: legacyHost(legacyClaudeEditCreate as unknown as Golden), skin: 'bubble' } };
export const LegacyHostCli: Story = { args: { golden: legacyHost(legacyCodexCommandOkFail as unknown as Golden), skin: 'cli' } };
export const DeniedBubble: Story = { args: { golden: denyGolden, skin: 'bubble' } };
export const EnglishCommandsBubble: Story = { args: { golden: codexCommandOkFail as unknown as Golden, skin: 'bubble', locale: 'en' } };
export const FindInConversation: Story = {
  args: { golden: claudeMarkdown as unknown as Golden, skin: 'bubble', locale: 'en' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('structured-agent-composer-input'));
    await userEvent.keyboard('{Control>}f{/Control}');
    const field = await canvas.findByRole('textbox', { name: 'Find in conversation' });
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.type(field, 'union');
    const status = within(canvas.getByTestId('chat-find')).getByRole('status');
    await waitFor(() => expect(status.textContent).toMatch(/^\d+ of \d+$/u));
    const [current, total] = status.textContent!.split(' of ').map(Number);
    await expect(current).toBe(total);
    await userEvent.keyboard('{Enter}');
    await expect(status.textContent).toBe(`1 of ${total}`);
    await expect(canvasElement.querySelector('[data-find-current]')?.getAttribute('data-kind')).toBe('user');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByTestId('chat-find')).not.toBeInTheDocument());
  },
};
/** The one-row header with every action present: changes, extensions, a running heartbeat and the session menu. */
export const HeaderActions: Story = {
  args: { golden: editGolden, skin: 'bubble', heartbeatActive: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const details = await waitFor(() => {
      const found = canvasElement.querySelector<HTMLDetailsElement>('.agent-capabilities--compact');
      if (!found) throw new Error('extensions not rendered');
      return found;
    });
    const summary = details.querySelector('summary')!;
    // The extensions dropdown closes like a menu: Esc, or a click elsewhere.
    await userEvent.click(summary);
    await expect(details.open).toBe(true);
    await userEvent.keyboard('{Escape}');
    await expect(details.open).toBe(false);
    await userEvent.click(summary);
    await userEvent.click(canvas.getByTestId('structured-agent-composer-input'));
    await expect(details.open).toBe(false);
  },
};
