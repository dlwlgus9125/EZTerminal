import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkflowDraftStore } from './workflow-draft-store';
import { createWorkflowGraph } from '../shared/workflow';
const roots: string[] = [];
afterEach(async () => { for (const directory of roots.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
it('encrypts incomplete graphs, creation drafts and exact pending commands with CAS and host isolation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-recovery-')); roots.push(directory);
  const key = randomBytes(32);
  const options = { directory, hostId: 'host', windowsAcl: async () => undefined, resolveProject: (id: string) => id === 'project', protector: {
    available: () => true,
    encrypt: (plain: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt: (bytes: Buffer) => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); },
  } };
  const store = new WorkflowDraftStore(options); const graph = createWorkflowGraph('research', 'sub'); graph.nodes[0].title = ''; graph.nodes[0].acceptance = ['']; graph.nodes[0].document = 'Private unfinished document';
  const pendingCommand = { commandId: 'exact', projectId: 'project', hostId: 'host', expectedRevision: 0, type: 'subproject.create', payload: { id: 'sub', title: 'Reviewed title', goal: '', presetId: 'research' } };
  const state = { projectId: 'project', hostId: 'host', drafts: { sub: { baseRevision: 0, graph } }, pendingCommand, creation: { id: 'preview', title: '', goal: 'private', preset: 'research', mode: 'conversation', graph }, view: { page: 'stage', subprojectId: 'sub', nodeId: graph.nodes[0].id, scrollTop: 123 } };
  const saved = await store.write('project', { expectedRevision: 0, state }); expect(saved).toMatchObject({ ok: true, snapshot: { revision: 1 } });
  expect(await new WorkflowDraftStore(options).read('project')).toEqual(saved);
  expect(await store.write('project', { expectedRevision: 0, state })).toMatchObject({ ok: false, error: 'stale' });
  expect(await store.write('project', { expectedRevision: 1, state: { ...state, hostId: 'other' } })).toMatchObject({ ok: false });
  expect(await new WorkflowDraftStore({ ...options, hostId: 'other' }).read('project')).toMatchObject({ ok: true, snapshot: { state: null } });
  const file = path.join(directory, (await fs.readdir(directory)).find(name => name.endsWith('.bin'))!); const bytes = await fs.readFile(file, 'utf8'); expect(bytes).not.toContain('Private unfinished');
  await fs.writeFile(file, 'corrupt'); expect(await store.read('project')).toMatchObject({ ok: false, error: 'corrupt' }); expect(await fs.readFile(file, 'utf8')).toBe('corrupt');
});
it('keeps an older build\'s recovery file for that build and moves this version\'s saves to v2', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-recovery-v2-')); roots.push(directory);
  const key = randomBytes(32);
  const options = { directory, hostId: 'host', windowsAcl: async () => undefined, resolveProject: (id: string) => id === 'project', protector: {
    available: () => true,
    encrypt: (plain: string) => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(plain), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decrypt: (bytes: Buffer) => { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'); },
  } };
  const graph = createWorkflowGraph('research', 'sub');
  const state = { projectId: 'project', hostId: 'host', drafts: { sub: { baseRevision: 0, graph } }, pendingCommand: null };
  // An older build saved recovery as <id>.bin.
  expect(await new WorkflowDraftStore(options).write('project', { expectedRevision: 0, state })).toMatchObject({ ok: true, snapshot: { revision: 1 } });
  const [written] = await fs.readdir(directory); expect(written).toMatch(/\.v2\.bin$/u);
  const legacy = path.join(directory, written!.replace(/\.v2\.bin$/u, '.bin')); await fs.rename(path.join(directory, written!), legacy);
  const legacyBytes = await fs.readFile(legacy);
  // This version reads it, then saves to v2 and leaves the older file as it was.
  const store = new WorkflowDraftStore(options);
  expect(await store.read('project')).toMatchObject({ ok: true, snapshot: { revision: 1, state: { drafts: { sub: { baseRevision: 0 } } } } });
  expect(await store.write('project', { expectedRevision: 1, state: { ...state, drafts: {} } })).toMatchObject({ ok: true, snapshot: { revision: 2 } });
  expect((await fs.readdir(directory)).sort()).toEqual([path.basename(legacy), written].sort());
  expect(await fs.readFile(legacy)).toEqual(legacyBytes);
  expect(await new WorkflowDraftStore(options).read('project')).toMatchObject({ ok: true, snapshot: { revision: 2, state: { drafts: {} } } });
  // A damaged v2 file is reported and kept; the older file never silently comes back in its place.
  await fs.writeFile(path.join(directory, written!), 'corrupt');
  expect(await new WorkflowDraftStore(options).read('project')).toMatchObject({ ok: false, error: 'corrupt' });
  expect(await fs.readFile(legacy)).toEqual(legacyBytes);
});
