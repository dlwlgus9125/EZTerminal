// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatAgentProfile, ChatAgentProfileAccess } from '../shared/chat-agent-profiles';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot } from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { ChatAgentCollaborationSettings } from './ChatAgentCollaborationSettings';
import { AppI18nProvider } from './i18n';
import { sessionStartSnapshot } from './session-start.fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot = (revision: number, orchestrationToolsEnabled = false): DaemonSnapshot => ({
  ...sessionStartSnapshot, revision, runtime: { ...sessionStartSnapshot.runtime, orchestrationToolsEnabled },
});

function capabilities(getSnapshot: () => Promise<DaemonSnapshot>, sendCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>): CapabilityAccess {
  return { ...rendererCapabilities, daemon: { ...rendererCapabilities.daemon, getSnapshot, sendCommand } };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function flush(): Promise<void> {
  await act(async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); });
}

function render(access: CapabilityAccess, profilesAccess: ChatAgentProfileAccess): void {
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><ChatAgentCollaborationSettings capabilities={access} profilesAccess={profilesAccess} /></AppI18nProvider>));
}

const noProfiles: ChatAgentProfileAccess = { list: async () => [], save: async () => ({ ok: true, profiles: [] }), remove: async () => ({ ok: true, profiles: [] }) };

describe('ChatAgentCollaborationSettings', () => {
  it('uses a fresh daemon revision for orchestration and reloads authority after a conflict', async () => {
    const snapshots = [snapshot(4), snapshot(12), snapshot(13, true)];
    const getSnapshot = vi.fn(async () => snapshots.shift() ?? snapshot(13, true));
    const sendCommand = vi.fn(async (command: DaemonCommand): Promise<DaemonCommandReceipt> => ({
      ok: false, status: 'rejected', commandId: command.commandId, revision: 13,
      error: { code: 'revision-conflict', message: 'revision changed', retryable: true, currentRevision: 13 },
    }));
    render(capabilities(getSnapshot, sendCommand), noProfiles);
    await flush();

    act(() => container.querySelector<HTMLInputElement>('[data-testid="agent-profiles-orchestration"]')!.click());
    await flush();

    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runtime.set-settings', expectedRevision: 12, payload: { orchestrationToolsEnabled: true },
    }));
    expect(container.querySelector<HTMLInputElement>('[data-testid="agent-profiles-orchestration"]')!.checked).toBe(true);
    expect(container.textContent).toContain('latest settings were reloaded');
  });

  it('lists, saves and deletes profiles through the desktop store', async () => {
    const saved: ChatAgentProfile = { id: 'reviewer', name: 'Careful reviewer', providerId: 'codex', permissionPreset: 'plan', whenToUse: 'Review without editing.' };
    const profilesAccess: ChatAgentProfileAccess = {
      list: vi.fn(async () => [saved]),
      save: vi.fn(async () => ({ ok: true as const, profiles: [saved] })),
      remove: vi.fn(async () => ({ ok: true as const, profiles: [] })),
    };
    render(capabilities(async () => snapshot(4), async (command) => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 5, eventSequence: 5 })), profilesAccess);
    await flush();
    expect(container.textContent).toContain('Careful reviewer');
    expect(container.textContent).toContain('Review without editing.');

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Delete: Careful reviewer"]')!.click());
    await flush();
    expect(profilesAccess.remove).toHaveBeenCalledWith('reviewer');
    expect(container.textContent).toContain('No profiles yet.');
  });
});
