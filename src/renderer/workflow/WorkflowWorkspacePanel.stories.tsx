import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, within, userEvent, fn } from 'storybook/test';
import { AppI18nProvider } from '../i18n';
import { WorkflowWorkspacePanel } from './WorkflowWorkspacePanel';
import { workflowFixture } from './workflow-fixtures';
import type { WorkflowDraftAccess } from '../../shared/workflow-draft';
import '../index.css';

function WorkflowStory({ mobile = false, locale = 'ko', selected = false, archived = false, invalid = false, offline = false }: { mobile?: boolean; locale?: 'ko' | 'en'; selected?: boolean; archived?: boolean; invalid?: boolean; offline?: boolean }): JSX.Element {
  const snapshot = useMemo(() => {
    const value = workflowFixture();
    if (archived) value.subprojects[0].status = 'archived';
    if (invalid) value.subprojects[0].graph.edges = [];
    return value;
  }, [archived, invalid]);
  const access = useMemo(() => ({ getWorkflowSnapshot: async () => ({ ok: true as const, snapshot }), executeWorkflowCommand: async () => ({ ok: false as const, error: 'read-only-story', message: 'This story does not write to a project.' }) }), [snapshot]);
  const recovery = useMemo<WorkflowDraftAccess | undefined>(() => offline ? { workflowDraftRead: async () => ({ ok: true as const, snapshot: { projectId: snapshot.projectId, revision: 0, state: { projectId: snapshot.projectId, hostId: snapshot.hostId, snapshot, drafts: {}, pendingCommand: null } } }), workflowDraftWrite: async (projectId, request) => ({ ok: true as const, snapshot: { projectId, revision: request.expectedRevision + 1, state: request.state } }) } : undefined, [offline, snapshot]);
  return <AppI18nProvider locale={locale} languages={[locale]}><div style={{ width: mobile ? 'min(100vw, 390px)' : '100%', height: '100vh' }}><WorkflowWorkspacePanel projectId="project-story" projectName="EZTerminal" access={access} recoveryAccess={recovery} mobile={mobile} disabled={offline} navigationTarget={selected ? { subprojectId: 'login', key: 'story' } : undefined} onOpenConversation={fn()} onNewConversation={fn()} conversations={[{ id: 'chat-general', title: locale === 'ko' ? '빌드 설정이 어떻게 동작하지?' : 'How does the build configuration work?', providerLabel: 'Codex' }, { id: 'chat-stage', title: locale === 'ko' ? '로그인 요구사항 검토' : 'Review login requirements', providerLabel: 'Claude Code' }]} /></div></AppI18nProvider>;
}
const meta = { title: 'Production/Workflow/Project workspace', component: WorkflowStory, parameters: { layout: 'fullscreen', a11y: { test: 'error' } } } satisfies Meta<typeof WorkflowStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ProjectItems: Story = { args: { locale: 'en' }, play: async ({ canvasElement }) => { const canvas = within(canvasElement); await expect(canvas.findByText('Login improvements')).resolves.toBeVisible(); await expect(canvas.getByText(/Conversation · no plan · Codex/u)).toBeVisible(); await userEvent.click(canvas.getByRole('button', { name: /Login improvements/ })); await expect(canvas.findByTestId('workflow-run-bar')).resolves.toBeVisible(); await userEvent.click(canvas.getByRole('button', { name: 'Edit the flow' })); await expect(canvas.getByRole('button', { name: 'Add stage' })).toBeVisible(); await userEvent.click(canvas.getByRole('button', { name: 'Done editing the flow' })); } };
export const Graph: Story = { args: { selected: true } };
export const MobileList: Story = { args: { mobile: true, selected: true } };
export const InvalidConnections: Story = { args: { selected: true, invalid: true, locale: 'en' } };
export const Archived: Story = { args: { selected: true, archived: true } };
export const Offline: Story = { args: { selected: true, offline: true, locale: 'en' } };
