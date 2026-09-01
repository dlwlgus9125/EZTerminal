// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EzTerminalDesktopApi } from '../shared/ipc';
import type { AgentTeamDesktopSnapshot } from '../shared/agent-team';
import { AgentTeamSettings } from './AgentTeamSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: AgentTeamDesktopSnapshot = {
  revision: 1,
  catalog: {
    revision: 1,
    personas: [],
    teams: [],
    capabilities: [
      {
        provider: 'codex',
        available: true,
        supportsModel: true,
        effortValues: [],
        permissionValues: ['read-only', 'workspace-write'],
        modelAvailability: 'launch-time',
      },
    ],
  },
  runRevision: 0,
  runs: [],
};

let originalDesktop: typeof window.ezterminalDesktop;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  originalDesktop = window.ezterminalDesktop;
});

afterEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(window, 'ezterminalDesktop', {
    configurable: true,
    value: originalDesktop,
  });
  vi.restoreAllMocks();
});

describe('AgentTeamSettings', () => {
  it('saves a bounded Persona without exposing raw CLI arguments', async () => {
    const saveAgentPersona = vi.fn(async () => ({
      ok: true as const,
      value: {
        personaId: crypto.randomUUID(),
        revision: 1,
        name: 'Reviewer',
        preset: 'reviewer' as const,
        icon: 'shield-check' as const,
        role: 'Reviewer',
        instructions: 'Review the approved work.',
        launch: { provider: 'codex' as const, sandbox: 'read-only' as const },
        createdAt: 1,
        updatedAt: 1,
      },
    }));
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        getAgentTeamSnapshot: vi.fn(async () => snapshot),
        onAgentTeamSnapshot: vi.fn(() => () => undefined),
        saveAgentPersona,
      } as unknown as EzTerminalDesktopApi,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<AgentTeamSettings />));
    await flush();

    const add = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Add Persona'));
    act(() => add?.click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="agent-persona-editor"]')!;
    const preset = dialog.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      preset.value = 'reviewer';
      preset.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const name = dialog.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Reviewer');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.includes('Save'));
    await act(async () => {
      save?.click();
      await Promise.resolve();
    });
    expect(saveAgentPersona).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Reviewer',
      preset: 'reviewer',
      role: 'Reviewer',
      instructions: expect.stringContaining('Review the approved work'),
      launch: { provider: 'codex', sandbox: 'read-only' },
    }));
    expect(JSON.stringify(saveAgentPersona.mock.calls[0])).not.toContain('args');
    act(() => root.unmount());
  });

  it('creates the starter Personas and Team through one atomic desktop action', async () => {
    const createAgentStarterTeam = vi.fn(async () => ({
      ok: true as const,
      value: {} as never,
    }));
    Object.defineProperty(window, 'ezterminalDesktop', {
      configurable: true,
      value: {
        getAgentTeamSnapshot: vi.fn(async () => snapshot),
        onAgentTeamSnapshot: vi.fn(() => () => undefined),
        createAgentStarterTeam,
      } as unknown as EzTerminalDesktopApi,
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<AgentTeamSettings />));
    await flush();

    const open = [...container.querySelectorAll('button')].find((button) => (
      button.textContent?.includes('Create starter team')
    ));
    act(() => open?.click());
    const dialog = document.querySelector<HTMLElement>('[data-testid="agent-team-starter-editor"]')!;
    const create = [...dialog.querySelectorAll('button')].find((button) => (
      button.textContent?.includes('Create starter team')
    ));
    await act(async () => {
      create?.click();
      await Promise.resolve();
    });

    expect(createAgentStarterTeam).toHaveBeenCalledTimes(1);
    expect(createAgentStarterTeam).toHaveBeenCalledWith({
      plannerProvider: 'codex',
      implementerProvider: 'codex',
    });
    act(() => root.unmount());
  });
});
