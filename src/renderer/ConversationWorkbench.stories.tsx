import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { ChatComposerDraft } from '../shared/chat-message';
import type { ChatStateSnapshot } from '../shared/chat-state';
import type { ChatStateAccess } from './chat-recovery';
import { ConversationStartPanel } from './ConversationStartPanel';
import type { ConversationEntry, ConversationHistoryClient } from '../shared/conversation-history';
import type { DaemonTranscriptItem } from '../shared/daemon-protocol';
import { MobileActionSheet } from '../../mobile/src/MobileActionSheet';
import { MobileNavigationHistoryProvider } from '../../mobile/src/MobileNavigationHistory';
import { ConversationHistoryDialog, ConversationHistoryPicker } from './ConversationHistoryPicker';
import { ProjectConversationTree } from './ProjectConversationTree';
import { projectConversationTree, type ProjectNavigationTarget } from './project-conversation-tree-model';
import { StructuredAgentSessionPanel } from './StructuredAgentSession';
import { WorkflowWorkspacePanel } from './workflow/WorkflowWorkspacePanel';
import { workflowFixture, workflowNavigationFixture } from './workflow/workflow-fixtures';
import { AppI18nProvider } from './i18n';
import { Button } from './ui';
import './index.css';
import './structured-agent.css';
import './mobile-shared.css';
import '../../mobile/src/mobile.css';
import '../../mobile/src/mobile-shell.css';

const timestamp = '2026-10-14T09:42:00+09:00';
const updatedAt = Date.parse(timestamp);
const onContinueCli = fn();

/** Production components, deterministic local data; no provider process is started by this story. */
function ConversationWorkbenchStory({ mobile = false, preview = false, locale = 'ko' }: { mobile?: boolean; preview?: boolean; locale?: 'ko' | 'en' }): JSX.Element {
  const ko = locale === 'ko';
  const [history, setHistory] = useState<{ conversationId?: string }>();
  const [nativeId, setNativeId] = useState<string | undefined>(preview ? 'native-cli' : undefined);
  const storage = useMemo<ChatStateAccess>(() => {
    const records = new Map<string, ChatStateSnapshot>();
    return { chatStateRead: async scope => ({ ok: true, snapshot: records.get(scope.sessionId) ?? { version: 2, scope, revision: 0, state: { draft: { text: '' } }, updatedAt: null } }),
      chatStateWrite: async (scope, request) => { const snapshot: ChatStateSnapshot = { version: 2, scope, revision: request.expectedRevision + 1, state: request.state, updatedAt: null }; records.set(scope.sessionId, snapshot); return { ok: true, snapshot }; } };
  }, []);
  const [target, setTarget] = useState<ProjectNavigationTarget>();
  const [sessionId, setSessionId] = useState('current-session');
  const [drafts, setDrafts] = useState<Record<string, ChatComposerDraft>>({ 'current-session': { text: ko ? '닫은 뒤 이 초안에서 계속할게요.' : 'Continue from this draft after closing history.' } });
  const workflow = useMemo(() => {
    const value = workflowFixture();
    if (ko) { value.subprojects[0].title = '로그인 개선'; value.subprojects[0].graph.nodes[0].title = '조사'; value.subprojects[1].title = '결제 검토'; }
    return value;
  }, [ko]);
  const entries = useMemo<readonly ConversationEntry[]>(() => [
    { conversationId: 'app-current', source: 'app', providerId: 'codex', projectId: 'project-story', projectTitle: 'EZTerminal', title: ko ? '명령과 스킬 입력 UX' : 'Command and skill input UX', preview: ko ? '첫 메시지 전에 사용 가능한 명령을 확인합니다.' : 'Discover available commands before the first message.', roots: ['C:\\Working\\EZTerminal'], workspaceId: 'main', linkedSessionId: 'current-session', createdAt: updatedAt, updatedAt, archived: false, state: 'idle', action: 'open' },
    { conversationId: 'native-cli', source: 'native', providerId: 'claude', projectId: 'project-story', projectTitle: 'EZTerminal', title: ko ? '어제 CLI에서 확인한 배포 조건' : 'Yesterday’s release checks in CLI', preview: ko ? 'Android 재연결 이후 초안을 보존하는 흐름을 확인했습니다.' : 'Reviewed draft preservation after Android reconnects.', roots: ['C:\\Working\\EZTerminal'], historyId: 'opaque-record', createdAt: updatedAt - 86_400_000, updatedAt: updatedAt - 3_600_000, archived: false, state: 'history', action: 'resume' },
    { conversationId: 'stage-review', source: 'app', providerId: 'codex', projectId: 'project-story', projectTitle: 'EZTerminal', title: ko ? '로그인 요구사항 검토' : 'Review login requirements', preview: ko ? '기존 단계 대화를 같은 대화로 다시 엽니다.' : 'Open the same existing stage conversation.', roots: ['C:\\Working\\EZTerminal'], workspaceId: 'main', linkedSessionId: 'chat-stage', subprojectId: 'login', subprojectTitle: ko ? '로그인 개선' : 'Login improvements', nodeId: 'login:research', nodeTitle: ko ? '조사' : 'Investigation', createdAt: updatedAt - 86_400_000, updatedAt: updatedAt - 7_200_000, archived: false, state: 'idle', action: 'open' },
  ], [ko]);
  const client = useMemo<ConversationHistoryClient>(() => ({
    listConversations: async query => ({ ok: true, items: entries.filter(entry => (!query?.projectId || entry.projectId === query.projectId) && (!query?.providerId || entry.providerId === query.providerId) && (!query?.source || entry.source === query.source) && query?.archived !== 'only' && (!query?.query || `${entry.title} ${entry.preview}`.toLowerCase().includes(query.query.toLowerCase()))), nextCursor: null }),
    readConversation: async conversationId => { const entry = entries.find(item => item.conversationId === conversationId)!; return { ok: true, entry, transcript: { historyId: conversationId, provider: entry.providerId as 'claude' | 'codex', nextCursor: null, turns: [{ id: 'turn', status: 'completed', entries: [
      { type: 'message', id: 'user', role: 'user', markdown: ko ? '이전에 CLI에서 진행한 검토를 앱에서 계속하고 싶어요.' : 'I want to continue the earlier CLI review in the app.' },
      { type: 'message', id: 'assistant', role: 'assistant', markdown: ko ? '대화의 원래 내용과 작업 폴더를 확인했습니다. 다음 단계는 Android 연결이 복구될 때 입력 중인 초안이 유지되는지 확인하는 것입니다.' : 'The original conversation and working folder are available. Next, verify that unsent drafts remain after Android reconnects.' },
    ] }] } }; },
    prepareHistoryResume: async ({ conversationId }) => ({ ok: true, entry: entries.find(item => item.conversationId === conversationId)!, revision: 'fixture-revision', workspaceId: 'main', canResume: true, action: 'resume', model: 'Default model', permissionPreset: 'standard' }),
    resumeHistory: async () => ({ ok: true, sessionId: 'continued-session', alreadyLinked: false }),
  }), [entries, ko]);
  const nodes = useMemo(() => projectConversationTree({ projects: [{ id: 'project-story', title: 'EZTerminal', pinned: true }], workflows: { 'project-story': workflowNavigationFixture(workflow) }, conversations: entries.map(entry => ({ id: entry.conversationId, projectId: entry.projectId, title: entry.title, updatedAt: entry.updatedAt, source: entry.source === 'native' ? 'native' : entry.nodeId ? 'stage' : 'agent', providerLabel: entry.providerId === 'codex' ? 'Codex' : 'Claude', sessionId: entry.linkedSessionId })) }), [entries, workflow]);
  const access = useMemo(() => ({ getWorkflowSnapshot: async () => ({ ok: true as const, snapshot: workflow }), executeWorkflowCommand: async () => ({ ok: false as const, error: 'read-only-story', message: 'No workflow commands are sent by this fixture.' }) }), [workflow]);
  const openTarget = (next: ProjectNavigationTarget): void => {
    setNativeId(next.kind === 'conversation' && !next.sessionId ? next.conversationId : undefined);
    setTarget(next);
    if (next.kind === 'conversation' && next.sessionId) setSessionId(next.sessionId);
  };
  const openSession = ({ sessionId: next }: { sessionId: string }): void => { setTarget({ kind: 'conversation', projectId: 'project-story', conversationId: next, sessionId: next }); setSessionId(next); setHistory(undefined); };
  const selectedWorkflow = target?.kind === 'stage' || target?.kind === 'subproject' ? target : undefined;
  const mobileDetail = mobile && (target?.kind === 'conversation' || !!selectedWorkflow || !!nativeId);
  const selectedEntry = entries.find(entry => entry.linkedSessionId === sessionId) ?? entries[1];
  const items: readonly DaemonTranscriptItem[] = [
    { id: 'request', sessionId, turnId: 'turn', sequence: 1, kind: 'user-message', text: selectedEntry.title, isDelta: false, isSensitive: false, createdAt: timestamp },
    { id: 'answer', sessionId, turnId: 'turn', sequence: 2, kind: 'assistant-message', text: selectedEntry.preview, isDelta: false, isSensitive: false, createdAt: timestamp },
  ];
  const picker = { client, currentProjectId: 'project-story', initialConversationId: history?.conversationId, onOpenSession: openSession,
    onOpenConversation: (entry: ConversationEntry) => { openTarget({ kind: 'conversation', projectId: entry.projectId, conversationId: entry.conversationId, sessionId: entry.linkedSessionId }); setHistory(undefined); } };
  const startAccess = useMemo(() => ({ history: client, getSnapshot: async () => null, sendCommand: async () => null, principal: { kind: 'desktop' as const, id: 'story' } }), [client]);
  return <AppI18nProvider locale={locale} languages={[locale]}><MobileNavigationHistoryProvider>
    <div className="project-navigation-story" data-mobile={mobile || undefined} style={mobile ? { width: '100vw', height: '100vh', overflow: 'auto' } : { height: '100vh', overflow: 'hidden' }}>
      <aside hidden={mobileDetail} className="project-navigation-story__navigation"><h2>{ko ? '프로젝트' : 'Projects'}</h2><div className="project-navigation-story__toolbar"><Button onClick={() => setHistory({})}>{ko ? '이전 대화' : 'Previous conversations'}</Button></div><ProjectConversationTree nodes={nodes} persistenceScope={`combined-story-${mobile}-${locale}`} mobile={mobile} onOpen={openTarget} /></aside>
      <main hidden={mobile && !mobileDetail} style={{ minWidth: 0, minHeight: 0, height: '100%', overflow: 'auto' }}>
        {mobileDetail && <Button onClick={() => { setTarget(undefined); setNativeId(undefined); }}>{ko ? '프로젝트로 돌아가기' : 'Back to projects'}</Button>}
        {nativeId ? <ConversationStartPanel key={nativeId} identity={nativeId} entry={entries.find(entry => entry.conversationId === nativeId)} snapshot={null} access={startAccess} storage={storage} variant={mobile ? 'mobile' : 'desktop'} onOpenHistory={() => setHistory({})} onContinueCli={async () => { onContinueCli(); }} onStarted={() => undefined} />
          : selectedWorkflow ? <WorkflowWorkspacePanel projectId="project-story" projectName="EZTerminal" access={access} mobile={mobile} conversations={[{ id: 'chat-stage', title: entries[2].title }]} onOpenConversation={next => openSession({ sessionId: next })} navigationTarget={{ subprojectId: selectedWorkflow.subprojectId, nodeId: selectedWorkflow.kind === 'stage' ? selectedWorkflow.nodeId : undefined, key: JSON.stringify(selectedWorkflow) }} />
          : <StructuredAgentSessionPanel key={sessionId} sessionId={sessionId} title={selectedEntry.title} providerId={selectedEntry.providerId} providerLabel={selectedEntry.providerId === 'codex' ? 'Codex' : 'Claude'} workspace={{ id: 'main', label: 'EZTerminal', kind: 'local', path: 'C:\\Working\\EZTerminal' }} permissionPreset="standard" state="idle" items={items} variant={mobile ? 'mobile' : 'desktop'} draftState={drafts[sessionId] ?? { text: '' }} onDraftChange={draft => setDrafts(current => ({ ...current, [sessionId]: draft }))} onOpenHistory={() => setHistory({})} onSend={async () => ({ ok: false, message: ko ? '시안에서는 메시지를 전송하지 않습니다.' : 'Messages are not sent by this fixture.' })} />}
      </main>
      {mobile ? history && <MobileActionSheet title={ko ? '이전 대화' : 'Previous conversations'} onClose={() => setHistory(undefined)} variant="fullscreen" className="mobile-conversation-history-sheet" contentClassName="mobile-conversation-history-content"><ConversationHistoryPicker {...picker} variant="mobile" /></MobileActionSheet>
        : <ConversationHistoryDialog {...picker} open={!!history} onOpenChange={open => { if (!open) setHistory(undefined); }} />}
    </div>
  </MobileNavigationHistoryProvider></AppI18nProvider>;
}

const meta = { title: 'Production/Navigation/Conversation workbench', component: ConversationWorkbenchStory, parameters: { layout: 'fullscreen', a11y: { test: 'error' } } } satisfies Meta<typeof ConversationWorkbenchStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop: Story = { args: { locale: 'en' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('treeitem', { name: 'Yesterday’s release checks in CLI · CLI · Claude' }));
  await expect(await canvas.findByText('I want to continue the earlier CLI review in the app.')).toBeVisible();
  await expect(canvas.getByRole('textbox', { name: 'Message Agent' })).toBeVisible();
  await expect(canvas.queryByRole('button', { name: 'Continue in Agent' })).toBeNull();
  await userEvent.click(canvas.getByRole('treeitem', { name: 'Command and skill input UX · Chat · Codex' }));
  await expect(canvas.getByRole('textbox', { name: 'Message Agent' })).toHaveValue('Continue from this draft after closing history.');
} };
export const DesktopNativePreview: Story = { args: { preview: true } };
export const AndroidNativePreview: Story = { args: { mobile: true, preview: true } };
export const AndroidNavigation: Story = { args: { mobile: true } };
