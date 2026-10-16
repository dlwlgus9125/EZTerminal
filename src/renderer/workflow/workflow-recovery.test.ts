import { describe, expect, it } from 'vitest';
import { WorkflowRecovery } from './workflow-recovery';
import type { WorkflowDraftAccess, WorkflowDraftState } from '../../shared/workflow-draft';

const state: WorkflowDraftState = { projectId: 'project', hostId: 'host-a', drafts: {}, pendingCommand: null };
describe('workflow recovery queue', () => {
  it('blocks subsequent saves after an uncertain write until an explicit authoritative reread', async () => {
    let revision = 0; let loseReceipt = true; const expected: number[] = [];
    const access: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: 'project', revision, state } }), workflowDraftWrite: async (_, request) => {
      expected.push(request.expectedRevision); revision++; if (loseReceipt) { loseReceipt = false; throw new Error('lost receipt'); }
      return { ok: true, snapshot: { projectId: 'project', revision, state: request.state } };
    } };
    const recovery = new WorkflowRecovery('project', 'host-a', access); await recovery.read();
    await expect(recovery.write(state)).rejects.toThrow('lost receipt');
    await expect(recovery.write(state)).rejects.toThrow('Read secure workflow recovery'); expect(expected).toEqual([0]);
    await recovery.read(); await recovery.write(state); expect(expected).toEqual([0, 1]);
  });
  it('does not accept a stored pending operation belonging to another host', async () => {
    const access: WorkflowDraftAccess = { workflowDraftRead: async () => ({ ok: true, snapshot: { projectId: 'project', revision: 1, state } }), workflowDraftWrite: async () => { throw new Error('must not write'); } };
    await expect(new WorkflowRecovery('project', 'host-b', access).read()).rejects.toThrow('another PC');
  });
});
