import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanningWorkspaceDraftSchema, type PlanningWorkspaceDraft } from '../shared/planning-draft';
import { PlanningCommandSchema } from '../shared/planning';
import { PlanningDraftStore, type PlanningDraftStoreOptions } from './planning-draft-store';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const draft = (): PlanningWorkspaceDraft => ({ version: 1, projectId: 'project', snapshot: null, selectedId: 'item',
  edits: { item: { item: { id: 'item', revision: 0, title: '', kind: 'requirement', body: 'Private unsaved idea', status: 'draft', acceptance: [] }, acceptanceText: 'Secret acceptance', dirty: true } }, uncertain: null });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-plan-recovery-')); roots.push(directory);
  const key = randomBytes(32);
  const options: PlanningDraftStoreOptions = { directory, windowsAcl: async () => undefined, resolveProject: (id) => id === 'project',
    protector: {
      available: vi.fn(() => true),
      encrypt: (text) => {
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
      },
      decrypt: (bytes) => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); },
    },
  };
  return { directory, options, store: new PlanningDraftStore(options) };
}

describe('encrypted planning recovery store', () => {
  it('keeps equal entity IDs and pending edits isolated between two subprojects', async () => {
    const f = await fixture(); const store = new PlanningDraftStore({ ...f.options, resolveSubproject: (_project, owner) => ['a', 'b'].includes(owner) });
    const a = { ...draft(), subprojectId: 'a' }; const b = { ...draft(), subprojectId: 'b' }; b.edits.item!.item.body = 'Other subproject';
    expect(await store.write('project', { expectedRevision: 0, state: a }, 'a')).toMatchObject({ ok: true });
    expect(await store.write('project', { expectedRevision: 0, state: b }, 'b')).toMatchObject({ ok: true });
    expect(await store.read('project', 'a')).toMatchObject({ ok: true, snapshot: { state: { edits: { item: { item: { body: 'Private unsaved idea' } } } } } });
    expect(await store.read('project', 'b')).toMatchObject({ ok: true, snapshot: { state: { edits: { item: { item: { body: 'Other subproject' } } } } } });
    expect(await store.write('project', { expectedRevision: 1, state: a }, 'b')).toMatchObject({ ok: false });
    expect(await store.read('project')).toMatchObject({ ok: true, snapshot: { state: null } });
  });
  it('returns null for older projects, then round-trips encrypted incomplete edits after restart', async () => {
    const { store, directory, options } = await fixture();
    expect(await store.read('project')).toMatchObject({ ok: true, snapshot: { revision: 0, state: null } });
    const saved = await store.write('project', { expectedRevision: 0, state: draft() });
    expect(saved).toMatchObject({ ok: true, snapshot: { revision: 1, state: { entityDrafts: { tasks: {}, profiles: {}, scenes: {}, components: {} } } } });
    expect(await new PlanningDraftStore(options).read('project')).toEqual(saved);
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    const bytes = await fs.readFile(path.join(directory, names[0]!), 'utf8');
    expect(bytes).not.toContain('Private unsaved idea');
    expect(bytes).not.toContain('Secret acceptance');
  });

  it('persists the exact uncertain command without executing it', async () => {
    const { store, options } = await fixture();
    const state: PlanningWorkspaceDraft = { ...draft(), uncertain: {
      commandId: 'original-command', projectId: 'project', expectedRevision: 3, actor: { kind: 'user', id: 'desktop-user' },
      type: 'planning.patch', payload: { summary: 'New feature', operations: [{ op: 'item.put', value: { ...draft().edits.item!.item, title: 'Valid title' } }] },
    } };
    expect(await store.write('project', { expectedRevision: 0, state })).toMatchObject({ ok: true });
    expect(await new PlanningDraftStore(options).read('project')).toMatchObject({ ok: true, snapshot: { state: { uncertain: state.uncertain } } });
  });

  it('serializes concurrent window writes and rejects stale recovery revisions', async () => {
    const { store } = await fixture();
    const results = await Promise.all([store.write('project', { expectedRevision: 0, state: draft() }), store.write('project', { expectedRevision: 0, state: { ...draft(), selectedId: null } })]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, error: 'stale', revision: 1 });
    expect(await store.read('project')).toMatchObject({ ok: true, snapshot: { state: { selectedId: 'item' } } });
  });

  it('rejects unauthorized roots, cross-project data and extra credential fields', async () => {
    const { store, directory } = await fixture();
    expect(await store.read('../outside')).toMatchObject({ ok: false, error: 'invalid' });
    expect(await store.read('unknown')).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await store.write('project', { expectedRevision: 0, state: { ...draft(), projectId: 'other' } })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await store.write('project', { expectedRevision: 0, state: { ...draft(), token: 'secret' } })).toMatchObject({ ok: false, error: 'invalid' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('preserves the previous file when encryption or atomic replacement fails', async () => {
    const { store, directory, options } = await fixture();
    await store.write('project', { expectedRevision: 0, state: draft() });
    const file = path.join(directory, (await fs.readdir(directory))[0]!); const original = await fs.readFile(file);
    vi.mocked(options.protector.available).mockReturnValue(false);
    expect(await store.write('project', { expectedRevision: 1, state: draft() })).toMatchObject({ ok: false, error: 'unavailable' });
    vi.mocked(options.protector.available).mockReturnValue(true);
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk failure'));
    expect(await store.write('project', { expectedRevision: 1, state: draft() })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await fs.readFile(file)).toEqual(original);
  });

  it('preserves corrupt ciphertext and refuses to replace it with an empty draft', async () => {
    const { store, directory } = await fixture();
    await store.write('project', { expectedRevision: 0, state: draft() });
    const file = path.join(directory, (await fs.readdir(directory))[0]!);
    await fs.writeFile(file, '{broken');
    expect(await store.read('project')).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await store.write('project', { expectedRevision: 1, state: draft() })).toMatchObject({ ok: false, error: 'corrupt' });
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
  });

  it('accepts incomplete task editor rows for recovery while authoritative commands reject them', () => {
    const task = { id: 'task', revision: 0, title: '', objective: '', featureIds: [], screenIds: [], inputRefs: [], dependencyIds: [], allowedPaths: ['', '../typing'], interfaceRefs: [],
      acceptance: [{ id: 'acceptance', description: '' }], validationPlan: [{ id: 'validation', acceptanceIds: ['acceptance'], description: '', method: 'inspection', environment: '' }], status: 'draft' };
    const parsed = PlanningWorkspaceDraftSchema.parse({ ...draft(), entityDrafts: { tasks: { task: { value: task, dirty: true } }, profiles: {}, scenes: {}, components: {} } });
    expect(parsed.entityDrafts.tasks.task!.value).toEqual(task);
    expect(PlanningCommandSchema.safeParse({ commandId: 'change', projectId: 'project', expectedRevision: 0, actor: { kind: 'user', id: 'desktop-user' }, type: 'planning.patch', payload: { summary: 'Invalid task', operations: [{ op: 'task.put', value: task }] } }).success).toBe(false);
  });
});
