import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION,
  AGENT_ORCHESTRATION_SCHEMA_VERSION,
  CollaborationEventSchema,
  CollaborationPolicySchema,
  CollaborationRunSchema,
  DEFAULT_COLLABORATION_LIMITS,
  DEFAULT_COLLABORATION_MERGE_POLICY,
  MAX_ORCHESTRATION_RUNS,
  type AgentOrchestrationMutationResult,
  type CollaborationEvent,
  type CollaborationPolicy,
  type CollaborationPolicyInput,
  type CollaborationRun,
  type LegacyTeamMigrationStatus,
  isTerminalCollaborationRun,
  isTerminalCollaborationTask,
  normalizeWriteScope,
} from '../shared/agent-orchestration';
import { JsonFile } from './json-file';

const MAX_EVENT_RECORDS = 512;
const MIGRATION_VERSION = 1 as const;

interface PolicyFile {
  readonly version: typeof AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION;
  readonly revision: number;
  readonly policies: readonly CollaborationPolicy[];
}

interface RunFile {
  readonly version: typeof AGENT_ORCHESTRATION_SCHEMA_VERSION;
  readonly revision: number;
  readonly runs: readonly CollaborationRun[];
  readonly events: readonly CollaborationEvent[];
}

interface MigrationMarker {
  readonly version: typeof MIGRATION_VERSION;
  readonly confirmedAt: number;
}

const EMPTY_POLICIES: PolicyFile = {
  version: AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION,
  revision: 0,
  policies: [],
};

const EMPTY_RUNS: RunFile = {
  version: AGENT_ORCHESTRATION_SCHEMA_VERSION,
  revision: 0,
  runs: [],
  events: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRunGraph(run: CollaborationRun): boolean {
  const taskIds = new Set(run.tasks.map((task) => task.taskId));
  if (taskIds.size !== run.tasks.length) return false;
  const workers = new Set<string>();
  const workerSessions = new Set<string>();
  const workerActivities = new Set<string>();
  for (const task of run.tasks) {
    if (new Set(task.dependsOn).size !== task.dependsOn.length
      || task.dependsOn.includes(task.taskId)
      || task.dependsOn.some((dependency) => !taskIds.has(dependency))) return false;
    if (task.mode === 'write' && task.writeScopes.length === 0) return false;
    if (task.mode !== 'write' && task.writeScopes.length > 0) return false;
    if (task.mode === 'verify') {
      if (!task.verifiesTaskId || !task.dependsOn.includes(task.verifiesTaskId)) return false;
      if (run.tasks.find((candidate) => candidate.taskId === task.verifiesTaskId)?.mode !== 'write') return false;
    } else if (task.verifiesTaskId !== undefined) return false;
    if (task.worker) {
      if (task.worker.taskId !== task.taskId || workers.has(task.worker.workerId)) return false;
      workers.add(task.worker.workerId);
      if (task.worker.sessionId) {
        if (workerSessions.has(task.worker.sessionId)) return false;
        workerSessions.add(task.worker.sessionId);
      }
      if (task.worker.activityId) {
        if (workerActivities.has(task.worker.activityId)) return false;
        workerActivities.add(task.worker.activityId);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(run.tasks.map((task) => [task.taskId, task]));
  const visit = (taskId: string): boolean => {
    if (visited.has(taskId)) return true;
    if (visiting.has(taskId)) return false;
    visiting.add(taskId);
    const task = byId.get(taskId);
    if (!task || task.dependsOn.some((dependency) => !visit(dependency))) return false;
    visiting.delete(taskId);
    visited.add(taskId);
    return true;
  };
  return run.tasks.every((task) => visit(task.taskId));
}

function parsePolicyFile(value: unknown): PolicyFile | null {
  if (!isRecord(value)
    || value.version !== AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.policies)) return null;
  const parsed = value.policies.map((entry) => CollaborationPolicySchema.safeParse(entry));
  if (parsed.some((entry) => !entry.success)) return null;
  const policies = parsed.map((entry) => entry.data!);
  if (new Set(policies.map((policy) => policy.projectId)).size !== policies.length) return null;
  return { version: AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION, revision: value.revision, policies };
}

function parseRunFile(value: unknown): RunFile | null {
  if (!isRecord(value)
    || value.version !== AGENT_ORCHESTRATION_SCHEMA_VERSION
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.runs)
    || !Array.isArray(value.events)
    || value.events.length > MAX_EVENT_RECORDS) return null;
  const parsedRuns = value.runs.map((entry) => CollaborationRunSchema.safeParse(entry));
  const parsedEvents = value.events.map((entry) => CollaborationEventSchema.safeParse(entry));
  if (parsedRuns.some((entry) => !entry.success) || parsedEvents.some((entry) => !entry.success)) return null;
  const runs = parsedRuns.map((entry) => entry.data!);
  const events = parsedEvents.map((entry) => entry.data!);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length
    || new Set(events.map((event) => event.eventId)).size !== events.length
    || runs.some((run) => !validRunGraph(run))) return null;
  const runById = new Map(runs.map((run) => [run.runId, run]));
  const activeLeadSessions = runs.filter((run) => !isTerminalCollaborationRun(run.state)).map((run) => run.leadSessionId);
  if (new Set(activeLeadSessions).size !== activeLeadSessions.length
    || events.some((event) => !runById.get(event.runId)?.tasks.some((task) => task.taskId === event.taskId))) return null;
  return { version: AGENT_ORCHESTRATION_SCHEMA_VERSION, revision: value.revision, runs, events };
}

function failure<T>(
  error: 'invalid' | 'not-found' | 'stale' | 'conflict' | 'unavailable' | 'forbidden',
  message: string,
): AgentOrchestrationMutationResult<T> {
  return { ok: false, error, message };
}

function normalizedScopes(values: readonly string[], allowEnvPrefix = false): readonly string[] | null {
  const normalized = values.map((value) => (
    allowEnvPrefix && value.trim() === '.env.' ? '.env.' : normalizeWriteScope(value)
  ));
  if (normalized.some((value) => value === null)) return null;
  const scopes = [...new Set(normalized as string[])];
  return scopes.length === values.length ? scopes : null;
}

function normalizedPolicy(
  input: CollaborationPolicyInput,
  current: CollaborationPolicy | undefined,
): CollaborationPolicy | null {
  const limits = { ...DEFAULT_COLLABORATION_LIMITS, ...input.limits };
  const allowPaths = normalizedScopes(input.mergePolicy?.allowPaths ?? DEFAULT_COLLABORATION_MERGE_POLICY.allowPaths);
  const denyPaths = normalizedScopes(
    input.mergePolicy?.denyPaths ?? DEFAULT_COLLABORATION_MERGE_POLICY.denyPaths,
    true,
  );
  if (!allowPaths || !denyPaths) return null;
  const mergePolicy = {
    ...DEFAULT_COLLABORATION_MERGE_POLICY,
    ...input.mergePolicy,
    allowPaths,
    denyPaths,
  };
  const parsed = CollaborationPolicySchema.safeParse({
    schemaVersion: AGENT_ORCHESTRATION_POLICY_SCHEMA_VERSION,
    projectId: input.projectId,
    enabled: input.enabled,
    permissionMode: input.permissionMode,
    allowedWorkerProfileIds: [...new Set(input.allowedWorkerProfileIds)],
    limits,
    mergePolicy,
    revision: (current?.revision ?? 0) + 1,
    updatedAt: Date.now(),
  });
  if (!parsed.success
    || parsed.data.allowedWorkerProfileIds.length !== input.allowedWorkerProfileIds.length
    || new Set(parsed.data.mergePolicy.targetBranches).size !== parsed.data.mergePolicy.targetBranches.length
    || new Set(parsed.data.mergePolicy.requiredValidationIds).size !== parsed.data.mergePolicy.requiredValidationIds.length) {
    return null;
  }
  return parsed.data;
}

function migrationMarker(value: unknown): MigrationMarker | null {
  if (!isRecord(value)
    || value.version !== MIGRATION_VERSION
    || typeof value.confirmedAt !== 'number'
    || !Number.isFinite(value.confirmedAt)) return null;
  return { version: MIGRATION_VERSION, confirmedAt: value.confirmedAt };
}

async function legacyCount(filePath: string, key: 'personas' | 'teams' | 'runs'): Promise<number> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isRecord(parsed) && Array.isArray(parsed[key]) ? parsed[key].length : 0;
  } catch {
    return 0;
  }
}

export class AgentOrchestrationStore {
  private readonly policyFile: JsonFile;
  private readonly runFile: JsonFile;
  private readonly migrationFile: JsonFile;
  private readonly legacyCatalogPath: string;
  private readonly legacyRunPath: string;
  private policies: PolicyFile = EMPTY_POLICIES;
  private runState: RunFile = EMPTY_RUNS;
  private migration: LegacyTeamMigrationStatus = {
    required: false,
    catalogItemCount: 0,
    runCount: 0,
  };

  constructor(private readonly userDataDirectory: string) {
    this.policyFile = new JsonFile(userDataDirectory, 'agent-collaboration-policy.json');
    this.runFile = new JsonFile(userDataDirectory, 'agent-orchestration-runs.json');
    this.migrationFile = new JsonFile(userDataDirectory, 'agent-team-migration.json');
    this.legacyCatalogPath = path.join(userDataDirectory, 'agent-team-catalog.json');
    this.legacyRunPath = path.join(userDataDirectory, 'agent-team-runs.json');
  }

  async init(): Promise<void> {
    await Promise.all([this.policyFile.init(), this.runFile.init(), this.migrationFile.init()]);
    const [policies, runs, marker] = await Promise.all([
      this.policyFile.readValidated(parsePolicyFile, EMPTY_POLICIES),
      this.runFile.readValidated(parseRunFile, EMPTY_RUNS),
      this.migrationFile.readValidated(migrationMarker, null),
    ]);
    this.policies = policies;
    this.runState = runs;
    await this.refreshMigration(marker?.confirmedAt);
    await this.recoverInterruptedRuns();
  }

  get policyRevision(): number {
    return this.policies.revision;
  }

  get runRevision(): number {
    return this.runState.revision;
  }

  listPolicies(): readonly CollaborationPolicy[] {
    return this.policies.policies;
  }

  getPolicy(projectId: string): CollaborationPolicy | undefined {
    return this.policies.policies.find((policy) => policy.projectId === projectId);
  }

  listRuns(): readonly CollaborationRun[] {
    return this.runState.runs;
  }

  getRun(runId: string): CollaborationRun | undefined {
    return this.runState.runs.find((run) => run.runId === runId);
  }

  activeRunForLead(sessionId: string): CollaborationRun | undefined {
    return this.runState.runs.find((run) => run.leadSessionId === sessionId && !isTerminalCollaborationRun(run.state));
  }

  workerRunForSession(sessionId: string): CollaborationRun | undefined {
    return this.runState.runs.find((run) => run.tasks.some((task) => task.worker?.sessionId === sessionId));
  }

  listEvents(): readonly CollaborationEvent[] {
    return this.runState.events;
  }

  get migrationStatus(): LegacyTeamMigrationStatus {
    return this.migration;
  }

  savePolicy(input: CollaborationPolicyInput): Promise<AgentOrchestrationMutationResult<CollaborationPolicy>> {
    return this.policyFile.enqueue(async () => {
      const current = this.getPolicy(input.projectId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.revision ?? 0)) {
        return failure('stale', 'Collaboration policy changed before this edit was saved.');
      }
      const policy = normalizedPolicy(input, current);
      if (!policy) return failure('invalid', 'Collaboration policy is invalid.');
      const next: PolicyFile = {
        ...this.policies,
        revision: this.policies.revision + 1,
        policies: [...this.policies.policies.filter((entry) => entry.projectId !== policy.projectId), policy],
      };
      if (!parsePolicyFile(next)) return failure('invalid', 'Collaboration policy would make the store invalid.');
      await this.policyFile.writeAtomic(JSON.stringify(next));
      this.policies = next;
      return { ok: true, value: policy };
    });
  }

  createRun(run: CollaborationRun): Promise<AgentOrchestrationMutationResult<CollaborationRun>> {
    if (!CollaborationRunSchema.safeParse(run).success || !validRunGraph(run) || run.revision !== 1) {
      return Promise.resolve(failure('invalid', 'Collaboration run is invalid.'));
    }
    return this.runFile.enqueue(async () => {
      if (this.getRun(run.runId)) return failure('conflict', 'Collaboration run already exists.');
      if (this.activeRunForLead(run.leadSessionId)) return failure('conflict', 'This Lead already has an active run.');
      const next = this.nextRunFile([...this.runState.runs, run], this.runState.events);
      if (!next) return failure('invalid', 'Collaboration run would make the store invalid.');
      await this.runFile.writeAtomic(JSON.stringify(next));
      this.runState = next;
      return { ok: true, value: run };
    });
  }

  updateRun(
    runId: string,
    mutate: (current: CollaborationRun) => {
      readonly run: CollaborationRun;
      readonly events?: readonly CollaborationEvent[];
    } | null,
  ): Promise<AgentOrchestrationMutationResult<CollaborationRun>> {
    return this.runFile.enqueue(async () => {
      const current = this.getRun(runId);
      if (!current) return failure('not-found', 'Collaboration run not found.');
      const mutation = mutate(current);
      if (!mutation) return failure('conflict', 'Collaboration run changed before this update.');
      if (mutation.run.runId !== current.runId || mutation.run.revision !== current.revision + 1) {
        return failure('stale', 'Collaboration run revision is stale.');
      }
      const events = [...this.runState.events, ...(mutation.events ?? [])];
      const runs = this.runState.runs.map((run) => run.runId === current.runId ? mutation.run : run);
      const next = this.nextRunFile(runs, events);
      if (!next) return failure('invalid', 'Collaboration update is invalid.');
      await this.runFile.writeAtomic(JSON.stringify(next));
      this.runState = next;
      return { ok: true, value: mutation.run };
    });
  }

  markEventDelivered(eventId: string, deliveredAt: number): Promise<boolean> {
    return this.runFile.enqueue(async () => {
      const index = this.runState.events.findIndex((event) => event.eventId === eventId);
      if (index < 0) return false;
      const event = this.runState.events[index]!;
      if (event.deliveredAt !== undefined) return true;
      const events = [...this.runState.events];
      events[index] = { ...event, deliveredAt };
      const next = this.nextRunFile(this.runState.runs, events);
      if (!next) return false;
      await this.runFile.writeAtomic(JSON.stringify(next));
      this.runState = next;
      return true;
    });
  }

  async confirmLegacyMigration(): Promise<LegacyTeamMigrationStatus> {
    const resolvedRoot = path.resolve(this.userDataDirectory);
    for (const target of [this.legacyCatalogPath, this.legacyRunPath]) {
      if (path.dirname(path.resolve(target)) !== resolvedRoot) throw new Error('Legacy Team path escaped user data.');
      await fs.unlink(target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    const marker: MigrationMarker = { version: MIGRATION_VERSION, confirmedAt: Date.now() };
    await this.migrationFile.enqueue(() => this.migrationFile.writeAtomic(JSON.stringify(marker)));
    await this.refreshMigration(marker.confirmedAt);
    return this.migration;
  }

  async removeProject(projectId: string): Promise<void> {
    await Promise.all([
      this.policyFile.enqueue(async () => {
        const policies = this.policies.policies.filter((policy) => policy.projectId !== projectId);
        if (policies.length === this.policies.policies.length) return;
        const next = { ...this.policies, revision: this.policies.revision + 1, policies };
        await this.policyFile.writeAtomic(JSON.stringify(next));
        this.policies = next;
      }),
      this.runFile.enqueue(async () => {
        const runs = this.runState.runs.filter((run) => run.projectId !== projectId);
        if (runs.length === this.runState.runs.length) return;
        const ids = new Set(runs.map((run) => run.runId));
        const next = this.nextRunFile(runs, this.runState.events.filter((event) => ids.has(event.runId)));
        if (!next) return;
        await this.runFile.writeAtomic(JSON.stringify(next));
        this.runState = next;
      }),
    ]);
  }

  async flush(): Promise<void> {
    await Promise.all([this.policyFile.flush(), this.runFile.flush(), this.migrationFile.flush()]);
  }

  private nextRunFile(
    candidateRuns: readonly CollaborationRun[],
    candidateEvents: readonly CollaborationEvent[],
  ): RunFile | null {
    const active = candidateRuns.filter((run) => !isTerminalCollaborationRun(run.state));
    const completed = candidateRuns
      .filter((run) => isTerminalCollaborationRun(run.state))
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(-MAX_ORCHESTRATION_RUNS);
    const runs = [...active, ...completed];
    const runIds = new Set(runs.map((run) => run.runId));
    const events = candidateEvents
      .filter((event) => runIds.has(event.runId))
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(-MAX_EVENT_RECORDS);
    const next: RunFile = {
      version: AGENT_ORCHESTRATION_SCHEMA_VERSION,
      revision: this.runState.revision + 1,
      runs,
      events,
    };
    return parseRunFile(next);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const now = Date.now();
    const runs = this.runState.runs.map((run): CollaborationRun => {
      if (isTerminalCollaborationRun(run.state)) return run;
      return {
        ...run,
        revision: run.revision + 1,
        state: 'interrupted',
        tasks: run.tasks.map((task) => isTerminalCollaborationTask(task.state) ? task : {
          ...task,
          revision: task.revision + 1,
          state: 'failed',
          error: 'EZTerminal stopped before this worker finished. Review its worktree before retrying.',
          updatedAt: now,
          ...(task.worker ? { worker: { ...task.worker, finishedAt: now } } : {}),
        }),
        updatedAt: now,
        finishedAt: now,
      };
    });
    if (runs.every((run, index) => run === this.runState.runs[index])) return;
    const next = this.nextRunFile(runs, this.runState.events);
    if (!next) throw new Error('Recovered orchestration state is invalid.');
    await this.runFile.enqueue(() => this.runFile.writeAtomic(JSON.stringify(next)));
    this.runState = next;
  }

  private async refreshMigration(confirmedAt?: number): Promise<void> {
    const [catalogPresent, runsPresent, personas, teams, runCount] = await Promise.all([
      fs.stat(this.legacyCatalogPath).then(() => true, () => false),
      fs.stat(this.legacyRunPath).then(() => true, () => false),
      legacyCount(this.legacyCatalogPath, 'personas'),
      legacyCount(this.legacyCatalogPath, 'teams'),
      legacyCount(this.legacyRunPath, 'runs'),
    ]);
    this.migration = {
      required: confirmedAt === undefined && (catalogPresent || runsPresent),
      catalogItemCount: personas + teams,
      runCount,
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
    };
  }
}
