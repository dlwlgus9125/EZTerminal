import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AGENT_SETTINGS_SCHEMA_VERSION } from '../shared/agent';
import { AgentIntegrationSettings } from './AgentIntegrationSettings';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { AppI18nProvider } from './i18n';
import { sessionStartSnapshot } from './session-start.fixtures';
import './index.css';

const capabilities: CapabilityAccess = {
  ...rendererCapabilities,
  agentIntegrations: {
    load: async () => ({
      integrations: ['codex', 'claude'].map((provider) => ({ provider: provider as 'codex' | 'claude', configPath: '', enabled: false, drift: false, needsTrust: false, blockers: [] })),
      settings: { schemaVersion: AGENT_SETTINGS_SCHEMA_VERSION, notifications: { waiting: true, blocked: true, error: true }, genericProfiles: [], approvalGate: true },
      launchers: ['codex', 'claude'].map((provider) => ({ launcherId: provider, provider: provider as 'codex' | 'claude', name: provider, supportsAdditionalRoots: true, installed: true })),
    }),
    setEnabled: async () => null,
    saveSettings: async (settings) => settings,
  },
  daemon: { ...rendererCapabilities.daemon, getSnapshot: async () => sessionStartSnapshot },
  structuredProviders: {
    ...rendererCapabilities.structuredProviders,
    getClaudeEnablement: async () => ({ ok: true, value: { enabled: false, termsAccepted: false, commercialUseApproved: false, authenticationPath: 'existing-cli-environment', anthropicThirdPartyApproval: false } }),
    inspect: async () => ({ ok: false, code: 'provider-operation-failed', message: 'App chat needs a compatible provider. Terminal CLI is installed.' }),
  },
};

const meta = {
  title: 'Settings/Agents', component: AgentIntegrationSettings,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { capabilities },
  decorators: [(Story, context) => <AppI18nProvider locale={context.globals.locale === 'ko' ? 'ko' : 'en'}><main className="settings-content" style={{ maxWidth: 640, padding: 24 }}><Story /></main></AppI18nProvider>],
} satisfies Meta<typeof AgentIntegrationSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
export const TerminalFirst: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText('CLI installed')).toHaveLength(2);
    await expect(canvas.queryByTestId('structured-provider-codex')).toBeNull();
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};
export const OptionalChat: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('agent-chat-settings').querySelector('summary')!);
    await expect(canvas.getByTestId('structured-provider-codex')).toBeVisible();
    await expect(canvas.getByTestId('structured-provider-codex')).toHaveTextContent('Not in use');
  },
};
export const Korean: Story = { globals: { locale: 'ko' } };
