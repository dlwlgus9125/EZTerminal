import {
  AGENT_COORDINATION_SCHEMA_VERSION,
  MAX_AGENT_AUDIT_RECORDS,
  MAX_AGENT_VALIDATIONS,
  type AgentProjectCoordination,
  type AgentProjectCoordinationInput,
  type AgentValidationCommand,
  type ManagedMergeAuditRecord,
  isSafeLocalBranch,
} from '../shared/agent-coordination';
import { JsonFile } from './json-file';

interface StoredProjectCoordination {
  readonly projectId: string;
  readonly goal: string;
  readonly defaultTargetBranch: string;
  readonly validationCommands: readonly AgentValidationCommand[];
  readonly configRevision: number;
  readonly updatedAt: number;
}

interface AgentCoordinationFile {
  readonly version: typeof AGENT_COORDINATION_SCHEMA_VERSION;
  readonly projects: readonly StoredProjectCoordination[];
  readonly audit: readonly ManagedMergeAuditRecord[];
}

const EMPTY_FILE: AgentCoordinationFile = {
  version: AGENT_COORDINATION_SCHEMA_VERSION,
  projects: [],
  audit: [],
};

function isValidationCommand(value: unknown): value is AgentValidationCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const command = value as Partial<AgentValidationCommand>;
  return typeof command.id === 'string'
    && command.id.length > 0
    && command.id.length <= 128
    && typeof command.name === 'string'
    && command.name.trim().length > 0
    && command.name.length <= 120
    && typeof command.command === 'string'
    && command.command.trim().length > 0
    && command.command.length <= 8_192
    && typeof command.timeoutMs === 'number'
    && Number.isFinite(command.timeoutMs)
    && command.timeoutMs >= 1_000
    && command.timeoutMs <= 30 * 60_000;
}

function isStoredProject(value: unknown): value is StoredProjectCoordination {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const project = value as Partial<StoredProjectCoordination>;
  return typeof project.projectId === 'string'
    && project.projectId.length > 0
    && project.projectId.length <= 128
    && typeof project.goal === 'string'
    && project.goal.trim().length > 0
    && project.goal.length <= 2_000
    && isSafeLocalBranch(project.defaultTargetBranch)
    && Array.isArray(project.validationCommands)
    && project.validationCommands.length <= MAX_AGENT_VALIDATIONS
    && project.validationCommands.every(isValidationCommand)
    && new Set(project.validationCommands.map((command) => command.id)).size === project.validationCommands.length
    && typeof project.configRevision === 'number'
    && Number.isSafeInteger(project.configRevision)
    && project.configRevision > 0
    && typeof project.updatedAt === 'number'
    && Number.isFinite(project.updatedAt);
}

const AUDIT_OUTCOMES = new Set([
  'preparing', 'validating', 'approval-required', 'override-required', 'merging',
  'merged', 'denied', 'conflict', 'stale', 'failed', 'interrupted', 'already-integrated',
]);
const AUDIT_VALIDATION_STATES = new Set([
  'pending', 'running', 'passed', 'failed', 'timed-out', 'cancelled',
]);

function isAuditValidation(value: unknown): value is ManagedMergeAuditRecord['validations'][number] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const validation = value as Partial<ManagedMergeAuditRecord['validations'][number]>;
  return typeof validation.name === 'string'
    && validation.name.trim().length > 0
    && validation.name.length <= 120
    && typeof validation.status === 'string'
    && AUDIT_VALIDATION_STATES.has(validation.status)
    && (validation.durationMs === undefined
      || (typeof validation.durationMs === 'number' && Number.isFinite(validation.durationMs) && validation.durationMs >= 0))
    && (validation.exitCode === undefined
      || (typeof validation.exitCode === 'number' && Number.isSafeInteger(validation.exitCode)))
    && (validation.digest === undefined
      || (typeof validation.digest === 'string' && /^[0-9a-f]{64}$/u.test(validation.digest)));
}

function isAuditRecord(value: unknown): value is ManagedMergeAuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<ManagedMergeAuditRecord>;
  return typeof record.auditId === 'string'
    && typeof record.requestId === 'string'
    && typeof record.projectId === 'string'
    && typeof record.participantId === 'string'
    && typeof record.sourceWorkspaceId === 'string'
    && typeof record.sourceBranch === 'string'
    && typeof record.sourceHead === 'string'
    && typeof record.targetBranch === 'string'
    && typeof record.targetHead === 'string'
    && Array.isArray(record.validations)
    && record.validations.length <= MAX_AGENT_VALIDATIONS
    && record.validations.every(isAuditValidation)
    && typeof record.outcome === 'string'
    && AUDIT_OUTCOMES.has(record.outcome)
    && (record.decisionActor === undefined || ['desktop', 'mobile', 'grant'].includes(record.decisionActor))
    && (record.overrideReason === undefined
      || (typeof record.overrideReason === 'string' && record.overrideReason.length <= 500))
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt)
    && typeof record.finishedAt === 'number'
    && Number.isFinite(record.finishedAt);
}

function storedAudit(record: ManagedMergeAuditRecord): ManagedMergeAuditRecord {
  return {
    auditId: record.auditId,
    requestId: record.requestId,
    projectId: record.projectId,
    participantId: record.participantId,
    sourceWorkspaceId: record.sourceWorkspaceId,
    sourceBranch: record.sourceBranch,
    sourceHead: record.sourceHead,
    targetBranch: record.targetBranch,
    targetHead: record.targetHead,
    ...(record.candidateHead === undefined ? {} : { candidateHead: record.candidateHead }),
    validations: record.validations.map((validation) => ({
      name: validation.name,
      status: validation.status,
      ...(validation.durationMs === undefined ? {} : { durationMs: validation.durationMs }),
      ...(validation.exitCode === undefined ? {} : { exitCode: validation.exitCode }),
      ...(validation.digest === undefined ? {} : { digest: validation.digest }),
    })),
    ...(record.decisionActor === undefined ? {} : { decisionActor: record.decisionActor }),
    outcome: record.outcome,
    ...(record.overrideReason === undefined ? {} : { overrideReason: record.overrideReason }),
    createdAt: record.createdAt,
    finishedAt: record.finishedAt,
  };
}

function parseFile(value: unknown): AgentCoordinationFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const file = value as Partial<AgentCoordinationFile>;
  if (
    file.version !== AGENT_COORDINATION_SCHEMA_VERSION
    || !Array.isArray(file.projects)
    || !file.projects.every(isStoredProject)
    || !Array.isArray(file.audit)
    || file.audit.length > MAX_AGENT_AUDIT_RECORDS
    || !file.audit.every(isAuditRecord)
  ) return null;
  return {
    version: AGENT_COORDINATION_SCHEMA_VERSION,
    projects: file.projects,
    audit: file.audit.map(storedAudit),
  };
}

function publicProject(project: StoredProjectCoordination): AgentProjectCoordination {
  return { ...project, participants: [] };
}

export class AgentCoordinationStore {
  private readonly file: JsonFile;
  private snapshot: AgentCoordinationFile = EMPTY_FILE;

  constructor(userDataDirectory: string) {
    this.file = new JsonFile(userDataDirectory, 'agent-coordination.json');
  }

  async init(): Promise<void> {
    await this.file.init();
    const raw = await this.file.read();
    if (raw === undefined) return;
    const parsed = parseFile(raw);
    if (!parsed) {
      await this.file.quarantine();
      this.snapshot = EMPTY_FILE;
      return;
    }
    this.snapshot = parsed;
  }

  listProjects(): readonly AgentProjectCoordination[] {
    return this.snapshot.projects.map(publicProject);
  }

  getProject(projectId: string): AgentProjectCoordination | null {
    const project = this.snapshot.projects.find((entry) => entry.projectId === projectId);
    return project ? publicProject(project) : null;
  }

  async saveProject(input: AgentProjectCoordinationInput): Promise<
    | { readonly ok: true; readonly project: AgentProjectCoordination }
    | { readonly ok: false; readonly reason: 'invalid' | 'stale' }
  > {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (
      typeof input.projectId !== 'string'
      || input.projectId.length < 1
      || input.projectId.length > 128
    || goal.length < 1
    || goal.length > 2_000
      || !isSafeLocalBranch(input.defaultTargetBranch)
      || !Array.isArray(input.validationCommands)
      || input.validationCommands.length > MAX_AGENT_VALIDATIONS
      || !input.validationCommands.every(isValidationCommand)
      || new Set(input.validationCommands.map((command) => command.id)).size !== input.validationCommands.length
    ) return { ok: false, reason: 'invalid' };

    return this.file.enqueue(async () => {
      const projects = [...this.snapshot.projects];
      const index = projects.findIndex((project) => project.projectId === input.projectId);
      const current = index >= 0 ? projects[index]! : null;
      if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.configRevision ?? 0)) {
        return { ok: false, reason: 'stale' } as const;
      }
      const next: StoredProjectCoordination = {
        projectId: input.projectId,
        goal,
        defaultTargetBranch: input.defaultTargetBranch,
        validationCommands: input.validationCommands.map((command) => ({
          id: command.id,
          name: command.name.trim(),
          command: command.command.trim(),
          timeoutMs: Math.round(command.timeoutMs),
        })),
        configRevision: (current?.configRevision ?? 0) + 1,
        updatedAt: Date.now(),
      };
      if (index >= 0) projects[index] = next;
      else projects.push(next);
      this.snapshot = { ...this.snapshot, projects };
      await this.persist();
      return { ok: true, project: publicProject(next) } as const;
    });
  }

  removeProject(projectId: string): Promise<boolean> {
    if (typeof projectId !== 'string' || projectId.length < 1 || projectId.length > 128) {
      return Promise.resolve(false);
    }
    return this.file.enqueue(async () => {
      const projects = this.snapshot.projects.filter((project) => project.projectId !== projectId);
      if (projects.length === this.snapshot.projects.length) return false;
      const next = { ...this.snapshot, projects };
      await this.file.writeAtomic(JSON.stringify(next));
      this.snapshot = next;
      return true;
    });
  }

  listAudit(projectId?: string): readonly ManagedMergeAuditRecord[] {
    return projectId
      ? this.snapshot.audit.filter((record) => record.projectId === projectId)
      : this.snapshot.audit;
  }

  appendAudit(record: ManagedMergeAuditRecord): Promise<void> {
    return this.file.enqueue(async () => {
      if (!isAuditRecord(record)) throw new Error('Invalid managed merge audit record.');
      const audit = [...this.snapshot.audit, storedAudit(record)].slice(-MAX_AGENT_AUDIT_RECORDS);
      this.snapshot = { ...this.snapshot, audit };
      await this.persist();
    });
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  private persist(): Promise<void> {
    return this.file.writeAtomic(JSON.stringify(this.snapshot));
  }
}
