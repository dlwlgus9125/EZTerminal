import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';

import type { AgentProjectSummary } from '../../shared/agent-history';
import { AppI18nProvider } from '../i18n';
import type { ProjectRegistryAccess } from '../ProjectDialogs';
import { AllProjectsDialog } from './AllProjectsDialog';
import '../index.css';

const at = Date.parse('2026-10-26T09:00:00+09:00');
const project = (projectId: string, name: string, pinned = false, extra = 0): AgentProjectSummary => ({
  projectId, name, primaryRoot: `C:\\Working\\${name}`, additionalRoots: Array.from({ length: extra }, (_, index) => `C:\\Working\\${name}-${index + 1}`),
  pinned, saved: true, sessionCount: 0, providers: ['codex'], lastActiveAt: at,
});
const projects = [
  project('ezterminal', 'EZTerminal', true, 1),
  project('ezpowers', 'EZPowers', true),
  project('firstnovel', 'FirstNovel'),
  project('friendskitchen', 'FriendsKitchen'),
  project('portfolio', 'portfolio'),
  project('planseminor', 'PlanSeminor'),
  project('wallugames', 'WalluGames'),
];
const many = Array.from({ length: 45 }, (_, index) => project(`project-${index + 1}`, `Project ${String(index + 1).padStart(2, '0')}`, index < 2));

function registry(items: readonly AgentProjectSummary[], overrides: Partial<ProjectRegistryAccess> = {}): ProjectRegistryAccess {
  return {
    listAgentProjects: fn(async (_force?: boolean, cursor?: string, limit = 40, query?: string) => {
      const matching = items.filter((item) => !query || item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      const start = cursor ? Number(cursor) : 0;
      const end = start + limit;
      return { items: matching.slice(start, end), nextCursor: end < matching.length ? String(end) : null };
    }),
    saveAgentProject: fn(async (input) => ({ ok: true as const, project: { ...items[0]!, ...input, projectId: input.projectId ?? 'new' } })),
    removeAgentProject: fn(async () => true),
    selectFolders: fn(async () => ({ canceled: false, paths: [] })),
    ...overrides,
  };
}

const meta = {
  title: 'Production/Projects/All projects',
  component: AllProjectsDialog,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  globals: { locale: 'ko' },
  args: {
    access: registry(projects), reloadKey: 0,
    onClose: fn(), onOpen: fn(), onAdd: fn(), onEdit: fn(), onCliHistory: fn(), onDelete: fn(), onChanged: fn(),
  },
  decorators: [(Story, context) => (
    <AppI18nProvider locale={context.globals.locale === 'en' ? 'en' : 'ko'} languages={['ko', 'en']}>
      <div style={{ minHeight: '100vh', background: 'var(--ui-surface)' }}><Story /></div>
    </AppI18nProvider>
  )],
} satisfies Meta<typeof AllProjectsDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The user's projects: pinned first, the ones past the five tabs too. */
export const PinnedAndRecent: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole('dialog', { name: '모든 프로젝트' })).toBeVisible());
    await waitFor(() => expect(page.getByTestId('all-projects-open-wallugames')).toBeVisible());
  },
};

export const English: Story = { globals: { locale: 'en' } };

export const Many: Story = {
  args: { access: registry(many) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByTestId('all-projects-more'));
    await expect(await page.findByTestId('all-projects-open-project-45', {}, { timeout: 5_000 })).toBeInTheDocument();
  },
};

/** Types once the dialog is shown: its opening focus (on the close button) must not take half the text. */
async function typeSearch(page: ReturnType<typeof within>, value: string): Promise<void> {
  await waitFor(() => expect(page.getByRole('dialog', { name: '모든 프로젝트' })).toBeVisible());
  const search = page.getByTestId('all-projects-search');
  await waitFor(() => expect(page.getByRole('button', { name: '닫기' })).toHaveFocus());
  await userEvent.click(search);
  await userEvent.type(search, value);
  await waitFor(() => expect(search).toHaveValue(value));
}

export const Search: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await typeSearch(page, 'kitchen');
    await waitFor(() => expect(page.queryByTestId('all-projects-open-ezterminal')).toBeNull(), { timeout: 5_000 });
    await expect(page.getByTestId('all-projects-open-friendskitchen')).toBeVisible();
  },
};

export const NoMatches: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await typeSearch(page, 'nothing-like-this');
    // Typing, the 200 ms debounce and the read: allow more than the default second under load.
    await expect(await page.findByText('검색과 일치하는 프로젝트가 없습니다.', {}, { timeout: 5_000 })).toBeVisible();
  },
};

export const Empty: Story = { args: { access: registry([]) } };

export const LoadFailed: Story = { args: { access: registry(projects, { listAgentProjects: fn(async () => { throw new Error('offline'); }) }) } };

export const Loading: Story = { args: { access: registry(projects, { listAgentProjects: () => new Promise(() => undefined) }) } };

/** A row's ⋯: edit, CLI history, delete. */
export const MenuOpen: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    // The dialog and the menu both fade in: wait for them rather than read the first frame.
    await waitFor(() => expect(page.getByRole('dialog', { name: '모든 프로젝트' })).toBeVisible());
    await userEvent.click(await page.findByRole('button', { name: 'EZPowers 관리' }));
    await waitFor(() => expect(page.getByRole('menu', { name: 'EZPowers 관리' })).toBeVisible());
    await waitFor(() => expect(page.getByRole('menuitem', { name: 'CLI 기록' })).toBeVisible());
  },
};
