import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor, within } from 'storybook/test';

import type { DaemonSnapshot } from '../../shared/daemon-protocol';
import type { WorkspaceWorktreeStatusView } from '../../shared/workspace-worktree';
import { AppI18nProvider } from '../i18n';
import { shellSnapshot } from './shell-fixtures';
import { WorktreesDialog } from './WorktreesDialog';
import '../index.css';

const record = { revision: 1, createdAt: '2026-10-24T09:00:00.000Z', updatedAt: '2026-10-24T09:00:00.000Z' };
const base = shellSnapshot();
const worktree = (id: string, name: string) => ({ id, projectId: 'p-ez', name, kind: 'worktree' as const, rootPath: `C:\\Working\\EZTerminal-${name}`, ...record });
const snapshot: DaemonSnapshot = {
  ...base,
  workspaces: [...base.workspaces, worktree('wt-login', 'login'), worktree('wt-crash', 'crash'), worktree('wt-deps', 'deps')],
  sessions: [...base.sessions, { id: 's-wt', projectId: 'p-ez', workspaceId: 'wt-crash', kind: 'agent', title: 'Crash fix', state: 'running', source: 'structured', ...record }],
  agents: [...base.agents, { sessionId: 's-wt', providerId: 'claude', permissionPreset: 'standard', queuedTurnCount: 0, orchestrationEnabled: false, state: 'working', ...record }],
};
const statuses: readonly WorkspaceWorktreeStatusView[] = [
  { workspaceId: 'wt-login', branch: 'feat/login', baseBranch: 'main', dirty: true, ahead: 3, merged: false, status: 'review' },
  { workspaceId: 'wt-crash', branch: 'fix/crash', baseBranch: 'main', dirty: true, ahead: 0, merged: false, status: 'review' },
  { workspaceId: 'wt-deps', branch: 'chore/deps', baseBranch: 'main', dirty: false, ahead: 0, merged: true, status: 'done' },
];

const meta = {
  title: 'Production/Projects/Worktrees',
  component: WorktreesDialog,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  globals: { locale: 'ko' },
  args: {
    project: { projectId: 'p-ez', name: 'EZTerminal' },
    snapshot,
    worktrees: { status: fn(async () => ({ ok: true as const, value: statuses })) },
    reloadKey: 0,
    onClose: fn(), onNew: fn(), onMerge: fn(),
  },
  decorators: [(Story, context) => (
    <AppI18nProvider locale={context.globals.locale === 'en' ? 'en' : 'ko'} languages={['ko', 'en']}>
      <div style={{ minHeight: '100vh', background: 'var(--ui-surface)' }}><Story /></div>
    </AppI18nProvider>
  )],
} satisfies Meta<typeof WorktreesDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 판 머리 워크트리: review waiting, a conversation still working, merged and done. */
export const Mixed: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole('dialog', { name: '워크트리 · EZTerminal' })).toBeVisible());
    await expect(await page.findByText('feat/login')).toBeVisible();
    await expect(page.getAllByTestId('workspace-merge')).toHaveLength(3);
  },
};

export const English: Story = { globals: { locale: 'en' } };

export const Empty: Story = { args: { snapshot: base, worktrees: { status: fn(async () => ({ ok: true as const, value: [] })) } } };

export const StatusError: Story = {
  args: { worktrees: { status: fn(async () => ({ ok: false as const, reason: 'git-failed' as const, message: 'git was not found on PATH.' })) } },
};

export const Loading: Story = { args: { worktrees: { status: () => new Promise(() => undefined) } } };
