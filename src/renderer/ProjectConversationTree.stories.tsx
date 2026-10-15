import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ProjectConversationTree } from './ProjectConversationTree';
import { projectConversationTree, type ProjectNavigationTarget } from './project-conversation-tree-model';
import { workflowFixture, workflowNavigationFixture } from './workflow/workflow-fixtures';
import { WorkflowWorkspacePanel } from './workflow/WorkflowWorkspacePanel';
import { AppI18nProvider } from './i18n';
import { Button } from './ui';
import './index.css';

const onOpen = fn();
function NavigationStory({ mobile = false, offline = false, empty = false, error = false, locale = 'ko' }: { mobile?: boolean; offline?: boolean; empty?: boolean; error?: boolean; locale?: 'ko' | 'en' }): JSX.Element {
  const ko = locale === 'ko';
  const [target, setTarget] = useState<ProjectNavigationTarget>();
  const workflow = useMemo(() => {
    const value = workflowFixture();
    if (ko) { value.subprojects[0].title = '로그인 개선'; value.subprojects[1].title = '결제 검토'; value.subprojects[0].graph.nodes[0].title = '조사'; }
    return value;
  }, [ko]);
  const access = useMemo(() => ({ getWorkflowSnapshot: async () => ({ ok: true as const, snapshot: workflow }), executeWorkflowCommand: async () => ({ ok: false as const, error: 'read-only-story', message: 'Read-only Storybook preview.' }) }), [workflow]);
  const nodes = useMemo(() => projectConversationTree({ projects: empty ? [] : [{ id: 'project-story', title: 'EZTerminal', pinned: true }, { id: 'second-project', title: 'EZCliTool' }], workflows: empty ? {} : { 'project-story': workflowNavigationFixture(workflow) }, conversations: empty ? [] : [
    { id: 'general', projectId: 'project-story', title: ko ? '빌드 옵션이 어떻게 동작하지?' : 'How do build options work?', source: 'agent', providerLabel: 'Codex', updatedAt: 1_792_000_100_000, sessionId: 'general' },
    { id: 'cli', projectId: 'project-story', title: ko ? '어제 CLI에서 확인한 배포 조건' : 'Yesterday’s release checks in CLI', source: 'native', providerLabel: 'Claude', updatedAt: 1_792_000_000_000 },
    { id: 'stage', projectId: 'project-story', title: ko ? '로그인 요구사항 검토' : 'Review login requirements', source: 'stage', providerLabel: 'Codex', updatedAt: 1_792_000_200_000, sessionId: 'chat-stage' },
    { id: 'archived', projectId: 'project-story', title: ko ? '지난 인증 흐름 검토' : 'Previous authentication review', source: 'agent', providerLabel: 'Claude', updatedAt: 1_790_000_000_000, sessionId: 'archived', archived: true },
  ] }), [empty, ko, workflow]);
  const scope = `story-project-tree-${mobile}-${offline}-${empty}-${error}-${locale}`;
  useState(() => { window.localStorage.removeItem(`ezterminal:project-navigation:v1:${scope}`); });
  const selectedWorkflow = target?.kind === 'stage' || target?.kind === 'subproject' ? target : undefined;
  return <AppI18nProvider locale={locale} languages={[locale]}><div className="project-navigation-story" data-mobile={mobile || undefined}>
    <aside className="project-navigation-story__navigation"><h2>{ko ? '프로젝트' : 'Projects'}</h2><div className="project-navigation-story__toolbar"><Button size="sm">{ko ? '새 대화' : 'New conversation'}</Button><Button size="sm">{ko ? '새 소프로젝트' : 'New subproject'}</Button></div>
      <ProjectConversationTree nodes={nodes} mobile={mobile} offline={offline} persistenceScope={scope}
        projectStatus={error ? { 'project-story': { error: ko ? '이 PC의 목록을 다시 확인해야 합니다.' : 'Reconnect to read this PC’s list.' } } : undefined}
        onOpen={next => { onOpen(next); setTarget(next); }} />
    </aside>
    {!mobile && <main className="project-navigation-story__content">
      {selectedWorkflow ? <WorkflowWorkspacePanel projectId="project-story" projectName="EZTerminal" access={access} disabled={offline}
        navigationTarget={{ subprojectId: selectedWorkflow.subprojectId, nodeId: selectedWorkflow.kind === 'stage' ? selectedWorkflow.nodeId : undefined, key: JSON.stringify(selectedWorkflow) }}
        conversations={[{ id: 'chat-stage', title: ko ? '로그인 요구사항 검토' : 'Review login requirements', providerLabel: 'Codex' }]} />
        : <><small>{ko ? '프로젝트 / 대화' : 'Project / Conversation'}</small><h1>{target?.kind === 'conversation' && !target.sessionId ? ko ? '이전 CLI 대화 미리보기' : 'Previous CLI conversation preview' : ko ? '현재 작업을 유지하며 탐색' : 'Browse while keeping your current work'}</h1><p>{ko ? '왼쪽의 펼치기는 목록만 바꿉니다. 대화 이름을 선택하면 같은 대화를 열고, 소프로젝트·단계 이름은 해당 작업 화면을 엽니다.' : 'Expand the hierarchy without changing your current work. Select a conversation to open the same session, or a stage to open its workspace.'}</p><p>{ko ? '이 화면은 production 탐색 컴포넌트의 읽기 전용 시안입니다.' : 'This is a read-only preview of the production navigation component.'}</p></>}
    </main>}
  </div></AppI18nProvider>;
}
const meta = { title: 'Production/Navigation/Projects and conversations', component: NavigationStory, parameters: { layout: 'fullscreen', a11y: { test: 'error' } } } satisfies Meta<typeof NavigationStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop: Story = { args: { locale: 'en' }, play: async ({ canvasElement }) => {
  onOpen.mockClear();
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Expand: Login improvements' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Expand: Investigation' }));
  await expect(onOpen).not.toHaveBeenCalled();
  await expect(canvas.getByRole('treeitem', { name: 'Review login requirements · Chat · Codex' })).toBeVisible();
} };
export const DesktopKorean: Story = {};
export const Android: Story = { args: { mobile: true } };
export const AndroidOffline: Story = { args: { mobile: true, offline: true } };
export const Empty: Story = { args: { empty: true, locale: 'en' } };
export const RecoverableError: Story = { args: { error: true, locale: 'en' } };
