import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { AgentProjectSummary } from '../shared/agent-history';
import { AppI18nProvider } from './i18n';
import { ProjectDeleteDialog, ProjectEditorDialog, type ProjectEditorMode, type ProjectRegistryAccess } from './ProjectDialogs';
import './index.css';

const project: AgentProjectSummary = {
  projectId: 'ezterminal', name: 'EZTerminal', primaryRoot: 'C:\\Working\\EZTerminal', additionalRoots: ['C:\\Working\\EZPowers'],
  pinned: true, saved: true, sessionCount: 0, providers: ['codex', 'claude'], lastActiveAt: Date.parse('2026-10-26T09:00:00+09:00'),
};

function access(overrides: Partial<ProjectRegistryAccess> = {}): ProjectRegistryAccess {
  return {
    listAgentProjects: fn(async () => ({ items: [project], nextCursor: null })),
    saveAgentProject: fn(async (input) => ({ ok: true as const, project: { ...project, ...input, projectId: input.projectId ?? 'new-project' } })),
    removeAgentProject: fn(async () => true),
    selectFolders: fn(async () => ({ canceled: false, paths: ['C:\\Working\\FriendsKitchen'] })),
    ...overrides,
  };
}

function ProjectDialogsStory({ dialog, mode, registry }: {
  readonly dialog: 'editor' | 'delete';
  readonly mode: ProjectEditorMode;
  readonly registry: ProjectRegistryAccess;
}): JSX.Element {
  return dialog === 'editor'
    ? <ProjectEditorDialog open mode={mode} access={registry} onClose={fn()} onSaved={fn()} />
    : <ProjectDeleteDialog project={project} access={registry} onClose={fn()} onDeleted={fn()} />;
}

const meta = {
  title: 'Production/Projects/Project dialogs',
  component: ProjectDialogsStory,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  globals: { locale: 'ko' },
  args: { dialog: 'editor', mode: { kind: 'add' }, registry: access() },
  decorators: [(Story, context) => (
    <AppI18nProvider locale={context.globals.locale === 'en' ? 'en' : 'ko'} languages={['ko', 'en']}>
      <div style={{ minHeight: '100vh', background: 'var(--ui-surface)' }}><Story /></div>
    </AppI18nProvider>
  )],
} satisfies Meta<typeof ProjectDialogsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** `+` in the top bar: nothing chosen yet, the folder is picked here. */
export const AddEmpty: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole('dialog', { name: '프로젝트 추가' })).toBeVisible());
    await expect(page.getByTestId('agent-project-save')).toBeDisabled();
  },
};

/** After choosing a folder: it is the primary folder and names the project. */
export const AddFilled: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByTestId('agent-project-add-folder'));
    await expect(page.getByTestId('agent-project-name')).toHaveValue('FriendsKitchen');
    await expect(page.getByTestId('agent-project-save')).toBeEnabled();
  },
};

export const AddEnglish: Story = { globals: { locale: 'en' } };

/** 프로젝트 설정 on the board, or 프로젝트 편집… from a conversation's folder. */
export const Edit: Story = { args: { mode: { kind: 'edit', project } } };

export const SaveFailed: Story = {
  args: { mode: { kind: 'edit', project }, registry: access({ saveAgentProject: fn(async () => ({ ok: false as const, reason: 'invalid' as const })) }) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByTestId('agent-project-save'));
    await expect(await page.findByRole('alert')).toHaveTextContent('프로젝트를 저장하지 못했습니다.');
  },
};

export const Delete: Story = { args: { dialog: 'delete' } };
