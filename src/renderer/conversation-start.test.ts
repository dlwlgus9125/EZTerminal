import { describe, expect, it, vi } from 'vitest';
import type { ChatStateSnapshot, ChatStateScope } from '../shared/chat-state';
import type { DaemonCommand, DaemonSnapshot } from '../shared/daemon-protocol';
import { ChatRecoveryController, type ChatStateAccess } from './chat-recovery';
import { ConversationStartController, initialConversationSettings, type ConversationStartAccess } from './conversation-start';

const settings = { workspaceId: 'workspace', providerId: 'codex', permissionPreset: 'standard' as const };
const scope: ChatStateScope = { projectId: 'project', sessionId: 'draft-1', kind: 'draft' };
function fixture(conversationId?: string) {
  const fixtureScope: ChatStateScope = conversationId ? { projectId: 'project', sessionId: conversationId, kind: 'conversation' } : scope;
  let stored: ChatStateSnapshot = { version: 2, scope: fixtureScope, revision: 0, state: { draft: { text: 'Hello' } }, updatedAt: null };
  const storage: ChatStateAccess = {
    chatStateRead: async () => ({ ok: true, snapshot: structuredClone(stored) }),
    chatStateWrite: async (_scope, request) => {
      if (request.expectedRevision !== stored.revision) return { ok: false, error: 'stale', message: 'Changed' };
      stored = { ...stored, revision: stored.revision + 1, state: structuredClone(request.state) };
      return { ok: true, snapshot: stored };
    },
  };
  const received = new Map<string, DaemonCommand>();
  let lose: DaemonCommand['type'] | undefined;
  const access: ConversationStartAccess = {
    principal: { kind: 'desktop', id: 'test' },
    getSnapshot: async () => ({ revision: received.size } as DaemonSnapshot),
    sendCommand: vi.fn(async command => {
      expect(stored.state.start?.[command.type === 'agent.create' ? 'create' : 'submit']).toEqual(command);
      received.set(command.commandId, command);
      if (command.type === lose) { lose = undefined; return null; }
      return { ok: true as const, commandId: command.commandId, revision: received.size, eventSequence: 0, status: 'applied' as const };
    }),
    history: { listConversations: vi.fn(), readConversation: vi.fn(), prepareHistoryResume: vi.fn(async () => ({ ok: true as const, entry: {} as never,
      revision: 'revision', workspaceId: 'workspace', canResume: true, action: 'resume' as const, permissionPreset: 'standard' as const })),
      resumeHistory: vi.fn(async () => ({ ok: true as const, sessionId: 'continued', alreadyLinked: false })) },
  };
  const restart = () => { const recovery = new ChatRecoveryController(fixtureScope, storage); return { recovery, controller: new ConversationStartController(recovery, access) }; };
  return { access, storage, received, stored: () => stored, lose: (type: DaemonCommand['type']) => { lose = type; }, restart, ...restart() };
}
describe('first message transaction', () => {
  it('retries a rejected revision with a new command while retaining one logical session', async () => {
    const h = fixture();
    vi.mocked(h.access.sendCommand).mockImplementationOnce(async command => ({ ok: false, status: 'rejected', commandId: command.commandId, revision: 3,
      error: { code: 'revision-conflict', message: 'Snapshot advanced', retryable: true } }));
    expect(await h.controller.send(settings, 'Hello')).toMatchObject({ ok: true });
    const commands = vi.mocked(h.access.sendCommand).mock.calls.map(([command]) => command);
    expect(commands.map(command => command.type)).toEqual(['agent.create', 'agent.create', 'agent.submit']);
    const creates = commands.filter(command => command.type === 'agent.create');
    expect(creates[0].payload.sessionId).toBe(creates[1].payload.sessionId);
    expect(commands[0].commandId).not.toBe(commands[1].commandId);
  });
  it('starts with a profile’s reasoning effort', async () => {
    const h = fixture();
    expect(await h.controller.send({ ...settings, model: 'gpt-5', permissionPreset: 'plan', reasoningEffort: 'high' }, 'Hello')).toMatchObject({ ok: true });
    const create = vi.mocked(h.access.sendCommand).mock.calls.map(([command]) => command).find(command => command.type === 'agent.create');
    expect(create?.payload).toMatchObject({ model: 'gpt-5', permissionPreset: 'plan', reasoningEffort: 'high' });
  });
  it('keeps a failed continuation in place without creating a replacement conversation', async () => {
    const h = fixture('conversation_original');
    vi.mocked(h.access.history.prepareHistoryResume).mockResolvedValue({ ok: false, reason: 'missing-root', message: 'Working folder is missing.' });
    expect(await h.controller.send(settings, 'Hello', undefined, 'conversation_original')).toMatchObject({ ok: false, message: 'Working folder is missing.' });
    expect(h.access.sendCommand).not.toHaveBeenCalled();
    expect(h.recovery.getSnapshot().draft.text).toBe('Hello');
  });
  it('creates without a prompt, then submits the full message context exactly once', async () => {
    const h = fixture();
    const context = { replyTo: { messageId: 'old-message', text: 'quoted text' } };
    expect(await h.controller.send(settings, 'Hello', context)).toMatchObject({ ok: true });
    const commands = [...h.received.values()];
    expect(commands.map(command => command.type)).toEqual(['agent.create', 'agent.submit']);
    expect(commands[0].payload).not.toHaveProperty('initialPrompt');
    expect(commands[1].payload).toMatchObject({ prompt: 'Hello', context });
  });
  it.each(['agent.create', 'agent.submit'] as const)('recovers lost %s receipts after a restart without a new operation', async type => {
    const h = fixture(); h.lose(type);
    expect(await h.controller.send(settings, 'Hello')).toMatchObject({ ok: false, deliveryUncertain: true });
    const prepared = [...h.received.values()].at(-1)!;
    const restart = h.restart();
    const calls = vi.mocked(h.access.sendCommand).mock.calls.length;
    await restart.recovery.load();
    expect(h.access.sendCommand).toHaveBeenCalledTimes(calls);
    expect(await restart.controller.send(settings, 'Hello')).toMatchObject({ ok: true });
    expect(h.access.sendCommand).toHaveBeenCalledWith(prepared);
    expect([...h.received.values()].map(command => command.type)).toEqual(['agent.create', 'agent.submit']);
  });
  it('keeps the original continuation when submit delivery is uncertain', async () => {
    const h = fixture('conversation_original'); h.lose('agent.submit');
    await h.controller.send(settings, 'Hello', undefined, 'conversation_original');
    const restart = h.restart();
    await restart.controller.send(settings, 'Hello', undefined, 'conversation_original');
    expect(h.access.history.resumeHistory).toHaveBeenCalledTimes(1);
    expect(h.received.size).toBe(1);
    expect([...h.received.values()][0].payload).toMatchObject({ sessionId: 'continued' });
  });
  it('preserves newer edits while reconciling an older accepted message', async () => {
    const h = fixture(); h.lose('agent.submit');
    await h.controller.send(settings, 'Hello');
    h.recovery.updateDraft({ text: 'My next message' });
    expect(await h.controller.send(settings, 'Hello')).toMatchObject({ ok: true });
    expect(h.recovery.getSnapshot().draft.text).toBe('My next message');
  });
});

describe('start form settings', () => {
  it('continues a previous conversation with what it last ran with, never another conversation’s settings', () => {
    const recent = { providerId: 'claude', model: 'claude-sonnet-5-5', permissionPreset: 'plan' as const };
    const source = { model: 'claude-opus-5-5', permissionPreset: 'full-access' as const };
    expect(initialConversationSettings({ entry: { providerId: 'claude', workspaceId: 'w' }, recent, source }))
      .toEqual({ providerId: 'claude', workspaceId: 'w', model: 'claude-opus-5-5', permissionPreset: 'full-access' });
  });

  it('starts a new conversation from the most recent one in the project', () => {
    expect(initialConversationSettings({ recent: { providerId: 'codex', model: 'gpt-6-astra', permissionPreset: 'full-access' }, fallbackWorkspaceId: 'w' }))
      .toEqual({ providerId: 'codex', workspaceId: 'w', model: 'gpt-6-astra', permissionPreset: 'full-access' });
  });

  it('starts a new conversation with the access level last chosen, never another conversation’s plan mode', () => {
    const recentPlan = { providerId: 'codex', model: 'gpt-6-astra', permissionPreset: 'plan' as const };
    expect(initialConversationSettings({ recent: recentPlan, lastAccess: 'full-access', fallbackWorkspaceId: 'w' }))
      .toEqual({ providerId: 'codex', workspaceId: 'w', model: 'gpt-6-astra', permissionPreset: 'full-access' });
    expect(initialConversationSettings({ recent: recentPlan, fallbackWorkspaceId: 'w' }))
      .toEqual({ providerId: 'codex', workspaceId: 'w', model: 'gpt-6-astra', permissionPreset: 'standard' });
    expect(initialConversationSettings({ recent: { providerId: 'codex', permissionPreset: 'full-access' }, lastAccess: 'standard', fallbackWorkspaceId: 'w' }))
      .toMatchObject({ permissionPreset: 'standard' });
  });

  it('starts a cleared conversation with exactly what it ran with, effort included', () => {
    const cleared = { providerId: 'claude', workspaceId: 'cleared', model: 'claude-opus-5-5', permissionPreset: 'plan' as const, reasoningEffort: 'high' };
    expect(initialConversationSettings({ seed: cleared, recent: { providerId: 'codex', permissionPreset: 'standard' }, fallbackWorkspaceId: 'w' }))
      .toEqual(cleared);
  });
});
