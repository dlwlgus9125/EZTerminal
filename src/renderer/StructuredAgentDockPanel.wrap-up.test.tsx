// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatAgentProfile } from '../shared/chat-agent-profiles';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { suggestedTaskChildSessionId, TURN_WRAP_UP_CAPABILITY } from '../shared/turn-wrap-up';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { cartStory, inSession } from './chat/wrap-up/wrap-up-fixtures';
import { AppI18nProvider } from './i18n';
import { clearRendererRecoveryState } from './renderer-recovery-state';
import { clearSessionViewStates } from './session-view-state';
import { STRUCTURED_AGENT_SESSION_PREFIX, StructuredAgentDockPanel } from './StructuredAgentDockPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-30T09:00:00.000Z';
const SESSION = 'chat-cart';
const WORKSPACE = 'project-1.root-1.main';
const PROFILE: ChatAgentProfile = { id: 'profile-codex', name: 'Codex build', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'full-access' };

function snapshotWith(transcript: readonly DaemonTranscriptItem[], turns: DaemonSnapshot['turns'], patch: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 4, eventSequence: 9, generatedAt: NOW, capabilities: [TURN_WRAP_UP_CAPABILITY, 'agent-effort-v1'],
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ id: 'project-1', name: 'cart-kit', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
    workspaces: [{ id: WORKSPACE, projectId: 'project-1', name: 'cart-kit', kind: 'local', rootPath: 'C:\\Working\\cart-kit', revision: 1, createdAt: NOW, updatedAt: NOW }],
    sessions: [{ id: SESSION, projectId: 'project-1', workspaceId: WORKSPACE, kind: 'agent', title: 'Cart', state: 'running', source: 'structured', revision: 2, createdAt: NOW, updatedAt: NOW }],
    agents: [{
      sessionId: SESSION, providerId: 'claude', providerSessionId: 'provider-session', model: 'opus', reasoningEffort: 'high', permissionPreset: 'full-access',
      state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true, revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [], turns: [...turns], approvals: [], schedules: [], heartbeats: [],
    transcriptHeads: [{ sessionId: SESSION, lastSequence: Math.max(...transcript.map((entry) => entry.sequence)), itemCount: transcript.length }],
    providers: ['claude', 'codex'].map((id) => ({
      id, displayName: id === 'claude' ? 'Claude' : 'Codex', protocol: id === 'codex' ? 'codex-app-server' as const : 'claude-agent-sdk' as const,
      executablePath: id, executableVersion: '1.0.0', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' as const,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    })),
    ...patch,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearSessionViewStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearRendererRecoveryState();
  Reflect.deleteProperty(window, 'ezterminal');
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const OK = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 5, eventSequence: 10 });

function mount(options: { readonly set?: Parameters<typeof cartStory>[2]; readonly patch?: Partial<DaemonSnapshot> } = {}) {
  const fixture = inSession(cartStory('en', 'claude', options.set), SESSION);
  const transcript = fixture.items.map((entry) => ({ ...entry, id: `${SESSION}:${String(entry.sequence)}` }));
  const snapshot = snapshotWith(transcript, fixture.turns, options.patch);
  const sendCommand = vi.fn(async (command: DaemonCommand) => OK(command));
  const create = vi.fn(async () => ({ ok: true as const, value: { workspaceId: 'workspace-suggest' } }));
  Object.defineProperty(window, 'ezterminal', { configurable: true, value: { ...window.ezterminal, chatAgentProfiles: { list: async () => [PROFILE], phases: async () => ({}) }, workspaceWorktrees: { create } } });
  const access: CapabilityAccess = {
    ...rendererCapabilities,
    daemon: {
      getAvailability: async () => ({ state: 'ready' as const, supportedSchemaVersion: 3, currentSchemaVersion: 3 }),
      getSnapshot: vi.fn(async () => snapshot),
      getTranscript: vi.fn(async (_session: string, after = 0, limit = 500) => transcript.filter((entry) => entry.sequence > after).slice(0, limit)),
      sendCommand,
      observeEvents: () => () => undefined,
      getLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
      setLifecycleSettings: async () => ({ keepRunning: true, startAtLogin: false }),
    },
    files: { ...rendererCapabilities.files, worktreeBase: vi.fn(async () => ({ ok: true as const, baseRef: 'main' })) },
    structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [{ id: 'opus', displayName: 'Opus 5.5', supportsReasoning: true, reasoningEfforts: ['high'], isDefault: true }] }) },
  };
  const props = {
    capabilities: access,
    params: { historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${SESSION}`, projectId: 'project-1', rootId: 'root-1', workspaceId: 'main' },
    api: { id: 'wrap-up-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
  } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><StructuredAgentDockPanel {...props} /></AppI18nProvider>));
  return { sendCommand, create, creates: () => sendCommand.mock.calls.map(([command]) => command).filter((command) => command.type === 'agent.create') };
}

const action = (kind: string, index = 0): HTMLButtonElement => {
  const found = container.querySelectorAll<HTMLButtonElement>(`[data-action="${kind}"]`)[index];
  if (!found) throw new Error(`no ${kind} button`);
  return found;
};

describe('turn wrap-up in the conversation tab', () => {
  it('offers nothing on a host without turn-wrap-up-v1, and the cards read as a record', async () => {
    mount({ patch: { capabilities: ['review-loop-v1'] } });
    await flush();
    expect(container.querySelector('[data-testid="chat-task-card"]')).not.toBeNull();
    expect(container.querySelector('[data-action]')).toBeNull();
  });

  it('shows the host’s suggestion in the empty message box', async () => {
    mount({ patch: { nextPromptSuggestions: { [SESSION]: { turnId: 'turn-cart', text: 'Add a test for it' } } } });
    await flush();
    expect(container.querySelector('[data-testid="structured-agent-suggestion"]')?.textContent).toContain('Add a test for it');
  });

  it('starts a task with what the card’s line says: this AI, model and effort, at 승인 후 실행 though this conversation has full access', async () => {
    const { creates } = mount();
    await flush();
    expect(container.querySelector('[data-testid="chat-task-defaults"]')?.textContent).toContain('Claude · Opus 5.5 · High · Ask before running');
    await act(async () => { action('task-start').click(); await Promise.resolve(); });
    await flush();
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.payload).toMatchObject({
      sessionId: suggestedTaskChildSessionId('task-claude-1'), workspaceId: WORKSPACE, parentSessionId: SESSION, providerId: 'claude', model: 'opus', reasoningEffort: 'high', permissionPreset: 'standard',
      wrapUpTask: { turnId: 'turn-cart', taskId: 'task-claude-1', oneClick: true },
    });
  });

  it('opens the start form on a worktree-recommended task, and the person’s choices stand', async () => {
    const { creates, create } = mount({ set: 'mixed' });
    await flush();
    await act(async () => { action('task-start-custom', 3).click(); await Promise.resolve(); });
    await flush();
    const form = document.body.querySelector<HTMLElement>('[data-testid="delegate-agent-dialog"]')!;
    expect(form.querySelector('h2')?.textContent).toBe('Start suggested task');
    expect(form.querySelector<HTMLInputElement>('[data-testid="delegate-agent-branch"]')?.value).toBe('suggest/reject-negative-and-fractional');
    // No saved profile says the card's settings: the form opens on them, not on the first profile.
    const profile = form.querySelector<HTMLSelectElement>('[data-testid="delegate-agent-profile"]')!;
    expect(profile.selectedOptions[0]?.textContent).toBe('Claude · Opus 5.5 · High · Ask before running');
    // Then the person picks the saved Codex profile, which runs with full access.
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => { setter.call(profile, PROFILE.id); profile.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(form.textContent).toContain('Codex · gpt-6-astra · Medium · Full access');
    await act(async () => { form.querySelector<HTMLButtonElement>('[data-testid="delegate-agent-submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(create).toHaveBeenCalledWith('project-1', 'suggest/reject-negative-and-fractional');
    expect(creates()[0]!.payload).toMatchObject({
      providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'full-access', workspaceId: 'workspace-suggest',
      sessionId: suggestedTaskChildSessionId('task-claude-4'), wrapUpTask: { turnId: 'turn-cart', taskId: 'task-claude-4', branch: 'suggest/reject-negative-and-fractional' },
    });
    expect((creates()[0]!.payload as { readonly wrapUpTask?: { readonly oneClick?: boolean } }).wrapUpTask?.oneClick).toBeUndefined();
  });
});
