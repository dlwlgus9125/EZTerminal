import { randomUUID } from 'node:crypto';

import {
  AGENT_TEAM_CATALOG_SCHEMA_VERSION,
  AGENT_TEAM_RUN_SCHEMA_VERSION,
  AGENT_PERSONA_PRESET_DEFINITIONS,
  DEFAULT_AGENT_TEAM_INSTRUCTIONS,
  MAX_AGENT_PERSONAS,
  MAX_AGENT_TEAMS,
  MAX_AGENT_TEAM_RUNS,
  AgentPersonaSchema,
  AgentTeamRunSchema,
  AgentTeamSchema,
  defaultAgentPersonaLaunch,
  type AgentPersona,
  type AgentPersonaInput,
  type AgentStarterTeam,
  type AgentStarterTeamInput,
  type AgentTeam,
  type AgentTeamInput,
  type AgentTeamMutationResult,
  type AgentTeamRun,
  isTerminalAgentTeamRunPhase,
} from '../shared/agent-team';
import { JsonFile } from './json-file';

interface AgentTeamCatalogFile {
  readonly schemaVersion: typeof AGENT_TEAM_CATALOG_SCHEMA_VERSION;
  readonly revision: number;
  readonly personas: readonly AgentPersona[];
  readonly teams: readonly AgentTeam[];
}

interface AgentTeamRunFile {
  readonly schemaVersion: typeof AGENT_TEAM_RUN_SCHEMA_VERSION;
  readonly revision: number;
  readonly runs: readonly AgentTeamRun[];
}

const EMPTY_CATALOG: AgentTeamCatalogFile = {
  schemaVersion: AGENT_TEAM_CATALOG_SCHEMA_VERSION,
  revision: 0,
  personas: [],
  teams: [],
};

const EMPTY_RUNS: AgentTeamRunFile = {
  schemaVersion: AGENT_TEAM_RUN_SCHEMA_VERSION,
  revision: 0,
  runs: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueCaseFolded(values: readonly string[]): boolean {
  const keys = values.map((value) => value.toLocaleLowerCase('en-US'));
  return new Set(keys).size === keys.length;
}

function validRunRelationships(run: AgentTeamRun): boolean {
  const personaIds = run.personas.map((persona) => persona.personaId);
  const slotIds = run.slots.map((slot) => slot.personaId);
  if (new Set(personaIds).size !== personaIds.length
    || run.team.personaIds.length !== personaIds.length
    || run.team.personaIds.some((personaId, index) => personaId !== personaIds[index])
    || new Set(slotIds).size !== slotIds.length
    || slotIds.length !== personaIds.length
    || slotIds.some((personaId, index) => personaId !== personaIds[index])
    || run.plannerPersonaId !== run.team.plannerPersonaId
    || !personaIds.includes(run.plannerPersonaId)) return false;

  const proposal = run.proposal;
  if (!proposal) {
    return run.approvedAt === undefined
      && !['awaiting-review', 'launching', 'active', 'partial'].includes(run.phase);
  }
  const assigned = proposal.assignments.map((assignment) => assignment.personaId);
  const excluded = proposal.excludedMembers.map((member) => member.personaId);
  const covered = [...assigned, ...excluded];
  const validations = new Set(run.validationCommands.map((command) => command.id));
  if (new Set(assigned).size !== assigned.length
    || new Set(excluded).size !== excluded.length
    || new Set(covered).size !== personaIds.length
    || covered.length !== personaIds.length
    || covered.some((personaId) => !personaIds.includes(personaId))
    || !assigned.includes(run.plannerPersonaId)
    || new Set(proposal.assignments.map((assignment) => assignment.taskId)).size !== proposal.assignments.length
    || proposal.assignments.some((assignment) => assignment.validationIds.some((id) => !validations.has(id)))) {
    return false;
  }
  if (run.approvedAt === undefined) return run.phase === 'awaiting-review' || isTerminalAgentTeamRunPhase(run.phase);
  const taskByPersona = new Map(proposal.assignments.map((assignment) => [assignment.personaId, assignment.taskId]));
  return run.slots.every((slot) => taskByPersona.has(slot.personaId)
    ? slot.taskId === taskByPersona.get(slot.personaId) && slot.state !== 'excluded'
    : slot.state === 'excluded');
}

function validateCatalog(value: unknown): AgentTeamCatalogFile | null {
  if (!isRecord(value)
    || value.schemaVersion !== AGENT_TEAM_CATALOG_SCHEMA_VERSION
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.personas)
    || value.personas.length > MAX_AGENT_PERSONAS
    || !Array.isArray(value.teams)
    || value.teams.length > MAX_AGENT_TEAMS) return null;
  const personas = value.personas.map((candidate) => AgentPersonaSchema.safeParse(candidate));
  const teams = value.teams.map((candidate) => AgentTeamSchema.safeParse(candidate));
  if (personas.some((result) => !result.success) || teams.some((result) => !result.success)) return null;
  const parsedPersonas = personas.map((result) => result.data!);
  const parsedTeams = teams.map((result) => result.data!);
  const personaIds = new Set(parsedPersonas.map((persona) => persona.personaId));
  if (personaIds.size !== parsedPersonas.length
    || !uniqueCaseFolded(parsedPersonas.map((persona) => persona.name))
    || new Set(parsedTeams.map((team) => team.teamId)).size !== parsedTeams.length
    || !uniqueCaseFolded(parsedTeams.map((team) => team.name))) return null;
  for (const team of parsedTeams) {
    if (new Set(team.personaIds).size !== team.personaIds.length
      || !team.personaIds.includes(team.plannerPersonaId)
      || team.personaIds.some((personaId) => !personaIds.has(personaId))) return null;
  }
  return {
    schemaVersion: AGENT_TEAM_CATALOG_SCHEMA_VERSION,
    revision: value.revision,
    personas: parsedPersonas,
    teams: parsedTeams,
  };
}

function validateRuns(value: unknown): AgentTeamRunFile | null {
  if (!isRecord(value)
    || value.schemaVersion !== AGENT_TEAM_RUN_SCHEMA_VERSION
    || typeof value.revision !== 'number'
    || !Number.isSafeInteger(value.revision)
    || value.revision < 0
    || !Array.isArray(value.runs)
    || value.runs.length > MAX_AGENT_TEAM_RUNS) return null;
  const parsed = value.runs.map((candidate) => AgentTeamRunSchema.safeParse(candidate));
  if (parsed.some((result) => !result.success)) return null;
  const runs = parsed.map((result) => result.data!);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length
    || runs.some((run) => !validRunRelationships(run))) return null;
  const activeProjects = new Set<string>();
  for (const run of runs) {
    if (isTerminalAgentTeamRunPhase(run.phase)) continue;
    if (activeProjects.has(run.projectId)) return null;
    activeProjects.add(run.projectId);
  }
  return {
    schemaVersion: AGENT_TEAM_RUN_SCHEMA_VERSION,
    revision: value.revision,
    runs,
  };
}

function failure<T>(
  error: 'invalid' | 'not-found' | 'stale' | 'conflict' | 'unavailable',
  message: string,
): AgentTeamMutationResult<T> {
  return { ok: false, error, message };
}

function normalizePersonaInput(input: AgentPersonaInput, current?: AgentPersona): AgentPersona | null {
  const now = Date.now();
  const parsed = AgentPersonaSchema.safeParse({
    personaId: current?.personaId ?? randomUUID(),
    revision: (current?.revision ?? 0) + 1,
    name: input.name,
    preset: input.preset ?? current?.preset ?? 'custom',
    icon: input.icon,
    role: input.role,
    instructions: input.instructions,
    launch: input.launch,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  });
  return parsed.success ? parsed.data : null;
}

function normalizeTeamInput(input: AgentTeamInput, current?: AgentTeam): AgentTeam | null {
  const now = Date.now();
  const parsed = AgentTeamSchema.safeParse({
    teamId: current?.teamId ?? randomUUID(),
    revision: (current?.revision ?? 0) + 1,
    name: input.name,
    ...(input.description?.trim() ? { description: input.description } : {}),
    instructions: input.instructions,
    ...(input.defaultGoal !== undefined ? { defaultGoal: input.defaultGoal } : {}),
    personaIds: [...input.personaIds],
    plannerPersonaId: input.plannerPersonaId,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  });
  return parsed.success ? parsed.data : null;
}

export class AgentTeamStore {
  private readonly catalogFile: JsonFile;
  private readonly runFile: JsonFile;
  private catalog: AgentTeamCatalogFile = EMPTY_CATALOG;
  private runSnapshot: AgentTeamRunFile = EMPTY_RUNS;

  constructor(userDataDirectory: string) {
    this.catalogFile = new JsonFile(userDataDirectory, 'agent-team-catalog.json');
    this.runFile = new JsonFile(userDataDirectory, 'agent-team-runs.json');
  }

  async init(): Promise<void> {
    await Promise.all([this.catalogFile.init(), this.runFile.init()]);
    const [catalog, runs] = await Promise.all([
      this.catalogFile.readValidated(validateCatalog, EMPTY_CATALOG),
      this.runFile.readValidated(validateRuns, EMPTY_RUNS),
    ]);
    this.catalog = catalog;
    const now = Date.now();
    const recoveredRuns = runs.runs.map((run): AgentTeamRun => {
      if (isTerminalAgentTeamRunPhase(run.phase)) return run;
      const message = 'EZTerminal stopped before this Team run finished.';
      return {
        ...run,
        revision: run.revision + 1,
        phase: 'failed',
        slots: run.slots.map((slot) => slot.state === 'excluded'
          ? slot
          : { ...slot, state: 'failed', error: slot.error ?? message, updatedAt: now }),
        message,
        updatedAt: now,
        finishedAt: now,
      };
    });
    if (recoveredRuns.some((run, index) => run !== runs.runs[index])) {
      const recovered: AgentTeamRunFile = {
        ...runs,
        revision: runs.revision + 1,
        runs: recoveredRuns,
      };
      await this.runFile.writeAtomic(JSON.stringify(recovered));
      this.runSnapshot = recovered;
    } else {
      this.runSnapshot = runs;
    }
  }

  get catalogRevision(): number {
    return this.catalog.revision;
  }

  get runRevision(): number {
    return this.runSnapshot.revision;
  }

  listPersonas(): readonly AgentPersona[] {
    return this.catalog.personas;
  }

  listTeams(): readonly AgentTeam[] {
    return this.catalog.teams;
  }

  listRuns(): readonly AgentTeamRun[] {
    return this.runSnapshot.runs;
  }

  getPersona(personaId: string): AgentPersona | undefined {
    return this.catalog.personas.find((persona) => persona.personaId === personaId);
  }

  getTeam(teamId: string): AgentTeam | undefined {
    return this.catalog.teams.find((team) => team.teamId === teamId);
  }

  getRun(runId: string): AgentTeamRun | undefined {
    return this.runSnapshot.runs.find((run) => run.runId === runId);
  }

  activeRunForProject(projectId: string): AgentTeamRun | undefined {
    return this.runSnapshot.runs.find((run) => (
      run.projectId === projectId && !isTerminalAgentTeamRunPhase(run.phase)
    ));
  }

  savePersona(input: AgentPersonaInput): Promise<AgentTeamMutationResult<AgentPersona>> {
    return this.catalogFile.enqueue(async () => {
      const current = input.personaId ? this.getPersona(input.personaId) : undefined;
      if (input.personaId && !current) return failure('not-found', 'Persona not found.');
      if (current && input.expectedRevision !== current.revision) {
        return failure('stale', 'Persona changed before this edit was saved.');
      }
      const persona = normalizePersonaInput(input, current);
      if (!persona) return failure('invalid', 'Persona settings are invalid or unsupported.');
      const duplicate = this.catalog.personas.find((candidate) => (
        candidate.personaId !== persona.personaId
        && candidate.name.toLocaleLowerCase('en-US') === persona.name.toLocaleLowerCase('en-US')
      ));
      if (duplicate) return failure('conflict', 'Persona names must be unique.');
      const personas = [
        ...this.catalog.personas.filter((candidate) => candidate.personaId !== persona.personaId),
        persona,
      ];
      const next: AgentTeamCatalogFile = {
        ...this.catalog,
        revision: this.catalog.revision + 1,
        personas,
      };
      if (!validateCatalog(next)) return failure('invalid', 'Persona would make the catalog invalid.');
      await this.catalogFile.writeAtomic(JSON.stringify(next));
      this.catalog = next;
      return { ok: true, value: persona };
    });
  }

  createStarterTeam(input: AgentStarterTeamInput): Promise<AgentTeamMutationResult<AgentStarterTeam>> {
    return this.catalogFile.enqueue(async () => {
      if (this.catalog.personas.length > 0 || this.catalog.teams.length > 0) {
        return failure('conflict', 'The starter Team can be created only in an empty catalog.');
      }
      if ((input.plannerProvider !== 'codex' && input.plannerProvider !== 'claude')
        || (input.implementerProvider !== 'codex' && input.implementerProvider !== 'claude')) {
        return failure('invalid', 'Choose a supported Provider for each starter Persona.');
      }
      const plannerDefaults = AGENT_PERSONA_PRESET_DEFINITIONS.planner;
      const implementerDefaults = AGENT_PERSONA_PRESET_DEFINITIONS.implementer;
      const planner = normalizePersonaInput({
        name: 'Planner',
        preset: 'planner',
        ...plannerDefaults,
        launch: defaultAgentPersonaLaunch('planner', input.plannerProvider),
      });
      const implementer = normalizePersonaInput({
        name: 'Implementer',
        preset: 'implementer',
        ...implementerDefaults,
        launch: defaultAgentPersonaLaunch('implementer', input.implementerProvider),
      });
      if (!planner || !implementer) return failure('invalid', 'Starter Personas are invalid.');
      const team = normalizeTeamInput({
        name: 'Starter team',
        instructions: DEFAULT_AGENT_TEAM_INSTRUCTIONS,
        personaIds: [planner.personaId, implementer.personaId],
        plannerPersonaId: planner.personaId,
      });
      if (!team) return failure('invalid', 'Starter Team is invalid.');
      const next: AgentTeamCatalogFile = {
        ...this.catalog,
        revision: this.catalog.revision + 1,
        personas: [planner, implementer],
        teams: [team],
      };
      if (!validateCatalog(next)) return failure('invalid', 'Starter Team would make the catalog invalid.');
      await this.catalogFile.writeAtomic(JSON.stringify(next));
      this.catalog = next;
      return { ok: true, value: { planner, implementer, team } };
    });
  }

  deletePersona(personaId: string, expectedRevision: number): Promise<AgentTeamMutationResult<true>> {
    return this.catalogFile.enqueue(async () => {
      const current = this.getPersona(personaId);
      if (!current) return failure('not-found', 'Persona not found.');
      if (current.revision !== expectedRevision) return failure('stale', 'Persona changed before deletion.');
      if (this.catalog.teams.some((team) => team.personaIds.includes(personaId))) {
        return failure('conflict', 'Remove this Persona from every Team before deleting it.');
      }
      const next: AgentTeamCatalogFile = {
        ...this.catalog,
        revision: this.catalog.revision + 1,
        personas: this.catalog.personas.filter((persona) => persona.personaId !== personaId),
      };
      await this.catalogFile.writeAtomic(JSON.stringify(next));
      this.catalog = next;
      return { ok: true, value: true };
    });
  }

  saveTeam(input: AgentTeamInput): Promise<AgentTeamMutationResult<AgentTeam>> {
    return this.catalogFile.enqueue(async () => {
      const current = input.teamId ? this.getTeam(input.teamId) : undefined;
      if (input.teamId && !current) return failure('not-found', 'Team not found.');
      if (current && input.expectedRevision !== current.revision) {
        return failure('stale', 'Team changed before this edit was saved.');
      }
      const team = normalizeTeamInput(input, current);
      if (!team
        || new Set(team.personaIds).size !== team.personaIds.length
        || !team.personaIds.includes(team.plannerPersonaId)
        || team.personaIds.some((personaId) => !this.getPersona(personaId))) {
        return failure('invalid', 'Team members and Planner must reference available Personas.');
      }
      const duplicate = this.catalog.teams.find((candidate) => (
        candidate.teamId !== team.teamId
        && candidate.name.toLocaleLowerCase('en-US') === team.name.toLocaleLowerCase('en-US')
      ));
      if (duplicate) return failure('conflict', 'Team names must be unique.');
      const teams = [...this.catalog.teams.filter((candidate) => candidate.teamId !== team.teamId), team];
      const next: AgentTeamCatalogFile = {
        ...this.catalog,
        revision: this.catalog.revision + 1,
        teams,
      };
      if (!validateCatalog(next)) return failure('invalid', 'Team would make the catalog invalid.');
      await this.catalogFile.writeAtomic(JSON.stringify(next));
      this.catalog = next;
      return { ok: true, value: team };
    });
  }

  deleteTeam(teamId: string, expectedRevision: number): Promise<AgentTeamMutationResult<true>> {
    return this.catalogFile.enqueue(async () => {
      const current = this.getTeam(teamId);
      if (!current) return failure('not-found', 'Team not found.');
      if (current.revision !== expectedRevision) return failure('stale', 'Team changed before deletion.');
      const next: AgentTeamCatalogFile = {
        ...this.catalog,
        revision: this.catalog.revision + 1,
        teams: this.catalog.teams.filter((team) => team.teamId !== teamId),
      };
      await this.catalogFile.writeAtomic(JSON.stringify(next));
      this.catalog = next;
      return { ok: true, value: true };
    });
  }

  saveRun(run: AgentTeamRun): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    const parsed = AgentTeamRunSchema.safeParse(run);
    if (!parsed.success) return Promise.resolve(failure('invalid', 'Team run is invalid.'));
    return this.runFile.enqueue(async () => {
      const current = this.getRun(run.runId);
      if (current && parsed.data.revision !== current.revision + 1) {
        return failure('stale', 'Team run changed before this update was saved.');
      }
      if (!current && parsed.data.revision !== 1) {
        return failure('invalid', 'A new Team run must start at revision 1.');
      }
      const existingActive = this.activeRunForProject(run.projectId);
      if (existingActive && existingActive.runId !== run.runId && !isTerminalAgentTeamRunPhase(run.phase)) {
        return failure('conflict', 'This project already has an active Team run.');
      }
      let runs = this.runSnapshot.runs.filter((candidate) => candidate.runId !== run.runId);
      if (isTerminalAgentTeamRunPhase(run.phase)) {
        runs = runs.filter((candidate) => (
          candidate.projectId !== run.projectId || !isTerminalAgentTeamRunPhase(candidate.phase)
        ));
      }
      runs = [...runs, parsed.data]
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(-MAX_AGENT_TEAM_RUNS);
      const next: AgentTeamRunFile = {
        schemaVersion: AGENT_TEAM_RUN_SCHEMA_VERSION,
        revision: this.runSnapshot.revision + 1,
        runs,
      };
      if (!validateRuns(next)) return failure('invalid', 'Team run would make the store invalid.');
      await this.runFile.writeAtomic(JSON.stringify(next));
      this.runSnapshot = next;
      return { ok: true, value: parsed.data };
    });
  }

  removeProjectRuns(projectId: string): Promise<void> {
    return this.runFile.enqueue(async () => {
      const runs = this.runSnapshot.runs.filter((run) => run.projectId !== projectId);
      if (runs.length === this.runSnapshot.runs.length) return;
      const next: AgentTeamRunFile = {
        ...this.runSnapshot,
        revision: this.runSnapshot.revision + 1,
        runs,
      };
      await this.runFile.writeAtomic(JSON.stringify(next));
      this.runSnapshot = next;
    });
  }

  async flush(): Promise<void> {
    await Promise.all([this.catalogFile.flush(), this.runFile.flush()]);
  }
}
