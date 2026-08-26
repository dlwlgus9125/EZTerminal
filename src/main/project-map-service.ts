import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import {
  PROJECT_MAP_QUALITY_GATE_VERSION,
  normalizeProjectMapInputText,
  projectMapEvidence,
  serializeProjectMapInputVersions,
  type ProjectMapApprovalRequest,
  type ProjectMapBindingRequest,
  type ProjectMapCollectionDescriptor,
  type ProjectMapCollectionRequest,
  type ProjectMapDescribeResult,
  type ProjectMapDiagnostic,
  type ProjectMapDocument,
  type ProjectMapManifest,
  type ProjectMapOpenResult,
  type ProjectMapReadRequest,
  type ProjectMapReadResult,
  type ProjectMapRootBinding,
  type ProjectMapRootProvenance,
  type ProjectMapSnapshot,
  type ProjectMapStartJobRequest,
  type ProjectMapJobRequest,
  type ProjectMapJob,
  type ProjectMapVerification,
  validateProjectMapManifestText,
  validateProjectMapSpecText,
} from '../shared/project-map';
import { layoutProjectMap } from '../shared/project-map-layout';
import { diffProjectMapDocuments } from '../shared/project-map-scene';
import type { ProjectTextSnapshot } from '../shared/project-workspace';
import { ProjectMapBindingStore } from './project-map-binding-store';
import { ProjectMapCacheStore } from './project-map-cache-store';
import type { ProjectMapApprovalStore } from './project-map-approval-store';
import type { ProjectMapJobStore } from './project-map-job-store';
import type { ProjectWorkspaceService } from './project-workspace-service';
import { GitRunner } from './worktree-service';

const PROJECT_MAP_DIRECTORY = '.ezterminal/project-map';
const MANIFEST_PATH = `${PROJECT_MAP_DIRECTORY}/manifest.json`;
const SAFE_GIT_PREFIX = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const;

interface LoadedManifest {
  readonly manifest: ProjectMapManifest;
  readonly file: ProjectTextSnapshot;
}

interface ReadFileRecord {
  readonly rootAlias: string;
  readonly relativePath: string;
  readonly file?: ProjectTextSnapshot;
}

interface CollectionContext {
  readonly request: ProjectMapCollectionRequest;
  readonly loaded: LoadedManifest;
  readonly bindings: readonly ProjectMapRootBinding[];
  readonly bindingByAlias: ReadonlyMap<string, ProjectMapRootBinding>;
}

export interface ProjectMapChangedEvent extends ProjectMapCollectionRequest {
  readonly reason: 'source-changed' | 'bindings-changed' | 'verification-complete' | 'approval-changed' | 'job-changed';
  readonly impactedMapIds?: readonly string[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function projectMapInputVersion(content: string): string {
  return createHash('sha256').update(normalizeProjectMapInputText(content), 'utf8').digest('hex');
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function digestProjectMapEvidenceLines(
  content: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const lines = normalizeProjectMapInputText(content).split('\n');
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return undefined;
  return sha256(lines.slice(startLine - 1, endLine).join('\n'));
}

export function digestProjectMapInputs(
  records: readonly { readonly rootAlias: string; readonly relativePath: string; readonly version: string }[],
): string {
  return sha256(serializeProjectMapInputVersions(records));
}

function diagnostic(
  code: string,
  subject: string,
  message: string,
  severity: ProjectMapDiagnostic['severity'] = 'error',
): ProjectMapDiagnostic {
  return { code, subject, message, severity };
}

function cacheKey(
  request: ProjectMapCollectionRequest,
  mapId: string,
  bindings: readonly ProjectMapRootBinding[],
): string {
  const bindingFingerprint = sha256([...bindings]
    .sort((left, right) => compareText(left.rootAlias, right.rootAlias)
      || compareText(left.rootId, right.rootId)
      || compareText(left.workspaceId, right.workspaceId))
    .map((binding) => `${binding.rootAlias}\u0000${binding.rootId}\u0000${binding.workspaceId}`)
    .join('\n'));
  return `${request.projectId}\u0000${request.ownerRootId}\u0000${request.ownerWorkspaceId}\u0000${mapId}\u0000${bindingFingerprint}`;
}

function approvedCacheKey(
  request: ProjectMapCollectionRequest,
  mapId: string,
  bindings: readonly ProjectMapRootBinding[],
  fingerprint: string,
): string {
  return `${cacheKey(request, mapId, bindings)}\u0000${fingerprint}`;
}

function requestKey(request: ProjectMapCollectionRequest): string {
  return `${request.projectId}\u0000${request.ownerRootId}\u0000${request.ownerWorkspaceId}`;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function descriptor(
  request: ProjectMapCollectionRequest,
  state: ProjectMapCollectionDescriptor['state'],
  options: {
    readonly manifest?: ProjectMapManifest;
    readonly bindings?: readonly ProjectMapRootBinding[];
    readonly diagnostics?: readonly ProjectMapDiagnostic[];
  } = {},
): ProjectMapCollectionDescriptor {
  const manifest = options.manifest;
  return {
    projectId: request.projectId,
    ...(manifest ? {
      collectionId: manifest.collectionId,
      overviewMapId: manifest.overviewMapId,
      ownerRootAlias: manifest.ownerRootAlias,
    } : {}),
    state,
    roots: manifest?.roots ?? [],
    bindings: options.bindings ?? [],
    maps: manifest?.maps.map((map) => ({ id: map.id, type: map.type })) ?? [],
    diagnostics: options.diagnostics ?? [],
  };
}

export class ProjectMapService {
  private readonly events = new EventEmitter();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pendingChanges = new Map<string, NodeJS.Timeout>();
  private readonly verificationFlights = new Map<string, Promise<ProjectMapReadResult>>();
  private readonly snapshots = new Map<string, ProjectMapSnapshot>();
  private readonly impactedByInput = new Map<string, ReadonlyMap<string, readonly string[]>>();
  private readonly pendingImpacts = new Map<string, Set<string>>();

  constructor(
    private readonly workspaces: ProjectWorkspaceService,
    private readonly bindingStore: ProjectMapBindingStore,
    private readonly cacheStore: ProjectMapCacheStore,
    private readonly git = new GitRunner(),
    private readonly approvalStore?: ProjectMapApprovalStore,
    private readonly jobStore?: ProjectMapJobStore,
  ) {}

  onChanged(listener: (event: ProjectMapChangedEvent) => void): () => void {
    this.events.on('changed', listener);
    return () => this.events.off('changed', listener);
  }

  async open(request: ProjectMapReadRequest, force = false): Promise<ProjectMapOpenResult> {
    const loaded = await this.loadManifest(request);
    if (!loaded.ok) {
      const snapshot: ProjectMapSnapshot = {
        collection: loaded.result.collection,
        freshness: loaded.result.collection.state === 'empty' ? 'empty' : 'verified',
        verificationPending: false,
        ...(this.jobStore?.activeFor(request, request.mapId)
          ? { activeJob: this.jobStore.activeFor(request, request.mapId) }
          : {}),
      };
      return loaded.result.collection.state === 'empty'
        ? { ok: true, snapshot }
        : { ok: false, error: loaded.result.error, snapshot };
    }
    const manifest = loaded.value.manifest;
    const mapId = request.mapId ?? manifest.overviewMapId;
    const entry = manifest.maps.find((candidate) => candidate.id === mapId);
    const bindings = await this.bindingStore.get(request);
    const bindingDiagnostics = await this.validateBindings(request, manifest, bindings);
    if (!entry || bindingDiagnostics.length > 0) {
      const state = entry ? 'binding-required' : 'invalid';
      const diagnostics = entry ? bindingDiagnostics : [
        diagnostic('manifest.map-not-found', mapId, 'The requested map is not listed in the manifest.'),
      ];
      const snapshot: ProjectMapSnapshot = {
        collection: descriptor(request, state, { manifest, bindings, diagnostics }),
        freshness: 'verified',
        verificationPending: false,
        ...(this.jobStore?.activeFor(request, mapId) ? { activeJob: this.jobStore.activeFor(request, mapId) } : {}),
      };
      return { ok: false, error: entry ? 'binding-required' : 'map-not-found', snapshot };
    }
    const key = `${requestKey(request)}\u0000${mapId}`;
    const current = this.snapshots.get(key);
    if (!force && current) {
      if (current.verificationPending) this.scheduleVerification(request, manifest, bindings, mapId);
      return { ok: true, snapshot: current };
    }
    const approval = this.approvalStore?.get(request, mapId);
    if (!force && approval) {
      const cached = await this.cacheStore.get(approvedCacheKey(request, mapId, bindings, approval.fingerprint));
      if (cached) {
        const map: ProjectMapDocument = { ...cached, state: 'invalid-with-last-good', fromLastGood: true };
        const snapshot: ProjectMapSnapshot = {
          collection: descriptor(request, 'invalid-with-last-good', { manifest, bindings }),
          map,
          displaySource: 'last-approved',
          freshness: 'cache',
          approval,
          verificationPending: true,
          ...(this.jobStore?.activeFor(request, mapId) ? { activeJob: this.jobStore.activeFor(request, mapId) } : {}),
        };
        this.snapshots.set(key, snapshot);
        this.scheduleVerification(request, manifest, bindings, mapId);
        return { ok: true, snapshot };
      }
    }
    const completed = await this.verificationFlight(request, mapId);
    return this.verifySnapshot(request, manifest, bindings, mapId, completed);
  }

  async approve(request: ProjectMapApprovalRequest): Promise<ProjectMapOpenResult> {
    if (!this.approvalStore) throw new Error('Project Map approvals are unavailable.');
    const verified = await this.open({ ...request, quality: 'production' }, true);
    const candidate = verified.snapshot.candidate ?? verified.snapshot.map;
    if (!candidate
      || candidate.verification.fingerprint !== request.fingerprint
      || candidate.state !== 'valid'
      || candidate.verification.quality !== 'production'
      || candidate.verification.checks.some((check) => check.status !== 'passed')
      || candidate.verification.diagnostics.length > 0) {
      return { ok: false, error: 'candidate-not-production-ready', snapshot: verified.snapshot };
    }
    const approval = await this.approvalStore.approve(request, candidate.mapId, request.fingerprint);
    const activeJob = this.jobStore?.activeFor(request, candidate.mapId);
    const completedJob = activeJob?.phase === 'awaiting-review'
      ? await this.jobStore?.report(activeJob.id, activeJob.activityId, 'completed')
      : activeJob;
    const snapshot: ProjectMapSnapshot = {
      ...verified.snapshot,
      map: candidate,
      candidate,
      displaySource: 'approved',
      approval,
      freshness: 'verified',
      verificationPending: false,
      diff: undefined,
      ...(completedJob ? { activeJob: completedJob } : {}),
    };
    this.snapshots.set(`${requestKey(request)}\u0000${candidate.mapId}`, snapshot);
    this.events.emit('changed', {
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      reason: 'approval-changed',
      impactedMapIds: [candidate.mapId],
    } satisfies ProjectMapChangedEvent);
    return { ok: true, snapshot };
  }

  async approvedDocument(
    request: ProjectMapApprovalRequest,
  ): Promise<ProjectMapDocument | undefined> {
    const approval = this.approvalStore?.get(request, request.mapId ?? '');
    if (!approval || approval.fingerprint !== request.fingerprint) return undefined;
    const bindings = await this.bindingStore.get(request);
    return this.cacheStore.get(approvedCacheKey(request, approval.mapId, bindings, approval.fingerprint));
  }

  async startJob(request: ProjectMapStartJobRequest): Promise<ProjectMapJob> {
    if (!this.jobStore) throw new Error('Project Map jobs are unavailable.');
    const job = await this.jobStore.start(request);
    this.emitJobChanged(request, job);
    return job;
  }

  async cancelJob(request: ProjectMapJobRequest): Promise<ProjectMapJob | undefined> {
    const existing = this.jobStore?.get(request.jobId);
    if (!existing || existing.projectId !== request.projectId || existing.ownerRootId !== request.ownerRootId
      || existing.ownerWorkspaceId !== request.ownerWorkspaceId) return undefined;
    const job = await this.jobStore?.cancel(request.jobId);
    if (job) this.emitJobChanged(request, job);
    return job;
  }

  async reportJob(
    jobId: string,
    activityId: string,
    phase: ProjectMapJob['phase'],
    message?: string,
  ): Promise<ProjectMapJob | undefined> {
    const job = await this.jobStore?.report(jobId, activityId, phase, message);
    if (job) this.emitJobChanged(job, job);
    return job;
  }

  private emitJobChanged(request: ProjectMapCollectionRequest, job: ProjectMapJob): void {
    const key = `${requestKey(request)}\u0000${job.mapId ?? ''}`;
    const current = this.snapshots.get(key);
    if (current) this.snapshots.set(key, { ...current, activeJob: job });
    this.events.emit('changed', {
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      reason: 'job-changed',
      ...(job.mapId ? { impactedMapIds: [job.mapId] } : {}),
    } satisfies ProjectMapChangedEvent);
  }

  private scheduleVerification(
    request: ProjectMapReadRequest,
    manifest: ProjectMapManifest,
    bindings: readonly ProjectMapRootBinding[],
    mapId: string,
  ): void {
    const flightKey = `${requestKey(request)}\u0000${mapId}`;
    if (this.verificationFlights.has(flightKey)) return;
    const flight = this.verificationFlight(request, mapId);
    void flight.then((completed) => this.verifySnapshot(request, manifest, bindings, mapId, completed, true))
      .catch(() => undefined);
  }

  private verificationFlight(request: ProjectMapReadRequest, mapId: string): Promise<ProjectMapReadResult> {
    const flightKey = `${requestKey(request)}\u0000${mapId}`;
    const active = this.verificationFlights.get(flightKey);
    if (active) return active;
    const flight = this.read({ ...request, mapId, quality: 'production' });
    this.verificationFlights.set(flightKey, flight);
    void flight.finally(() => {
      if (this.verificationFlights.get(flightKey) === flight) this.verificationFlights.delete(flightKey);
    }).catch(() => undefined);
    return flight;
  }

  private async verifySnapshot(
    request: ProjectMapReadRequest,
    manifest: ProjectMapManifest,
    bindings: readonly ProjectMapRootBinding[],
    mapId: string,
    completed?: ProjectMapReadResult,
    emitChanged = false,
  ): Promise<ProjectMapOpenResult> {
    const result = completed ?? await this.read({ ...request, mapId, quality: 'production' });
    const approval = this.approvalStore?.get(request, mapId);
    const activeJob = this.jobStore?.activeFor(request, mapId);
    let map: ProjectMapDocument | undefined;
    let candidate: ProjectMapDocument | undefined;
    let displaySource: ProjectMapSnapshot['displaySource'];
    if (result.ok) {
      candidate = result.map;
      if (approval?.fingerprint === candidate.verification.fingerprint) {
        map = candidate;
        displaySource = 'approved';
      } else if (approval) {
        map = await this.cacheStore.get(approvedCacheKey(request, mapId, bindings, approval.fingerprint));
        displaySource = map ? 'last-approved' : 'candidate-preview';
        map ??= candidate;
      } else {
        map = candidate;
        displaySource = 'candidate-preview';
      }
    } else if (result.lastGood) {
      map = result.lastGood;
      displaySource = 'last-approved';
    }
    const collectionState = result.ok ? result.map.state : result.state;
    const snapshot: ProjectMapSnapshot = {
      collection: descriptor(request, collectionState, {
        manifest,
        bindings,
        diagnostics: result.ok ? result.map.verification.diagnostics : result.diagnostics,
      }),
      ...(map ? { map } : {}),
      ...(candidate ? { candidate } : {}),
      ...(displaySource ? { displaySource } : {}),
      freshness: 'verified',
      ...(approval ? { approval } : {}),
      verificationPending: false,
      ...(activeJob ? { activeJob } : {}),
      ...(map && candidate && map.verification.fingerprint !== candidate.verification.fingerprint
        ? { diff: diffProjectMapDocuments(map, candidate) }
        : {}),
    };
    this.snapshots.set(`${requestKey(request)}\u0000${mapId}`, snapshot);
    if (emitChanged) {
      this.events.emit('changed', {
        projectId: request.projectId,
        ownerRootId: request.ownerRootId,
        ownerWorkspaceId: request.ownerWorkspaceId,
        reason: 'verification-complete',
        impactedMapIds: [mapId],
      } satisfies ProjectMapChangedEvent);
    }
    return result.ok || map
      ? { ok: true, snapshot }
      : { ok: false, error: result.error, snapshot };
  }

  async describe(request: ProjectMapCollectionRequest): Promise<ProjectMapDescribeResult> {
    const loaded = await this.loadManifest(request);
    if (!loaded.ok) return loaded.result;
    const bindings = await this.bindingStore.get(request);
    const bindingDiagnostics = await this.validateBindings(request, loaded.value.manifest, bindings);
    if (bindingDiagnostics.length > 0) {
      return {
        ok: true,
        collection: descriptor(request, 'binding-required', {
          manifest: loaded.value.manifest,
          bindings,
          diagnostics: bindingDiagnostics,
        }),
      };
    }
    await this.ensureWatcher(request);
    const read = await this.read({ ...request, mapId: loaded.value.manifest.overviewMapId });
    const state = read.ok ? read.map.state : read.state;
    return {
      ok: true,
      collection: descriptor(request, state, {
        manifest: loaded.value.manifest,
        bindings,
        diagnostics: read.ok ? read.map.verification.diagnostics : read.diagnostics,
      }),
    };
  }

  async setBindings(request: ProjectMapBindingRequest): Promise<ProjectMapDescribeResult> {
    const loaded = await this.loadManifest(request);
    if (!loaded.ok) return loaded.result;
    const diagnostics = await this.validateBindings(request, loaded.value.manifest, request.bindings);
    if (diagnostics.length > 0) {
      return {
        ok: false,
        error: 'invalid-bindings',
        collection: descriptor(request, 'binding-required', {
          manifest: loaded.value.manifest,
          bindings: request.bindings,
          diagnostics,
        }),
      };
    }
    await this.bindingStore.set(request, request.bindings);
    this.closeInputWatchers(request);
    const result = await this.describe(request);
    this.events.emit('changed', { ...request, reason: 'bindings-changed' } satisfies ProjectMapChangedEvent);
    return result;
  }

  async read(request: ProjectMapReadRequest): Promise<ProjectMapReadResult> {
    const quality = request.quality ?? 'production';
    const loaded = await this.loadManifest(request);
    if (!loaded.ok) {
      return {
        ok: false,
        error: loaded.result.error,
        state: loaded.result.collection.state,
        diagnostics: loaded.result.collection.diagnostics,
      };
    }
    const manifest = loaded.value.manifest;
    const mapId = request.mapId ?? manifest.overviewMapId;
    const entry = manifest.maps.find((candidate) => candidate.id === mapId);
    if (!entry) {
      return this.failed(request, mapId, 'map-not-found', [
        diagnostic('manifest.map-not-found', mapId, 'The requested map is not listed in the manifest.'),
      ]);
    }
    const bindings = await this.bindingStore.get(request);
    const bindingDiagnostics = await this.validateBindings(request, manifest, bindings);
    if (bindingDiagnostics.length > 0) {
      return this.failed(request, mapId, 'binding-required', bindingDiagnostics, 'binding-required');
    }
    const context: CollectionContext = {
      request,
      loaded: loaded.value,
      bindings,
      bindingByAlias: new Map(bindings.map((binding) => [binding.rootAlias, binding])),
    };
    await this.ensureWatcher(request);
    const relativeMapPath = `${PROJECT_MAP_DIRECTORY}/${entry.path}`;
    const mapFile = await this.workspaces.readText({
      projectId: request.projectId,
      rootId: request.ownerRootId,
      workspaceId: request.ownerWorkspaceId,
      relativePath: relativeMapPath,
    });
    if (!mapFile.ok) {
      return this.failed(request, mapId, `map-${mapFile.error}`, [
        diagnostic('source.map-unreadable', relativeMapPath, `Map source could not be read: ${mapFile.error}.`),
      ]);
    }
    const parsed = validateProjectMapSpecText(mapFile.file.content);
    if (!parsed.value) return this.failed(request, mapId, 'invalid-map', parsed.diagnostics);
    const spec = parsed.value;
    const diagnostics = [...parsed.diagnostics];
    if (spec.id !== entry.id || spec.type !== entry.type) {
      diagnostics.push(diagnostic(
        'manifest.map-identity-mismatch',
        entry.path,
        `Manifest expects ${entry.id}/${entry.type}, source declares ${spec.id}/${spec.type}.`,
      ));
    }
    const manifestAliases = new Set(manifest.roots.map((root) => root.alias));
    for (const evidence of projectMapEvidence(spec)) {
      if (!manifestAliases.has(evidence.rootAlias)) {
        diagnostics.push(diagnostic(
          'evidence.unknown-root-alias',
          `${evidence.rootAlias}:${evidence.relativePath}`,
          `Evidence uses root alias ${evidence.rootAlias}, which is not declared by the manifest.`,
        ));
      }
    }
    if (diagnostics.some((item) => item.severity === 'error')) {
      return this.failed(request, mapId, 'invalid-map', diagnostics);
    }

    const inputReads = await this.readFiles(context, entry.authoritativeInputs);
    diagnostics.push(...inputReads.diagnostics);
    const evidenceTargets = projectMapEvidence(spec).map((anchor) => ({
      rootAlias: anchor.rootAlias,
      relativePath: anchor.relativePath,
    }));
    const evidenceReads = await this.readFiles(context, evidenceTargets);
    diagnostics.push(...evidenceReads.diagnostics);
    const files = new Map<string, ReadFileRecord>();
    for (const record of [...inputReads.records, ...evidenceReads.records]) {
      files.set(`${record.rootAlias}\u0000${record.relativePath}`, record);
    }
    await this.ensureInputWatchers(context, [...entry.authoritativeInputs, ...evidenceTargets]);
    for (const anchor of projectMapEvidence(spec)) {
      const record = files.get(`${anchor.rootAlias}\u0000${anchor.relativePath}`);
      if (!record?.file) continue;
      const actual = digestProjectMapEvidenceLines(record.file.content, anchor.startLine, anchor.endLine);
      if (!actual) {
        diagnostics.push(diagnostic(
          'evidence.range-outside-file',
          `${anchor.rootAlias}:${anchor.relativePath}:${anchor.startLine}`,
          'Evidence line range is outside the current file.',
        ));
      } else if (actual !== anchor.lineDigest) {
        diagnostics.push(diagnostic(
          'evidence.digest-mismatch',
          `${anchor.rootAlias}:${anchor.relativePath}:${anchor.startLine}`,
          'Evidence lines changed since this claim was reviewed.',
        ));
      }
    }
    if (diagnostics.some((item) => item.severity === 'error')) {
      return this.failed(request, mapId, 'invalid-evidence', diagnostics);
    }

    const inputHash = digestProjectMapInputs(inputReads.records.flatMap((record) => record.file
      ? [{
          rootAlias: record.rootAlias,
          relativePath: record.relativePath,
          version: projectMapInputVersion(record.file.content),
        }]
      : []));
    const stale = inputHash !== entry.review.inputDigest;
    if (stale) {
      diagnostics.push(diagnostic(
        'inputs.review-required',
        entry.id,
        'Authoritative inputs changed after the recorded map review.',
        'warning',
      ));
    }
    const laidOut = layoutProjectMap(spec);
    diagnostics.push(...laidOut.diagnostics);
    if (laidOut.diagnostics.some((item) => item.severity === 'error')) {
      return this.failed(request, mapId, 'invalid-layout', diagnostics);
    }
    const provenanceFiles = new Map(files);
    provenanceFiles.set(`${manifest.ownerRootAlias}\u0000${MANIFEST_PATH}`, {
      rootAlias: manifest.ownerRootAlias,
      relativePath: MANIFEST_PATH,
      file: loaded.value.file,
    });
    provenanceFiles.set(`${manifest.ownerRootAlias}\u0000${relativeMapPath}`, {
      rootAlias: manifest.ownerRootAlias,
      relativePath: relativeMapPath,
      file: mapFile.file,
    });
    const provenance = await this.resolveProvenance(context, entry.path, provenanceFiles);
    diagnostics.push(...provenance.diagnostics);
    if (!provenance.value) return this.failed(request, mapId, 'invalid-provenance', diagnostics);

    const checkStatus = (prefixes: readonly string[]): ProjectMapVerification['checks'][number]['status'] => {
      const relevant = diagnostics.filter((item) => prefixes.some((prefix) => item.code.startsWith(prefix)));
      if (relevant.some((item) => item.severity === 'error')) return 'failed';
      return relevant.some((item) => item.severity === 'warning') ? 'warning' : 'passed';
    };
    const checks: ProjectMapVerification['checks'] = [
      { name: 'schema', status: checkStatus(['schema.', 'source.']) },
      { name: 'semantics', status: checkStatus(['semantic.', 'manifest.']) },
      { name: 'evidence', status: checkStatus(['evidence.']) },
      { name: 'inputs', status: stale ? 'warning' : checkStatus(['inputs.']) },
      { name: 'layout', status: checkStatus(['layout.node-', 'layout.invalid-']) },
      { name: 'routes', status: checkStatus(['routes.']) },
      { name: 'labels', status: checkStatus(['labels.', 'layout.dense-label']) },
      { name: 'containment', status: checkStatus(['containment.']) },
      { name: 'accessibility', status: checkStatus(['accessibility.']) },
      { name: 'provenance', status: checkStatus(['provenance.']) },
    ];
    const layoutHash = sha256(JSON.stringify(laidOut.layout));
    const fingerprint = sha256(JSON.stringify({
      qualityGateVersion: PROJECT_MAP_QUALITY_GATE_VERSION,
      collectionId: manifest.collectionId,
      ownerRootAlias: manifest.ownerRootAlias,
      roots: manifest.roots,
      map: entry,
      specHash: mapFile.file.version,
      inputHash,
      layoutHash,
      bindings: [...bindings].sort((left, right) => compareText(left.rootAlias, right.rootAlias)),
      provenance: {
        kind: provenance.value.kind,
        roots: provenance.value.roots.map((root) => ({
          rootAlias: root.rootAlias,
          head: root.head,
          dirty: root.dirty,
        })),
      },
    }));
    const verification: ProjectMapVerification = {
      quality,
      fingerprint,
      verifiedAt: new Date().toISOString(),
      manifestHash: `sha256:${loaded.value.file.version}`,
      specHash: `sha256:${mapFile.file.version}`,
      inputHash,
      layoutHash,
      checks,
      diagnostics,
    };
    const document: ProjectMapDocument = {
      collectionId: manifest.collectionId,
      mapId,
      mapPath: relativeMapPath,
      state: stale ? 'stale' : 'valid',
      spec,
      layout: laidOut.layout,
      provenance: provenance.value,
      verification,
      fromLastGood: false,
    };
    const productionReady = quality === 'production'
      && !stale
      && checks.every((check) => check.status === 'passed')
      && diagnostics.length === 0;
    if (productionReady) {
      await Promise.all([
        this.cacheStore.put(cacheKey(request, mapId, bindings), document),
        this.cacheStore.put(approvedCacheKey(request, mapId, bindings, fingerprint), document),
      ]);
    }
    return { ok: true, map: document };
  }

  close(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    for (const timeout of this.pendingChanges.values()) clearTimeout(timeout);
    this.pendingChanges.clear();
    this.pendingImpacts.clear();
    this.snapshots.clear();
  }

  private async loadManifest(request: ProjectMapCollectionRequest): Promise<
    | { readonly ok: true; readonly value: LoadedManifest }
    | { readonly ok: false; readonly result: ProjectMapDescribeResult & { readonly ok: false } }
  > {
    const result = await this.workspaces.readText({
      projectId: request.projectId,
      rootId: request.ownerRootId,
      workspaceId: request.ownerWorkspaceId,
      relativePath: MANIFEST_PATH,
    });
    if (!result.ok) {
      const state = result.error === 'not-found' ? 'empty' : 'invalid';
      const diagnostics = result.error === 'not-found' ? [] : [
        diagnostic('source.manifest-unreadable', MANIFEST_PATH, `Manifest could not be read: ${result.error}.`),
      ];
      return {
        ok: false,
        result: {
          ok: false,
          error: result.error === 'not-found' ? 'manifest-not-found' : `manifest-${result.error}`,
          collection: descriptor(request, state, { diagnostics }),
        },
      };
    }
    const parsed = validateProjectMapManifestText(result.file.content);
    if (!parsed.value) {
      return {
        ok: false,
        result: {
          ok: false,
          error: 'invalid-manifest',
          collection: descriptor(request, 'invalid', { diagnostics: parsed.diagnostics }),
        },
      };
    }
    const reverse = new Map<string, string[]>();
    for (const map of parsed.value.maps) {
      for (const input of map.authoritativeInputs) {
        const key = `${input.rootAlias}\u0000${input.relativePath}`;
        const ids = reverse.get(key) ?? [];
        if (!ids.includes(map.id)) ids.push(map.id);
        reverse.set(key, ids);
      }
    }
    this.impactedByInput.set(requestKey(request), reverse);
    return { ok: true, value: { manifest: parsed.value, file: result.file } };
  }

  private async validateBindings(
    request: ProjectMapCollectionRequest,
    manifest: ProjectMapManifest,
    bindings: readonly ProjectMapRootBinding[],
  ): Promise<ProjectMapDiagnostic[]> {
    const diagnostics: ProjectMapDiagnostic[] = [];
    const bindingByAlias = new Map(bindings.map((binding) => [binding.rootAlias, binding]));
    if (bindingByAlias.size !== bindings.length) {
      diagnostics.push(diagnostic('binding.duplicate-alias', 'bindings', 'Each logical root alias must have one binding.'));
    }
    for (const root of manifest.roots) {
      if (!bindingByAlias.has(root.alias)) {
        diagnostics.push(diagnostic(
          'binding.missing-alias',
          root.alias,
          `Choose a project root and workspace for ${root.label}.`,
        ));
      }
    }
    for (const binding of bindings) {
      if (!manifest.roots.some((root) => root.alias === binding.rootAlias)) {
        diagnostics.push(diagnostic(
          'binding.unknown-alias',
          binding.rootAlias,
          'Binding is not declared by the Project Map manifest.',
        ));
        continue;
      }
      const resolved = await this.workspaces.resolveProjectPath({
        projectId: request.projectId,
        rootId: binding.rootId,
        workspaceId: binding.workspaceId,
        relativePath: '',
      });
      if (!resolved.ok) {
        diagnostics.push(diagnostic(
          'binding.unavailable-workspace',
          binding.rootAlias,
          `Bound workspace is unavailable: ${resolved.error}.`,
        ));
      }
    }
    const owner = bindingByAlias.get(manifest.ownerRootAlias);
    if (owner && (owner.rootId !== request.ownerRootId || owner.workspaceId !== request.ownerWorkspaceId)) {
      diagnostics.push(diagnostic(
        'binding.owner-mismatch',
        manifest.ownerRootAlias,
        'The manifest owner alias must bind to the workspace that owns the collection.',
      ));
    }
    return diagnostics;
  }

  private async readFiles(
    context: CollectionContext,
    targets: readonly { readonly rootAlias: string; readonly relativePath: string }[],
  ): Promise<{ readonly records: readonly ReadFileRecord[]; readonly diagnostics: readonly ProjectMapDiagnostic[] }> {
    const diagnostics: ProjectMapDiagnostic[] = [];
    const unique = new Map(targets.map((target) => [`${target.rootAlias}\u0000${target.relativePath}`, target]));
    const records = await Promise.all([...unique.values()].map(async (target): Promise<ReadFileRecord> => {
      const binding = context.bindingByAlias.get(target.rootAlias);
      if (!binding) {
        diagnostics.push(diagnostic(
          'binding.missing-alias',
          target.rootAlias,
          'No local root binding exists for this source.',
        ));
        return target;
      }
      const read = await this.workspaces.readText({
        projectId: context.request.projectId,
        rootId: binding.rootId,
        workspaceId: binding.workspaceId,
        relativePath: target.relativePath,
      });
      if (!read.ok) {
        diagnostics.push(diagnostic(
          'source.authoritative-input-unreadable',
          `${target.rootAlias}:${target.relativePath}`,
          `Referenced source could not be read: ${read.error}.`,
        ));
        return target;
      }
      return { ...target, file: read.file };
    }));
    return { records, diagnostics };
  }

  private async resolveProvenance(
    context: CollectionContext,
    mapPath: string,
    files: ReadonlyMap<string, ReadFileRecord>,
  ): Promise<{
    readonly value?: { readonly kind: 'commit-pinned' | 'worktree-snapshot'; readonly roots: readonly ProjectMapRootProvenance[] };
    readonly diagnostics: readonly ProjectMapDiagnostic[];
  }> {
    const diagnostics: ProjectMapDiagnostic[] = [];
    const roots: ProjectMapRootProvenance[] = [];
    for (const manifestRoot of context.loaded.manifest.roots) {
      const binding = context.bindingByAlias.get(manifestRoot.alias);
      if (!binding) continue;
      const resolved = await this.workspaces.resolveProjectPath({
        projectId: context.request.projectId,
        rootId: binding.rootId,
        workspaceId: binding.workspaceId,
        relativePath: '',
      });
      if (!resolved.ok) {
        diagnostics.push(diagnostic('provenance.root-unavailable', manifestRoot.alias, resolved.error));
        continue;
      }
      const rootPath = resolved.value.absolutePath;
      const relevant = [...files.values()]
        .filter((record) => record.rootAlias === manifestRoot.alias)
        .map((record) => record.relativePath);
      if (manifestRoot.alias === context.loaded.manifest.ownerRootAlias) {
        relevant.push(MANIFEST_PATH, `${PROJECT_MAP_DIRECTORY}/${mapPath}`);
      }
      const uniqueRelevant = [...new Set(relevant)].sort();
      try {
        const [gitTopRaw, headRaw, status] = await Promise.all([
          this.git.run(rootPath, [...SAFE_GIT_PREFIX, 'rev-parse', '--show-toplevel']),
          this.git.run(rootPath, [...SAFE_GIT_PREFIX, 'rev-parse', 'HEAD']),
          this.git.run(rootPath, [
            ...SAFE_GIT_PREFIX,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--',
            ...uniqueRelevant,
          ]),
        ]);
        const gitTop = await fs.realpath(gitTopRaw.trim());
        const realRoot = await fs.realpath(rootPath);
        if (!samePath(gitTop, realRoot)) {
          diagnostics.push(diagnostic(
            'provenance.root-not-git-top-level',
            manifestRoot.alias,
            'Project Map v1 requires each bound root to be a Git top-level checkout.',
          ));
          continue;
        }
        const head = headRaw.trim();
        const dirty = status.length > 0;
        const snapshotHash = dirty
          ? sha256(JSON.stringify({
              head,
              status,
              files: [...files.values()]
                .filter((record) => record.rootAlias === manifestRoot.alias)
                .map((record) => [record.relativePath, record.file?.version ?? 'missing'])
                .sort((left, right) => compareText(left[0], right[0])),
            }))
          : undefined;
        roots.push({ rootAlias: manifestRoot.alias, head, dirty, ...(snapshotHash ? { snapshotHash } : {}) });
      } catch {
        diagnostics.push(diagnostic(
          'provenance.git-failed',
          manifestRoot.alias,
          'Could not establish local Git provenance for this root.',
        ));
      }
    }
    if (diagnostics.some((item) => item.severity === 'error')
      || roots.length !== context.loaded.manifest.roots.length) {
      return { diagnostics };
    }
    return {
      value: { kind: roots.some((root) => root.dirty) ? 'worktree-snapshot' : 'commit-pinned', roots },
      diagnostics,
    };
  }

  private async failed(
    request: ProjectMapCollectionRequest,
    mapId: string,
    error: string,
    diagnostics: readonly ProjectMapDiagnostic[],
    state: 'binding-required' | 'invalid' = 'invalid',
  ): Promise<ProjectMapReadResult> {
    const bindings = await this.bindingStore.get(request);
    const lastGood = await this.cacheStore.get(cacheKey(request, mapId, bindings));
    if (lastGood) {
      return {
        ok: false,
        error,
        state: 'invalid-with-last-good',
        diagnostics,
        lastGood: {
          ...lastGood,
          state: 'invalid-with-last-good',
          fromLastGood: true,
          verification: {
            ...lastGood.verification,
            diagnostics: [...diagnostics, ...lastGood.verification.diagnostics],
          },
        },
      };
    }
    return { ok: false, error, state, diagnostics };
  }

  private async ensureWatcher(request: ProjectMapCollectionRequest): Promise<void> {
    const key = `collection\u0000${requestKey(request)}`;
    if (this.watchers.has(key)) return;
    const resolved = await this.workspaces.resolveProjectPath({
      projectId: request.projectId,
      rootId: request.ownerRootId,
      workspaceId: request.ownerWorkspaceId,
      relativePath: PROJECT_MAP_DIRECTORY,
    });
    if (!resolved.ok) return;
    try {
      const watcher = watch(resolved.value.absolutePath, { recursive: true }, () => {
        this.scheduleChanged(request, undefined);
      });
      watcher.on('error', () => {
        this.closeWatcher(key);
      });
      this.watchers.set(key, watcher);
    } catch {
      // Manual refresh remains available on filesystems without recursive watch.
    }
  }

  private async ensureInputWatchers(
    context: CollectionContext,
    targets: readonly { readonly rootAlias: string; readonly relativePath: string }[],
  ): Promise<void> {
    const unique = new Map(targets.map((target) => [`${target.rootAlias}\u0000${target.relativePath}`, target]));
    await Promise.all([...unique.values()].map(async (target) => {
      const binding = context.bindingByAlias.get(target.rootAlias);
      if (!binding) return;
      const key = `input\u0000${requestKey(context.request)}\u0000${target.rootAlias}\u0000${binding.rootId}\u0000${binding.workspaceId}\u0000${target.relativePath}`;
      if (this.watchers.has(key)) return;
      const resolved = await this.workspaces.resolveProjectPath({
        projectId: context.request.projectId,
        rootId: binding.rootId,
        workspaceId: binding.workspaceId,
        relativePath: target.relativePath,
      });
      if (!resolved.ok) return;
      try {
        const watcher = watch(resolved.value.absolutePath, () => {
          // A file may have been atomically replaced. Drop the inode-bound watcher;
          // the change event reload registers a watcher for the replacement file.
          this.closeWatcher(key);
          const impacted = this.impactedByInput.get(requestKey(context.request))
            ?.get(`${target.rootAlias}\u0000${target.relativePath}`);
          this.scheduleChanged(context.request, impacted);
        });
        watcher.on('error', () => {
          this.closeWatcher(key);
        });
        this.watchers.set(key, watcher);
      } catch {
        // Manual refresh remains available when an individual source cannot be watched.
      }
    }));
  }

  private scheduleChanged(
    request: ProjectMapCollectionRequest,
    impactedMapIds?: readonly string[],
  ): void {
    const key = `changed\u0000${requestKey(request)}`;
    const impacts = this.pendingImpacts.get(key) ?? new Set<string>();
    for (const mapId of impactedMapIds ?? []) impacts.add(mapId);
    this.pendingImpacts.set(key, impacts);
    const pending = this.pendingChanges.get(key);
    if (pending) clearTimeout(pending);
    this.pendingChanges.set(key, setTimeout(() => {
      this.pendingChanges.delete(key);
      const finalImpacts = this.pendingImpacts.get(key);
      this.pendingImpacts.delete(key);
      const impacted = finalImpacts && finalImpacts.size > 0 ? [...finalImpacts].sort() : undefined;
      const prefix = `${requestKey(request)}\u0000`;
      for (const [snapshotKey, snapshot] of this.snapshots) {
        if (!snapshotKey.startsWith(prefix)) continue;
        const mapId = snapshot.map?.mapId ?? snapshot.candidate?.mapId;
        if (impacted && mapId && !impacted.includes(mapId)) continue;
        this.snapshots.set(snapshotKey, { ...snapshot, verificationPending: true });
      }
      this.events.emit('changed', {
        ...request,
        reason: 'source-changed',
        ...(impacted ? { impactedMapIds: impacted } : {}),
      } satisfies ProjectMapChangedEvent);
    }, 120));
  }

  private closeWatcher(key: string): void {
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
  }

  private closeInputWatchers(request: ProjectMapCollectionRequest): void {
    const prefix = `input\u0000${requestKey(request)}\u0000`;
    for (const key of this.watchers.keys()) {
      if (key.startsWith(prefix)) this.closeWatcher(key);
    }
  }
}
