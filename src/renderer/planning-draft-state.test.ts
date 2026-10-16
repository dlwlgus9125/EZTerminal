// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanningWorkspaceDraftSchema, type PlanningDraftResult, type PlanningDraftWrite, type PlanningWorkspaceDraft } from '../shared/planning-draft';
import { desktopPlanningDraftStorage } from './planning-draft-state';

const draft: PlanningWorkspaceDraft = { version: 1, projectId: 'project', snapshot: null, selectedId: null, edits: {}, uncertain: null };
afterEach(() => { Object.defineProperty(window, 'ezterminal', { configurable: true, value: undefined }); vi.restoreAllMocks(); });
function fixture() {
  const read = vi.fn(async (): Promise<PlanningDraftResult> => ({ ok: true, snapshot: { version: 1, projectId: 'project', revision: 3, state: null, updatedAt: null } }));
  const write = vi.fn(async (projectId: string, request: PlanningDraftWrite): Promise<PlanningDraftResult> => ({ ok: true, snapshot: { version: 1, projectId, revision: request.expectedRevision + 1, state: PlanningWorkspaceDraftSchema.parse(request.state), updatedAt: null } }));
  Object.defineProperty(window, 'ezterminal', { configurable: true, value: { planningDraftRead: read, planningDraftWrite: write } });
  return { read, write, storage: desktopPlanningDraftStorage('project') };
}
describe('desktop planning recovery adapter', () => {
  it('reads and writes host encrypted recovery using compare-and-swap without browser storage', async () => {
    const { storage, write } = fixture();
    const localRead = vi.spyOn(Storage.prototype, 'getItem'); const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    expect(await storage.loadDraft()).toBeNull();
    await storage.saveDraft(draft); await storage.saveDraft(draft);
    expect(write.mock.calls.map((call) => call[1].expectedRevision)).toEqual([3, 4]);
    expect(localRead).not.toHaveBeenCalled(); expect(localWrite).not.toHaveBeenCalled();
  });
  it('locks subsequent autosaves after a conflict until an explicit recovery read', async () => {
    const { storage, write } = fixture();
    await storage.loadDraft();
    write.mockResolvedValueOnce({ ok: false, error: 'stale', message: 'Another window changed this draft' });
    await expect(storage.saveDraft(draft)).rejects.toThrow('Another window');
    await expect(storage.saveDraft(draft)).rejects.toThrow('Read stored');
    expect(write).toHaveBeenCalledOnce();
    await storage.loadDraft(); await storage.saveDraft(draft);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('requires a successful read and rejects project-crossing drafts', async () => {
    const { storage, write } = fixture();
    await expect(storage.saveDraft(draft)).rejects.toThrow('Read stored');
    await storage.loadDraft();
    await expect(storage.saveDraft({ ...draft, projectId: 'other' })).rejects.toThrow('project mismatch');
    expect(write).not.toHaveBeenCalled();
  });
});
