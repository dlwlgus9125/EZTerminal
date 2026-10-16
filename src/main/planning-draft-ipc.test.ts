import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningDraftResult } from '../shared/planning-draft';
import { installPlanningDraftIpc } from './planning-draft-ipc';
import type { FeatureIpc } from './ipc-registration';
import { LocalMutationIngress } from './local-mutation-ingress';

function fixture(ready = Promise.resolve<unknown>(undefined)) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: vi.fn((name, handler) => handlers.set(name, handler)), removeHandler: vi.fn((name) => handlers.delete(name)), on: vi.fn(), removeListener: vi.fn() } as FeatureIpc;
  const value: PlanningDraftResult = { ok: true, snapshot: { version: 1, projectId: 'project', revision: 0, state: null, updatedAt: null } };
  const store = { read: vi.fn(async () => value), write: vi.fn(async () => value) };
  const principal = vi.fn((_event: IpcMainInvokeEvent, id: unknown) => id === 'known' ? 'desktop-user' : null);
  const ingress = new LocalMutationIngress('planning-draft-test');
  const dispose = installPlanningDraftIpc({ ipc, store, ready, ingress, resolvePrincipal: principal });
  const invoke = (channel: 'read' | 'write', id = 'known') => handlers.get(`planning-draft:${channel}`)!({}, id, 'project', { expectedRevision: 0 });
  return { store, ingress, dispose, handlers, principal, invoke };
}

describe('planning recovery IPC authority', () => {
  it('rejects unregistered surfaces and removes both registrations on disposal', async () => {
    const { store, invoke, dispose, handlers } = fixture();
    expect(await invoke('read', 'spoofed')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await invoke('write', 'spoofed')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(store.read).not.toHaveBeenCalled(); expect(store.write).not.toHaveBeenCalled();
    dispose(); expect(handlers.size).toBe(0);
  });
  it('rechecks the authenticated window after host initialization', async () => {
    let release!: () => void;
    const { invoke, principal, store } = fixture(new Promise((resolve) => { release = () => resolve(undefined); }));
    const pending = invoke('write'); principal.mockReturnValue(null); release();
    expect(await pending).toMatchObject({ ok: false, error: 'forbidden' });
    expect(store.write).not.toHaveBeenCalled();
  });
  it('prevents new saves after shutdown admission closes', async () => {
    const { invoke, store, ingress } = fixture(); await ingress.closeAndDrain();
    expect(await invoke('write')).toMatchObject({ ok: false, error: 'unavailable' });
    expect(store.write).not.toHaveBeenCalled();
  });
});
