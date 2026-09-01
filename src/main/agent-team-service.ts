import { randomUUID } from 'node:crypto';

import {
  AGENT_TEAM_RUN_SCHEMA_VERSION,
  MAX_AGENT_TEAM_GOAL_CRITERIA,
  MAX_AGENT_TEAM_MEMBERS,
  AgentTeamPlanProposalSchema,
  defaultAgentPersonaLaunch,
  type AgentLauncherCapabilities,
  type AgentPersona,
  type AgentPersonaInput,
  type AgentStarterTeam,
  type AgentStarterTeamInput,
  type AgentTeam,
  type AgentTeamAssignment,
  type AgentTeamDesktopSnapshot,
  type AgentTeamInput,
  type AgentTeamMemberSlot,
  type AgentTeamMemberBinding,
  type AgentTeamMutationResult,
  type AgentTeamPlanApprovalInput,
  type AgentTeamPlanProposal,
  type AgentTeamPlanSubmission,
  type AgentTeamRun,
  type AgentTeamRunDecisionInput,
  type AgentTeamRunInput,
  composeAgentTeamMemberBrief,
  composeAgentTeamPlanningBrief,
  isTerminalAgentTeamRunPhase,
} from '../shared/agent-team';
import {
  isSafeAgentPromptText,
  type AgentProjectCoordination,
} from '../shared/agent-coordination';
import type { AgentProjectRecord } from './agent-project-store';
import type { AgentTeamStore } from './agent-team-store';

type MutableLaunchState = Extract<AgentTeamMemberSlot['state'], 'preparing' | 'prepared' | 'launching' | 'active' | 'failed'>;

const AllowedLaunchTransitions: Readonly<Record<MutableLaunchState, ReadonlySet<AgentTeamMemberSlot['state']>>> = {
  preparing: new Set(['planned', 'failed']),
  prepared: new Set(['planned', 'failed', 'prepared']),
  launching: new Set(['prepared', 'launching', 'failed']),
  active: new Set(['launching']),
  failed: new Set(['planned', 'preparing', 'prepared', 'launching', 'failed']),
};

const StableBindingKeys = [
  'branch',
  'rootId',
  'workspaceId',
  'worktreeId',
  'worktreePath',
] as const satisfies readonly (keyof AgentTeamMemberBinding)[];

function failure<T>(
  error: 'invalid' | 'not-found' | 'stale' | 'conflict' | 'unavailable',
  message: string,
): AgentTeamMutationResult<T> {
  return { ok: false, error, message };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) return null;
  return normalized;
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined || value === '') return undefined;
  return text(value, max);
}

function criteria(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AGENT_TEAM_GOAL_CRITERIA) return null;
  const normalized = value.map((criterion) => text(criterion, 500));
  if (normalized.some((criterion) => criterion === null)) return null;
  const resolved = normalized as string[];
  return new Set(resolved.map((criterion) => criterion.toLocaleLowerCase('en-US'))).size === resolved.length
    ? resolved
    : null;
}

function launchSupported(
  launch: AgentPersona['launch'],
  capability: AgentLauncherCapabilities | undefined,
): boolean {
  if (!capability?.available || capability.provider !== launch.provider) return false;
  if (launch.model && !capability.supportsModel) return false;
  if (launch.provider === 'claude' && launch.effort
    && !capability.effortValues.includes(launch.effort)) return false;
  const permission = launch.provider === 'codex' ? launch.sandbox : launch.permissionMode;
  return capability.permissionValues.includes(permission);
}

function proposalError(run: AgentTeamRun, proposal: AgentTeamPlanProposal): string | null {
  const parsed = AgentTeamPlanProposalSchema.safeParse(proposal);
  if (!parsed.success) return 'The proposed Team plan is invalid.';
  const personaIds = new Set(run.personas.map((persona) => persona.personaId));
  const assigned = parsed.data.assignments.map((assignment) => assignment.personaId);
  const excluded = parsed.data.excludedMembers.map((member) => member.personaId);
  if (new Set(assigned).size !== assigned.length
    || new Set(excluded).size !== excluded.length
    || new Set(parsed.data.assignments.map((assignment) => assignment.taskId)).size !== parsed.data.assignments.length) {
    return 'Every Persona and task may appear only once.';
  }
  const covered = [...assigned, ...excluded];
  if (covered.length !== personaIds.size
    || new Set(covered).size !== covered.length
    || covered.some((personaId) => !personaIds.has(personaId))) {
    return 'Assignments and exclusions must cover the complete Team snapshot.';
  }
  if (!assigned.includes(run.plannerPersonaId)) return 'The Planner must receive an assignment.';
  const validationIds = new Set(run.validationCommands.map((command) => command.id));
  if (parsed.data.assignments.some((assignment) => (
    new Set(assignment.validationIds).size !== assignment.validationIds.length
    || assignment.validationIds.some((id) => !validationIds.has(id))
  ))) return 'Assignments may reference only configured Project validations.';
  if (parsed.data.assignments.some((assignment) => {
    const persona = run.personas.find((candidate) => candidate.personaId === assignment.personaId);
    return !persona || !isSafeAgentPromptText(composeAgentTeamMemberBrief(run, persona, assignment));
  })) return 'Every approved member brief must fit safely in one terminal prompt.';
  return null;
}

export class AgentTeamService {
  private readonly listeners = new Set<(snapshot: AgentTeamDesktopSnapshot) => void>();
  private revision = 0;

  constructor(private readonly deps: {
    readonly store: AgentTeamStore;
    readonly listProjects: () => readonly AgentProjectRecord[];
    readonly getCoordinationProject: (projectId: string) => AgentProjectCoordination | null;
    readonly capabilities: () => readonly AgentLauncherCapabilities[];
    readonly inspectBase?: (
      project: AgentProjectRecord,
      targetBranch: string,
    ) => Promise<{ readonly head: string; readonly dirty: boolean } | null>;
    readonly isActivityLive?: (activityId: string) => boolean;
    readonly newId?: () => string;
    readonly now?: () => number;
  }) {}

  getSnapshot(): AgentTeamDesktopSnapshot {
    return {
      revision: this.revision,
      catalog: {
        revision: this.deps.store.catalogRevision,
        personas: this.deps.store.listPersonas(),
        teams: this.deps.store.listTeams(),
        capabilities: this.deps.capabilities(),
      },
      runRevision: this.deps.store.runRevision,
      runs: this.deps.store.listRuns(),
    };
  }

  onSnapshot(listener: (snapshot: AgentTeamDesktopSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capabilitiesChanged(): void {
    this.publish();
  }

  async savePersona(input: AgentPersonaInput): Promise<AgentTeamMutationResult<AgentPersona>> {
    const result = await this.deps.store.savePersona(input);
    if (result.ok) this.publish();
    return result;
  }

  async createStarterTeam(input: AgentStarterTeamInput): Promise<AgentTeamMutationResult<AgentStarterTeam>> {
    if ((input.plannerProvider !== 'codex' && input.plannerProvider !== 'claude')
      || (input.implementerProvider !== 'codex' && input.implementerProvider !== 'claude')) {
      return failure('invalid', 'Choose a supported Provider for each starter Persona.');
    }
    const capabilities = new Map(this.deps.capabilities().map((capability) => [capability.provider, capability]));
    const plannerLaunch = defaultAgentPersonaLaunch('planner', input.plannerProvider);
    const implementerLaunch = defaultAgentPersonaLaunch('implementer', input.implementerProvider);
    if (!launchSupported(plannerLaunch, capabilities.get(input.plannerProvider))) {
      return failure('unavailable', `The ${input.plannerProvider} Provider cannot launch the Planner preset.`);
    }
    if (!launchSupported(implementerLaunch, capabilities.get(input.implementerProvider))) {
      return failure('unavailable', `The ${input.implementerProvider} Provider cannot launch the Implementer preset.`);
    }
    const result = await this.deps.store.createStarterTeam(input);
    if (result.ok) this.publish();
    return result;
  }

  async deletePersona(personaId: string, expectedRevision: number): Promise<AgentTeamMutationResult<true>> {
    const result = await this.deps.store.deletePersona(personaId, expectedRevision);
    if (result.ok) this.publish();
    return result;
  }

  async saveTeam(input: AgentTeamInput): Promise<AgentTeamMutationResult<AgentTeam>> {
    const result = await this.deps.store.saveTeam(input);
    if (result.ok) this.publish();
    return result;
  }

  async deleteTeam(teamId: string, expectedRevision: number): Promise<AgentTeamMutationResult<true>> {
    const result = await this.deps.store.deleteTeam(teamId, expectedRevision);
    if (result.ok) this.publish();
    return result;
  }

  async createRun(input: AgentTeamRunInput): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    const projectId = text(input.projectId, 128);
    const teamId = text(input.teamId, 128);
    const goal = text(input.goal, 2_000);
    const acceptanceCriteria = criteria(input.acceptanceCriteria);
    const constraints = optionalText(input.constraints, 2_000);
    if (!projectId || !teamId || !goal || !acceptanceCriteria
      || constraints === null || typeof input.warningAcknowledged !== 'boolean') {
      return failure('invalid', 'Project, Team, desired outcome, and at least one completion criterion are required.');
    }
    if (this.deps.store.activeRunForProject(projectId)) {
      return failure('conflict', 'This Project already has an active Team run.');
    }
    const project = this.deps.listProjects().find((candidate) => candidate.projectId === projectId);
    const coordination = this.deps.getCoordinationProject(projectId);
    const team = this.deps.store.getTeam(teamId);
    if (!project || !coordination || !team) {
      return failure('not-found', 'Save the Project collaboration settings and Team before starting.');
    }
    const personas = team.personaIds.map((personaId) => this.deps.store.getPersona(personaId));
    if (personas.some((persona) => !persona)) return failure('conflict', 'The Team references a missing Persona.');
    const resolvedPersonas = personas as AgentPersona[];
    const capabilities = new Map(this.deps.capabilities().map((capability) => [capability.provider, capability]));
    const unavailable = resolvedPersonas.find((persona) => (
      !launchSupported(persona.launch, capabilities.get(persona.launch.provider))
    ));
    if (unavailable) {
      return failure('unavailable', `${unavailable.name}'s ${unavailable.launch.provider} launch settings are unavailable.`);
    }
    const base = this.deps.inspectBase
      ? await this.deps.inspectBase(project, coordination.defaultTargetBranch)
      : null;
    if (this.deps.inspectBase && !base) {
      return failure('unavailable', 'The target branch could not be resolved to one Git commit.');
    }
    if (base?.dirty && !input.warningAcknowledged) {
      return failure('conflict', 'The Project working tree has local changes. Review and acknowledge them first.');
    }
    const now = (this.deps.now ?? Date.now)();
    const run: AgentTeamRun = {
      schemaVersion: AGENT_TEAM_RUN_SCHEMA_VERSION,
      runId: (this.deps.newId ?? randomUUID)(),
      revision: 1,
      projectId,
      projectName: project.name,
      projectGoal: coordination.goal,
      goal,
      goalAcceptanceCriteria: acceptanceCriteria,
      ...(constraints ? { constraints } : {}),
      targetBranch: coordination.defaultTargetBranch,
      validationConfigRevision: coordination.configRevision,
      validationCommands: coordination.validationCommands.map((command) => ({ ...command })),
      team: {
        ...team,
        personaIds: [...team.personaIds],
        ...(team.defaultGoal ? {
          defaultGoal: {
            ...team.defaultGoal,
            acceptanceCriteria: [...team.defaultGoal.acceptanceCriteria],
          },
        } : {}),
      },
      personas: resolvedPersonas.map((persona) => ({ ...persona, launch: { ...persona.launch } })),
      plannerPersonaId: team.plannerPersonaId,
      phase: 'preparing-planner',
      slots: resolvedPersonas.map((persona) => ({
        personaId: persona.personaId,
        state: 'planned',
        updatedAt: now,
      })),
      ...(base ? { baseHead: base.head, baseDirty: base.dirty } : {}),
      warningAcknowledged: input.warningAcknowledged,
      createdAt: now,
      updatedAt: now,
    };
    const result = await this.deps.store.saveRun(run);
    if (result.ok) this.publish();
    return result;
  }

  async submitPlan(
    activityId: string,
    input: AgentTeamPlanSubmission,
  ): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    const run = this.deps.store.getRun(input.runId);
    if (!run) return failure('not-found', 'Team run not found.');
    if (run.revision !== input.expectedRevision) return failure('stale', 'The Team run changed.');
    if (run.phase !== 'planning') return failure('conflict', 'This Team run is not accepting a plan.');
    const planner = run.slots.find((slot) => slot.personaId === run.plannerPersonaId);
    if (!planner?.activityId || planner.activityId !== activityId) {
      return failure('conflict', 'Only the designated live Planner may submit this plan.');
    }
    const error = proposalError(run, input.proposal);
    if (error) return failure('invalid', error);
    return this.replaceRun({
      ...run,
      revision: run.revision + 1,
      phase: 'awaiting-review',
      proposal: input.proposal,
      updatedAt: (this.deps.now ?? Date.now)(),
    });
  }

  async approvePlan(input: AgentTeamPlanApprovalInput): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    const run = this.deps.store.getRun(input.runId);
    if (!run) return failure('not-found', 'Team run not found.');
    if (run.revision !== input.expectedRevision) return failure('stale', 'The Team run changed.');
    if (run.phase !== 'awaiting-review') return failure('conflict', 'This Team run is not awaiting review.');
    const planner = run.slots.find((slot) => slot.personaId === run.plannerPersonaId);
    if (!planner?.activityId
      || (this.deps.isActivityLive && !this.deps.isActivityLive(planner.activityId))) {
      return failure('unavailable', 'The Planner is no longer running. Cancel this run and plan again.');
    }
    const coordination = this.deps.getCoordinationProject(run.projectId);
    if (!coordination || coordination.configRevision !== run.validationConfigRevision) {
      return failure('stale', 'Project collaboration settings changed; start a new planning pass.');
    }
    const reviewed = AgentTeamPlanProposalSchema.safeParse(input.proposal);
    if (!reviewed.success) return failure('invalid', 'The proposed Team plan is invalid.');
    if (!run.proposal || JSON.stringify(reviewed.data) !== JSON.stringify(run.proposal)) {
      return failure('conflict', 'Approve exactly the reviewed Team plan.');
    }
    const error = proposalError(run, input.proposal);
    if (error) return failure('invalid', error);
    const assignments = new Map(input.proposal.assignments.map((assignment) => [assignment.personaId, assignment]));
    const now = (this.deps.now ?? Date.now)();
    const slots = run.slots.map((slot): AgentTeamMemberSlot => {
      const assignment = assignments.get(slot.personaId);
      return assignment
        ? { ...slot, taskId: assignment.taskId, state: slot.activityId ? 'active' : 'planned', updatedAt: now }
        : { ...slot, state: 'excluded', updatedAt: now };
    });
    return this.replaceRun({
      ...run,
      revision: run.revision + 1,
      phase: 'launching',
      proposal: input.proposal,
      slots,
      approvedAt: now,
      updatedAt: now,
    });
  }

  memberBrief(runId: string, personaId: string): string | null {
    const run = this.deps.store.getRun(runId);
    const persona = run?.personas.find((candidate) => candidate.personaId === personaId);
    const assignment = run?.proposal?.assignments.find((candidate) => candidate.personaId === personaId);
    return run && persona && assignment ? composeAgentTeamMemberBrief(run, persona, assignment) : null;
  }

  waitForPlanDecision(
    runId: string,
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<AgentTeamMutationResult<{
    readonly run: AgentTeamRun;
    readonly assignment: AgentTeamAssignment;
    readonly brief: string;
  }>> {
    const evaluate = (): AgentTeamMutationResult<{
      readonly run: AgentTeamRun;
      readonly assignment: AgentTeamAssignment;
      readonly brief: string;
    }> | null => {
      const run = this.deps.store.getRun(runId);
      if (!run) return failure('not-found', 'Team run not found.');
      if (run.approvedAt && run.revision > afterRevision) {
        const persona = run.personas.find((candidate) => candidate.personaId === run.plannerPersonaId);
        const assignment = run.proposal?.assignments.find(
          (candidate) => candidate.personaId === run.plannerPersonaId,
        );
        if (!persona || !assignment) return failure('conflict', 'The approved Planner assignment is unavailable.');
        return {
          ok: true,
          value: { run, assignment, brief: composeAgentTeamMemberBrief(run, persona, assignment) },
        };
      }
      if (isTerminalAgentTeamRunPhase(run.phase)) {
        return failure('conflict', run.message ?? 'The Team plan was not approved.');
      }
      return null;
    };
    const immediate = evaluate();
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.resolve(failure('unavailable', 'Plan review was interrupted.'));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: AgentTeamMutationResult<{
        readonly run: AgentTeamRun;
        readonly assignment: AgentTeamAssignment;
        readonly brief: string;
      }>): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const check = (): void => {
        const result = evaluate();
        if (result) finish(result);
      };
      const onAbort = (): void => finish(failure('unavailable', 'Plan review was interrupted.'));
      const unsubscribe = this.onSnapshot(check);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else check();
    });
  }

  launchContext(
    runId: string,
    personaId: string,
    expectedRevision?: number,
  ): AgentTeamMutationResult<{
    readonly run: AgentTeamRun;
    readonly persona: AgentPersona;
    readonly brief: string;
    readonly task: string;
  }> {
    const run = this.deps.store.getRun(runId);
    if (!run) return failure('not-found', 'Team run not found.');
    if (expectedRevision !== undefined && run.revision !== expectedRevision) {
      return failure('stale', 'The Team run changed.');
    }
    if (isTerminalAgentTeamRunPhase(run.phase)) return failure('conflict', 'The Team run has ended.');
    const persona = run.personas.find((candidate) => candidate.personaId === personaId);
    const slot = run.slots.find((candidate) => candidate.personaId === personaId);
    if (!persona || !slot || slot.state === 'excluded') return failure('not-found', 'Active Team member not found.');
    if (!run.approvedAt) {
      if (personaId !== run.plannerPersonaId || run.phase !== 'preparing-planner') {
        return failure('conflict', 'Only the Planner may launch before plan approval.');
      }
      return {
        ok: true,
        value: {
          run,
          persona,
          brief: composeAgentTeamPlanningBrief(run),
          task: `Plan Team work for: ${run.goal}`.slice(0, 1_000),
        },
      };
    }
    if (run.phase !== 'launching' && run.phase !== 'partial') {
      return failure('conflict', 'This Team run is not launching members.');
    }
    const assignment = run.proposal?.assignments.find((candidate) => candidate.personaId === personaId);
    if (!assignment) return failure('not-found', 'Approved assignment not found.');
    return {
      ok: true,
      value: {
        run,
        persona,
        brief: composeAgentTeamMemberBrief(run, persona, assignment),
        task: assignment.title,
      },
    };
  }

  async bindMember(
    runId: string,
    personaId: string,
    expectedRevision: number,
    state: MutableLaunchState,
    binding: AgentTeamMemberBinding = {},
    error?: string,
  ): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    const run = this.deps.store.getRun(runId);
    if (!run) return failure('not-found', 'Team run not found.');
    if (run.revision !== expectedRevision) return failure('stale', 'The Team run changed.');
    if (isTerminalAgentTeamRunPhase(run.phase)) return failure('conflict', 'The Team run has ended.');
    const current = run.slots.find((slot) => slot.personaId === personaId);
    if (!current || current.state === 'excluded') return failure('not-found', 'Active Team member not found.');
    if (!AllowedLaunchTransitions[state].has(current.state)) {
      return failure('conflict', `Team member cannot move from ${current.state} to ${state}.`);
    }
    if (StableBindingKeys.some((key) => (
      current[key] !== undefined && binding[key] !== undefined && current[key] !== binding[key]
    ))) {
      return failure('conflict', 'The Team member is already bound to another managed worktree.');
    }
    if (state === 'active'
      && current.sessionId !== undefined
      && binding.sessionId !== undefined
      && current.sessionId !== binding.sessionId) {
      return failure('conflict', 'The observed Agent belongs to another terminal session.');
    }
    const now = (this.deps.now ?? Date.now)();
    const slot: AgentTeamMemberSlot = {
      ...current,
      ...(state === 'prepared'
        ? { sessionId: undefined, activityId: undefined, participantId: undefined }
        : {}),
      ...binding,
      state,
      error: state === 'failed' && error ? error.slice(0, 500) : undefined,
      updatedAt: now,
    };
    const slots = run.slots.map((candidate) => candidate.personaId === personaId ? slot : candidate);
    const active = slots.filter((candidate) => candidate.state !== 'excluded');
    const nextPhase = state === 'active' && personaId === run.plannerPersonaId && run.phase === 'preparing-planner'
      ? 'planning'
      : run.approvedAt && active.every((candidate) => candidate.state === 'active')
        ? 'active'
        : run.approvedAt && active.some((candidate) => candidate.state === 'failed')
          ? 'partial'
          : run.phase;
    return this.replaceRun({
      ...run,
      revision: run.revision + 1,
      phase: nextPhase,
      slots,
      updatedAt: now,
    });
  }

  async bindMemberCurrent(
    runId: string,
    personaId: string,
    state: MutableLaunchState,
    binding: AgentTeamMemberBinding = {},
    error?: string,
  ): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    for (let attempt = 0; attempt < MAX_AGENT_TEAM_MEMBERS + 2; attempt += 1) {
      const run = this.deps.store.getRun(runId);
      if (!run) return failure('not-found', 'Team run not found.');
      const result = await this.bindMember(runId, personaId, run.revision, state, binding, error);
      if (result.ok || result.error !== 'stale') return result;
    }
    return failure('stale', 'The Team run changed repeatedly. Retry this member.');
  }

  async decideRun(input: AgentTeamRunDecisionInput): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    if (typeof input.runId !== 'string'
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 1
      || (input.decision !== 'complete' && input.decision !== 'cancel')) {
      return failure('invalid', 'Invalid Team run decision.');
    }
    const run = this.deps.store.getRun(input.runId);
    if (!run) return failure('not-found', 'Team run not found.');
    if (run.revision !== input.expectedRevision) return failure('stale', 'The Team run changed.');
    if (isTerminalAgentTeamRunPhase(run.phase)) return failure('conflict', 'The Team run has already ended.');
    if (input.decision === 'complete' && run.phase !== 'active' && run.phase !== 'partial') {
      return failure('conflict', 'Only an active or partial Team run can be completed.');
    }
    const now = (this.deps.now ?? Date.now)();
    return this.replaceRun({
      ...run,
      revision: run.revision + 1,
      phase: input.decision === 'complete' ? 'completed' : 'canceled',
      finishedAt: now,
      updatedAt: now,
    });
  }

  async removeProject(projectId: string): Promise<void> {
    await this.deps.store.removeProjectRuns(projectId);
    this.publish();
  }

  dispose(): void {
    this.listeners.clear();
  }

  private async replaceRun(run: AgentTeamRun): Promise<AgentTeamMutationResult<AgentTeamRun>> {
    const result = await this.deps.store.saveRun(run);
    if (result.ok) this.publish();
    return result;
  }

  private publish(): void {
    this.revision += 1;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Observers consume committed level-triggered state.
      }
    }
  }
}
