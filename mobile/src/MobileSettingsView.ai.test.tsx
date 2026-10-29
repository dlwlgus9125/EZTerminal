import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCapabilityCatalog, AgentHostExtensionsClient } from '../../src/shared/agent-capabilities';
import type { DaemonSnapshot } from '../../src/shared/daemon-protocol';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import { MobileSettingsView } from './MobileSettingsView';
import { MobileUiPreferencesProvider } from './MobileUiPreferencesProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const catalog: AgentCapabilityCatalog = {
  providerId: 'claude', workspaceId: '@pc-user', workspaceRoot: 'C:/host', hostId: 'PC', observedAt: 'now', revision: 'a'.repeat(64),
  canManage: true, application: 'new-session', models: [], issues: [], actions: ['plugin-disable'], marketplaces: [],
  items: [{ id: 'tool@official', kind: 'plugin', name: 'tool', source: 'official', scope: 'user', enabled: true, actions: ['plugin-disable'] }],
};
const snapshot = {
  providers: [{ id: 'claude', enabled: true, health: 'ready', executableVersion: '2.1.289' }],
  projects: [], workspaces: [],
} as unknown as DaemonSnapshot;

function render(agentManagement?: { extensions: AgentHostExtensionsClient; loadSnapshot: () => Promise<DaemonSnapshot | null> }): void {
  act(() => {
    root.render(
      <MobileUiPreferencesProvider>
        <MobileNavigationHistoryProvider>
          <MobileSettingsView
            onClose={vi.fn()}
            onDisconnect={vi.fn()}
            openclawMode="auto"
            onOpenClawModeChange={vi.fn()}
            currentTheme="matrix"
            onOpenTheme={vi.fn()}
            {...(agentManagement ? { agentManagement } : {})}
          />
        </MobileNavigationHistoryProvider>
      </MobileUiPreferencesProvider>,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MobileSettingsView AI', () => {
  it('opens the PC’s AI management without a program update control', async () => {
    const extensions: AgentHostExtensionsClient = {
      list: vi.fn<AgentHostExtensionsClient['list']>(async () => ({ ok: true, value: catalog })),
      browse: vi.fn<AgentHostExtensionsClient['browse']>(),
      manage: vi.fn<AgentHostExtensionsClient['manage']>(),
    };
    render({ extensions, loadSnapshot: async () => snapshot });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="settings-category-ai"]')!.click());
    await act(async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); });
    expect(container.querySelector('[data-testid="agent-management"]')?.getAttribute('data-variant')).toBe('mobile');
    expect(extensions.list).toHaveBeenCalledWith({ providerId: 'claude' });
    expect(container.querySelector('[data-testid="agent-plugin-tool@official"]')).not.toBeNull();
    expect(container.textContent).toContain('2.1.289');
    expect(container.querySelector('[data-testid^="agent-program-update"]')).toBeNull();
  });

  it('has no AI row when the connection offers no PC extension access', () => {
    render();
    expect(container.querySelector('[data-testid="settings-category-ai"]')).toBeNull();
    expect(container.querySelector('[data-testid="settings-category-general"]')).not.toBeNull();
  });
});
