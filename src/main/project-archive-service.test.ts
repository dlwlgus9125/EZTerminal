import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonStore } from './daemon-store';
import { PlanningExecutionStore } from './planning-execution-store';
import { PlanningService } from './planning-service';
import { ProjectArchiveService } from './project-archive-service';
import { archiveHash, archiveObjectHash, decodeArchiveEntry, parseArchiveJson, redactArchiveValue, verifyArchive } from './project-archive-package';
import { createDaemonCommand } from '../shared/daemon-protocol';
import { WorkflowService } from './workflow-service';

const stores: DaemonStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const NOW = '2026-10-13T00:00:00.000Z';
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ez-archive-'));
  const root = path.join(directory, 'original'); await fs.mkdir(root);
  const assetBytes = Buffer.from('A project-owned text asset'); await fs.writeFile(path.join(root, 'asset.txt'), assetBytes);
  await fs.writeFile(path.join(root, 'keep.txt'), 'Uncommitted user source');
  const userDataDir = path.join(directory, 'data'); const store = new DaemonStore(userDataDir); stores.push(store); await store.init();
  await store.applySystemCommit({ mutations: [
    { kind: 'project.upsert', value: { id: 'P', name: 'Original', rootPath: root, source: 'native' } },
    { kind: 'workspace.upsert', value: { id: 'W', projectId: 'P', name: 'Main', kind: 'local', rootPath: root } },
    { kind: 'session.upsert', value: { id: 'S', projectId: 'P', workspaceId: 'W', kind: 'agent', title: 'Archived conversation', state: 'archived', source: 'structured', archivedAt: NOW } },
    { kind: 'session.upsert', value: { id: 'active', projectId: 'P', workspaceId: 'W', kind: 'agent', title: 'Active conversation', state: 'idle', source: 'structured' } },
  ] });
  await store.appendTranscriptBatch([{ id: 'M', sessionId: 'S', sequence: 1, kind: 'assistant-message', text: 'Useful history; Bearer token-123456789012345', isDelta: false, isSensitive: false, createdAt: NOW }]);
  const planning = new PlanningService({ resolveProjectRoot: id => store.getSnapshot().projects.find(project => project.id === id)?.rootPath });
  const added = await planning.execute({ commandId: 'asset', projectId: 'P', expectedRevision: 0, actor: { kind: 'user', id: 'user' }, type: 'planning.patch',
    payload: { summary: 'Add asset', operations: [
      { op: 'item.put', value: { id: 'requirement', revision: 0, title: 'Preserve records', kind: 'requirement', body: 'Keep complete history', status: 'ready', acceptance: ['History remains accessible'] } },
      { op: 'asset.put', value: { id: 'asset', revision: 0, title: 'Owned text', relativePath: 'asset.txt', hash: archiveHash(assetBytes), mimeType: 'text/plain', byteLength: assetBytes.length } },
    ] } });
  expect(added.ok).toBe(true);
  expect(await planning.execute({ commandId: 'freeze', projectId: 'P', expectedRevision: 1, actor: { kind: 'user', id: 'user' }, type: 'planning.freeze', payload: { baselineId: 'B', title: 'Frozen' } })).toMatchObject({ ok: true });
  const ledger = new PlanningExecutionStore(store);
  const register = vi.fn(async ({ projectId, name, rootPath }: { projectId: string; name: string; rootPath: string }) => {
    const existing = store.getSnapshot().projects.find(project => project.id === projectId);
    if (existing) { if (existing.rootPath !== rootPath) throw new Error('Project collision'); return; }
    await store.applySystemCommit({ mutations: [{ kind: 'project.upsert', value: { id: projectId, name, rootPath, source: 'native' } },
      { kind: 'workspace.upsert', value: { id: `${projectId}-W`, projectId, name: 'Main', kind: 'local', rootPath } }] });
  });
  const options = { userDataDir, store, planning, ledger, registerRestoredProject: register };
  const service = new ProjectArchiveService(options);
  return { directory, root, store, ledger, planning, service, options, register, assetBytes };
}

describe('project archive authority', () => {
  it('inventories legacy planning before the first workflow mutation without creating a registry', async () => {
    const f = await fixture();
    expect(await f.service.inventory('P')).toMatchObject({ projectId: 'P' });
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: id => f.store.getSnapshot().projects.find(project => project.id === id)?.rootPath,
      planning: f.planning, runs: id => f.ledger.read(id).runs, session: () => undefined });
    const service = new ProjectArchiveService({ ...f.options, workflows });
    expect(await service.inventory('P')).toMatchObject({ projectId: 'P', groups: expect.arrayContaining([expect.objectContaining({ kind: 'workflow' })]) });
    await expect(fs.stat(path.join(f.root, '.ezterminal', 'planning', 'workflows.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('round-trips independent subproject documents and graph ownership with historical conversation links', async () => {
    const f = await fixture();
    const workflows = new WorkflowService({ hostId: 'host', resolveProjectRoot: id => f.store.getSnapshot().projects.find(project => project.id === id)?.rootPath,
      planning: f.planning, runs: id => f.ledger.read(id).runs, session: sessionId => sessionId === 'active' ? { projectId: 'P', managed: false } : undefined });
    const user = { kind: 'desktop' as const, id: 'test' }; const common = { projectId: 'P', hostId: 'host' };
    for (const [index, id] of ['one', 'two'].entries()) {
      expect(await workflows.execute({ ...common, expectedRevision: index, commandId: `create-${id}`, type: 'subproject.create', payload: { id, title: id, goal: '', presetId: 'research' } }, user)).toMatchObject({ ok: true });
      expect(await f.planning.execute({ projectId: 'P', subprojectId: id, commandId: `plan-${id}`, expectedRevision: 0, actor: { kind: 'user', id: 'test' }, type: 'planning.patch', payload: { summary: id,
        operations: [{ op: 'item.put', value: { id: 'same-item-id', revision: 0, title: id, body: `${id} private document`, kind: 'requirement', status: 'ready', acceptance: [] } }] } })).toMatchObject({ ok: true });
    }
    await workflows.execute({ ...common, expectedRevision: 0, commandId: 'link', subprojectId: 'one', type: 'session.link', payload: { sessionId: 'active', nodeId: 'one:research', scope: 'stage' } }, user);
    const service = new ProjectArchiveService({ ...f.options, workflows }); const target = path.join(f.directory, 'multi.json');
    await service.exportProject('P', target, 'export-multi');
    const inspected = await service.inspectArchive(target);
    const restored = await service.restoreArchive(inspected.archiveId, 'Restored', f.directory, 'restore-multi');
    const one = await f.planning.read(restored.projectId, 'one'); const two = await f.planning.read(restored.projectId, 'two');
    expect(one).toMatchObject({ ok: true, snapshot: { draft: { items: [{ body: 'one private document' }] } } });
    expect(two).toMatchObject({ ok: true, snapshot: { draft: { items: [{ body: 'two private document' }] } } });
    const registry = await workflows.exportRegistry(restored.projectId);
    expect(registry.subprojects.map(entry => entry.id)).toEqual(['legacy-default', 'one', 'two']); expect(registry.sessionLinks).toEqual([]); expect(registry.historicalSessionLinks?.[0].sessionId).toBe('active');
    const historical = await service.history(restored.projectId); expect(historical?.workflow?.sessionLinks[0].sessionId).toBe('active');
    expect(historical?.subprojectPlanning?.one.draft.items[0].title).toBe('one');
    expect(await service.restoreArchive(inspected.archiveId, 'Restored', f.directory, 'restore-multi')).toEqual(restored);
  });
  it('masks sensitive transcript attachments and credentials encoded inside text attachments without changing the source', () => {
    const source = [{ isSensitive: true, text: 'Sensitive original', context: { attachments: [{ kind: 'image', data: 'original-image' }] } },
      { kind: 'text', data: Buffer.from('api_key=secret-value-123456').toString('base64') }];
    const original = structuredClone(source); const exclusions: { item: string; reason: string }[] = [];
    const cleaned = redactArchiveValue(source, exclusions, 'test') as typeof source;
    expect(cleaned[0].text).toBe('[REDACTED SENSITIVE CONTENT]'); expect(cleaned[0].context).toBeUndefined();
    expect(Buffer.from(cleaned[1].data!, 'base64').toString('utf8')).toContain('[REDACTED]');
    expect(source).toEqual(original); expect(exclusions).toHaveLength(2);
  });

  it('includes owned capture bytes and explicitly reports unresolved capture references', async () => {
    const f = await fixture(); const capturePath = '.ezterminal/captures/verified.png';
    await fs.mkdir(path.dirname(path.join(f.root, capturePath)), { recursive: true });
    const capture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4nQAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(f.root, capturePath), capture);
    const deviceCaptureHash = archiveHash(capture);
    const deviceDirectory = path.join(f.options.userDataDir, 'planning-captures-v1', archiveHash('P'));
    await fs.mkdir(deviceDirectory, { recursive: true });
    await fs.writeFile(path.join(deviceDirectory, `${deviceCaptureHash}.png`), capture);
    await f.store.applySystemCommit({ mutations: [
      { kind: 'provider.upsert', value: { id: 'codex', displayName: 'Codex', protocol: 'codex-app-server', executablePath: 'codex', executableVersion: '1', argv: [], environmentVariableNames: [], capabilities: [], enabled: true, health: 'ready' } },
      { kind: 'agent.upsert', value: { sessionId: 'active', providerId: 'codex', model: 'model', permissionPreset: 'plan', state: 'working', queuedTurnCount: 0, orchestrationEnabled: false } },
    ] });
    const baseline = { baselineId: 'B', revision: 1, fingerprint: 'a'.repeat(64) };
    let sequence = 0;
    const send = (type: string, payload: Record<string, unknown>, kind = 'desktop') => f.ledger.execute({ commandId: `capture-${++sequence}`, projectId: 'P', expectedRevision: f.ledger.read('P').revision, principal: { kind, id: 'test' }, type, payload: { runId: 'R', ...payload } });
    expect(await send('run.prepare', { preparation: { baseline, artifacts: [], teamMode: 'single', progressPolicy: 'checkpoint', tasks: [{ taskId: 'T', taskRevision: 1, stage: 'planning', title: 'Capture', brief: 'Inspect actual capture', dependsOn: [], retryLimit: 2,
      profile: { profileId: 'profile', revision: 1, role: 'planning', providerId: 'codex', model: 'model', prompt: 'Inspect', permissionPreset: 'plan', capabilities: ['read'] },
      acceptance: [{ acceptanceId: 'AC', description: 'Capture available' }], validations: [{ validationId: 'V', acceptanceIds: ['AC'], method: 'device', environment: 'Android device' }],
    }] } })).toMatchObject({ ok: true });
    expect(await send('run.start', {})).toMatchObject({ ok: true });
    await f.store.beginOutbox(createDaemonCommand({ commandId: 'capture-turn', idempotencyKey: 'capture-turn', expectedRevision: f.store.getRevision(), issuedAt: NOW, principal: { kind: 'desktop', id: 'test' }, type: 'agent.submit', payload: { sessionId: 'active', prompt: 'Inspect capture' } }));
    await f.store.commitCommand('capture-turn', { mutations: [{ kind: 'turn.upsert', value: { id: 'turn', sessionId: 'active', commandId: 'capture-turn', state: 'working' } }] });
    expect(await send('attempt.start', { attemptId: 'A', taskId: 'T', dispatchId: 'D', sessionId: 'active', turnId: 'turn' }, 'runtime')).toMatchObject({ ok: true });
    const artifacts = [{ artifactId: 'result', revision: 0 }];
    expect(await send('attempt.finish', { attemptId: 'A', outcome: 'succeeded', artifacts, summary: 'Captured' }, 'runtime')).toMatchObject({ ok: true });
    expect(await send('evidence.record', { attemptId: 'A', evidenceId: 'E', validationId: 'V', acceptanceIds: ['AC'], environment: 'Android device', logRefs: [], captureRefs: [capturePath, `capture:${deviceCaptureHash}`, 'unavailable-capture'], kind: 'preview', status: 'passed', baseline, artifacts, summary: 'Actual capture from test fixture' }, 'runtime')).toMatchObject({ ok: true });
    const target = path.join(f.directory, 'captures.json'); const manifest = await f.service.exportProject('P', target, 'capture-export');
    const archive = verifyArchive(await fs.readFile(target));
    expect(decodeArchiveEntry(archive.entries.find(entry => entry.kind === 'capture')!)).toEqual(capture);
    expect(decodeArchiveEntry(archive.entries.find(entry => entry.metadata?.reference === `capture:${deviceCaptureHash}`)!)).toEqual(capture);
    expect(manifest.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ item: 'capture:unavailable-capture' })]));
  });
  it('round-trips complete history and owned assets into a new project without restoring active authority', async () => {
    const f = await fixture(); const target = path.join(f.directory, 'backup.ezarchive.json');
    const manifest = await f.service.exportProject('P', target, 'export-one');
    expect(manifest.source).toMatchObject({ planningRevision: 2, executionRevision: 0 });
    const bytes = await fs.readFile(target); const archive = verifyArchive(bytes);
    expect(archive.entries.map(entry => entry.kind)).toEqual(expect.arrayContaining(['planning', 'execution', 'daemon', 'transcript', 'asset']));
    const text = archive.entries.filter(entry => entry.kind === 'transcript').map(entry => decodeArchiveEntry(entry).toString('utf8')).join('');
    expect(text).toContain('Useful history'); expect(text).not.toContain('token-123456789012345');
    expect(manifest.exclusions.some(entry => entry.reason.includes('masked'))).toBe(true);
    expect(await f.service.exportProject('P', target, 'export-one')).toEqual(manifest);
    const inspected = await f.service.inspectArchive(target);
    const restored = await f.service.restoreArchive(inspected.archiveId, 'Copy', f.directory, 'restore-one');
    const currentPlanning = await f.planning.read(restored.projectId);
    expect(currentPlanning).toMatchObject({ ok: true, snapshot: { projectId: restored.projectId, revision: 2, baselines: [{ id: 'B' }] } });
    if (!currentPlanning.ok) throw new Error('Missing restored planning');
    expect(await fs.readFile(path.join(restored.rootPath, currentPlanning.snapshot.draft.assets[0].relativePath))).toEqual(f.assetBytes);
    const history = await f.service.history(restored.projectId);
    expect(history!.conversations.find(entry => entry.session.id === 'S')?.transcript[0].text).toContain('Useful history');
    expect(f.ledger.read(restored.projectId).runs).toEqual([]);
    expect(f.store.getSnapshot().sessions.filter(session => session.projectId === restored.projectId)).toEqual([]);
    const restarted = new ProjectArchiveService(f.options);
    expect(await restarted.restoreArchive(inspected.archiveId, 'Copy', f.directory, 'restore-one')).toEqual(restored);
    expect(f.store.getSnapshot().projects.filter(project => project.id === restored.projectId)).toHaveLength(1);
    await expect(restarted.restoreArchive(inspected.archiveId, 'Different', f.directory, 'restore-one')).rejects.toThrow(/different/u);
    expect(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('Uncommitted user source');
    const movedBackup = path.join(f.directory, 'moved-again.json');
    await restarted.exportProject(restored.projectId, movedBackup, 'second-generation');
    const moved = await restarted.inspectArchive(movedBackup);
    const restoredAgain = await restarted.restoreArchive(moved.archiveId, 'Second copy', f.directory, 'restore-second-generation');
    expect((await restarted.history(restoredAgain.projectId))?.conversations.find(entry => entry.session.id === 'S')?.transcript[0].text).toContain('Useful history');
  });

  it('never overwrites another backup and resumes an interrupted export with the same exact package', async () => {
    const f = await fixture(); const target = path.join(f.directory, 'existing.json'); await fs.writeFile(target, 'Existing backup');
    await expect(f.service.exportProject('P', target, 'export-conflict')).rejects.toThrow(/preserved/u);
    expect(await fs.readFile(target, 'utf8')).toBe('Existing backup');
    await expect(f.service.exportProject('P', path.join(f.directory, 'other.json'), 'export-conflict')).rejects.toThrow(/another destination/u);
    const next = path.join(f.directory, 'next.json'); const first = await f.service.exportProject('P', next, 'export-ok');
    const restarted = new ProjectArchiveService(f.options);
    expect(await restarted.exportProject('P', next, 'export-ok')).toEqual(first);
  });

  it('rejects corrupt packages and archive traversal before registering or writing a restored project', async () => {
    const f = await fixture(); const target = path.join(f.directory, 'backup.json'); await f.service.exportProject('P', target, 'export');
    const archive = verifyArchive(await fs.readFile(target));
    const changed = structuredClone(archive); changed.entries[0].content = Buffer.from('{}').toString('base64');
    await fs.writeFile(path.join(f.directory, 'corrupt.json'), JSON.stringify(changed));
    await expect(f.service.inspectArchive(path.join(f.directory, 'corrupt.json'))).rejects.toThrow(/integrity/u);
    const traversal = structuredClone(archive); const asset = traversal.entries.find(entry => entry.kind === 'asset')!; asset.metadata!.relativePath = '../escape.txt';
    traversal.manifest.entries.find(entry => entry.id === asset.id)!.metadata = asset.metadata;
    traversal.manifest.integrity = archiveObjectHash({ ...traversal.manifest, integrity: undefined });
    await fs.writeFile(path.join(f.directory, 'traversal.json'), JSON.stringify(traversal));
    await expect(f.service.inspectArchive(path.join(f.directory, 'traversal.json'))).rejects.toThrow(/escapes/u);
    expect(f.register).not.toHaveBeenCalled();
    const inbox = await f.service.prepareImport('P');
    await expect(f.service.inspectUploaded('P', target)).rejects.toThrow(/inbox/u);
    const uploaded = path.join(inbox, 'uploaded.json'); await fs.copyFile(target, uploaded);
    expect(await f.service.inspectUploaded('P', uploaded)).toMatchObject({ manifest: { projectId: 'P' } });
  });

  it('cleans only selected archived unreferenced transcript rows after an unchanged preview', async () => {
    const f = await fixture(); const inventory = await f.service.inventory('P');
    expect(inventory.conversations.find(entry => entry.sessionId === 'active')?.deletable).toBe(false);
    await expect(f.service.cleanup('P', inventory.token, ['active'])).rejects.toThrow(/protected/u);
    await f.store.appendTranscriptBatch([{ id: 'M2', sessionId: 'S', sequence: 2, kind: 'assistant-message', text: 'New history', isDelta: false, isSensitive: false, createdAt: NOW }]);
    await expect(f.service.cleanup('P', inventory.token, ['S'])).rejects.toThrow(/changed/u);
    const refreshed = await f.service.inventory('P'); const before = f.store.getSnapshot();
    expect(await f.service.cleanup('P', refreshed.token, ['S'])).toBe(2);
    expect(f.store.getTranscript('S')).toEqual([]);
    expect(f.store.getSnapshot().revision).toBe(before.revision + 1);
    expect(f.store.getSnapshot().sessions.find(entry => entry.id === 'S')).toBeDefined();
    expect(await fs.readFile(path.join(f.root, 'keep.txt'), 'utf8')).toBe('Uncommitted user source');
  });

  it('keeps unavailable asset references explicit instead of claiming a complete portable package', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.root, 'asset.txt'), 'Changed asset');
    const target = path.join(f.directory, 'missing-asset.json');
    const manifest = await f.service.exportProject('P', target, 'export');
    expect(manifest.portable).toBe(false);
    expect(manifest.exclusions).toEqual(expect.arrayContaining([expect.objectContaining({ item: 'asset:asset', reason: expect.stringContaining('changed') })]));
    const archive = verifyArchive(await fs.readFile(target));
    expect(archive.entries.some(entry => entry.kind === 'asset')).toBe(false);
    expect(parseArchiveJson(archive.entries.find(entry => entry.kind === 'planning')!)).toMatchObject({ baselines: [{ id: 'B' }] });
    expect(archiveObjectHash({ ...manifest, integrity: undefined })).toBe(manifest.integrity);
  });
});
