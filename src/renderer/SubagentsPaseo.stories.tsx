import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { DaemonApproval, DaemonTranscriptItem, DaemonTurn, ManagedAgentState } from '../shared/daemon-protocol';
import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import { AgentProfilesSettings } from './AgentProfilesSettings';
import { AppChatInbox, type AppChatInboxItem } from './AppChatInbox';
import { DelegateAgentDialog, type DelegateMode } from './DelegateAgentDialog';
import { AppI18nProvider } from './i18n';
import { ProjectConversationTree } from './ProjectConversationTree';
import { projectConversationTree, type ProjectNavigationConversation, type ProjectNavigationWorkspace } from './project-conversation-tree-model';
import { StructuredAgentChildTrack, StructuredAgentSessionPanel, type StructuredAgentChildTrackItem } from './StructuredAgentSession';
import { HighlighterProvider } from './chat/markdown/HighlighterProvider';
import claudeSubagentApproval from './chat/fixtures/claude-subagent-approval.json';
import claudeSubagents from './chat/fixtures/claude-subagents.json';
import { Button, IconButton } from './ui';
import { GitMerge, MessageSquarePlus, FileDiff } from 'lucide-react';
import './index.css';
import './structured-agent.css';

/**
 * Proposal for the subagent and Paseo pass: production components fed with
 * real recordings (test/fixtures/provider-capture → expected goldens in which
 * each subagent's rows live in its own session).
 */

interface Golden {
  readonly items: readonly DaemonTranscriptItem[];
  readonly approvals: readonly DaemonApproval[];
  readonly sessions: readonly { readonly sessionId: string; readonly title: string; readonly subagentType?: string; readonly state: string }[];
}

const STARTED = '2026-10-17T03:55:00.000Z';
const FINISHED = '2026-10-17T03:55:31.000Z';
const subagents = claudeSubagents as unknown as Golden;
const subagentApproval = claudeSubagentApproval as unknown as Golden;

function sessionItems(golden: Golden, sessionId: string): DaemonTranscriptItem[] {
  return golden.items.filter((item) => item.sessionId === sessionId);
}

function turnsOf(items: readonly DaemonTranscriptItem[], state: DaemonTurn['state']): DaemonTurn[] {
  const ids = [...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : [])))];
  return ids.map((id) => ({
    id, sessionId: items[0]?.sessionId ?? 'session', commandId: `command-${id}`, state,
    ...(state === 'working' || state === 'blocked'
      ? { startedAt: new Date(Date.now() - 12_000).toISOString() }
      : { startedAt: STARTED, finishedAt: FINISHED }),
    revision: 1, createdAt: STARTED, updatedAt: FINISHED,
  }));
}

const PARENT = 'replay-session';
const PARENT_TITLE = 'README 제목과 greet 위치 확인';
const workspace = { id: 'workspace', label: 'demo-app', path: 'C:\\Working\\demo-app', kind: 'local' as const };

function Frame({ children, width = 760, height = 720 }: { readonly children: JSX.Element; readonly width?: number; readonly height?: number }): JSX.Element {
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <HighlighterProvider>
        <div style={{ width: `min(100vw, ${width}px)`, height: `min(92vh, ${height}px)`, display: 'flex' }}>{children}</div>
      </HighlighterProvider>
    </AppI18nProvider>
  );
}

function childTrackFor(golden: Golden, extra: readonly StructuredAgentChildTrackItem[] = []): JSX.Element {
  return (
    <StructuredAgentChildTrack
      items={[...golden.sessions.map((session): StructuredAgentChildTrackItem => ({
        sessionId: session.sessionId, title: session.title, providerLabel: 'Claude', state: session.state as ManagedAgentState, owner: 'provider-native',
      })), ...extra]}
      onSelectSession={fn()}
    />
  );
}

const meta = {
  title: 'Compositions/Subagents and Paseo (proposal)',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Parent: each Agent call carries its subagent (kind, outcome, Open), each result is one block. */
export const ParentWithSubagents: Story = {
  render: () => {
    const items = sessionItems(subagents, PARENT);
    return (
      <Frame>
        <StructuredAgentSessionPanel
          sessionId={PARENT} title={PARENT_TITLE} providerId="claude" providerLabel="Claude Agent" workspace={workspace}
          permissionPreset="standard" state="idle" items={items} approvals={subagents.approvals} turns={turnsOf(items, 'completed')}
          skin="bubble" childTrack={childTrackFor(subagents)} onOpenRelatedSession={fn()} onDelegate={fn()} onSend={fn(async () => ({ ok: true as const }))}
        />
      </Frame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /서브에이전트 2개/u }));
    await expect(canvas.getAllByRole('button', { name: /^열기: Read README title/u }).length).toBeGreaterThan(0);
  },
};

/** The same parent in the CLI skin the user runs (Matrix + CLI). */
export const ParentWithSubagentsCli: Story = {
  render: () => {
    const items = sessionItems(subagents, PARENT);
    return (
      <Frame>
        <StructuredAgentSessionPanel
          sessionId={PARENT} title={PARENT_TITLE} providerId="claude" providerLabel="Claude Agent" workspace={workspace}
          permissionPreset="standard" state="idle" items={items} approvals={subagents.approvals} turns={turnsOf(items, 'completed')}
          skin="cli" childTrack={childTrackFor(subagents)} onOpenRelatedSession={fn()} onDelegate={fn()} onSend={fn(async () => ({ ok: true as const }))}
        />
      </Frame>
    );
  },
};

/** A subagent opened from its parent: its instruction, its own work and answer; read-only with a way back. */
export const SubagentOpened: Story = {
  render: () => {
    const child = subagents.sessions[1]!;
    const items = sessionItems(subagents, child.sessionId);
    return (
      <Frame>
        <StructuredAgentSessionPanel
          sessionId={child.sessionId} title={child.title} providerId="claude" providerLabel="Claude Agent" workspace={workspace}
          permissionPreset="standard" state="done" owner="provider-native" items={items} turns={turnsOf(items, 'completed')}
          parent={{ sessionId: PARENT, title: PARENT_TITLE }} subagentType={child.subagentType}
          onOpenRelatedSession={fn()} onSend={fn(async () => ({ ok: true as const }))}
        />
      </Frame>
    );
  },
};

/** The subagent asked for approval: the parent holds it, the subagent says so and leads there. */
export const SubagentWaitingForApproval: Story = {
  render: () => {
    const child = subagentApproval.sessions[0]!;
    const all = sessionItems(subagentApproval, child.sessionId);
    const items = all.slice(0, all.findIndex((item) => item.kind === 'approval'));
    return (
      <Frame>
        <StructuredAgentSessionPanel
          sessionId={child.sessionId} title={child.title} providerId="claude" providerLabel="Claude Agent" workspace={workspace}
          permissionPreset="standard" state="blocked" owner="provider-native" items={items} turns={turnsOf(items, 'blocked')}
          parent={{ sessionId: PARENT, title: 'README 삭제 맡기기' }} subagentType={child.subagentType} parentApprovalPending
          onOpenRelatedSession={fn()} onSend={fn(async () => ({ ok: true as const }))}
        />
      </Frame>
    );
  },
};

/** The parent's approval dock for a request raised inside a subagent. */
export const ParentApprovalFromSubagent: Story = {
  render: () => {
    const items = sessionItems(subagentApproval, PARENT).filter((item) => item.kind !== 'child-summary' && !(item.kind === 'tool-result') && item.kind !== 'assistant-message');
    const approvals = subagentApproval.approvals.map((approval) => ({ ...approval, state: 'pending' as const }));
    return (
      <Frame>
        <StructuredAgentSessionPanel
          sessionId={PARENT} title="README 삭제 맡기기" providerId="claude" providerLabel="Claude Agent" workspace={workspace}
          permissionPreset="standard" state="blocked" items={items} approvals={approvals} turns={turnsOf(items, 'blocked')}
          childTrack={childTrackFor({ ...subagentApproval, sessions: subagentApproval.sessions.map((session) => ({ ...session, state: 'blocked' })) })}
          onResolveApproval={fn(async () => ({ ok: true as const }))} onOpenRelatedSession={fn()} onSend={fn(async () => ({ ok: true as const }))}
        />
      </Frame>
    );
  },
};

const MANY: readonly StructuredAgentChildTrackItem[] = Array.from({ length: 20 }, (_, index) => ({
  sessionId: `many-${index}`,
  title: ['Inventory Phase 5 surfaces', 'Find greet definition', 'Review settings density', 'Check Android color-mix', 'Map tool rows'][index % 5]!,
  providerLabel: 'Claude',
  state: index === 13 ? 'blocked' : index === 7 ? 'error' : index < 3 ? 'working' : 'done',
  owner: 'provider-native' as const,
}));

/** Twenty subagents (a real conversation had 20): what needs you first, the rest behind "+N". */
export const TwentySubagents: Story = {
  render: () => {
    const items = sessionItems(subagents, PARENT).slice(0, 4);
    return (
      <Frame height={420}>
        <StructuredAgentSessionPanel
          sessionId={PARENT} title="Phase 5 화면 조사" providerId="claude" providerLabel="Claude Agent" workspace={workspace}
          permissionPreset="standard" state="working" items={items} turns={turnsOf(items, 'working')}
          childTrack={<StructuredAgentChildTrack items={MANY} onSelectSession={fn()} />} onOpenRelatedSession={fn()} onSend={fn(async () => ({ ok: true as const }))}
        />
      </Frame>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId('structured-agent-child')).toHaveLength(4);
    await userEvent.click(canvas.getByTestId('structured-agent-child-more'));
    await expect(canvas.getAllByTestId('structured-agent-child')).toHaveLength(20);
  },
};

const PROJECT = 'ezterminal';
const CONVERSATIONS: readonly ProjectNavigationConversation[] = [
  { id: 'parent', projectId: PROJECT, sessionId: 'parent', title: '로그인 화면 개선', source: 'agent', providerLabel: 'Claude', updatedAt: 1_792_210_000_000, status: 'completed' },
  { id: 'sub-1', projectId: PROJECT, sessionId: 'sub-1', parentSessionId: 'parent', title: 'Read README title', subagentType: 'Explore', source: 'agent', providerLabel: 'Claude', updatedAt: 1_792_210_010_000, status: 'completed' },
  { id: 'sub-2', projectId: PROJECT, sessionId: 'sub-2', parentSessionId: 'parent', title: 'Delete README.md via shell', subagentType: 'general-purpose', source: 'agent', providerLabel: 'Claude', updatedAt: 1_792_210_020_000, status: 'blocked' },
  { id: 'codex', projectId: PROJECT, sessionId: 'codex', title: '대화창 UI를 개선해 제안', source: 'agent', providerLabel: 'Codex', updatedAt: 1_792_200_000_000 },
  { id: 'review', projectId: PROJECT, sessionId: 'review', workspaceId: 'tree-review', title: '로그인 변경 검토', source: 'agent', providerLabel: 'Codex', updatedAt: 1_792_205_000_000, status: 'completed' },
  { id: 'settings', projectId: PROJECT, sessionId: 'settings', workspaceId: 'tree-settings', title: '설정 문구 정리', source: 'agent', providerLabel: 'Claude', updatedAt: 1_792_190_000_000, status: 'working' },
  { id: 'cli', projectId: PROJECT, title: '지금 프로젝트별 이전대화를 보면', source: 'native', providerLabel: 'Claude', updatedAt: 1_792_150_000_000 },
];
/** The profile copy's real list: two local entries for the same folder, worktrees archived. */
const REAL_WORKSPACES: readonly ProjectNavigationWorkspace[] = [
  { id: 'local', projectId: PROJECT, title: 'EZTerminal', kind: 'local' },
  { id: 'local-main', projectId: PROJECT, title: 'EZTerminal (main)', kind: 'local' },
  { id: 'old-1', projectId: PROJECT, title: '(detached)', kind: 'worktree', archived: true },
];
const WITH_WORKTREES: readonly ProjectNavigationWorkspace[] = [
  ...REAL_WORKSPACES,
  { id: 'tree-review', projectId: PROJECT, title: 'feature/login-review', kind: 'worktree', branch: 'feature/login-review', status: 'review' },
  { id: 'tree-settings', projectId: PROJECT, title: 'fix/settings-copy', kind: 'worktree', branch: 'fix/settings-copy', status: 'working' },
];

function TreeStory({ workspaces, expandParent }: { readonly workspaces: readonly ProjectNavigationWorkspace[]; readonly expandParent: boolean }): JSX.Element {
  const nodes = useMemo(() => projectConversationTree({ projects: [{ id: PROJECT, title: 'EZTerminal', pinned: true }], conversations: CONVERSATIONS, workflows: {}, workspaces }), [workspaces]);
  const scope = `proposal-tree-${workspaces.length}-${expandParent}`;
  useState(() => {
    const expanded = [nodes[0]!.id, ...nodes[0]!.children!.filter((node) => node.target.kind === 'workspace').map((node) => node.id)];
    if (expandParent) {
      const visit = (node: (typeof nodes)[number]): void => { if (node.title === '로그인 화면 개선') expanded.push(node.id); node.children?.forEach(visit); };
      nodes.forEach(visit);
    }
    window.localStorage.setItem(`ezterminal:project-navigation:v1:${scope}`, JSON.stringify({ expanded, query: '', view: 'projects', includeArchived: false, scrollTop: 0 }));
  });
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <div style={{ width: 340, height: 640, display: 'flex', flexDirection: 'column' }} className="project-navigation-story__navigation">
        <ProjectConversationTree nodes={nodes} persistenceScope={scope} onOpen={fn()}
          renderWorkspaceActions={(target) => target.local ? null : <>
            <IconButton icon={MessageSquarePlus} size="sm" variant="ghost" aria-label="이 작업 위치에서 새 대화" />
            <IconButton icon={FileDiff} size="sm" variant="ghost" aria-label="변경 검토" />
            <IconButton icon={GitMerge} size="sm" variant="ghost" aria-label="병합" />
          </>} />
      </div>
    </AppI18nProvider>
  );
}

/** Today's real list (no active worktree): no extra level; a collapsed parent shows its waiting subagent. */
export const TreeSubagentRollup: Story = { render: () => <TreeStory workspaces={REAL_WORKSPACES} expandParent={false} /> };
/** Opened: each subagent under its parent with its task and kind. */
export const TreeSubagentsOpen: Story = { render: () => <TreeStory workspaces={REAL_WORKSPACES} expandParent /> };
/** With worktrees: one row per place to work, with its state; local checkouts share one row. */
export const TreeWorktrees: Story = { render: () => <TreeStory workspaces={WITH_WORKTREES} expandParent={false} /> };

const PROFILES: readonly ChatAgentProfile[] = [
  { id: 'reviewer', name: '꼼꼼한 검토자', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', permissionPreset: 'plan', whenToUse: '바뀐 코드를 고치지 않고 검토만 할 때' },
  { id: 'builder', name: '빠른 구현', providerId: 'claude', model: 'claude-opus-5-5', permissionPreset: 'standard', whenToUse: '정해진 계획대로 코드를 바꿀 때' },
];
const PROVIDER_LABELS = { codex: 'Codex', claude: 'Claude' };

function DelegateStory({ mode }: { readonly mode: DelegateMode }): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <div style={{ width: 720, height: 680 }}>
        <Button onClick={() => setOpen(true)}>맡기기 열기</Button>
        <DelegateAgentDialog open={open} onOpenChange={setOpen} mode={mode} profiles={PROFILES} providerLabels={PROVIDER_LABELS}
          workspaces={[{ id: 'local', label: 'EZTerminal', kind: 'local' }, { id: 'tree-review', label: 'feature/login-review', kind: 'worktree' }]}
          defaultWorkspaceId="local"
          initialInstruction={mode === 'review'
            ? '이 대화에서 바꾼 로그인 화면 코드를 검토해 주세요. 고치지 말고 문제와 위험만 알려 주세요.'
            : '로그인 화면 개선의 남은 작업(오류 문구, 접근성 레이블)을 이어서 구현해 주세요.'}
          onSubmit={fn(async () => ({ ok: true as const }))} />
      </div>
    </AppI18nProvider>
  );
}

export const DelegateHandoff: Story = { render: () => <DelegateStory mode="handoff" /> };
export const DelegateReview: Story = { render: () => <DelegateStory mode="review" /> };

export const CollaborationSettings: Story = {
  render: () => (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <div style={{ width: 560 }} className="settings-workbench">
        <AgentProfilesSettings orchestrationEnabled={false} onOrchestrationChange={fn()} profiles={PROFILES}
          providers={[{ id: 'codex', label: 'Codex', models: ['gpt-6-astra'], efforts: ['low', 'medium', 'high', 'xhigh'] }, { id: 'claude', label: 'Claude', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], efforts: ['low', 'medium', 'high'] }]}
          onSaveProfile={fn(async () => ({ ok: true as const }))} onDeleteProfile={fn(async () => ({ ok: true as const }))} />
      </div>
    </AppI18nProvider>
  ),
};

const INBOX: readonly AppChatInboxItem[] = [
  { id: 'a1', sessionId: 'parent', kind: 'approval', conversationTitle: 'README 삭제 맡기기', providerId: 'claude', subagentTitle: 'Delete README.md via shell', detail: 'Remove-Item -LiteralPath README.md', at: '2026-10-17T04:01:00.000Z' },
  { id: 'a2', sessionId: 'codex', kind: 'approval', conversationTitle: '대화창 UI를 개선해 제안', providerId: 'codex', detail: 'src/renderer/chat/chat.css', at: '2026-10-17T03:58:00.000Z' },
  { id: 'f1', sessionId: 'review', kind: 'finished', conversationTitle: '로그인 변경 검토', providerId: 'codex', at: '2026-10-17T03:40:00.000Z' },
  { id: 'f2', sessionId: 'settings', kind: 'failed', conversationTitle: '설정 문구 정리', providerId: 'claude', errorCode: 'provider-session-failed', at: '2026-10-17T03:20:00.000Z' },
];

export const InboxAppChats: Story = {
  render: () => (
    <AppI18nProvider locale="ko" languages={['ko']}>
      <div style={{ width: 360 }}>
        <AppChatInbox items={INBOX} onOpen={fn()} onMarkSeen={fn()} />
      </div>
    </AppI18nProvider>
  ),
};
