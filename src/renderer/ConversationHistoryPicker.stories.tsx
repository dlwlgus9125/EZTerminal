import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { ConversationEntry, ConversationHistoryClient } from '../shared/conversation-history';
import { ConversationHistoryPicker } from './ConversationHistoryPicker';
import { AppI18nProvider } from './i18n';
import './index.css';

const updatedAt = Date.parse('2026-10-14T09:42:00+09:00');
const entries: readonly ConversationEntry[] = [
  { conversationId: 'app-current', source: 'app', providerId: 'codex', projectId: 'ezterminal', projectTitle: 'EZTerminal', title: '입력 UX 검토', preview: '첫 메시지 전에 스킬과 명령을 찾을 수 있어야 합니다.', roots: ['C:\\Working\\EZTerminal'], workspaceId: 'main', linkedSessionId: 'session-current', createdAt: updatedAt, updatedAt, archived: false, state: 'idle', action: 'open' },
  { conversationId: 'native-cli', source: 'native', providerId: 'claude', projectId: 'ezterminal', projectTitle: 'EZTerminal', title: 'Android 연결 복구', preview: '프로젝트 목록에서 이전 대화를 바로 열고 복구 흐름을 검토했습니다.', roots: ['C:\\Working\\EZTerminal'], historyId: 'opaque-cli-record', createdAt: updatedAt - 3_600_000, updatedAt: updatedAt - 1_800_000, archived: false, state: 'history', action: 'resume' },
  { conversationId: 'stage-review', source: 'app', providerId: 'claude', projectId: 'ezterminal', projectTitle: 'EZTerminal', title: '오프라인 초안 검증', preview: '재연결 후 자동으로 메시지를 전송하지 않는 것을 확인했습니다.', roots: ['C:\\Working\\EZTerminal'], workspaceId: 'main', linkedSessionId: 'session-stage', subprojectId: 'mobile', subprojectTitle: '모바일 개선', nodeId: 'review', nodeTitle: '검증', createdAt: updatedAt - 86_400_000, updatedAt: updatedAt - 50_000_000, archived: true, state: 'archived', action: 'resume' },
];
const client: ConversationHistoryClient = {
  listConversations: fn(async (query) => ({ ok: true as const, items: entries.filter((entry) => (!query?.projectId || entry.projectId === query.projectId) && (!query?.providerId || entry.providerId === query.providerId) && (!query?.source || entry.source === query.source) && (query?.archived !== 'only' || entry.archived) && (query?.archived !== 'exclude' || !entry.archived) && (!query?.query || `${entry.title} ${entry.preview}`.includes(query.query))), nextCursor: null })),
  readConversation: fn(async (conversationId) => {
    const entry = entries.find((item) => item.conversationId === conversationId)!;
    return { ok: true as const, entry, transcript: { historyId: conversationId, provider: entry.providerId as 'codex' | 'claude', nextCursor: null, turns: [{ id: 'turn-1', status: 'completed', entries: [
      { type: 'message' as const, id: 'message-user', role: 'user' as const, markdown: '프로젝트 목록에서 이전 대화와 소프로젝트를 바로 확인하고 싶어요.' },
      { type: 'message' as const, id: 'message-assistant', role: 'assistant' as const, markdown: '대화와 소프로젝트를 같은 깊이에서 표시하고, 이전 CLI 기록은 출처를 함께 보여주겠습니다.\n\n현재 입력과 읽던 위치는 대화를 전환해도 유지됩니다.' },
    ] }] } };
  }),
  prepareHistoryResume: fn(async ({ conversationId }) => ({ ok: true as const, entry: entries.find((entry) => entry.conversationId === conversationId)!, revision: 'reviewed-revision', workspaceId: 'main', canResume: true, action: 'resume' as const, model: 'Default model', permissionPreset: 'standard' as const })),
  resumeHistory: fn(async () => ({ ok: true as const, sessionId: 'continued-session', alreadyLinked: false })),
};

const meta = {
  title: 'Agents/Unified conversation history', component: ConversationHistoryPicker,
  parameters: { layout: 'centered', a11y: { test: 'error' } },
  globals: { locale: 'ko' },
  args: { client, currentProjectId: 'ezterminal', projects: [{ id: 'ezterminal', name: 'EZTerminal' }], onOpenSession: fn(), onOpenCliHistory: fn() },
  decorators: [(Story, context) => <AppI18nProvider locale={context.globals.locale === 'en' ? 'en' : 'ko'} languages={['ko', 'en']}><div style={{ width: 'min(calc(100vw - 32px), 1060px)', background: 'var(--ui-surface)' }}><Story /></div></AppI18nProvider>],
} satisfies Meta<typeof ConversationHistoryPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CombinedList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('입력 UX 검토')).toBeVisible();
    await expect(canvas.getByText('Android 연결 복구')).toBeVisible();
    await expect(canvas.getByText('오프라인 초안 검증')).toBeVisible();
  },
};
export const NativePreview: Story = { args: { initialConversationId: 'native-cli' } };
export const ExistingConversation: Story = { args: { initialConversationId: 'app-current' } };
export const ArchivedStage: Story = { args: { initialConversationId: 'stage-review' } };
export const EnglishNativePreview: Story = { globals: { locale: 'en' }, args: NativePreview.args };
export const EmptySearch: Story = { play: async ({ canvasElement }) => { const canvas = within(canvasElement); await userEvent.type(canvas.getByRole('textbox'), 'no-matching-conversation'); await expect(await canvas.findByText('조건에 맞는 대화가 없습니다. 검색 조건을 바꿔보세요.')).toBeVisible(); } };
export const Loading: Story = { args: { client: { ...client, listConversations: () => new Promise(() => undefined) } } };
export const Offline: Story = { args: { disconnected: true } };
export const HostUpdateNeeded: Story = { args: { client: undefined } };
export const MissingWorkingFolder: Story = { args: { ...NativePreview.args, client: { ...client, prepareHistoryResume: fn(async () => ({ ok: true as const, entry: entries[1], revision: 'missing-root', canResume: false, action: 'unavailable' as const, blockedReason: 'missing-root' as const, permissionPreset: 'standard' as const })) } } };
export const UnconfirmedContinuation: Story = {
  args: { ...NativePreview.args, client: { ...client, resumeHistory: fn(async () => ({ ok: false as const, reason: 'unavailable' as const, message: 'Connection lost.' })) } },
  play: async ({ canvasElement }) => { const canvas = within(canvasElement); const action = await canvas.findByRole('button', { name: 'Agent로 이어가기' }); await expect(action).toBeEnabled(); await userEvent.click(action); await expect(await canvas.findByRole('button', { name: '같은 요청 결과 확인' })).toBeVisible(); },
};
export const MobileList: Story = {
  args: { variant: 'mobile' },
  decorators: [(Story) => <div style={{ width: 'min(100vw, 390px)', height: 'min(90vh, 760px)' }}><Story /></div>],
};
export const MobileNativePreview: Story = { ...MobileList, args: { ...MobileList.args, ...NativePreview.args } };
