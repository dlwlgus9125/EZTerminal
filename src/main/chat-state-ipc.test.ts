import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { ChatStateResult } from '../shared/chat-state';
import { installChatStateIpc } from './chat-state-ipc';
import type { FeatureIpc } from './ipc-registration';
import { LocalMutationIngress } from './local-mutation-ingress';

function fixture(ready = Promise.resolve<unknown>(undefined)) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((name, handler) => handlers.set(name, handler)),
    removeHandler: vi.fn((name) => handlers.delete(name)), on: vi.fn(), removeListener: vi.fn(),
  } as FeatureIpc;
  const success: ChatStateResult = { ok: true, snapshot: { version: 1, scope: { projectId: 'p', sessionId: 's' }, revision: 0, state: { draft: { text: '' } }, updatedAt: null } };
  const store = { read: vi.fn(async (): Promise<ChatStateResult> => success), write: vi.fn(async (): Promise<ChatStateResult> => success) };
  const resolvePrincipal = vi.fn((_event: IpcMainInvokeEvent, clientId: unknown) => clientId === 'trusted' ? 'desktop-user' : null);
  const ingress = new LocalMutationIngress('chat-test');
  const dispose = installChatStateIpc({ ipc, store, resolvePrincipal, ready, ingress });
  const invoke = (channel: string, clientId = 'trusted') => handlers.get(channel)!({}, clientId, { projectId: 'p', sessionId: 's' }, { expectedRevision: 0, state: { draft: { text: 'draft' } } });
  return { store, resolvePrincipal, ingress, dispose, handlers, invoke };
}

describe('authenticated chat recovery IPC', () => {
  it('rejects unregistered windows without reading or saving recovery data', async () => {
    const { invoke, store } = fixture();
    expect(await invoke('chat-state:read', 'spoofed')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await invoke('chat-state:write', 'spoofed')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(store.read).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });
  it('rechecks surface authorization after waiting for host readiness', async () => {
    let release!: () => void;
    const { invoke, store, resolvePrincipal } = fixture(new Promise((resolve) => { release = () => resolve(undefined); }));
    const pending = invoke('chat-state:write');
    resolvePrincipal.mockReturnValue(null);
    release();
    expect(await pending).toMatchObject({ ok: false, error: 'forbidden' });
    expect(store.write).not.toHaveBeenCalled();
  });
  it('closes mutation admission on shutdown and unregisters both channels', async () => {
    const { invoke, store, ingress, dispose, handlers } = fixture();
    await ingress.closeAndDrain();
    expect(await invoke('chat-state:write')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(store.write).not.toHaveBeenCalled();
    dispose();
    expect(handlers.size).toBe(0);
  });
  it('drains an admitted disk save before shutdown completes', async () => {
    const { invoke, store, ingress } = fixture();
    let release!: () => void;
    store.write.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: false, error: 'unavailable', message: 'test' }); }));
    const pending = invoke('chat-state:write');
    await vi.waitFor(() => expect(store.write).toHaveBeenCalledOnce());
    let drained = false;
    const drain = ingress.closeAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await pending;
    await drain;
    expect(drained).toBe(true);
  });
});
