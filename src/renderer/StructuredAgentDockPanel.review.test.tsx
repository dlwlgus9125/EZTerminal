// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatAgentPhaseMap, ChatAgentProfile } from '../shared/chat-agent-profiles';
import type { DaemonCommand, DaemonCommandReceipt, DaemonSnapshot, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { inSession, otherAiReview, OTHER_REVIEW_ID } from './chat/review/review-fixtures';
import { AppI18nProvider } from './i18n';
import { clearRendererRecoveryState } from './renderer-recovery-state';
import { clearSessionViewStates } from './session-view-state';
import { STRUCTURED_AGENT_SESSION_PREFIX, StructuredAgentDockPanel } from './StructuredAgentDockPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = '2026-10-30T09:00:00.000Z';
const SESSION = 'chat-prices';
const WORKSPACE = 'project-1.root-1.worktree-1';

function snapshotWith(patch: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    protocolVersion: 12, revision: 4, eventSequence: 9, generatedAt: NOW, capabilities: ['review-loop-v1'],
    runtime: { keepRunning: true, startAtLogin: false, orchestrationToolsEnabled: true, browserEnabled: false },
    projects: [{ id: 'project-1', name: 'cart-kit', source: 'native', revision: 1, createdAt: NOW, updatedAt: NOW }],
    workspaces: [{ id: WORKSPACE, projectId: 'project-1', name: 'review/cart-kit', kind: 'worktree', rootPath: 'C:\\Working\\cart-kit', revision: 1, createdAt: NOW, updatedAt: NOW }],
    sessions: [{
      id: SESSION, projectId: 'project-1', workspaceId: WORKSPACE, kind: 'agent', title: 'Prices',
      state: 'running', source: 'structured', revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agents: [{
      sessionId: SESSION, providerId: 'claude', providerSessionId: 'provider-session', model: 'opus', permissionPreset: 'standard',
      state: 'idle', queuedTurnCount: 0, orchestrationEnabled: true, revision: 2, createdAt: NOW, updatedAt: NOW,
    }],
    agentRelations: [], turns: [], approvals: [], schedules: [], heartbeats: [],
    transcriptHeads: [],
    providers: ['claude', 'codex'].map((id) => ({
      id, displayName: id === 'claude' ? 'Claude' : 'Codex', protocol: id === 'codex' ? 'codex-app-server' as const : 'claude-agent-sdk' as const,
      executablePath: id, executableVersion: '1.0.0', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' as const,
      revision: 1, createdAt: NOW, updatedAt: NOW,
    })),
    reviewSupport: { claude: { self: true, reviewer: true }, codex: { self: true, reviewer: true } },
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
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

const OK = (command: DaemonCommand): DaemonCommandReceipt => ({ ok: true, status: 'applied', commandId: command.commandId, revision: 5, eventSequence: 10 });

function mount(base: DaemonSnapshot, transcript: readonly DaemonTranscriptItem[], answer: (command: DaemonCommand, index: number) => DaemonCommandReceipt = OK) {
  // The head the host reports matches what the transcript holds.
  const snapshot: DaemonSnapshot = { ...base, transcriptHeads: transcript.length
    ? [{ sessionId: SESSION, lastSequence: Math.max(...transcript.map((entry) => entry.sequence)), itemCount: transcript.length }] : [] };
  let calls = 0;
  const sendCommand = vi.fn(async (command: DaemonCommand) => answer(command, calls++));
  const worktreeBase = vi.fn(async () => ({ ok: true as const, baseRef: 'main' }));
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
    files: { ...rendererCapabilities.files, worktreeBase },
    structuredProviders: { ...rendererCapabilities.structuredProviders, listModels: async () => ({ ok: true, value: [] }) },
  };
  const props = {
    capabilities: access,
    params: { historyId: `${STRUCTURED_AGENT_SESSION_PREFIX}${SESSION}`, projectId: 'project-1', rootId: 'root-1', workspaceId: 'worktree-1' },
    api: { id: 'review-agent', setTitle: vi.fn(), updateParameters: vi.fn() },
  } as unknown as IDockviewPanelProps & { capabilities: CapabilityAccess };
  act(() => root.render(<AppI18nProvider locale="en" languages={['en']}><StructuredAgentDockPanel {...props} /></AppI18nProvider>));
  return { sendCommand, worktreeBase, reviews: () => sendCommand.mock.calls.map(([command]) => command).filter((command) => command.type.startsWith('review.')) };
}

function type(control: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => { setter.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); });
}
const composer = (): HTMLTextAreaElement => container.querySelector('[data-testid="structured-agent-composer-input"]')!;
/** The fixture's review conversation as the host pages it: one sequence after another. */
function reviewTranscript(): DaemonTranscriptItem[] {
  return inSession(otherAiReview(), SESSION).items.map((entry, index) => ({ ...entry, sequence: index + 1, id: `${SESSION}:${String(index + 1)}` }));
}
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
};

describe('reviews through the host (review-loop-v1)', () => {
  it('opens the start form from /review with its focus and the worktree base, and starts the review on the host', async () => {
    const { reviews, worktreeBase } = mount(snapshotWith(), []);
    await flush();
    expect(worktreeBase).toHaveBeenCalledWith(WORKSPACE);
    type(composer(), '/review the price math');
    act(() => composer().closest('form')!.requestSubmit());
    await flush();
    expect(document.querySelector<HTMLTextAreaElement>('[data-testid="review-start-focus"]')?.value).toBe('the price math');
    expect(document.querySelector('[data-testid="review-start"]')?.textContent).toContain('Compare with the base branch (main)');
    expect(reviews()).toEqual([]);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="review-start-submit"]')!.click());
    await flush();
    expect(reviews()).toEqual([expect.objectContaining({
      type: 'review.start', expectedRevision: 4, principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      payload: { sessionId: SESSION, reviewId: expect.stringMatching(/^rv-/u), reviewer: { kind: 'self' }, target: { kind: 'uncommitted' }, focus: 'the price math' },
    })]);
  });

  it('sends a card’s buttons as review commands, reading the revision again after a race', async () => {
    const conflict = (command: DaemonCommand): DaemonCommandReceipt => ({
      ok: false, status: 'rejected', commandId: command.commandId, revision: 5, error: { code: 'revision-conflict', message: 'stale', retryable: true },
    });
    const { reviews } = mount(snapshotWith(), reviewTranscript(), (command, index) => (index === 0 ? conflict(command) : OK(command)));
    await flush();
    await act(async () => button('Fix src/auth.ts:6').click());
    await flush();
    await act(async () => button('Dismiss src/cart.ts:1').click());
    await flush();
    const sent = reviews();
    expect(sent.map((command) => command.type)).toEqual(['review.fix', 'review.fix', 'review.resolve']);
    expect(sent[0]!.payload).toEqual({ sessionId: SESSION, reviewId: OTHER_REVIEW_ID, findingIds: [expect.stringMatching(/^f-/u)] });
    expect(sent[1]!.payload).toEqual(sent[0]!.payload);
    expect(sent[2]!.payload).toEqual({ sessionId: SESSION, reviewId: OTHER_REVIEW_ID, findingIds: [expect.stringMatching(/^f-/u)], state: 'dismissed' });
  });

  it('shows what the host refused', async () => {
    mount(snapshotWith(), reviewTranscript(), (command) => ({
      ok: false, status: 'rejected', commandId: command.commandId, revision: 5, error: { code: 'invalid-state', message: 'This finding is being fixed.', retryable: false },
    }));
    await flush();
    await act(async () => button('Fix src/auth.ts:6').click());
    await flush();
    expect(container.querySelector('[data-testid="structured-agent-review-error"]')?.textContent).toContain('This finding is being fixed.');
  });

  it('names the review agent another AI reviews as, as 단계 연결 says when the form opens', async () => {
    // The person links a review agent in Settings while this conversation's tab stays open.
    const profiles: ChatAgentProfile[] = [{ id: 'careful', name: 'Careful reviewer', providerId: 'codex', reasoningEffort: 'low', permissionPreset: 'standard' }];
    let phases: ChatAgentPhaseMap = { byProvider: {}, switchModel: false };
    const previous = Object.getOwnPropertyDescriptor(window, 'ezterminal');
    Object.defineProperty(window, 'ezterminal', { configurable: true, value: { ...window.ezterminal, chatAgentProfiles: { list: async () => profiles, phases: async () => phases } } });
    try {
      mount(snapshotWith(), []);
      await flush();
      phases = { ...phases, review: { profileId: 'careful' } };
      type(composer(), '/review');
      act(() => composer().closest('form')!.requestSubmit());
      await flush();
      act(() => document.querySelector<HTMLInputElement>('[data-testid="review-start-other"]')!.click());
      await flush();
      expect(document.querySelector('[data-testid="review-start-other-settings"]')?.textContent).toBe('Uses the review agent Careful reviewer · Low');
    } finally {
      if (previous) Object.defineProperty(window, 'ezterminal', previous);
      else delete (window as { ezterminal?: unknown }).ezterminal;
    }
  });

  it('keeps the older behaviour on a host without review-loop-v1', async () => {
    const { reviews } = mount(snapshotWith({ capabilities: [] }), reviewTranscript());
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="structured-agent-menu"]')!.click());
    expect(document.querySelector('[data-testid="structured-agent-review"]')).toBeNull();
    expect(document.querySelector('.chat-review-finding__action')).toBeNull();
    expect(reviews()).toEqual([]);
  });
});
