import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { NewSessionDraftPanel } from './NewSessionDraftPanel';
import { AppI18nProvider } from './i18n';
import { sessionStartSnapshot } from './session-start.fixtures';
import './index.css';
import './structured-agent.css';

const meta = {
  title: 'Sessions/New session', component: NewSessionDraftPanel,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: {
    snapshot: sessionStartSnapshot, projectId: 'project', workspaceId: 'feature',
    agent: { providers: [{ id: 'codex', label: 'Codex', models: [] }], workspaces: sessionStartSnapshot.workspaces.map((workspace) => ({ id: workspace.id, label: workspace.name, kind: workspace.kind })), onCreate: fn(async () => ({ ok: true as const })) },
    access: { getDaemonSnapshot: async () => sessionStartSnapshot, listAgentProjectLaunchers: async () => [{ launcherId: 'codex-cli', name: 'Codex CLI', provider: 'codex' as const, supportsAdditionalRoots: true }], prepareAgentLaunch: async () => ({ ok: false as const, reason: 'unavailable' as const }) },
    onTerminal: fn(async () => ({ ok: true as const })), onLaunchCli: fn(async () => undefined),
  },
  decorators: [(Story, context) => <AppI18nProvider locale={context.globals.locale === 'ko' ? 'ko' : 'en'}><main style={{ height: '100vh', maxWidth: 960, margin: 'auto' }}><Story /></main></AppI18nProvider>],
} satisfies Meta<typeof NewSessionDraftPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Conversation: Story = { args: { initialIntent: { kind: 'agent', agentMode: 'conversation' } } };
export const TerminalWithoutProvider: Story = {
  args: { agent: { ...meta.args.agent, providers: [] } },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('new-session-terminal'));
    await expect(canvas.getByTestId('new-session-open-terminal')).toBeEnabled();
    await expect(args.onTerminal).not.toHaveBeenCalled();
  },
};
export const Cli: Story = { args: { initialIntent: { kind: 'agent', agentMode: 'cli' } }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByTestId('new-session-cli'));
  await userEvent.selectOptions(canvas.getByTestId('session-cli-launcher'), 'codex-cli');
} };
export const GlobalLocation: Story = { args: { projectId: undefined, workspaceId: undefined } };
export const UnavailableWorkspace: Story = { args: { workspaceId: 'removed' } };
export const Korean: Story = { globals: { locale: 'ko' } };
