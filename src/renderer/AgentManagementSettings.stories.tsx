import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import type {
  AgentCapabilityCatalog,
  AgentCapabilityItem,
  AgentExtensionReceipt,
  AgentHostExtensionsClient,
  AgentMarketplace,
  AgentPluginEntry,
} from '../shared/agent-capabilities';
import type { AgentCliClient, AgentCliStatus, AgentCliUpdateResult } from '../shared/agent-cli';
import { AgentManagementSettings, type AgentManagementProject, type AgentManagementProviderId } from './AgentManagementSettings';
import { AppI18nProvider } from './i18n';
import './index.css';
import './settings-panel.css';

const REVISION = 'a'.repeat(64);
const OBSERVED = '2026-10-29T09:00:00.000Z';

const plugin = (id: string, version: string, enabled: boolean, description?: string): AgentCapabilityItem => ({
  id, kind: 'plugin', name: id.split('@')[0]!, source: id.split('@')[1], scope: 'user', version, enabled,
  ...(description ? { description } : {}),
  actions: ['plugin-enable', 'plugin-disable', 'plugin-update', 'plugin-remove'],
});
const projectPlugin = (id: string, version: string, scope: 'project' | 'local', projectPath: string, workspaceId?: string): AgentCapabilityItem => ({
  ...plugin(id, version, scope === 'project'), scope, projectPath,
  ...(workspaceId ? { workspaceId } : { actions: [] }),
});
const codexPlugin = (id: string, version: string, enabled: boolean, description?: string): AgentCapabilityItem => ({
  ...plugin(id, version, enabled, description), actions: ['plugin-enable', 'plugin-disable', 'plugin-remove'],
});
const mcp = (name: string, status: string, scope: string, removable: boolean): AgentCapabilityItem => ({
  id: name, kind: 'mcp', name, status, scope, enabled: status !== 'disabled', actions: removable ? ['mcp-remove'] : [],
});
const skill = (name: string, invocation: string, description: string, toggle: boolean, enabled = true): AgentCapabilityItem => ({
  id: toggle ? `C:\\Users\\me\\.codex\\skills\\${name}\\SKILL.md` : name, kind: 'skill', name, description, invocation, enabled,
  actions: toggle ? ['skill-enable', 'skill-disable'] : [],
});

const CLAUDE_MARKETPLACES: readonly AgentMarketplace[] = [
  { name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official', actions: ['marketplace-update', 'marketplace-remove'] },
  { name: 'ezpowers-dev', source: 'https://github.com/dlwlgus9125/EZPowers.git', actions: ['marketplace-update', 'marketplace-remove'] },
  { name: 'openai-codex', source: 'openai/codex-plugin-cc', actions: ['marketplace-update', 'marketplace-remove'] },
  { name: 'superpowers-marketplace', source: 'obra/superpowers-marketplace', actions: ['marketplace-update', 'marketplace-remove'] },
];
const CODEX_MARKETPLACES: readonly AgentMarketplace[] = [
  { name: 'ezpowers-dev', source: 'https://github.com/dlwlgus9125/EZPowers.git', actions: ['marketplace-update', 'marketplace-remove'] },
  { name: 'openai-curated', actions: [] },
];

const CLAUDE_SKILLS = [
  ['deep-interview', 'Turn a vague request into a confirmed, decision-ready one.'],
  ['diagnose', 'Reproduce the exact symptom before changing product behavior.'],
  ['frontend-design', 'Settle UI structure and tokens before implementation.'],
  ['code-review', 'Review the current diff for correctness bugs.'],
  ['simplify', 'Review changed code for reuse and simplification.'],
  ['security-review', 'Review pending changes for security issues.'],
  ['init', 'Initialize a CLAUDE.md file.'],
  ['loop', 'Run a prompt on a recurring interval.'],
  ['schedule', 'Create scheduled cloud agents.'],
  ['codex:rescue', 'Delegate investigation to the Codex rescue subagent.'],
  ['claude-api', 'Reference for the Claude API.'],
  ['run', 'Launch and drive this project\u2019s app.'],
].map(([name, description]) => skill(name!, `/${name}`, description!, false));

function catalogFor(providerId: AgentManagementProviderId, receipts?: readonly AgentExtensionReceipt[]): AgentCapabilityCatalog {
  const claude = providerId === 'claude';
  return {
    providerId, workspaceId: '@pc-user', workspaceRoot: 'C:\\Users\\me\\AppData\\Roaming\\EZTerminal\\agent-host-scope',
    hostId: 'desk-pc', observedAt: OBSERVED, revision: REVISION, canManage: true, application: 'new-session',
    models: [], issues: [],
    ...(receipts ? { extensionReceipts: receipts } : {}),
    actions: claude
      ? ['plugin-install', 'plugin-remove', 'plugin-enable', 'plugin-disable', 'plugin-update', 'marketplace-add', 'marketplace-remove', 'marketplace-update', 'mcp-add', 'mcp-remove']
      : ['plugin-install', 'plugin-remove', 'plugin-enable', 'plugin-disable', 'marketplace-add', 'marketplace-remove', 'marketplace-update', 'skill-enable', 'skill-disable', 'mcp-add', 'mcp-remove'],
    marketplaces: claude ? CLAUDE_MARKETPLACES : CODEX_MARKETPLACES,
    items: claude
      ? [
        plugin('ezpowers@ezpowers-dev', '5.6.0', true, 'Requirement interviews, diagnosis and design skills.'),
        plugin('codex@openai-codex', '1.0.6', true, 'Hand work to Codex from Claude Code.'),
        plugin('frontend-design@claude-plugins-official', '58267944f921', true),
        plugin('code-simplifier@claude-plugins-official', '1.0.0', false),
        plugin('playwright@claude-plugins-official', '58267944f921', true),
        projectPlugin('csharp-lsp@claude-plugins-official', '1.0.0', 'project', 'C:\\Working\\EZTerminal', 'workspace-ezterminal'),
        projectPlugin('ezskill@ezskill-dev', '0.1.0', 'local', 'C:\\Working\\Research\\stock-trading-program'),
        mcp('context7', 'connected', 'user', true),
        mcp('plugin:playwright:playwright', 'connected', 'dynamic', false),
        mcp('claude.ai Gmail', 'needs-auth', 'claudeai', false),
        ...CLAUDE_SKILLS,
      ]
      : [
        codexPlugin('ezpowers@ezpowers-dev', '5.8.2', true, 'Requirement interviews, diagnosis and design skills.'),
        codexPlugin('openai-templates@openai-curated', '0.1.1', true),
        mcp('godot-gopeak', 'connected', 'user', true),
        mcp('openaiDeveloperDocs', 'failed', 'user', true),
        skill('deep-interview', '$deep-interview', 'Turn a vague request into a confirmed, decision-ready one.', true),
        skill('diagnose', '$diagnose', 'Reproduce the exact symptom first.', true, false),
        skill('wiki', '$wiki', 'Capture and search project knowledge.', true),
      ],
  };
}

const BROWSE_ENTRIES: readonly AgentPluginEntry[] = [
  { id: '42crunch-api-security-testing@claude-plugins-official', name: '42crunch-api-security-testing', marketplace: 'claude-plugins-official', installCount: 3474, installed: false,
    description: 'Automate API security in Claude Code: audit OpenAPI specs, detect vulnerabilities aligned with OWASP API risks and apply fixes.' },
  { id: 'adobe-for-creativity@claude-plugins-official', name: 'adobe-for-creativity', marketplace: 'claude-plugins-official', installCount: 3986, installed: false,
    description: 'Edit images, automate design workflows, remove backgrounds and vectorize.' },
  { id: 'code-simplifier@claude-plugins-official', name: 'code-simplifier', marketplace: 'claude-plugins-official', version: '1.0.0', installCount: 51203, installed: true,
    description: 'Simplifies and refines code for clarity while preserving functionality.' },
  { id: 'rust-analyzer-lsp@claude-plugins-official', name: 'rust-analyzer-lsp', marketplace: 'claude-plugins-official', version: '1.0.0', installCount: 8120, installed: false,
    description: 'Rust language server for code intelligence.' },
  { id: 'superpowers@superpowers-marketplace', name: 'superpowers', marketplace: 'superpowers-marketplace', version: '4.3.1', installed: false,
    description: 'Core skills library: TDD, debugging, collaboration patterns.' },
  { id: 'ezskill@ezskill-dev', name: 'ezskill', marketplace: 'ezskill-dev', version: '0.1.0', installed: false, description: 'Personal skill pack.' },
];

interface FakeOptions {
  readonly listFails?: boolean;
  readonly listNeverResolves?: boolean;
  readonly browseFails?: boolean;
  readonly browseEmpty?: boolean;
  readonly browseTotal?: number;
  readonly receipts?: readonly AgentExtensionReceipt[];
}

function fakeExtensions(options: FakeOptions = {}): AgentHostExtensionsClient {
  const installed = new Set<string>();
  return {
    async list({ providerId }) {
      if (options.listNeverResolves) return new Promise(() => undefined);
      if (options.listFails) return { ok: false, code: 'unavailable', message: 'Provider discovery timed out.' };
      return { ok: true, value: catalogFor(providerId, options.receipts) };
    },
    async browse({ providerId, query, marketplace, offset = 0, limit = 30 }) {
      if (options.browseFails) return { ok: false, code: 'unavailable', message: 'Marketplace read failed.' };
      const needle = query?.toLocaleLowerCase() ?? '';
      const all = options.browseEmpty ? [] : BROWSE_ENTRIES;
      const matches = all.filter((entry) => (!marketplace || entry.marketplace === marketplace)
        && `${entry.name} ${entry.description ?? ''}`.toLocaleLowerCase().includes(needle));
      return {
        ok: true,
        value: {
          providerId,
          entries: matches.slice(offset, offset + limit).map((entry) => ({ ...entry, installed: entry.installed || installed.has(entry.id) })),
          total: options.browseTotal ?? matches.length,
          offset,
          marketplaces: [...new Set(all.map((entry) => entry.marketplace))],
          observedAt: OBSERVED,
        },
      };
    },
    async manage(command) {
      if (command.action === 'plugin-install') installed.add(command.target);
      return { ok: true, value: { commandId: command.commandId, action: command.action, state: 'applied', application: 'new-session', observedAt: OBSERVED } };
    },
  };
}

function cliStatus(providerId: AgentManagementProviderId, patch: Partial<AgentCliStatus> = {}): AgentCliStatus {
  const claude = providerId === 'claude';
  return {
    providerId,
    installedVersion: claude ? '2.1.289' : '0.165.0',
    latestVersion: claude ? '2.1.312' : '0.165.0',
    updateAvailable: claude,
    updating: false,
    blockers: [],
    manualCommand: `npm install -g ${claude ? '@anthropic-ai/claude-code@2.1.312' : '@openai/codex@0.165.0'}`,
    checkedAt: OBSERVED,
    ...patch,
  };
}

function fakeCli(patch: Partial<AgentCliStatus> = {}, update?: AgentCliUpdateResult): AgentCliClient {
  return {
    async status(providerId) { return cliStatus(providerId, patch); },
    async update() { return update ?? { ok: true, previousVersion: '2.1.289', version: '2.1.312', provider: 'ready' }; },
  };
}

const PROJECTS: readonly AgentManagementProject[] = [
  { workspaceId: 'workspace-ezterminal', name: 'EZTerminal', path: 'C:\\Working\\EZTerminal' },
  { workspaceId: 'workspace-easystation', name: 'EasyStation', path: 'C:\\EasyStation' },
];

const ENABLED = { claude: { enabled: true, version: '2.1.289' }, codex: { enabled: true, version: '0.165.0' } } as const;

const meta = {
  title: 'Settings/Agents/Programs and extensions',
  component: AgentManagementSettings,
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { variant: 'desktop', extensions: fakeExtensions(), cli: fakeCli(), providers: ENABLED, projects: PROJECTS },
  decorators: [(Story, context) => (
    <AppI18nProvider locale={context.globals.locale === 'ko' ? 'ko' : 'en'}>
      <main className="settings-content" style={{ maxWidth: 720, padding: 24 }}><Story /></main>
    </AppI18nProvider>
  )],
} satisfies Meta<typeof AgentManagementSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeUpdateAvailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId('agent-program-update-claude')).toBeEnabled());
    await expect(canvas.getByTestId('agent-plugins-claude')).toHaveTextContent('ezpowers');
  },
};
export const CodexUpToDate: Story = { args: { initialProvider: 'codex' } };
export const Korean: Story = { globals: { locale: 'ko' } };
export const KoreanCodex: Story = { globals: { locale: 'ko' }, args: { initialProvider: 'codex' } };

export const BlockedWhileRunning: Story = {
  args: {
    cli: fakeCli({ blockers: [{ kind: 'running', locations: [
      { kind: 'conversation', label: 'Release notes draft' },
      { kind: 'terminal', label: 'PowerShell 2' },
      { kind: 'outside' },
    ] }] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId('agent-program-running-claude')).toBeVisible());
    await expect(canvas.getByTestId('agent-program-update-claude')).toBeDisabled();
  },
};
export const InstalledAnotherWay: Story = {
  args: { cli: fakeCli({ blockers: [{ kind: 'not-npm' }], manualCommand: 'claude update' }) },
};
export const UpdatesBlockedByPolicy: Story = { args: { cli: fakeCli({ blockers: [{ kind: 'policy' }] }) } };
export const LatestIncompatible: Story = {
  args: { cli: fakeCli({ latestVersion: '3.0.0', blockers: [{ kind: 'incompatible', version: '3.0.0' }] }) },
};
export const LatestUnknown: Story = { args: { cli: fakeCli({ latestVersion: null, updateAvailable: false }) } };
export const NotInstalled: Story = {
  args: {
    cli: fakeCli({ installedVersion: null, latestVersion: '2.1.312', updateAvailable: false, manualCommand: 'npm install -g @anthropic-ai/claude-code' }),
    providers: { ...ENABLED, claude: { enabled: false } },
  },
};
export const Updating: Story = { args: { cli: fakeCli({ updating: true }) } };
export const UpdateConfirm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const update = await canvas.findByTestId('agent-program-update-claude');
    await waitFor(() => expect(update).toBeEnabled());
    await userEvent.click(update);
    const dialog = await within(canvasElement.ownerDocument.body).findByTestId('agent-program-update-dialog');
    await waitFor(() => expect(dialog).toBeVisible());
  },
};
export const UpdateFailed: Story = {
  args: {
    cli: fakeCli({}, { ok: false, code: 'failed', detail: 'npm error code EBUSY: resource busy or locked', manualCommand: 'npm install -g @anthropic-ai/claude-code@2.1.312' }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const update = await canvas.findByTestId('agent-program-update-claude');
    await waitFor(() => expect(update).toBeEnabled());
    await userEvent.click(update);
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByTestId('agent-program-update-confirm'));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('EBUSY');
  },
};

export const NotEnabledInApp: Story = { args: { providers: { ...ENABLED, claude: { enabled: false, version: '2.1.289' } } } };
export const ListLoading: Story = { args: { extensions: fakeExtensions({ listNeverResolves: true }) } };
export const ListFailed: Story = { args: { extensions: fakeExtensions({ listFails: true }) } };
export const UnconfirmedChange: Story = {
  args: { extensions: fakeExtensions({ receipts: [{ commandId: 'extension-1', action: 'plugin-install', state: 'uncertain', application: 'new-session', observedAt: OBSERVED }] }) },
};

export const BrowsePlugins: Story = {
  args: { extensions: fakeExtensions({ browseTotal: 3916 }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('agent-plugins-browse-claude'));
    const dialog = within(await within(canvasElement.ownerDocument.body).findByTestId('agent-plugin-browser'));
    const entry = await dialog.findByText('adobe-for-creativity');
    await waitFor(() => expect(entry).toBeVisible());
  },
};
export const BrowseInstallConfirm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('agent-plugins-browse-claude'));
    const body = within(canvasElement.ownerDocument.body);
    const install = await body.findByTestId('agent-plugin-install-rust-analyzer-lsp@claude-plugins-official');
    await waitFor(() => expect(install).toBeVisible());
    await userEvent.click(install);
    const confirm = await body.findByTestId('agent-plugin-install-confirm');
    await waitFor(() => expect(confirm).toBeVisible());
  },
};
export const BrowseInstallIntoProject: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('agent-plugins-browse-claude'));
    const body = within(canvasElement.ownerDocument.body);
    const install = await body.findByTestId('agent-plugin-install-superpowers@superpowers-marketplace');
    await waitFor(() => expect(install).toBeVisible());
    await userEvent.click(install);
    await userEvent.click(await body.findByTestId('agent-plugin-scope-project'));
    await waitFor(() => expect(body.getByTestId('agent-plugin-project')).toBeVisible());
  },
};
export const CodexInstallConfirm: Story = {
  args: { initialProvider: 'codex' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByTestId('agent-plugins-browse-codex'));
    const body = within(canvasElement.ownerDocument.body);
    const install = await body.findByTestId('agent-plugin-install-superpowers@superpowers-marketplace');
    await waitFor(() => expect(install).toBeVisible());
    await userEvent.click(install);
    await waitFor(() => expect(body.getByTestId('agent-plugin-install-panel')).toHaveTextContent('Codex'));
  },
};
export const BrowseEmpty: Story = {
  args: { extensions: fakeExtensions({ browseEmpty: true }) },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('agent-plugins-browse-claude'));
  },
};
export const BrowseFailed: Story = {
  args: { extensions: fakeExtensions({ browseFails: true }) },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByTestId('agent-plugins-browse-claude'));
  },
};
export const RemoveConfirm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = within(await canvas.findByTestId('agent-plugin-codex@openai-codex'));
    await userEvent.click(row.getByRole('button', { name: /codex/i }));
    const dialog = await within(canvasElement.ownerDocument.body).findByTestId('agent-management-remove-dialog');
    await waitFor(() => expect(dialog).toBeVisible());
  },
};
export const AddMcpServer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = within(await canvas.findByTestId('agent-mcp'));
    await userEvent.click(group.getByText('Add an MCP server'));
    await expect(group.getByTestId('agent-mcp-name')).toBeVisible();
  },
};

export const Mobile: Story = {
  args: { variant: 'mobile', cli: undefined },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  decorators: [(Story) => <div style={{ maxWidth: 400 }}><Story /></div>],
};
export const MobileKorean: Story = {
  ...Mobile,
  globals: { locale: 'ko' },
};
export const MobileOldPcApp: Story = {
  args: { variant: 'mobile', cli: undefined, extensions: null },
  decorators: [(Story) => <div style={{ maxWidth: 400 }}><Story /></div>],
};
