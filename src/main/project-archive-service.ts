import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DaemonSession, DaemonTranscriptItem } from '../shared/daemon-protocol';
import { PlanningSnapshotSchema } from '../shared/planning';
import { PlanningExecutionSnapshotSchema } from '../shared/planning-execution';
import { PlanningIntegrationRecordSchema, PlanningResultRecordSchema } from '../shared/planning-result';
import { ARCHIVE_MAX_BYTES, type ArchiveEntry, type ProjectArchiveHistory, type ProjectArchiveInventory, type ProjectArchiveManifest, type ProjectArchivePackage } from '../shared/project-archive';
import { AsyncMutationGate } from './async-mutation-gate';
import { projectIdForRoot } from './agent-project-store';
import type { DaemonStore } from './daemon-store';
import type { PlanningExecutionStore } from './planning-execution-store';
import { PlanningService } from './planning-service';
import { WorkflowService } from './workflow-service';
import { WorkflowRegistrySchema, type WorkflowRegistry } from '../shared/workflow';
import { archiveCanonical, archiveEntry, archiveHash, archiveObjectHash, decodeArchiveEntry, parseArchiveJson, redactArchiveValue, verifyArchive } from './project-archive-package';

const MAX_ITEM_BYTES = 32 * 1024 * 1024;
const excludedPath = /(?:^|[/\\])(?:\.env(?:\..*)?|credentials?[^/\\]*|id_(?:rsa|ed25519|ecdsa)|[^/\\]*\.(?:pem|key|p12|pfx)|node_modules|\.git)(?:$|[/\\])/iu;
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
interface ArchiveIntent { kind: 'export' | 'restore'; fingerprint: string; archiveId: string; destination: string; projectId?: string; name?: string; }
export interface ProjectArchiveServiceOptions {
  readonly userDataDir: string; readonly store: DaemonStore; readonly planning: PlanningService; readonly ledger: PlanningExecutionStore;
  readonly registerRestoredProject: (project: { projectId: string; name: string; rootPath: string }) => Promise<void>;
  readonly onHistoryChanged?: (afterSequence: number) => void;
  readonly knownCredentialValues?: () => readonly string[];
  readonly environmentMetadata?: () => readonly { sessionId: string; [key: string]: unknown }[];
  readonly workflows?: Pick<WorkflowService, 'exportRegistry'>;
}

/** Project records are copied as data, never as live processes, credentials, or runnable approvals. */
export class ProjectArchiveService {
  private readonly gate = new AsyncMutationGate();
  private readonly directory: string;
  constructor(private readonly options: ProjectArchiveServiceOptions) { this.directory = path.join(options.userDataDir, 'project-archives-v1'); }
  private file(kind: string, id: string) { return path.join(this.directory, kind, `${archiveHash(id)}.json`); }
  private async read<T>(kind: string, id: string): Promise<T | null> {
    try { const bytes = await fs.readFile(this.file(kind, id)); if (bytes.length > ARCHIVE_MAX_BYTES) throw new Error('Stored archive exceeds its limit.'); return JSON.parse(bytes.toString('utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async write(kind: string, id: string, value: unknown): Promise<void> {
    const destination = this.file(kind, id); await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`; const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(jsonBytes(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination);
  }
  private project(projectId: string) {
    const project = this.options.store.getSnapshot().projects.find(entry => entry.id === projectId);
    if (!project?.rootPath) throw new Error('The registered project root is unavailable.'); return project;
  }
  private transcripts(sessionId: string): readonly DaemonTranscriptItem[] {
    const items: DaemonTranscriptItem[] = []; let cursor = 0;
    for (let page = 0; page < 2_000; page++) {
      const batch = this.options.store.getTranscript(sessionId, cursor, 500); items.push(...batch);
      if (batch.length < 500) return items; cursor = batch.at(-1)!.sequence;
    }
    throw new Error('A conversation exceeds the one-million item export limit; no partial history was exported.');
  }
  async inventory(projectId: string): Promise<ProjectArchiveInventory> {
    const snapshot = this.options.store.getSnapshot(); this.project(projectId);
    const execution = this.options.ledger.read(projectId); const planning = await this.options.planning.read(projectId);
    if (!planning.ok) throw new Error(planning.message);
    const references = new Set(execution.runs.flatMap(run => run.attempts.flatMap(attempt => [attempt.sessionId, ...run.reviews.map(review => review.reviewerSessionId)])));
    const workflow = await this.options.workflows?.exportRegistry(projectId);
    for (const link of workflow?.sessionLinks ?? []) references.add(link.sessionId);
    const conversations = snapshot.sessions.filter(session => session.projectId === projectId).map(session => {
      const transcript = this.transcripts(session.id);
      const protectedReason = !session.archivedAt ? 'Archive the conversation before deleting its history.'
        : references.has(session.id) ? 'Execution or review evidence references this conversation.'
          : snapshot.turns.some(turn => turn.sessionId === session.id && !['completed', 'failed', 'interrupted'].includes(turn.state)) ? 'A turn is active or its delivery is uncertain.'
            : snapshot.approvals.some(approval => approval.sessionId === session.id && approval.state === 'pending') ? 'An approval is pending.'
              : snapshot.agentRelations.some(relation => relation.parentSessionId === session.id || relation.childSessionId === session.id) ? 'Agent relationships reference this conversation.' : undefined;
      return { sessionId: session.id, title: session.title, items: transcript.length, bytes: jsonBytes(transcript).length, deletable: !protectedReason, ...(protectedReason ? { protection: protectedReason } : {}) };
    });
    if (this.options.store.getRevision() !== snapshot.revision) throw new Error('Project history changed while reading storage usage. Refresh the preview.');
    const groups = [{ kind: 'planning', items: planning.snapshot.history.length + planning.snapshot.baselines.length + 1, bytes: jsonBytes(planning.snapshot).length },
      { kind: 'execution', items: execution.runs.length, bytes: jsonBytes(execution).length },
      { kind: 'conversations', items: conversations.reduce((sum, entry) => sum + entry.items, 0), bytes: conversations.reduce((sum, entry) => sum + entry.bytes, 0) }];
    const planningSnapshots = [planning.snapshot];
    if (workflow) groups.push({ kind: 'workflow', items: workflow.subprojects.length + workflow.sessionLinks.length, bytes: jsonBytes(workflow).length });
    for (const owner of workflow?.subprojects ?? []) if (owner.id !== 'legacy-default') {
      const scoped = await this.options.planning.read(projectId, owner.id); if (!scoped.ok) throw new Error(scoped.message);
      planningSnapshots.push(scoped.snapshot); groups.push({ kind: 'subproject-planning', items: scoped.snapshot.history.length + scoped.snapshot.baselines.length + 1, bytes: jsonBytes(scoped.snapshot).length });
    }
    const assets = [...new Map(planningSnapshots.flatMap(value => [...value.draft.assets, ...value.baselines.flatMap(baseline => baseline.draft.assets)]).map(asset => [asset.hash, asset])).values()];
    groups.push({ kind: 'assets-referenced', items: assets.length, bytes: assets.reduce((sum, asset) => sum + asset.byteLength, 0) });
    let resultBytes = 0; let resultItems = 0;
    for (const kind of ['attempt', 'integration', 'integration-candidate', 'logs', 'review-history']) {
      const directory = path.join(this.options.userDataDir, 'planning-results-v1', kind);
      const names = await fs.readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
        const file = path.join(directory, name); const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ITEM_BYTES) continue;
        const value = JSON.parse(await fs.readFile(file, 'utf8')) as { projectId?: string };
        if (value.projectId === projectId) { resultItems++; resultBytes += stat.size; }
      }
    }
    groups.push({ kind: 'results-and-evidence', items: resultItems, bytes: resultBytes });
    const restored = await this.read<{ archiveId: string }>('restored', projectId);
    if (restored) groups.push({ kind: 'restored-history', items: 1, bytes: jsonBytes(await this.selectedArchive(restored.archiveId)).length });
    if (this.options.store.getRevision() !== snapshot.revision || this.options.ledger.read(projectId).revision !== execution.revision) throw new Error('Project history changed while reading storage usage. Refresh the preview.');
    if (workflow && archiveHash(jsonBytes(await this.options.workflows!.exportRegistry(projectId))) !== archiveHash(jsonBytes(workflow))) throw new Error('Workflow references changed. Refresh the cleanup preview.');
    const value = { projectId, revision: snapshot.revision, groups, conversations };
    return { ...value, token: archiveObjectHash({ ...value, executionRevision: execution.revision, planningRevision: planning.snapshot.revision }) };
  }
  async cleanup(projectId: string, token: string, sessionIds: readonly string[]): Promise<number> {
    return this.gate.runExclusive(async () => {
      const inventory = await this.inventory(projectId);
      if (inventory.token !== token || sessionIds.some(id => !inventory.conversations.some(entry => entry.sessionId === id && entry.deletable))) throw new Error('The cleanup preview changed or contains protected records.');
      const beforeSequence = this.options.store.getEventSequence();
      const result = await this.options.store.purgeArchivedSessionHistory(projectId, sessionIds, inventory.revision, inventory.conversations.filter(entry => !entry.deletable).map(entry => entry.sessionId));
      this.options.onHistoryChanged?.(beforeSequence); return result.removedItems;
    });
  }
  private async projectDirectory(projectId: string, name: 'archive-inbox' | 'backups'): Promise<string> {
    const root = await fs.realpath(this.project(projectId).rootPath!);
    let current = root;
    for (const segment of ['.ezterminal', name]) {
      current = path.join(current, segment);
      try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(root, await fs.realpath(current)).startsWith('..')) throw new Error('Archive storage must remain in an ordinary project-owned directory.');
    }
    return current;
  }
  prepareImport(projectId: string): Promise<string> { return this.projectDirectory(projectId, 'archive-inbox'); }
  async remoteExportPath(projectId: string, commandId: string): Promise<string> {
    return path.join(await this.projectDirectory(projectId, 'backups'), `${archiveHash(commandId)}.ezarchive.json`);
  }
  async inspectUploaded(projectId: string, uploadedPath: string) {
    const root = await this.prepareImport(projectId); const file = await fs.realpath(uploadedPath); const relative = path.relative(root, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(file) !== root || (await fs.lstat(uploadedPath)).isSymbolicLink()) throw new Error('Uploaded archives must be selected from this project inbox.');
    return this.inspectArchive(file);
  }
  async inspectArchive(file: string): Promise<{ archiveId: string; manifest: ProjectArchiveManifest }> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARCHIVE_MAX_BYTES) throw new Error('Choose an ordinary project archive of at most 50 MiB.');
    const bytes = await fs.readFile(file); const archive = verifyArchive(bytes); const archiveId = `archive-${archiveHash(bytes)}`;
    await this.write('packages', archiveId, archive);
    return { archiveId, manifest: archive.manifest };
  }
  private async selectedArchive(archiveId: string): Promise<ProjectArchivePackage> {
    const value = await this.read<ProjectArchivePackage>('packages', archiveId);
    if (!value) throw new Error('Select and verify the archive again.'); return verifyArchive(jsonBytes(value));
  }
  async exportProject(projectId: string, targetPath: string, commandId: string): Promise<ProjectArchiveManifest> {
    return this.gate.runExclusive(async () => {
      const key = `export:${projectId}:${commandId}`; const fingerprint = archiveObjectHash({ projectId, targetPath: path.resolve(targetPath), commandId });
      let intent = await this.read<ArchiveIntent>('commands', key);
      if (intent && intent.fingerprint !== fingerprint) throw new Error('This export command ID already names another destination.');
      if (!intent) {
        const archive = await this.collect(projectId); const archiveId = `archive-${archiveHash(jsonBytes(archive))}`;
        await this.write('packages', archiveId, archive);
        intent = { kind: 'export', fingerprint, archiveId, destination: path.resolve(targetPath) }; await this.write('commands', key, intent);
      }
      const archive = await this.selectedArchive(intent.archiveId); const bytes = jsonBytes(archive);
      try {
        const existing = await fs.readFile(intent.destination);
        if (archiveHash(existing) !== archiveHash(bytes)) throw new Error('The destination already contains another file. Existing backups were preserved.');
        return archive.manifest;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = await fs.realpath(path.dirname(intent.destination));
      const destination = path.join(parent, path.basename(intent.destination));
      const temporary = path.join(parent, `.ezterminal-archive-${randomUUID()}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      // Linking publishes a complete file atomically and refuses an existing destination.
      await fs.link(temporary, destination); await fs.unlink(temporary);
      return archive.manifest;
    });
  }
  private async collect(projectId: string): Promise<ProjectArchivePackage> {
    for (let retry = 0; retry < 3; retry++) {
      const planning = await this.options.planning.read(projectId); if (!planning.ok) throw new Error(planning.message);
      const workflow = await this.options.workflows?.exportRegistry(projectId);
      const scopedPlanning = new Map<string, typeof planning.snapshot>();
      for (const owner of workflow?.subprojects ?? []) if (!owner.legacyPlanning) {
        const scoped = await this.options.planning.read(projectId, owner.id); if (!scoped.ok) throw new Error(scoped.message);
        scopedPlanning.set(owner.id, scoped.snapshot);
      }
      const snapshot = this.options.store.getSnapshot(); const project = snapshot.projects.find(entry => entry.id === projectId);
      if (!project?.rootPath) throw new Error('The project root is unavailable.');
      const execution = this.options.ledger.read(projectId); const sessions = snapshot.sessions.filter(entry => entry.projectId === projectId); const sessionIds = new Set(sessions.map(entry => entry.id));
      const workspaceIds = new Set(snapshot.workspaces.filter(entry => entry.projectId === projectId).map(entry => entry.id));
      const exclusions: ProjectArchiveManifest['exclusions'] = [{ item: 'credentials', reason: 'API keys, authentication tokens, SSH private keys and device pairing are excluded.' },
        { item: 'source-repository', reason: 'The source repository and executable binaries are external references; reconnect the matching base revision separately.' },
        { item: 'runtime-authority', reason: 'Live processes, active ports, execution approvals and provider connection authority are never restored.' }];
      const entries: ArchiveEntry[] = []; const checkedFiles: { file: string; hash: string }[] = [];
      const secrets = this.options.knownCredentialValues?.() ?? [];
      const addJson = (id: string, kind: ArchiveEntry['kind'], value: unknown, metadata?: Record<string, string>) => {
        const cleaned = redactArchiveValue(value, exclusions, id, secrets);
        entries.push(archiveEntry(id, kind, jsonBytes(cleaned), metadata));
      };
      const portablePlanning = PlanningSnapshotSchema.parse(redactArchiveValue(planning.snapshot, exclusions, 'planning', secrets));
      portablePlanning.baselines = portablePlanning.baselines.map(baseline => ({ ...baseline, hash: archiveObjectHash(baseline.draft) }));
      addJson('planning', 'planning', portablePlanning); addJson('execution', 'execution', execution);
      if (workflow) addJson('workflow', 'workflow', workflow);
      for (const [subprojectId, scoped] of scopedPlanning) {
        const portable = PlanningSnapshotSchema.parse(redactArchiveValue(scoped, exclusions, `planning:${subprojectId}`, secrets));
        portable.baselines = portable.baselines.map(baseline => ({ ...baseline, hash: archiveObjectHash(baseline.draft) }));
        addJson(`planning:${subprojectId}`, 'subproject-planning', portable, { subprojectId });
      }
      const outbox = this.options.store.readPlanningExecution(database => database.prepare('SELECT envelope_json, receipt_json, state, detail, created_at, updated_at FROM command_outbox').all().filter(row => {
        const command = JSON.parse(String(row.envelope_json)) as { payload?: { projectId?: string; sessionId?: string; workspaceId?: string } };
        return command.payload?.projectId === projectId || sessionIds.has(command.payload?.sessionId ?? '') || workspaceIds.has(command.payload?.workspaceId ?? '');
      }).map(row => ({ ...row, envelope_json: JSON.parse(String(row.envelope_json)), receipt_json: row.receipt_json ? JSON.parse(String(row.receipt_json)) : null })));
      addJson('daemon', 'daemon', { project, workspaces: snapshot.workspaces.filter(entry => workspaceIds.has(entry.id)), sessions,
        agents: snapshot.agents.filter(entry => sessionIds.has(entry.sessionId)).map(agent => ({ ...agent, providerSessionId: undefined })),
        relations: snapshot.agentRelations.filter(entry => sessionIds.has(entry.parentSessionId) && sessionIds.has(entry.childSessionId)),
        turns: snapshot.turns.filter(entry => sessionIds.has(entry.sessionId)), approvals: snapshot.approvals.filter(entry => sessionIds.has(entry.sessionId)), outbox,
        schedules: snapshot.schedules.filter(entry => workspaceIds.has(entry.workspaceId)), heartbeats: snapshot.heartbeats.filter(entry => sessionIds.has(entry.sessionId)),
        providers: snapshot.providers.filter(entry => snapshot.agents.some(agent => sessionIds.has(agent.sessionId) && agent.providerId === entry.id)).map(entry => ({ id: entry.id, displayName: entry.displayName, protocol: entry.protocol, executableVersion: entry.executableVersion, connectionRequired: true })),
      });
      for (const session of sessions) addJson(`transcript-${archiveHash(session.id)}`, 'transcript', { sessionId: session.id, items: this.transcripts(session.id) });
      for (const lease of this.options.environmentMetadata?.() ?? []) if (sessionIds.has(lease.sessionId)) addJson(`environment-${archiveHash(lease.sessionId)}`, 'environment', { ...lease, status: 'historical', activeAuthority: false });
      const resultsRoot = path.join(this.options.userDataDir, 'planning-results-v1');
      for (const kind of ['attempt', 'integration', 'integration-candidate', 'logs', 'review-history', 'review-retry', 'device-registration']) {
        const directory = path.join(resultsRoot, kind);
        const names = await fs.readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
        for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))) {
          const file = path.join(directory, name); const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ITEM_BYTES) { exclusions.push({ item: `result:${name}`, reason: 'Result metadata is not an ordinary file within the 32 MiB item limit.' }); continue; }
          const bytes = await fs.readFile(file); const value = JSON.parse(bytes.toString('utf8')) as { projectId?: string; receipt?: { projectId?: string } };
          if (value.projectId !== projectId && value.receipt?.projectId !== projectId) continue;
          checkedFiles.push({ file, hash: archiveHash(bytes) });
          addJson(`${kind}-${name.slice(0, -5)}`, kind === 'attempt' || kind === 'review-history' ? 'result' : kind.startsWith('integration') ? 'integration' : kind === 'logs' ? 'log' : 'history', value);
        }
      }
      const assets = new Map([planning.snapshot, ...scopedPlanning.values()].flatMap(scoped => [...scoped.draft.assets, ...scoped.baselines.flatMap(baseline => baseline.draft.assets)]).map(asset => [asset.hash, asset]));
      const root = await fs.realpath(project.rootPath);
      // Candidates are compared by real path, so the app data folder must be too (it may be spelled
      // by an 8.3 alias). It is absent for projects without device captures.
      const userDataDir = await fs.realpath(this.options.userDataDir).catch(() => this.options.userDataDir);
      const captureRoots = [path.join(root, '.ezterminal', 'captures'), path.join(root, '.ezterminal', 'planning', 'captures'), path.join(userDataDir, 'planning-captures-v1', archiveHash(projectId))];
      const captureReferences = new Set(execution.runs.flatMap(run => run.evidence.flatMap(evidence => [...evidence.captureRefs])));
      for (const entry of entries.filter(entry => entry.kind === 'result' || entry.kind === 'integration')) {
        const value = parseArchiveJson(entry) as { validations?: { device?: { captureRefs?: string[] } }[] };
        for (const validation of value.validations ?? []) for (const reference of validation.device?.captureRefs ?? []) captureReferences.add(reference);
      }
      for (const reference of captureReferences) {
        try {
          let candidate = path.isAbsolute(reference) ? reference : path.resolve(root, reference);
          if (/^capture:[a-f0-9]{64}$/u.test(reference)) {
            const ownedDirectory = captureRoots[2];
            const candidates = ['png', 'jpg', 'webp'].map(extension => path.join(ownedDirectory, `${reference.slice(8)}.${extension}`));
            candidate = '';
            for (const possible of candidates) if (await fs.lstat(possible).then(() => true, () => false)) { candidate = possible; break; }
            if (!candidate) throw new Error('The immutable device capture is unavailable.');
          }
          const real = await fs.realpath(candidate); const stat = await fs.lstat(candidate);
          const owned = captureRoots.some(directory => { const relative = path.relative(directory, real); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); });
          if (!owned || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ITEM_BYTES || !/\.(?:png|jpe?g|webp)$/iu.test(real)) throw new Error('The capture is not a readable owned image within the 32 MiB limit.');
          const bytes = await fs.readFile(real);
          if (reference.startsWith('capture:') && archiveHash(bytes) !== reference.slice(8)) throw new Error('The immutable device capture failed its content hash check.');
          entries.push(archiveEntry(`capture-${archiveHash(reference)}`, 'capture', bytes, { reference })); checkedFiles.push({ file: real, hash: archiveHash(bytes) });
        } catch (error) { exclusions.push({ item: `capture:${reference}`, reason: error instanceof Error ? error.message : 'Capture bytes are unavailable; reference retained.' }); }
      }
      for (const asset of assets.values()) {
        try {
          if (excludedPath.test(asset.relativePath) || !/^(?:image\/|font\/|text\/plain$)/u.test(asset.mimeType)) throw new Error('Credentials and executable or unsupported asset types are excluded.');
          const file = path.resolve(root, asset.relativePath); const real = await fs.realpath(file); const relative = path.relative(root, real); const stat = await fs.lstat(file);
          if (relative.startsWith('..') || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ITEM_BYTES) throw new Error('Asset path or size is outside the portable asset boundary.');
          const bytes = await fs.readFile(real); if (archiveHash(bytes) !== asset.hash || bytes.length !== asset.byteLength) throw new Error('The asset changed after its planning reference was recorded.');
          if ((asset.mimeType.startsWith('text/') || asset.mimeType === 'image/svg+xml') && redactArchiveValue(bytes.toString('utf8'), [], 'asset', secrets) !== bytes.toString('utf8')) throw new Error('The asset contains recognized credentials and was excluded.');
          entries.push(archiveEntry(`asset-${asset.hash}`, 'asset', bytes, { relativePath: asset.relativePath, assetId: asset.id, mimeType: asset.mimeType })); checkedFiles.push({ file: real, hash: asset.hash });
        } catch (error) { exclusions.push({ item: `asset:${asset.id}`, reason: error instanceof Error ? error.message : 'Asset unavailable.' }); }
      }
      for (const result of entries.filter(entry => entry.kind === 'result')) {
        const record = PlanningResultRecordSchema.safeParse(parseArchiveJson(result));
        if (!record.success || !record.data.commit || !record.data.baseCommit) continue;
        try {
          const patch = await this.gitBytes(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', record.data.baseCommit, record.data.commit, '--']);
          if (record.data.changedPaths.some(file => excludedPath.test(file)) || redactArchiveValue(patch.toString('utf8'), [], 'patch', secrets) !== patch.toString('utf8')) throw new Error('A result contains recognized credentials; its recoverable patch was excluded.');
          const patchId = `patch-${record.data.commit}`;
          if (!entries.some(entry => entry.id === patchId)) entries.push(archiveEntry(patchId, 'patch', patch, { commit: record.data.commit, baseCommit: record.data.baseCommit }));
          for (const file of record.data.changedPaths) {
            const listing = (await this.gitBytes(root, ['ls-tree', '-z', record.data.baseCommit, '--', file])).toString('utf8');
            const blob = /^100(?:644|755) blob ([a-f0-9]{40,64})\t/u.exec(listing)?.[1]; if (!blob || entries.some(entry => entry.id === `base-${blob}`)) continue;
            const bytes = await this.gitBytes(root, ['cat-file', 'blob', blob]);
            if (redactArchiveValue(bytes.toString('utf8'), [], 'blob', secrets) !== bytes.toString('utf8')) throw new Error('A base blob contains recognized credentials.');
            entries.push(archiveEntry(`base-${blob}`, 'base-blob', bytes, { gitObject: blob }));
          }
        } catch (error) { exclusions.push({ item: `result:${record.data.attemptId}`, reason: error instanceof Error ? error.message : 'Exact result patch unavailable.' }); }
      }
      const prior = await this.read<{ archiveId: string }>('restored', projectId);
      if (prior) addJson('previous-archive', 'history', await this.selectedArchive(prior.archiveId));
      const latest = await this.options.planning.read(projectId);
      const latestWorkflow = await this.options.workflows?.exportRegistry(projectId);
      let scopedUnchanged = archiveObjectHash(workflow ?? null) === archiveObjectHash(latestWorkflow ?? null);
      for (const [owner, before] of scopedPlanning) { const current = await this.options.planning.read(projectId, owner); if (!current.ok || archiveObjectHash(current.snapshot) !== archiveObjectHash(before)) scopedUnchanged = false; }
      const unchangedFiles = (await Promise.all(checkedFiles.map(async entry => archiveHash(await fs.readFile(entry.file)) === entry.hash))).every(Boolean);
      if (!scopedUnchanged || !latest.ok || archiveObjectHash(latest.snapshot) !== archiveObjectHash(planning.snapshot) || snapshot.revision !== this.options.store.getRevision() || execution.revision !== this.options.ledger.read(projectId).revision || !unchangedFiles) continue;
      const manifest = { version: 1 as const, createdAt: new Date().toISOString(), projectId, projectName: project.name,
        source: { planningRevision: planning.snapshot.revision, daemonRevision: snapshot.revision, executionRevision: execution.revision },
        entries: entries.map(({ id, kind, hash, byteLength, metadata }) => ({ id, kind, hash, byteLength, ...(metadata ? { metadata } : {}) })), exclusions,
        portable: false, notes: ['Full recorded project history is included within the 50 MiB package / 32 MiB item limits; source repositories remain external.',
          'Recognized credentials are masked. Review free-form planning and conversation content before sharing.',
          'Restored execution, approvals, providers and environments remain historical data. Reconnect source code and AI providers explicitly.'],
      };
      const archive = { manifest: { ...manifest, integrity: archiveObjectHash(manifest) }, entries };
      return verifyArchive(jsonBytes(archive));
    }
    throw new Error('Project records kept changing. Pause edits or active work and retry the backup; no partial archive was exported.');
  }
  private gitBytes(root: string, args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => execFile('git', ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', ...args],
      { cwd: root, encoding: 'buffer', windowsHide: true, timeout: 30_000, maxBuffer: MAX_ITEM_BYTES }, (error, stdout) => error ? reject(new Error(`Required Git result data could not be read: ${error.message}`)) : resolve(stdout)));
  }
  async restoreArchive(archiveId: string, name: string, parentPath: string, commandId: string): Promise<{ projectId: string; rootPath: string; manifest: ProjectArchiveManifest }> {
    return this.gate.runExclusive(async () => {
      const archive = await this.selectedArchive(archiveId); const parent = await fs.realpath(parentPath);
      const key = `restore:${commandId}`; const fingerprint = archiveObjectHash({ archiveId, name, parent, commandId });
      let intent = await this.read<ArchiveIntent>('commands', key);
      if (intent && intent.fingerprint !== fingerprint) throw new Error('This restore command ID belongs to a different archive or destination.');
      if (!intent) {
        const suffix = randomUUID().slice(-8); const safeName = name.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 60).replace(/[. ]+$/u, '') || 'Restored project';
        const destination = path.join(parent, `${safeName}-${suffix}`);
        intent = { kind: 'restore', fingerprint, archiveId, destination, projectId: projectIdForRoot(destination), name };
        await this.write('commands', key, intent);
      }
      const rootPath = intent.destination; const projectId = intent.projectId!;
      try { await fs.mkdir(rootPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(rootPath); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Restore requires a new ordinary project directory.');
      const ownerFile = path.join(rootPath, '.ezterminal-restore.json');
      const owner = await fs.readFile(ownerFile, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (owner === null) {
        if ((await fs.readdir(rootPath)).length) throw new Error('The restore destination contains user files. They were preserved.');
        await fs.writeFile(ownerFile, JSON.stringify({ fingerprint, archiveId, projectId }), { flag: 'wx', mode: 0o600 });
      } else if (JSON.parse(owner).fingerprint !== fingerprint) throw new Error('The restore destination belongs to a different operation.');
      const snapshot = PlanningSnapshotSchema.parse(parseArchiveJson(archive.entries.find(entry => entry.kind === 'planning')!));
      const remapAssets = (draft: typeof snapshot.draft) => ({ ...draft, assets: draft.assets.map(asset => {
        const entry = archive.entries.find(entry => entry.kind === 'asset' && entry.hash === asset.hash);
        return entry ? { ...asset, relativePath: `.ezterminal/restored-assets/${asset.hash}` } : asset;
      }) });
      snapshot.draft = remapAssets(snapshot.draft); snapshot.baselines = snapshot.baselines.map(baseline => { const draft = remapAssets(baseline.draft); return { ...baseline, draft, hash: archiveObjectHash(draft) }; });
      const stagingPlanning = new PlanningService({ resolveProjectRoot: id => id === projectId ? rootPath : null });
      const planningFile = path.join(rootPath, '.ezterminal', 'planning', 'project.json');
      const hasPlanning = await fs.stat(planningFile).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
      if (!hasPlanning) {
        const restored = await stagingPlanning.importSnapshot(projectId, snapshot); if (!restored.ok) throw new Error(restored.message);
      } else {
        const existing = await stagingPlanning.read(projectId); if (!existing.ok || archiveCanonical(existing.snapshot) !== archiveCanonical({ ...snapshot, projectId })) throw new Error('The partially restored planning file changed; it was preserved.');
      }
      const assetRoot = path.join(rootPath, '.ezterminal', 'restored-assets'); await fs.mkdir(assetRoot, { recursive: true });
      for (const entry of archive.entries.filter(value => value.kind === 'subproject-planning')) {
        const subprojectId = entry.metadata!.subprojectId;
        const source = PlanningSnapshotSchema.parse(parseArchiveJson(entry));
        source.draft = remapAssets(source.draft); source.baselines = source.baselines.map(baseline => { const draft = remapAssets(baseline.draft); return { ...baseline, draft, hash: archiveObjectHash(draft) }; });
        const scopedFile = path.join(rootPath, '.ezterminal', 'planning', `subproject-${archiveHash(subprojectId)}.json`);
        const exists = await fs.stat(scopedFile).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        if (!exists) { const result = await stagingPlanning.importSnapshot(projectId, source, subprojectId); if (!result.ok) throw new Error(result.message); }
        else { const current = await stagingPlanning.read(projectId, subprojectId); if (!current.ok || archiveCanonical(current.snapshot) !== archiveCanonical({ ...source, projectId })) throw new Error('The partially restored subproject changed.'); }
      }
      const workflowEntry = archive.entries.find(entry => entry.kind === 'workflow');
      if (workflowEntry) {
        const source: WorkflowRegistry = WorkflowRegistrySchema.parse(parseArchiveJson(workflowEntry));
        source.historicalSessionLinks = [...(source.historicalSessionLinks ?? []), ...source.sessionLinks]; source.sessionLinks = []; source.projectId = projectId;
        const stagingWorkflow = new WorkflowService({ hostId: 'archive-restore', resolveProjectRoot: id => id === projectId ? rootPath : null, planning: stagingPlanning, runs: () => [], session: () => undefined });
        const exists = await fs.stat(path.join(rootPath, '.ezterminal', 'planning', 'workflows.json')).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        if (!exists) await stagingWorkflow.importRegistry(projectId, source);
        else if (archiveCanonical(await stagingWorkflow.exportRegistry(projectId)) !== archiveCanonical(source)) throw new Error('The partially restored workflow registry changed.');
      }
      if ((await fs.lstat(assetRoot)).isSymbolicLink()) throw new Error('The restored asset directory changed.');
      for (const entry of archive.entries.filter(entry => entry.kind === 'asset')) {
        const target = path.join(assetRoot, entry.hash); const bytes = decodeArchiveEntry(entry);
        try { await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || archiveHash(await fs.readFile(target)) !== entry.hash) throw error; }
      }
      await this.write('restored', projectId, { archiveId, rootPath, sourceProjectId: archive.manifest.projectId, historicalOnly: true });
      await this.options.registerRestoredProject({ projectId, name, rootPath });
      return { projectId, rootPath, manifest: archive.manifest };
    });
  }
  async history(projectId: string): Promise<ProjectArchiveHistory | null> {
    const reference = await this.read<{ archiveId: string }>('restored', projectId); if (!reference) return null;
    return this.historicalRecords(await this.selectedArchive(reference.archiveId));
  }
  private historicalRecords(archive: ProjectArchivePackage, depth = 0): ProjectArchiveHistory {
    if (depth > 20) throw new Error('The archive history nesting exceeds the safe inspection limit.');
    const daemon = parseArchiveJson(archive.entries.find(entry => entry.kind === 'daemon')!) as { sessions: DaemonSession[] };
    const history: ProjectArchiveHistory = { manifest: archive.manifest, planning: PlanningSnapshotSchema.parse(parseArchiveJson(archive.entries.find(entry => entry.kind === 'planning')!)),
      ...(archive.entries.some(entry => entry.kind === 'workflow') ? { workflow: WorkflowRegistrySchema.parse(parseArchiveJson(archive.entries.find(entry => entry.kind === 'workflow')!)),
        subprojectPlanning: Object.fromEntries(archive.entries.filter(entry => entry.kind === 'subproject-planning').map(entry => [entry.metadata!.subprojectId, PlanningSnapshotSchema.parse(parseArchiveJson(entry))])) } : {}),
      execution: PlanningExecutionSnapshotSchema.parse(parseArchiveJson(archive.entries.find(entry => entry.kind === 'execution')!)),
      conversations: daemon.sessions.map(session => ({ session, transcript: archive.entries.filter(entry => entry.kind === 'transcript').flatMap(entry => {
        const transcript = parseArchiveJson(entry) as { sessionId: string; items: DaemonTranscriptItem[] }; return transcript.sessionId === session.id ? transcript.items : [];
      }) })),
      results: archive.entries.filter(entry => entry.kind === 'result').map(entry => PlanningResultRecordSchema.parse(parseArchiveJson(entry))),
      integrations: archive.entries.filter(entry => entry.kind === 'integration').map(entry => PlanningIntegrationRecordSchema.parse(parseArchiveJson(entry))),
    };
    const previous = archive.entries.find(entry => entry.id === 'previous-archive' && entry.kind === 'history');
    if (!previous) return history;
    const inherited = this.historicalRecords(verifyArchive(decodeArchiveEntry(previous)), depth + 1);
    return { ...history,
      execution: { ...history.execution, runs: [...history.execution.runs, ...inherited.execution.runs] },
      conversations: [...new Map([...history.conversations, ...inherited.conversations].map(entry => [`${entry.session.projectId}:${entry.session.id}`, entry])).values()],
      results: [...history.results, ...inherited.results], integrations: [...history.integrations, ...inherited.integrations],
    };
  }
}
