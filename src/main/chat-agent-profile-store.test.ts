import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ChatAgentProfileStore, installChatAgentProfileIpc } from './chat-agent-profile-store';

const makeDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'ez-chat-agent-profiles-'));
const reviewer = { id: 'reviewer', name: 'Careful reviewer', providerId: 'claude', model: 'opus', reasoningEffort: 'high', permissionPreset: 'plan' as const, whenToUse: 'Review without editing.' };

describe('ChatAgentProfileStore', () => {
  it('saves, replaces in place and removes profiles, and keeps them across restarts', async () => {
    const dir = makeDir();
    const store = new ChatAgentProfileStore(dir);
    await store.init();
    expect(store.list()).toEqual([]);
    await store.save(reviewer);
    await store.save({ id: 'builder', name: 'Builder', providerId: 'codex', permissionPreset: 'standard' });
    expect(await store.save({ ...reviewer, name: 'Strict reviewer' })).toMatchObject({ ok: true });
    expect(store.list().map((profile) => profile.name)).toEqual(['Strict reviewer', 'Builder']);

    const reloaded = new ChatAgentProfileStore(dir);
    await reloaded.init();
    expect(reloaded.list()).toEqual(store.list());
    expect(await reloaded.remove('builder')).toEqual({ ok: true, profiles: [expect.objectContaining({ id: 'reviewer' })] });
  });

  it('refuses incomplete profiles and more than 50', async () => {
    const store = new ChatAgentProfileStore(makeDir());
    await store.init();
    expect(await store.save({ id: 'x', name: '', providerId: 'codex', permissionPreset: 'standard' })).toMatchObject({ ok: false });
    expect(await store.save({ ...reviewer, permissionPreset: 'root' })).toMatchObject({ ok: false });
    for (let index = 0; index < 50; index += 1) await store.save({ ...reviewer, id: `p${index}` });
    expect(await store.save({ ...reviewer, id: 'one-more' })).toMatchObject({ ok: false });
    expect(store.list()).toHaveLength(50);
  });

  it('starts empty from a damaged file instead of failing', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'chat-agent-profiles.json'), '{"version":1,"profiles":[{"id":1}]}');
    const store = new ChatAgentProfileStore(dir);
    await store.init();
    expect(store.list()).toEqual([]);
  });

  it('answers the renderer after the store is ready and removes its handlers', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); }), removeHandler: vi.fn((name: string) => { handlers.delete(name); }) };
    const store = new ChatAgentProfileStore(makeDir());
    const dispose = installChatAgentProfileIpc({ ipc: ipc as never, store, ready: store.init(), authorized: (_event, clientId) => clientId === 'surface-1' });
    // Only an EZTerminal window's own surface: another sender changes and reads nothing.
    expect(await handlers.get('chat-agent-profiles:save')!({}, 'other', reviewer)).toMatchObject({ ok: false });
    expect(await handlers.get('chat-agent-profiles:save')!({}, 'surface-1', reviewer)).toMatchObject({ ok: true });
    expect(await handlers.get('chat-agent-profiles:list')!({}, 'other')).toEqual([]);
    expect(await handlers.get('chat-agent-profiles:list')!({}, 'surface-1')).toEqual([reviewer]);
    expect(await handlers.get('chat-agent-profiles:remove')!({}, 'surface-1', 'reviewer')).toEqual({ ok: true, profiles: [] });
    expect(await handlers.get('chat-agent-profiles:phases')!({}, 'surface-1')).toEqual({ byProvider: {}, switchModel: false });
    expect(await handlers.get('chat-agent-profiles:save-phases')!({}, 'other', { byProvider: {}, switchModel: true })).toMatchObject({ ok: false });
    expect(await handlers.get('chat-agent-profiles:save-phases')!({}, 'surface-1', { byProvider: { claude: { plan: { profileId: 'reviewer' } } }, switchModel: false })).toMatchObject({ ok: true });
    dispose();
    expect(handlers.size).toBe(0);
  });

  it('keeps 단계 연결 in its own file and links only an agent of the conversation AI', async () => {
    const dir = makeDir();
    const store = new ChatAgentProfileStore(dir);
    await store.init();
    await store.save(reviewer);
    await store.save({ id: 'builder', name: 'Builder', providerId: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium', permissionPreset: 'standard' });
    const phases = { byProvider: { codex: { implement: { profileId: 'builder' } }, claude: { plan: { profileId: 'reviewer' }, implement: { profileId: 'builder' } } }, switchModel: false };
    expect(await store.savePhases(phases)).toEqual({ ok: true, phases });
    expect(store.phaseSettings('codex', 'implement')).toEqual({ reasoningEffort: 'medium' });
    // A Claude conversation cannot switch to a Codex agent.
    expect(store.phaseSettings('claude', 'implement')).toBeUndefined();
    expect(store.phaseSettings('claude', 'plan')).toEqual({ reasoningEffort: 'high' });
    await store.savePhases({ ...phases, switchModel: true });
    expect(store.phaseSettings('codex', 'implement')).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'medium' });
    // A deleted agent is no link.
    await store.remove('builder');
    expect(store.phaseSettings('codex', 'implement')).toBeUndefined();
    const reloaded = new ChatAgentProfileStore(dir);
    await reloaded.init();
    expect(reloaded.phases()).toEqual({ ...phases, switchModel: true });
    expect(await reloaded.savePhases({ byProvider: { codex: { implement: { profileId: '' } } }, switchModel: false })).toMatchObject({ ok: false });
  });
});
