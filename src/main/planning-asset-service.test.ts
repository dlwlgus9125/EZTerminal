import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanningService } from './planning-service';
import { PlanningAssetService } from './planning-asset-service';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z+1kAAAAASUVORK5CYII=';
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ezt-scene-assets-')); directories.push(root);
  const resolveProjectRoot = (id: string) => id === 'project' ? root : null;
  const planning = new PlanningService({ resolveProjectRoot });
  const service = new PlanningAssetService({ planning, resolveProjectRoot });
  const stage = () => service.request({ type: 'stage', projectId: 'project', assetId: 'logo', title: 'Logo', mimeType: 'image/png', dataBase64 });
  return { root, planning, service, stage };
}
describe('planning asset binary storage', () => {
  it('resolves equal asset IDs only inside the explicitly selected subproject', async () => {
    const f = await fixture(); const service = new PlanningAssetService({ planning: f.planning, resolveProjectRoot: () => f.root, ownsSubproject: async (_project, owner) => ['a', 'b'].includes(owner) });
    const staged = await service.request({ type: 'stage', projectId: 'project', subprojectId: 'a', assetId: 'logo', title: 'A logo', mimeType: 'image/png', dataBase64 });
    if (!staged.ok) throw new Error(staged.message);
    await f.planning.execute({ type: 'planning.patch', projectId: 'project', subprojectId: 'a', commandId: 'a-logo', expectedRevision: 0, actor: { kind: 'user', id: 'u' }, payload: { operations: [{ op: 'asset.put', value: staged.asset }], summary: 'A only' } });
    expect(await service.request({ type: 'read', projectId: 'project', subprojectId: 'a', assetId: 'logo' })).toMatchObject({ ok: true });
    expect(await service.request({ type: 'read', projectId: 'project', subprojectId: 'b', assetId: 'logo' })).toMatchObject({ ok: false });
    expect(await service.request({ type: 'read', projectId: 'project', subprojectId: 'foreign', assetId: 'logo' })).toMatchObject({ ok: false });
  });
  it('stages idempotent bytes without changing planning; reads only after explicit metadata apply', async () => {
    const f = await fixture(); const staged = await f.stage(); expect(staged.ok).toBe(true); if (!staged.ok) throw new Error(staged.message);
    expect(await f.stage()).toEqual(staged);
    expect(await f.service.request({ type: 'read', projectId: 'project', assetId: 'logo' })).toMatchObject({ ok: false });
    const read = await f.planning.read('project'); expect(read.ok && read.snapshot.revision).toBe(0);
    expect(await f.planning.execute({ type: 'planning.patch', projectId: 'project', commandId: 'save-logo', expectedRevision: 0, actor: { kind: 'user', id: 'desktop-user' }, payload: { operations: [{ op: 'asset.put', value: staged.asset }], summary: 'Save asset' } })).toMatchObject({ ok: true });
    expect(await f.service.request({ type: 'read', projectId: 'project', assetId: 'logo' })).toMatchObject({ ok: true, dataBase64 });
    await fs.writeFile(path.join(f.root, staged.asset.relativePath), Buffer.from(dataBase64, 'base64').fill(0));
    expect(await f.service.request({ type: 'read', projectId: 'project', assetId: 'logo' })).toMatchObject({ ok: false, message: expect.stringMatching(/changed/u) });
  });
  it('refuses executable/SVG, mismatched signatures, malformed encoding, oversized data, and unknown projects', async () => {
    const f = await fixture(); const request = { type: 'stage', projectId: 'project', assetId: 'logo', title: 'Logo', mimeType: 'image/png', dataBase64 };
    for (const patch of [{ mimeType: 'image/svg+xml' }, { dataBase64: Buffer.from('<script/>').toString('base64') }, { dataBase64: `${dataBase64}!` }, { dataBase64: Buffer.alloc(512 * 1024 + 1).toString('base64') }, { projectId: 'foreign' }]) {
      expect(await f.service.request({ ...request, ...patch })).toMatchObject({ ok: false });
    }
  });
  it('rejects a junction replacing the managed asset directory', async () => {
    const f = await fixture(); const external = await fs.mkdtemp(path.join(os.tmpdir(), 'ezt-foreign-assets-')); directories.push(external);
    await fs.mkdir(path.join(f.root, '.ezterminal', 'planning'), { recursive: true });
    await fs.symlink(external, path.join(f.root, '.ezterminal', 'planning', 'assets'), 'junction');
    expect(await f.stage()).toMatchObject({ ok: false, message: expect.stringMatching(/links/u) });
    expect(await fs.readdir(external)).toEqual([]);
  });
});
