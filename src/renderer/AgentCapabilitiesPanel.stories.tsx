import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import type { AgentCapabilitiesClient, AgentCapabilityCatalog } from '../shared/agent-capabilities';
import { AgentCapabilitiesPanel } from './AgentCapabilitiesPanel';
import { StructuredAgentDraftPanel } from './StructuredAgentSession';
import { AppI18nProvider } from './i18n';
import { Button } from './ui';
import './index.css';
import './structured-agent.css';

const catalog = (workspaceId = 'project-1'): AgentCapabilityCatalog => ({
  providerId: 'codex', workspaceId, workspaceRoot: `C:\\Projects\\${workspaceId}`, hostId: 'Development PC',
  revision: 'a'.repeat(64), observedAt: '2026-10-13T13:00:00Z', canManage: true, application: 'new-session',
  models: [{ id: 'gpt-6.1', displayName: 'GPT-6.1', supportsReasoning: true, isDefault: true }],
  items: [
    { id: '/skills/review/SKILL.md', kind: 'skill', name: 'review', description: 'Review the current changes before implementation.', enabled: true, scope: 'user', invocation: '$review', actions: ['skill-disable'] },
    { id: '/skills/legacy/SKILL.md', kind: 'skill', name: 'legacy', description: 'Installed on this PC, currently disabled.', enabled: false, scope: 'user', invocation: '$legacy', actions: ['skill-enable'] },
    { id: 'design@team', kind: 'plugin', name: 'Design tools', enabled: false, source: 'team', scope: 'user', version: '2.0.1', actions: ['plugin-enable', 'plugin-remove'] },
    { id: 'docs', kind: 'mcp', name: 'Documentation', enabled: true, scope: 'user', status: 'needs-auth', actions: ['mcp-remove'] },
    { id: 'ezterminal-workflow', kind: 'app-skill', name: 'ezterminal-workflow', description: 'Read and edit the project workflow draft.', enabled: true, source: 'EZTerminal', invocation: 'Use the EZTerminal workflow tools to ', actions: [] },
  ],
  actions: ['plugin-install', 'plugin-enable', 'plugin-disable', 'plugin-remove', 'skill-enable', 'skill-disable', 'mcp-add', 'mcp-remove'], issues: [],
});
const client: AgentCapabilitiesClient = {
  list: fn(async (request) => ({ ok: true as const, value: catalog(request.workspaceId) })),
  manage: fn(async (command) => ({ ok: true as const, value: { commandId: command.commandId, action: command.action, state: 'applied' as const, application: 'new-session' as const } })),
};
const meta = {
  title: 'Agents/Capabilities', component: AgentCapabilitiesPanel,
  parameters: { layout: 'centered', a11y: { test: 'error' } },
  args: { client, providerId: 'codex', workspaceId: 'project-1', onInsert: fn() },
  decorators: [(Story, context) => <AppI18nProvider locale={context.globals.locale === 'ko' ? 'ko' : 'en'} languages={['en', 'ko']}><div style={{ width: 'min(calc(100vw - 32px), 820px)' }}><Story /></div></AppI18nProvider>],
} satisfies Meta<typeof AgentCapabilitiesPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const InstalledAndDisabled: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Skills · plugins · MCP'));
    await expect(canvas.getByText('legacy')).toBeVisible();
    await expect(within(canvas.getByText('legacy').closest('li')!).getByRole('button', { name: 'Insert' })).toBeDisabled();
  },
};

export const ZeroTurnDraft: Story = {
  render: () => <StructuredAgentDraftPanel capabilityClient={client} providers={[{ id: 'codex', label: 'Codex', models: [] }]} workspaces={[{ id: 'project-1', label: 'Project 1', kind: 'local' }]} onCreate={fn(async () => ({ ok: true as const }))} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Skills · plugins · MCP'));
    await userEvent.click(within(canvas.getByText('review').closest('li')!).getByRole('button', { name: 'Insert' }));
    await expect(await canvas.findByDisplayValue(/^\$review\s*$/u)).toHaveValue('$review ');
  },
};

const recoveryClient: AgentCapabilitiesClient = { ...client, list: fn(async () => ({ ok: true as const, value: { ...catalog(), extensionReceipts: [{ commandId: 'saved-request', action: 'plugin-install' as const, state: 'uncertain' as const, application: 'new-session' as const, observedAt: '2026-10-13T13:00:00Z' }] } })) };
export const RecoveryAfterRestart: Story = {
  args: { client: recoveryClient, remote: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('Skills · plugins · MCP'));
    await expect(canvas.getByText(/Unconfirmed change saved on PC/)).toBeVisible();
    await userEvent.click(canvas.getByText('Manage PC extensions'));
    await expect(canvas.getByRole('button', { name: 'Apply to PC settings' })).toBeDisabled();
  },
};

function ScopeSwitch(): JSX.Element {
  const [workspaceId, setWorkspaceId] = useState('project-1');
  const [scopeClient] = useState<AgentCapabilitiesClient>(() => ({ ...client, manage: async (command) => { await new Promise((resolve) => setTimeout(resolve, 800)); return { ok: true, value: { commandId: command.commandId, action: command.action, state: 'uncertain', application: 'new-session' } }; } }));
  return <><Button onClick={() => setWorkspaceId((current) => current === 'project-1' ? 'project-2' : 'project-1')}>Switch workspace</Button><AgentCapabilitiesPanel client={scopeClient} providerId="codex" workspaceId={workspaceId} /></>;
}
export const SlowScopeSwitch: Story = { render: () => <ScopeSwitch /> };
export const MobileConnectedPc: Story = { args: { remote: true }, decorators: [(Story) => <div data-variant="mobile" style={{ width: 360 }}><Story /></div>], play: InstalledAndDisabled.play };
export const KoreanInstalled: Story = { globals: { locale: 'ko' }, play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByText('스킬 · 플러그인 · MCP')); } };
