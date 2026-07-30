/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProjectSummary } from '../../src/shared/agent-history';
import { MobileAgentProjects } from './MobileAgentProjects';
import { MobileNavigationHistoryProvider } from './MobileNavigationHistory';
import type { WsEzTerminalTransport } from './transport/ws-ezterminal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('MobileAgentProjects launch picker', () => {
  it('starts blank globally and preselects only the project from a project card', async () => {
    const project: AgentProjectSummary = {
      projectId: 'project-1',
      name: 'Workspace',
      primaryRoot: 'C:\\Workspace',
      additionalRoots: ['C:\\Shared'],
      pinned: false,
      saved: true,
      sessionCount: 0,
      providers: [],
      lastActiveAt: 20,
    };
    const launcher = {
      launcherId: 'generic-1',
      provider: 'generic' as const,
      name: 'My Agent',
      supportsAdditionalRoots: false,
    };
    const transport = {
      supportsAgentProjectManagement: true,
      supportsAgentDirectLaunch: true,
      listAgentProjects: vi.fn(async () => ({ items: [project], nextCursor: null })),
      listAgentProjectLaunchers: vi.fn(async () => [launcher]),
      prepareAgentLaunch: vi.fn(async () => ({
        ok: true as const,
        target: { kind: 'project' as const, projectId: project.projectId },
        launcherId: launcher.launcherId,
        provider: launcher.provider,
        name: launcher.name,
        cwd: project.primaryRoot,
        roots: [project.primaryRoot],
        ignoredAdditionalRootCount: 1,
        revision: 'revision-1',
      })),
    } as unknown as WsEzTerminalTransport;
    const onLaunchAgent = vi.fn(async () => undefined);

    act(() => root.render(
      <MobileNavigationHistoryProvider>
        <MobileAgentProjects
          transport={transport}
          onResumeHistory={async () => undefined}
          onLaunchAgent={onLaunchAgent}
        />
      </MobileNavigationHistoryProvider>,
    ));
    await flush();

    act(() => container.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-agent-new-run"]',
    )!.click());
    await flush();
    expect(document.body.querySelector<HTMLSelectElement>(
      '[data-testid="mobile-agent-launch-agent"]',
    )?.value).toBe('');
    expect(document.body.querySelector<HTMLSelectElement>(
      '[data-testid="mobile-agent-launch-project"]',
    )?.value).toBe('');

    act(() => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="mobile-agent-launch-picker"] .mobile-action-sheet-cancel',
    )?.click());
    await flush();
    act(() => {
      const newChat = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('New chat'));
      newChat!.click();
    });
    await flush();

    const agentSelect = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="mobile-agent-launch-agent"]',
    )!;
    const projectSelect = document.body.querySelector<HTMLSelectElement>(
      '[data-testid="mobile-agent-launch-project"]',
    )!;
    expect(projectSelect.value).toBe(project.projectId);
    expect(agentSelect.value).toBe('');

    act(() => {
      agentSelect.value = launcher.launcherId;
      agentSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('1 additional project folder');

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="mobile-agent-launch-submit"]',
      )!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(transport.prepareAgentLaunch).toHaveBeenCalledWith(
      { kind: 'project', projectId: project.projectId },
      launcher.launcherId,
    );
    expect(onLaunchAgent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'new-chat',
      target: { kind: 'project', projectId: project.projectId },
      launcherId: launcher.launcherId,
    }));
  });
});
