import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DaemonSnapshot, DaemonTranscriptItem } from '../shared/daemon-protocol';
import type { ExecutionArtifact, ExecutionAttempt, ExecutionRun, PreparedExecutionTask, PlanningExecutionReceipt } from '../shared/planning-execution';
import { PlanningResultRecordSchema, PlanningIntegrationRecordSchema, type PlanningResultRecord, type PlanningIntegrationRecord } from '../shared/planning-result';
import type { GitRunner, WorktreeService } from './worktree-service';
import type { PlanningDeviceEvidenceInput } from '../shared/planning-device-evidence';
import { turnReplies } from './planning-transcript';

export const resultHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const commitPattern = /^[a-f0-9]{40,64}$/u;
const safeGit = ['--no-pager', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false'] as const;
const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

export type { PlanningResultRecord, PlanningIntegrationRecord, PlanningValidationRecord } from '../shared/planning-result';

interface PreparedWorkspace {
  readonly runId: string; readonly taskId: string; readonly path: string; readonly baseCommit: string; readonly repairPending?: boolean;
}
export interface ReviewRetryRecord { readonly fingerprint: string; readonly generation: number; readonly receipt: PlanningExecutionReceipt; }
export interface DeviceRegistrationRecord extends ReviewRetryRecord { readonly completed?: boolean; }
interface ApplyJournal { fingerprint: string; next: number; head: string; pending?: string; }

export interface PlanningResultRepositoryOptions {
  readonly userDataDir: string;
  readonly git: Pick<GitRunner, 'run'>;
  readonly worktrees: Pick<WorktreeService, 'execute'>;
  readonly getSnapshot: () => DaemonSnapshot;
  readonly readTranscript: (sessionId: string, afterSequence: number, limit: number) => readonly DaemonTranscriptItem[];
}

/** Immutable Git objects plus device-owned recovery metadata; never resets the user's checkout. */
export class PlanningResultRepository {
  private readonly directory: string;
  constructor(private readonly options: PlanningResultRepositoryOptions) {
    this.directory = path.join(options.userDataDir, 'planning-results-v1');
  }
  private file(kind: string, identity: readonly string[]): string {
    return path.join(this.directory, kind, `${resultHash(identity)}.json`);
  }
  private async read<T>(kind: string, identity: readonly string[]): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.file(kind, identity), 'utf8');
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Result recovery metadata is too large.');
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async write(kind: string, identity: readonly string[], value: unknown): Promise<void> {
    const target = this.file(kind, identity);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      // Windows refuses to replace a file another handle has open (a concurrent read of the same
      // result): retry briefly instead of failing the review that is saving it.
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, target); return; }
        catch (error) {
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 15 * 2 ** attempt));
        }
      }
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
  async readResult(projectId: string, attemptId: string): Promise<PlanningResultRecord | null> {
    const value = await this.read<PlanningResultRecord>('attempt', [projectId, attemptId]);
    if (value && (value.version !== 1 || value.projectId !== projectId || value.attemptId !== attemptId
      || !Array.isArray(value.artifacts) || !Array.isArray(value.validations))) throw new Error('Result recovery identity is invalid.');
    return value ? PlanningResultRecordSchema.parse(value) : null;
  }
  saveResult(value: PlanningResultRecord): Promise<void> {
    return this.write('attempt', [value.projectId, value.attemptId], value);
  }
  readReviewRetry(projectId: string, commandId: string): Promise<ReviewRetryRecord | null> { return this.read('review-retry', [projectId, commandId]); }
  saveReviewRetry(projectId: string, commandId: string, value: ReviewRetryRecord): Promise<void> { return this.write('review-retry', [projectId, commandId], value); }
  saveReviewHistory(value: PlanningResultRecord): Promise<void> { return this.write('review-history', [value.projectId, value.attemptId, String(value.reviewAttempt ?? 0)], value); }
  readDeviceRegistration(projectId: string, commandId: string): Promise<DeviceRegistrationRecord | null> { return this.read('device-registration', [projectId, commandId]); }
  saveDeviceRegistration(projectId: string, commandId: string, value: DeviceRegistrationRecord): Promise<void> { return this.write('device-registration', [projectId, commandId], value); }
  async saveDeviceProof(projectId: string, proofId: string, input: PlanningDeviceEvidenceInput, principalId: string): Promise<import('../shared/planning-result').PlanningValidationRecord> {
    const bytes = Buffer.from(input.capture.dataBase64, 'base64');
    if (bytes.toString('base64') !== input.capture.dataBase64 || bytes.length > 512 * 1024) throw new Error('Invalid or oversized capture encoding.');
    const validImage = input.capture.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : input.capture.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!validImage) throw new Error('The capture content does not match its image type.');
    const captureHash = createHash('sha256').update(bytes).digest('hex');
    const directory = path.join(this.options.userDataDir, 'planning-captures-v1', createHash('sha256').update(projectId).digest('hex'));
    await fs.mkdir(directory, { recursive: true });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('The device evidence directory is not owned.');
    const capturePath = path.join(directory, `${captureHash}.${input.capture.mimeType === 'image/png' ? 'png' : input.capture.mimeType === 'image/jpeg' ? 'jpg' : 'webp'}`);
    const temporary = `${capturePath}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, capturePath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await fs.unlink(temporary).catch(() => undefined); }
    const stat = await fs.lstat(capturePath);
    if (!stat.isFile() || stat.isSymbolicLink() || !bytes.equals(await fs.readFile(capturePath))) throw new Error('The immutable capture changed.');
    const logRef = await this.saveLog(projectId, input.textLog);
    return { validationId: input.validationId, status: input.exitCode === 0 ? 'passed' : 'failed',
      logRefs: [logRef], summary: `User-attested device evidence; the host did not execute this command. ${input.summary}`,
      device: { provenance: 'user-attested', proofId, principalId, deviceId: input.deviceId, platformVersion: input.platformVersion,
        appVersion: input.appVersion, command: input.command, exitCode: input.exitCode, startedAt: input.startedAt, finishedAt: input.finishedAt,
        captureRefs: [`capture:${captureHash}`], captureHash, logHash: createHash('sha256').update(input.textLog).digest('hex') } };
  }
  async readDeviceCapture(projectId: string, reference: string): Promise<{ mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string } | null> {
    if (!/^[a-f0-9]{64}$/u.test(reference)) throw new Error('Invalid device capture reference.');
    const directory = path.join(this.options.userDataDir, 'planning-captures-v1', createHash('sha256').update(projectId).digest('hex'));
    for (const [extension, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
      try {
        if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('The device evidence directory is not owned.');
        const target = path.join(directory, `${reference}.${extension}`);
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Invalid device capture file.');
        const bytes = await fs.readFile(target);
        if (createHash('sha256').update(bytes).digest('hex') !== reference) throw new Error('Device capture integrity check failed.');
        return { mimeType, dataBase64: bytes.toString('base64') };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return null;
  }
  async readIntegration(projectId: string, runId: string): Promise<PlanningIntegrationRecord | null> {
    const value = await this.read<PlanningIntegrationRecord>('integration', [projectId, runId]);
    if (value && (value.version !== 1 || value.projectId !== projectId || value.runId !== runId)) throw new Error('Integration recovery identity is invalid.');
    return value ? PlanningIntegrationRecordSchema.parse(value) : null;
  }
  async saveIntegration(value: PlanningIntegrationRecord): Promise<void> {
    // Keep each failed or passed candidate, not only the last summary.
    await this.write('integration-candidate', [value.projectId, value.runId, value.inputFingerprint], value);
    await this.write('integration', [value.projectId, value.runId], value);
  }
  async saveLog(projectId: string, value: string): Promise<string> {
    const bounded = value.slice(-1_048_576);
    const hash = resultHash(bounded);
    await this.write('logs', [projectId, hash], { projectId, hash, text: bounded, truncated: value.length > bounded.length });
    return `log:${hash}`;
  }
  async readLog(projectId: string, reference: string): Promise<string | null> {
    if (!/^log:[a-f0-9]{64}$/u.test(reference)) throw new Error('Invalid validation log reference.');
    const value = await this.read<{ projectId: string; hash: string; text: string }>('logs', [projectId, reference.slice(4)]);
    if (!value) return null;
    if (value.projectId !== projectId || value.hash !== reference.slice(4) || resultHash(value.text) !== value.hash) throw new Error('Validation log integrity check failed.');
    return value.text;
  }
  async readDiff(projectId: string, attemptId: string): Promise<string | null> {
    const record = await this.readResult(projectId, attemptId);
    if (!record?.baseCommit || !record.commit) return null;
    await this.assertOwnedWorktree(projectId, record.rootPath);
    const output = await this.runGit(record.rootPath, ['diff', '--no-ext-diff', '--no-textconv', record.baseCommit, record.commit, '--']);
    const limit = 1_048_576;
    return Buffer.byteLength(output) <= limit ? output : `${Buffer.from(output).subarray(0, limit).toString('utf8')}\n[Diff preview truncated at 1 MiB; exact Git artifact retained.]`;
  }
  projectRoot(projectId: string): string {
    const project = this.options.getSnapshot().projects.find(entry => entry.id === projectId && !entry.archivedAt);
    if (!project?.rootPath) throw new Error('The project root is unavailable.');
    return project.rootPath;
  }
  async assertOwnedWorktree(projectId: string, workspacePath: string): Promise<void> {
    const root = this.projectRoot(projectId);
    if (samePath(root, workspacePath)) throw new Error('The original project checkout cannot be used as a result workspace.');
    const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    if (!listed.ok || !listed.worktrees.some(entry => entry.managed && samePath(entry.path, workspacePath))) throw new Error('The result workspace is not an owned managed worktree.');
  }
  private runGit(root: string, args: readonly string[]): Promise<string> {
    return this.options.git.run(root, [...safeGit, ...args]);
  }
  private async head(root: string): Promise<string> {
    const commit = (await this.runGit(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!commitPattern.test(commit)) throw new Error('Git did not return an exact commit identity.');
    return commit;
  }
  private async applyArtifacts(root: string, identity: readonly string[], artifacts: readonly ExecutionArtifact[]): Promise<void> {
    const commits = artifacts.filter(artifact => artifact.artifactId.startsWith('git:')).map(artifact => artifact.artifactId.slice(4));
    if (commits.some(commit => !commitPattern.test(commit))) throw new Error('Invalid result commit identity.');
    const fingerprint = resultHash(commits);
    let journal = await this.read<ApplyJournal>('apply-journal', identity);
    if (journal && journal.fingerprint !== fingerprint) throw new Error('The prepared Git inputs changed. Existing work was preserved.');
    if (!journal) {
      journal = { fingerprint, next: 0, head: await this.head(root) };
      await this.write('apply-journal', identity, journal);
    }
    if ((await this.runGit(root, ['status', '--porcelain'])).trim()) throw new Error('Git application has unresolved changes; they were preserved.');
    const actual = await this.head(root);
    if (actual !== journal.head) {
      // The process may have stopped after Git committed, before the progress record was saved.
      const parent = (await this.runGit(root, ['rev-parse', `${actual}^`])).trim();
      const message = await this.runGit(root, ['show', '-s', '--format=%B', actual]);
      if (!journal.pending || parent !== journal.head || !message.trimEnd().endsWith(`(cherry picked from commit ${journal.pending})`)) throw new Error('Git state changed outside the recorded application. Reconcile it before continuing.');
      journal = { fingerprint, next: journal.next + 1, head: actual };
      await this.write('apply-journal', identity, journal);
    }
    for (let index = journal.next; index < commits.length; index++) {
      const commit = commits[index];
      const included = await this.runGit(root, ['merge-base', '--is-ancestor', commit, 'HEAD']).then(() => true, () => false);
      if (!included) {
        journal = { fingerprint, next: index, head: await this.head(root), pending: commit };
        await this.write('apply-journal', identity, journal);
        await this.runGit(root, ['-c', 'user.name=EZTerminal', '-c', 'user.email=ezterminal@localhost', 'cherry-pick', '-x', '--keep-redundant-commits', commit]);
      }
      journal = { fingerprint, next: index + 1, head: await this.head(root) };
      await this.write('apply-journal', identity, journal);
    }
  }
  async workspace(projectId: string, branch: string, base: string): Promise<string> {
    if (!commitPattern.test(base)) throw new Error('Workspaces require an exact Git commit.');
    const root = this.projectRoot(projectId);
    const listed = await this.options.worktrees.execute({ action: 'list', cwd: root }, 'desktop');
    if (!listed.ok) throw new Error(listed.message);
    const existing = listed.worktrees.find(entry => entry.branch === branch || entry.branch === `refs/heads/${branch}`);
    if (existing) {
      if (!existing.managed || samePath(existing.path, root)) throw new Error('The result branch belongs to an unmanaged checkout.');
      return existing.path;
    }
    const created = await this.options.worktrees.execute({ action: 'create', cwd: root, branch, base, allowDirtyBase: true }, 'desktop');
    if (!created.ok || !created.opened) throw new Error(created.ok ? 'No result worktree was returned.' : created.message);
    return created.opened.path;
  }
  async prepareWorkspace(run: ExecutionRun, task: PreparedExecutionTask, root: string, dependencies: readonly ExecutionArtifact[], repairArtifacts: readonly ExecutionArtifact[] = []): Promise<void> {
    if (!run.preparation.baseCommit) return;
    await this.assertOwnedWorktree(run.projectId, root);
    const identity = [run.runId, task.taskId, path.resolve(root)];
    const existing = await this.read<PreparedWorkspace>('workspace-base', identity);
    if (existing) {
      if (!samePath(existing.path, root) || existing.runId !== run.runId || existing.taskId !== task.taskId || !commitPattern.test(existing.baseCommit)) throw new Error('Prepared workspace identity is invalid.');
      if (existing.repairPending) {
        await this.applyArtifacts(root, ['repair', ...identity], repairArtifacts);
        await this.write('workspace-base', identity, { ...existing, repairPending: false });
      }
      return;
    }
    if ((await this.runGit(root, ['status', '--porcelain'])).trim()) throw new Error('The new workspace contains uncommitted changes; it was preserved.');
    await this.applyArtifacts(root, ['dependencies', ...identity], dependencies);
    const baseCommit = await this.head(root);
    if (repairArtifacts.some(artifact => !artifact.artifactId.startsWith('git:') && !/^transcript:[a-f0-9]{64}$/u.test(artifact.artifactId))) throw new Error('Repair requires the exact captured Git or conversation result.');
    await this.write('workspace-base', identity, { runId: run.runId, taskId: task.taskId, path: root, baseCommit, repairPending: true } satisfies PreparedWorkspace);
    await this.applyArtifacts(root, ['repair', ...identity], repairArtifacts);
    await this.write('workspace-base', identity, { runId: run.runId, taskId: task.taskId, path: root, baseCommit, repairPending: false } satisfies PreparedWorkspace);
  }
  private permits(file: string, allowed: readonly string[]): boolean {
    const normalized = file.replaceAll('\\', '/');
    if (path.isAbsolute(normalized) || normalized.split('/').some(part => part === '..' || part === '.git')) return false;
    return allowed.some(scope => {
      const prefix = scope.replaceAll('\\', '/').replace(/\/$/u, '').replace(/\/\*\*$/u, '');
      if (prefix.includes('*') || path.isAbsolute(prefix) || prefix.split('/').includes('..')) return false;
      const compare = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      const boundary = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
      return boundary === '.' || compare === boundary || compare.startsWith(`${boundary}/`);
    });
  }
  async capture(run: ExecutionRun, task: PreparedExecutionTask, attempt: ExecutionAttempt): Promise<PlanningResultRecord> {
    const previous = await this.readResult(run.projectId, attempt.attemptId);
    if (previous) {
      if (previous.baselineFingerprint !== run.preparation.baseline.fingerprint || previous.runId !== run.runId || previous.taskId !== task.taskId) throw new Error('Captured result belongs to a different execution baseline.');
      return previous;
    }
    const workspace = this.options.getSnapshot().workspaces.find(entry => entry.id === attempt.workspaceId && entry.projectId === run.projectId && !entry.archivedAt);
    if (!workspace) throw new Error('The attempt workspace is unavailable.');
    const common = { version: 1 as const, projectId: run.projectId, runId: run.runId, taskId: task.taskId, attemptId: attempt.attemptId,
      baselineFingerprint: run.preparation.baseline.fingerprint, rootPath: workspace.rootPath, validations: [] };
    let record: PlanningResultRecord;
    let transcript: DaemonTranscriptItem[] | undefined;
    if (!run.preparation.baseCommit || task.profile.permissionPreset === 'plan') {
      if (!run.preparation.baseCommit && task.profile.permissionPreset !== 'plan') throw new Error('Writable results require an isolated Git workspace.');
      const turnItems: DaemonTranscriptItem[] = [];
      let cursor = 0;
      for (let page = 0; page < 100; page++) {
        const next = this.options.readTranscript(attempt.sessionId, cursor, 500);
        turnItems.push(...next.filter(item => item.turnId === attempt.turnId));
        if (next.length < 500) break;
        cursor = next.at(-1)!.sequence;
        if (page === 99) throw new Error('Result transcript is too large to capture without truncation.');
      }
      // The replies themselves (once each, whatever their sensitivity marker) plus the turn's other
      // non-sensitive rows; sensitive tool output such as command results stays out of results.
      const items = [...turnItems.filter(item => item.kind !== 'assistant-message' && !item.isSensitive), ...turnReplies(turnItems)].sort((a, b) => a.sequence - b.sequence);
      if (!items.some(item => item.kind === 'assistant-message' && item.text.trim())) throw new Error('The completed turn has no reviewable assistant result.');
      transcript = items;
    }
    if (!run.preparation.baseCommit) {
      record = { ...common, artifacts: [{ artifactId: `transcript:${resultHash(transcript)}`, revision: 0 }], transcript, changedPaths: [] };
    } else {
      await this.assertOwnedWorktree(run.projectId, workspace.rootPath);
      const prepared = await this.read<PreparedWorkspace>('workspace-base', [run.runId, task.taskId, path.resolve(workspace.rootPath)]);
      const base = prepared?.baseCommit ?? run.preparation.baseCommit;
      await this.runGit(workspace.rootPath, ['merge-base', '--is-ancestor', base, 'HEAD']);
      const changed = await this.runGit(workspace.rootPath, ['diff', '--name-only', '-z', base, '--']);
      const untracked = await this.runGit(workspace.rootPath, ['ls-files', '--others', '--exclude-standard', '-z']);
      const paths = [...new Set([...changed.split('\0'), ...untracked.split('\0')].filter(Boolean))].sort();
      if (paths.some(file => !this.permits(file, task.allowedPaths ?? []))) throw new Error('The task changed files outside its approved paths. All files were preserved.');
      for (const file of paths) {
        try {
          const stat = await fs.lstat(path.join(workspace.rootPath, file));
          if (stat.isSymbolicLink()) throw new Error('Symlink result changes require explicit separate review.');
          const real = await fs.realpath(path.join(workspace.rootPath, file));
          const relative = path.relative(await fs.realpath(workspace.rootPath), real);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('A result file escapes its owned workspace.');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (paths.length) await this.runGit(workspace.rootPath, ['--literal-pathspecs', 'add', '-A', '--', ...paths]);
      const tree = (await this.runGit(workspace.rootPath, ['write-tree'])).trim();
      // An index entry can differ from an already-reverted working file. Check the captured tree as well.
      const capturedPaths = (await this.runGit(workspace.rootPath, ['diff', '--name-only', '-z', base, tree, '--'])).split('\0').filter(Boolean);
      if (capturedPaths.some(file => !this.permits(file, task.allowedPaths ?? []))) throw new Error('The staged result contains files outside its approved paths. All files were preserved.');
      if (capturedPaths.length) {
        const entries = await this.runGit(workspace.rootPath, ['ls-tree', '-r', '-z', tree, '--', ...capturedPaths]);
        if (entries.split('\0').filter(Boolean).some(entry => !/^100(?:644|755) blob /u.test(entry))) throw new Error('Captured symlink or gitlink entries require separate explicit review.');
      }
      const ref = `refs/ezterminal/results/${resultHash([run.projectId, attempt.attemptId])}`;
      let commit = await this.runGit(workspace.rootPath, ['rev-parse', '--verify', ref]).then(value => value.trim(), () => '');
      if (commit) {
        if ((await this.runGit(workspace.rootPath, ['rev-parse', `${commit}^{tree}`])).trim() !== tree) throw new Error('A captured result changed before recovery completed.');
      } else {
        commit = (await this.runGit(workspace.rootPath, ['-c', 'user.name=EZTerminal', '-c', 'user.email=ezterminal@localhost', 'commit-tree', tree, '-p', base, '-m', `EZTerminal result ${attempt.attemptId}`])).trim();
        if (!commitPattern.test(commit)) throw new Error('Result commit creation failed.');
        await this.runGit(workspace.rootPath, ['update-ref', ref, commit, '0'.repeat(commit.length)]);
      }
      record = { ...common, baseCommit: base, commit, changedPaths: paths, artifacts: [{ artifactId: `git:${commit}`, revision: 0 }] };
      if (transcript) record = { ...record, transcript, artifacts: [...record.artifacts, { artifactId: `transcript:${resultHash(transcript)}`, revision: 0 }] };
    }
    if (Buffer.byteLength(JSON.stringify(record)) > 16 * 1024 * 1024) throw new Error('The exact result exceeds the 16 MiB capture limit. Its original conversation is preserved; no truncated result was accepted.');
    await this.saveResult(record);
    return record;
  }
  async validationWorkspace(record: PlanningResultRecord): Promise<string> {
    if (!record.commit) return record.rootPath;
    const root = await this.workspace(record.projectId, `ezterminal/validation-${resultHash([record.attemptId, record.commit]).slice(0, 32)}`, record.commit);
    await this.assertCleanRevision(root, record.commit);
    return root;
  }
  async assertCleanRevision(root: string, commit: string): Promise<void> {
    if (await this.head(root) !== commit || (await this.runGit(root, ['status', '--porcelain'])).trim()) throw new Error('Validation workspace changed; previous evidence no longer matches the exact result.');
  }
  async integrationCandidate(run: ExecutionRun, artifacts: readonly ExecutionArtifact[]): Promise<PlanningIntegrationRecord | null> {
    if (!run.preparation.baseCommit) return null;
    const fingerprint = resultHash([run.preparation.baseline, artifacts]);
    const previous = await this.readIntegration(run.projectId, run.runId);
    if (previous?.inputFingerprint === fingerprint) return previous;
    const root = await this.workspace(run.projectId, `ezterminal/integration-${fingerprint.slice(0, 32)}`, run.preparation.baseCommit);
    try {
      if ((await this.runGit(root, ['status', '--porcelain'])).trim()) throw new Error('The integration candidate has unresolved changes; it was preserved.');
      await this.applyArtifacts(root, ['integration', run.projectId, run.runId, fingerprint], artifacts);
      const result: PlanningIntegrationRecord = { version: 1, projectId: run.projectId, runId: run.runId, inputFingerprint: fingerprint,
        status: 'validating', inputArtifacts: [...artifacts], workspacePath: root, candidateCommit: await this.head(root),
        previousSuccessfulCommit: previous?.successfulCommit ?? previous?.previousSuccessfulCommit, validations: [] };
      await this.saveIntegration(result); return result;
    } catch (error) {
      const result: PlanningIntegrationRecord = { version: 1, projectId: run.projectId, runId: run.runId, inputFingerprint: fingerprint,
        status: 'failed', inputArtifacts: [...artifacts], workspacePath: root, candidateCommit: await this.head(root),
        previousSuccessfulCommit: previous?.successfulCommit ?? previous?.previousSuccessfulCommit, validations: [], error: error instanceof Error ? error.message : 'Integration failed.' };
      await this.saveIntegration(result); return result;
    }
  }
  async adoptIntegration(record: PlanningIntegrationRecord): Promise<void> {
    await this.assertCleanRevision(record.workspacePath, record.candidateCommit);
    const ref = `refs/ezterminal/integrations/${resultHash([record.projectId, record.runId])}`;
    const current = await this.runGit(record.workspacePath, ['rev-parse', '--verify', ref]).then(value => value.trim(), () => '0'.repeat(record.candidateCommit.length));
    if (current !== record.candidateCommit) {
      if (current !== (record.previousSuccessfulCommit ?? '0'.repeat(record.candidateCommit.length))) throw new Error('The last successful integration changed. Reconcile before adopting this candidate.');
      await this.runGit(record.workspacePath, ['update-ref', ref, record.candidateCommit, current]);
    }
    await this.saveIntegration({ ...record, status: 'passed', successfulCommit: record.candidateCommit });
  }
}
