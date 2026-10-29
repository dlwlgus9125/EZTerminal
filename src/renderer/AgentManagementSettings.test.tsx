// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilityCatalog, AgentHostExtensionsClient } from '../shared/agent-capabilities';
import type { DaemonSnapshot } from '../shared/daemon-protocol';
import { AgentManagementSettings, agentManagementInputs } from './AgentManagementSettings';
import { AppI18nProvider } from './i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let container: HTMLDivElement;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.replaceChildren(); });

const REVISION = 'a'.repeat(64);
const catalog: AgentCapabilityCatalog = {
  providerId: 'claude', workspaceId: '@pc-user', workspaceRoot: 'C:/app/host', hostId: 'PC-1', revision: REVISION,
  observedAt: '2026-10-29T00:00:00Z', canManage: true, application: 'new-session', models: [], issues: [],
  actions: ['plugin-install', 'plugin-enable', 'plugin-disable', 'plugin-remove', 'marketplace-add'],
  marketplaces: [{ name: 'official', source: 'anthropics/official', actions: ['marketplace-update', 'marketplace-remove'] }],
  items: [
    { id: 'tool@official', kind: 'plugin', name: 'tool', source: 'official', scope: 'user', enabled: true, actions: ['plugin-enable', 'plugin-disable', 'plugin-remove'] },
    { id: 'lsp@official', kind: 'plugin', name: 'lsp', source: 'official', scope: 'project', projectPath: 'C:/work/app', workspaceId: 'ws-app', enabled: false, actions: ['plugin-enable', 'plugin-disable'] },
  ],
};
const flush = async (): Promise<void> => { await act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }); };
function client(): AgentHostExtensionsClient {
  return {
    list: vi.fn<AgentHostExtensionsClient['list']>(async () => ({ ok: true, value: catalog })),
    browse: vi.fn<AgentHostExtensionsClient['browse']>(async ({ providerId }) => ({ ok: true, value: {
      providerId, total: 1, offset: 0, marketplaces: ['official'], observedAt: '2026-10-29T00:00:00Z',
      entries: [{ id: 'new@official', name: 'new', marketplace: 'official', installed: false }],
    } })),
    manage: vi.fn<AgentHostExtensionsClient['manage']>(async (command) => ({ ok: true, value: { commandId: command.commandId, action: command.action, state: 'applied', application: 'new-session' } })),
  };
}
const projects = [{ workspaceId: 'ws-app', name: 'App', path: 'C:/work/app' }];
const enabled = { claude: { enabled: true, version: '2.1.289' }, codex: { enabled: true } };
function render(element: JSX.Element): void {
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}>{element}</AppI18nProvider>));
}
const byTestId = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};

describe('AI management', () => {
  it('sends a project install with its scope and app project', async () => {
    const extensions = client();
    render(<AgentManagementSettings variant="desktop" extensions={extensions} providers={enabled} projects={projects} />);
    await flush();
    act(() => byTestId('agent-plugins-browse-claude').click());
    await flush();
    act(() => byTestId('agent-plugin-install-new@official').click());
    act(() => byTestId<HTMLInputElement>('agent-plugin-scope-local').click());
    act(() => byTestId('agent-plugin-install-confirm').click());
    await flush();
    expect(extensions.manage).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude', action: 'plugin-install', target: 'new@official', scope: 'local', workspaceId: 'ws-app', expectedRevision: REVISION,
    }));
  });

  it('changes a project install in its own project and a PC install PC-wide', async () => {
    const extensions = client();
    render(<AgentManagementSettings variant="desktop" extensions={extensions} providers={enabled} projects={projects} />);
    await flush();
    act(() => byTestId('agent-plugin-lsp@official').querySelector<HTMLInputElement>('input[role="switch"]')!.click());
    await flush();
    expect(extensions.manage).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'plugin-enable', target: 'lsp@official', scope: 'project', workspaceId: 'ws-app' }));
    act(() => byTestId('agent-plugin-tool@official').querySelector<HTMLInputElement>('input[role="switch"]')!.click());
    await flush();
    const last = vi.mocked(extensions.manage).mock.lastCall?.[0];
    expect(last).toMatchObject({ action: 'plugin-disable', target: 'tool@official', scope: 'user' });
    expect(last).not.toHaveProperty('workspaceId');
  });

  it('points to the provider switch instead of listing extensions for an AI not in use', async () => {
    const extensions = client();
    render(<AgentManagementSettings variant="mobile" extensions={extensions} providers={{ claude: { enabled: false, version: '2.1.289' }, codex: { enabled: true } }} />);
    await flush();
    expect(byTestId('agent-management-not-enabled').textContent).toContain('Settings › Agents › Chat in app');
    expect(extensions.list).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2.1.289');
    expect(container.querySelector('[data-testid^="agent-program-update"]')).toBeNull();
  });

  it('derives usable AIs and app projects from the daemon snapshot', () => {
    const snapshot = {
      providers: [{ id: 'claude', enabled: true, health: 'ready', executableVersion: '2.1.289' }, { id: 'codex', enabled: true, health: 'error', executableVersion: 'unknown' }],
      projects: [{ id: 'p1', name: 'Zed', rootPath: 'C:/z' }, { id: 'p2', name: 'App', rootPath: 'C:/a' }, { id: 'p3', name: 'Old', rootPath: 'C:/o', archivedAt: 'x' }],
      workspaces: [{ id: 'w-tree', projectId: 'p2', kind: 'worktree', rootPath: 'C:/a-tree' }, { id: 'w-a', projectId: 'p2', kind: 'local', rootPath: 'C:/a' }, { id: 'w-z', projectId: 'p1', kind: 'local', rootPath: 'C:/z' }],
    } as unknown as DaemonSnapshot;
    expect(agentManagementInputs(snapshot)).toEqual({
      providers: { claude: { enabled: true, version: '2.1.289' }, codex: { enabled: false } },
      projects: [{ workspaceId: 'w-a', name: 'App', path: 'C:/a' }, { workspaceId: 'w-z', name: 'Zed', path: 'C:/z' }],
    });
  });
});
