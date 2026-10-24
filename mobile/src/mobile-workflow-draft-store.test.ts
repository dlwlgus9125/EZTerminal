import { describe, expect, it, vi } from 'vitest';
import { mobileWorkflowDraftAccess } from './mobile-workflow-draft-store';
import type { SecureStorageLike } from './mobile-agent-create-recovery-store';
import type { WorkflowDraftState } from '../../src/shared/workflow-draft';

function fixture() {
  const values = new Map<string, string>();
  const secure: SecureStorageLike = {
    getPlatform: async () => ({ value: 'android' }), keys: async () => ({ value: [...values.keys()] }),
    get: async ({ key }) => ({ value: values.get(key)! }),
    set: vi.fn(async ({ key, value }) => { values.set(key, value); return { value: true }; }),
    remove: async ({ key }) => ({ value: values.delete(key) }),
  };
  let token = 'authority-a';
  const access = mobileWorkflowDraftAccess(async () => token, secure);
  const state: WorkflowDraftState = { projectId: 'project', hostId: 'host-a', drafts: {}, pendingCommand: null };
  return { access, secure, values, state, token: (value: string) => { token = value; }, getToken: async () => token };
}
describe('encrypted mobile workflow recovery', () => {
  it('keeps an older app v1 recovery for that app and moves saves of this version to the v2 key', async () => {
    const f = fixture();
    expect(await f.access.workflowDraftWrite('project', { expectedRevision: 0, state: f.state })).toMatchObject({ ok: true, snapshot: { revision: 1 } });
    const [v2Key] = [...f.values.keys()]; expect(v2Key).toMatch(/^ezterminal-workflow-draft-v2:/u);
    // Pretend an older app saved it: same record under its v1 key, with its own scope.
    const v1Key = v2Key!.replace('-v2:', '-v1:'); const stored = JSON.parse(f.values.get(v2Key!)!) as { scope: string };
    f.values.delete(v2Key!); f.values.set(v1Key, JSON.stringify({ ...stored, scope: v1Key })); const v1Value = f.values.get(v1Key);
    expect(await f.access.workflowDraftRead('project')).toMatchObject({ ok: true, snapshot: { revision: 1 } });
    expect(await f.access.workflowDraftWrite('project', { expectedRevision: 1, state: { ...f.state, drafts: {} } })).toMatchObject({ ok: true, snapshot: { revision: 2 } });
    expect([...f.values.keys()].sort()).toEqual([v1Key, v2Key].sort());
    expect(f.values.get(v1Key)).toBe(v1Value);
    expect(await f.access.workflowDraftRead('project')).toMatchObject({ ok: true, snapshot: { revision: 2 } });
  });
  it('serializes CAS across access objects sharing the same native storage', async () => {
    const f = fixture(); const other = mobileWorkflowDraftAccess(f.getToken, f.secure);
    const results = await Promise.all([f.access.workflowDraftWrite('project', { expectedRevision: 0, state: f.state }), other.workflowDraftWrite('project', { expectedRevision: 0, state: f.state })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ error: 'stale' });
    expect(f.secure.set).toHaveBeenCalledTimes(1);
  });
  it('does not save authority A state under authority B when the bearer changes during read', async () => {
    const f = fixture();
    f.secure.keys = async () => { f.token('authority-b'); return { value: [] }; };
    expect(await f.access.workflowDraftWrite('project', { expectedRevision: 0, state: f.state })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(f.secure.set).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
  it('fails the receipt after authority changes during native write and keeps it isolated under A', async () => {
    const f = fixture(); const original = f.secure.set;
    f.secure.set = async request => { const result = await original(request); f.token('authority-b'); return result; };
    expect(await f.access.workflowDraftWrite('project', { expectedRevision: 0, state: f.state })).toMatchObject({ ok: false });
    expect(await f.access.workflowDraftRead('project')).toMatchObject({ ok: true, snapshot: { state: null } });
    f.token('authority-a'); expect(await f.access.workflowDraftRead('project')).toMatchObject({ ok: true, snapshot: { revision: 1, state: f.state } });
  });
  it('rejects host changes inside the same authority and preserves the original encrypted record', async () => {
    const f = fixture(); await f.access.workflowDraftWrite('project', { expectedRevision: 0, state: f.state });
    expect(await f.access.workflowDraftWrite('project', { expectedRevision: 1, state: { ...f.state, hostId: 'host-b' } })).toMatchObject({ ok: false });
    expect(await f.access.workflowDraftRead('project')).toMatchObject({ ok: true, snapshot: { state: { hostId: 'host-a' } } });
  });
});
