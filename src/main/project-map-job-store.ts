import { randomUUID } from 'node:crypto';

import type {
  ProjectMapCollectionRequest,
  ProjectMapJob,
  ProjectMapJobPhase,
  ProjectMapStartJobRequest,
} from '../shared/project-map';
import { JsonFile } from './json-file';

const SCHEMA_VERSION = 1 as const;
const MAX_JOBS = 128;
const TERMINAL_PHASES = new Set<ProjectMapJobPhase>(['completed', 'failed', 'canceled']);
const PHASES: readonly ProjectMapJobPhase[] = [
  'queued', 'analyzing', 'authoring', 'validating-draft', 'validating-production',
  'awaiting-review', 'completed', 'failed', 'cancel-requested', 'canceled',
];

interface JobFile {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly jobs: readonly ProjectMapJob[];
}

const EMPTY: JobFile = { schemaVersion: SCHEMA_VERSION, jobs: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validText(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && ![...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20);
}

function validateJob(value: unknown): value is ProjectMapJob {
  if (!isRecord(value)) return false;
  const allowed = [
    'id', 'projectId', 'ownerRootId', 'ownerWorkspaceId', 'mapId', 'type', 'intent', 'activityId',
    'dispatch', 'agentLabel', 'phase', 'createdAt', 'updatedAt', 'message',
  ];
  return Object.keys(value).every((key) => allowed.includes(key))
    && validText(value.id)
    && validText(value.projectId)
    && validText(value.ownerRootId)
    && validText(value.ownerWorkspaceId)
    && (value.mapId === undefined || (typeof value.mapId === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value.mapId)))
    && typeof value.type === 'string'
    && ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'].includes(value.type)
    && (value.intent === 'create' || value.intent === 'update')
    && validText(value.activityId)
    && (value.dispatch === undefined
      || value.dispatch === 'existing-session'
      || value.dispatch === 'dedicated-session')
    && (value.agentLabel === undefined || validText(value.agentLabel))
    && typeof value.phase === 'string'
    && PHASES.includes(value.phase as ProjectMapJobPhase)
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
    && (value.message === undefined || validText(value.message, 512));
}

function validateFile(value: unknown): JobFile | null {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.jobs)
    || value.jobs.length > MAX_JOBS || !value.jobs.every(validateJob)) return null;
  const ids = new Set(value.jobs.map((job) => job.id));
  if (ids.size !== value.jobs.length) return null;
  return { schemaVersion: SCHEMA_VERSION, jobs: [...value.jobs] };
}

function sameCollection(job: ProjectMapJob, request: ProjectMapCollectionRequest): boolean {
  return job.projectId === request.projectId
    && job.ownerRootId === request.ownerRootId
    && job.ownerWorkspaceId === request.ownerWorkspaceId;
}

function mayTransition(from: ProjectMapJobPhase, to: ProjectMapJobPhase): boolean {
  if (from === to) return true;
  const allowed: Readonly<Record<ProjectMapJobPhase, readonly ProjectMapJobPhase[]>> = {
    queued: ['analyzing', 'failed', 'canceled'],
    analyzing: ['authoring', 'failed', 'canceled'],
    authoring: ['validating-draft', 'failed', 'canceled'],
    'validating-draft': ['authoring', 'validating-production', 'failed', 'canceled'],
    'validating-production': ['authoring', 'awaiting-review', 'failed', 'canceled'],
    'awaiting-review': ['authoring', 'completed', 'failed', 'canceled'],
    'cancel-requested': ['canceled', 'failed'],
    completed: [],
    failed: [],
    canceled: [],
  };
  return allowed[from].includes(to);
}

export class ProjectMapJobStore {
  private readonly file: JsonFile;
  private snapshot: JobFile = EMPTY;

  constructor(userDataDir: string) {
    this.file = new JsonFile(userDataDir, 'project-map-jobs.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    this.snapshot = await this.file.readValidated(validateFile, EMPTY);
  }

  activeFor(request: ProjectMapCollectionRequest, mapId?: string): ProjectMapJob | undefined {
    return [...this.snapshot.jobs].reverse().find((job) => sameCollection(job, request)
      && !TERMINAL_PHASES.has(job.phase)
      && (mapId === undefined || job.mapId === undefined || job.mapId === mapId));
  }

  get(jobId: string): ProjectMapJob | undefined {
    return this.snapshot.jobs.find((job) => job.id === jobId);
  }

  async start(request: ProjectMapStartJobRequest): Promise<ProjectMapJob> {
    const existing = this.activeFor(request, request.mapId);
    if (existing) throw new Error('A Project Map job is already active for this map.');
    const now = new Date().toISOString();
    const job: ProjectMapJob = {
      id: randomUUID(),
      projectId: request.projectId,
      ownerRootId: request.ownerRootId,
      ownerWorkspaceId: request.ownerWorkspaceId,
      ...(request.mapId ? { mapId: request.mapId } : {}),
      type: request.type,
      intent: request.intent,
      activityId: request.activityId,
      ...(request.dispatch ? { dispatch: request.dispatch } : {}),
      ...(request.agentLabel ? { agentLabel: request.agentLabel } : {}),
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    await this.replace(job);
    return job;
  }

  async cancel(jobId: string): Promise<ProjectMapJob | undefined> {
    const job = this.get(jobId);
    if (!job || TERMINAL_PHASES.has(job.phase)) return job;
    return this.update(job, job.phase === 'queued' ? 'canceled' : 'cancel-requested');
  }

  async report(
    jobId: string,
    activityId: string,
    phase: ProjectMapJobPhase,
    message?: string,
  ): Promise<ProjectMapJob | undefined> {
    const job = this.get(jobId);
    if (!job || job.activityId !== activityId || job.phase === 'canceled' || job.phase === 'completed') return undefined;
    if (job.phase === 'cancel-requested' && phase !== 'canceled' && phase !== 'failed') return undefined;
    if (!mayTransition(job.phase, phase)) return undefined;
    return this.update(job, phase, message);
  }

  private update(job: ProjectMapJob, phase: ProjectMapJobPhase, message?: string): Promise<ProjectMapJob> {
    const updated: ProjectMapJob = {
      ...job,
      phase,
      updatedAt: new Date().toISOString(),
      ...(message ? { message: message.slice(0, 512) } : {}),
    };
    return this.replace(updated).then(() => updated);
  }

  private async replace(job: ProjectMapJob): Promise<void> {
    const updated = await this.file.update(
      validateFile,
      EMPTY,
      (current) => ({
        schemaVersion: SCHEMA_VERSION,
        jobs: [...current.jobs.filter((candidate) => candidate.id !== job.id), job].slice(-MAX_JOBS),
      }),
      'update project map job',
    );
    if (!updated) throw new Error('Could not persist Project Map job.');
    this.snapshot = updated;
  }

  flush(): Promise<void> {
    return this.file.flush();
  }
}
