import { createHash, randomUUID } from 'node:crypto';

import { CronExpressionParser } from 'cron-parser';

import {
  createDaemonCommand,
  type DaemonAgent,
  type DaemonCommand,
  type DaemonCommandError,
  type DaemonCommandReceipt,
  type DaemonCommandType,
  type DaemonHeartbeat,
  type DaemonSchedule,
  type DaemonSnapshot,
  type DaemonSession,
  type DaemonTurn,
} from '../shared/daemon-protocol';
import type {
  DaemonCommandExecutionResult,
  DaemonCommandHandler,
} from './daemon-command-router';
import type {
  DaemonScheduleRunInput,
  DaemonStoreCommit,
  DaemonStoreMutation,
} from './daemon-store';
import { findActiveDaemonWorkspace } from './daemon-workspace-authority';

type AutomationCommandType = Extract<DaemonCommandType,
  | 'schedule.create'
  | 'schedule.update'
  | 'schedule.delete'
  | 'schedule.run-now'
  | 'heartbeat.configure'
  | 'heartbeat.trigger'
>;

export interface AutomationScheduleRun extends DaemonScheduleRunInput {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationClaimState {
  readonly snapshot: DaemonSnapshot;
  readonly scheduleRuns: readonly AutomationScheduleRun[];
}

export interface AutomationTransitionPlan<T> {
  readonly commit: DaemonStoreCommit;
  readonly value: T;
}

export interface AutomationTransitionReceipt<T> {
  readonly applied: boolean;
  readonly revision: number;
  readonly eventSequence: number;
  readonly value: T;
}

export interface DaemonAutomationRuntimeOptions {
  readonly getSnapshot: () => DaemonSnapshot;
  readonly getScheduleRuns: (
    states?: readonly AutomationScheduleRun['state'][],
  ) => readonly AutomationScheduleRun[];
  /** The callback must be evaluated synchronously under the authority's write lock. */
  readonly applySystemTransition: <T>(
    transition: (state: AutomationClaimState) => AutomationTransitionPlan<T> | undefined,
  ) => Promise<AutomationTransitionReceipt<T> | undefined>;
  /** Must route back through DaemonCommandRouter.execute; never call a provider directly. */
  readonly executeCommand: (command: DaemonCommand) => Promise<DaemonCommandReceipt>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly pendingPollMs?: number;
  readonly reportError?: (context: string, error: unknown) => void;
}

interface CanonicalCron {
  readonly cron: string;
  readonly timezone: string;
  readonly nextRunAt: string;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_PENDING_POLL_MS = 1_000;
const ACTIVE_AGENT_STATES = new Set<DaemonAgent['state']>([
  'starting',
  'queued',
  'working',
  'blocked',
]);

class AutomationInputError extends Error {}

function commandError(
  code: DaemonCommandError['code'],
  message: string,
  retryable = false,
): DaemonCommandExecutionResult {
  return { ok: false, error: { code, message, retryable } };
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function canonicalTimezone(value: string): string {
  const timezone = value.trim();
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone;
    if (/^[+-]/u.test(canonical)) throw new Error('fixed offsets are not IANA zones');
    return canonical;
  } catch {
    throw new AutomationInputError(`Timezone ${JSON.stringify(value)} is not a supported IANA timezone.`);
  }
}

function canonicalCron(
  expression: string,
  timezoneValue: string,
  after: Date,
  hashSeed: string,
): CanonicalCron {
  const normalized = expression.trim().replace(/\s+/gu, ' ');
  if (normalized.split(' ').length !== 5) {
    throw new AutomationInputError('Automation cron expressions must contain exactly five fields.');
  }
  const timezone = canonicalTimezone(timezoneValue);
  try {
    const parsed = CronExpressionParser.parse(normalized, {
      currentDate: after,
      tz: timezone,
      hashSeed,
    });
    return {
      cron: parsed.stringify(false),
      timezone,
      nextRunAt: parsed.next().toDate().toISOString(),
    };
  } catch (error) {
    throw new AutomationInputError(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalExpiry(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new AutomationInputError('Automation expiry must be an ISO date-time with an explicit offset.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AutomationInputError('Automation expiry must be a valid ISO date-time.');
  }
  return new Date(timestamp).toISOString();
}

function automationEnabled(snapshot: DaemonSnapshot): boolean {
  return snapshot.runtime.keepRunning && snapshot.runtime.startAtLogin;
}

function exhausted(schedule: Pick<DaemonSchedule, 'maxRuns' | 'runCount' | 'expiresAt'>, now: Date): boolean {
  return (schedule.maxRuns !== undefined && schedule.runCount >= schedule.maxRuns)
    || (schedule.expiresAt !== undefined && Date.parse(schedule.expiresAt) <= now.valueOf());
}

function scheduleInput(
  schedule: DaemonSchedule,
  patch: Partial<Omit<DaemonSchedule, 'id' | 'revision' | 'createdAt' | 'updatedAt'>> = {},
): Omit<DaemonSchedule, 'revision' | 'createdAt' | 'updatedAt'> {
  const model = Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model : schedule.model;
  const maxRuns = Object.prototype.hasOwnProperty.call(patch, 'maxRuns') ? patch.maxRuns : schedule.maxRuns;
  const expiresAt = Object.prototype.hasOwnProperty.call(patch, 'expiresAt') ? patch.expiresAt : schedule.expiresAt;
  const nextRunAt = Object.prototype.hasOwnProperty.call(patch, 'nextRunAt') ? patch.nextRunAt : schedule.nextRunAt;
  return {
    id: schedule.id,
    name: patch.name ?? schedule.name,
    workspaceId: patch.workspaceId ?? schedule.workspaceId,
    providerId: patch.providerId ?? schedule.providerId,
    ...(model ? { model } : {}),
    permissionPreset: patch.permissionPreset ?? schedule.permissionPreset,
    prompt: patch.prompt ?? schedule.prompt,
    cron: patch.cron ?? schedule.cron,
    timezone: patch.timezone ?? schedule.timezone,
    enabled: patch.enabled ?? schedule.enabled,
    ...(maxRuns === undefined ? {} : { maxRuns }),
    runCount: patch.runCount ?? schedule.runCount,
    ...(expiresAt ? { expiresAt } : {}),
    ...(nextRunAt ? { nextRunAt } : {}),
  };
}

function heartbeatInput(
  heartbeat: DaemonHeartbeat,
  patch: Partial<Omit<DaemonHeartbeat, 'sessionId' | 'revision' | 'createdAt' | 'updatedAt'>> = {},
): Omit<DaemonHeartbeat, 'revision' | 'createdAt' | 'updatedAt'> {
  const nextRunAt = Object.prototype.hasOwnProperty.call(patch, 'nextRunAt')
    ? patch.nextRunAt
    : heartbeat.nextRunAt;
  return {
    sessionId: heartbeat.sessionId,
    prompt: patch.prompt ?? heartbeat.prompt,
    cron: patch.cron ?? heartbeat.cron,
    timezone: patch.timezone ?? heartbeat.timezone,
    enabled: patch.enabled ?? heartbeat.enabled,
    pending: patch.pending ?? heartbeat.pending,
    ...(nextRunAt ? { nextRunAt } : {}),
  };
}

function scheduleRunInput(
  run: AutomationScheduleRun,
  patch: Partial<DaemonScheduleRunInput> = {},
): DaemonScheduleRunInput {
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    ...(patch.sessionId ?? run.sessionId ? { sessionId: patch.sessionId ?? run.sessionId } : {}),
    state: patch.state ?? run.state,
    scheduledFor: patch.scheduledFor ?? run.scheduledFor,
    ...(patch.startedAt ?? run.startedAt ? { startedAt: patch.startedAt ?? run.startedAt } : {}),
    ...(patch.finishedAt ?? run.finishedAt ? { finishedAt: patch.finishedAt ?? run.finishedAt } : {}),
    ...(patch.summary ?? run.summary ? { summary: patch.summary ?? run.summary } : {}),
    ...(patch.errorCode ?? run.errorCode ? { errorCode: patch.errorCode ?? run.errorCode } : {}),
  };
}

function inactiveScheduleMutations(
  schedule: DaemonSchedule,
  scheduleRuns: readonly AutomationScheduleRun[],
  observedAt: string,
  errorCode: 'not-found' | 'provider-unavailable',
): DaemonStoreMutation[] {
  return [
    { kind: 'schedule.upsert', value: scheduleInput(schedule, {
      enabled: false,
      nextRunAt: undefined,
    }) },
    ...scheduleRuns
      .filter((run) => run.scheduleId === schedule.id && run.state === 'queued')
      .map((run): DaemonStoreMutation => ({
        kind: 'schedule-run.upsert',
        value: scheduleRunInput(run, {
          state: 'failed',
          finishedAt: observedAt,
          errorCode,
        }),
      })),
  ];
}

function findAgentSession(
  snapshot: DaemonSnapshot,
  sessionId: string,
): { readonly session: DaemonSession; readonly agent: DaemonAgent } | undefined {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  const agent = snapshot.agents.find((candidate) => candidate.sessionId === sessionId);
  const workspace = session
    ? findActiveDaemonWorkspace(snapshot, session.workspaceId, session.projectId)
    : undefined;
  return session?.kind === 'agent' && !session.archivedAt && agent && workspace
    ? { session, agent }
    : undefined;
}

interface ScheduleSessionDisposition {
  readonly state: 'running' | 'completed' | 'interrupted' | 'failed';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
}

function firstSessionTurn(snapshot: DaemonSnapshot, sessionId: string): DaemonTurn | undefined {
  return snapshot.turns
    .filter((turn) => turn.sessionId === sessionId)
    .sort((left, right) => (
      (left.enqueueSequence ?? Number.MAX_SAFE_INTEGER)
        - (right.enqueueSequence ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
    ))[0];
}

function scheduleSessionDisposition(
  snapshot: DaemonSnapshot,
  schedule: DaemonSchedule,
  sessionId: string,
  observedAt: string,
): ScheduleSessionDisposition {
  const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
  const agent = snapshot.agents.find((candidate) => candidate.sessionId === sessionId);
  if (
    !session
    || session.kind !== 'agent'
    || session.workspaceId !== schedule.workspaceId
    || !agent
    || agent.providerId !== schedule.providerId
  ) {
    return {
      state: 'failed',
      finishedAt: observedAt,
      errorCode: 'schedule-session-mismatch',
    };
  }

  // A Schedule represents its initial prompt, not every later direct
  // follow-up in the reusable Agent Session. The first durable turn is
  // therefore the most precise recovery cursor after a crash or Quit race.
  const turn = firstSessionTurn(snapshot, sessionId);
  if (turn) {
    const timing = {
      ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
      ...(turn.finishedAt ? { finishedAt: turn.finishedAt } : {}),
    };
    switch (turn.state) {
      case 'completed':
        return { state: 'completed', ...timing, finishedAt: turn.finishedAt ?? observedAt };
      case 'interrupted':
        return {
          state: 'interrupted',
          ...timing,
          finishedAt: turn.finishedAt ?? observedAt,
          ...(turn.errorCode ? { errorCode: turn.errorCode } : {}),
        };
      case 'failed':
        return {
          state: 'failed',
          ...timing,
          finishedAt: turn.finishedAt ?? observedAt,
          errorCode: turn.errorCode ?? 'agent-turn-failed',
        };
      case 'delivery-uncertain':
        return {
          state: 'failed',
          ...timing,
          finishedAt: observedAt,
          errorCode: turn.errorCode ?? 'delivery-uncertain',
        };
      default:
        return { state: 'running', ...timing };
    }
  }

  if (session.state === 'completed' || session.state === 'archived' || agent.state === 'done') {
    return { state: 'completed', finishedAt: observedAt };
  }
  if (session.state === 'interrupted' || agent.state === 'interrupted') {
    return { state: 'interrupted', finishedAt: observedAt };
  }
  if (
    session.state === 'failed'
    || session.state === 'delivery-uncertain'
    || agent.state === 'error'
    || agent.state === 'delivery-uncertain'
  ) {
    return {
      state: 'failed',
      finishedAt: observedAt,
      errorCode: session.state === 'delivery-uncertain' || agent.state === 'delivery-uncertain'
        ? 'delivery-uncertain'
        : 'agent-session-failed',
    };
  }
  if (ACTIVE_AGENT_STATES.has(agent.state) || session.state === 'starting' || session.state === 'running') {
    return { state: 'running' };
  }
  return {
    state: 'failed',
    finishedAt: observedAt,
    errorCode: 'schedule-session-missing-turn',
  };
}

/**
 * Durable schedule + heartbeat engine. Cron parsing, DST behavior, claim
 * serialization, crash recovery and pending coalescing stay behind handlers,
 * while Agent execution returns through the normal command authority.
 */
export class DaemonAutomationRuntime {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly setTimer: NonNullable<DaemonAutomationRuntimeOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DaemonAutomationRuntimeOptions['clearTimer']>;
  private readonly pendingPollMs: number;
  private readonly heartbeatDispatching = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickPromise: Promise<void> | null = null;
  private tickAgain = false;
  private started = false;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly options: DaemonAutomationRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.pendingPollMs = options.pendingPollMs ?? DEFAULT_PENDING_POLL_MS;
    if (!Number.isSafeInteger(this.pendingPollMs) || this.pendingPollMs < 1) {
      throw new Error('pendingPollMs must be a positive integer.');
    }
  }

  handlers(): Partial<Record<AutomationCommandType, DaemonCommandHandler>> {
    return {
      'schedule.create': (command, context) => (
        this.runCommand(() => this.createSchedule(command, context.snapshot))
      ),
      'schedule.update': (command, context) => (
        this.runCommand(() => this.updateSchedule(command, context.snapshot))
      ),
      'schedule.delete': (command, context) => (
        this.runCommand(() => this.deleteSchedule(command, context.snapshot))
      ),
      'schedule.run-now': (command, context) => (
        this.runCommand(() => this.runScheduleNow(command, context.snapshot))
      ),
      'heartbeat.configure': (command, context) => (
        this.runCommand(() => this.configureHeartbeat(command, context.snapshot))
      ),
      'heartbeat.trigger': (command, context) => (
        this.runCommand(() => this.triggerHeartbeat(command, context.snapshot))
      ),
    };
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    await this.requestTick();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.clearWakeTimer();
    this.disposePromise = this.tickPromise ?? Promise.resolve();
    return this.disposePromise;
  }

  /** Allows the eventual main integration to wake the engine after runtime-setting changes. */
  notifyAuthorityChanged(): void {
    this.wakeSoon();
  }

  private createSchedule(
    command: DaemonCommand,
    snapshot: DaemonSnapshot,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'schedule.create') {
      return commandError('invalid-command', 'Unexpected schedule create command.');
    }
    if (snapshot.schedules.some((schedule) => schedule.id === command.payload.scheduleId)) {
      return commandError('invalid-state', 'Schedule already exists.');
    }
    const workspace = findActiveDaemonWorkspace(snapshot, command.payload.workspaceId);
    if (!workspace) return commandError('not-found', 'Active Workspace was not found.');
    const provider = snapshot.providers.find((candidate) => candidate.id === command.payload.providerId);
    if (!provider || !provider.enabled || provider.health !== 'ready') {
      return commandError('provider-unavailable', 'The selected provider is not ready.', true);
    }
    if (command.payload.enabled && !automationEnabled(snapshot)) {
      return this.requiresDaemon();
    }
    try {
      const now = this.currentDate();
      const parsed = canonicalCron(
        command.payload.cron,
        command.payload.timezone,
        now,
        command.payload.scheduleId,
      );
      const expiresAt = canonicalExpiry(command.payload.expiresAt);
      if (command.payload.enabled && expiresAt && Date.parse(expiresAt) < Date.parse(parsed.nextRunAt)) {
        return commandError('invalid-state', 'The Schedule expires before its next cron occurrence.');
      }
      const value = {
        id: command.payload.scheduleId,
        name: command.payload.name,
        workspaceId: workspace.id,
        providerId: provider.id,
        ...(command.payload.model ? { model: command.payload.model } : {}),
        permissionPreset: command.payload.permissionPreset,
        prompt: command.payload.prompt,
        cron: parsed.cron,
        timezone: parsed.timezone,
        enabled: command.payload.enabled,
        ...(command.payload.maxRuns === undefined ? {} : { maxRuns: command.payload.maxRuns }),
        runCount: 0,
        ...(expiresAt ? { expiresAt } : {}),
        ...(command.payload.enabled ? { nextRunAt: parsed.nextRunAt } : {}),
      } satisfies Omit<DaemonSchedule, 'revision' | 'createdAt' | 'updatedAt'>;
      this.wakeSoon();
      return { ok: true, commit: { mutations: [{ kind: 'schedule.upsert', value }] } };
    } catch (error) {
      return this.invalidInput(error);
    }
  }

  private updateSchedule(
    command: DaemonCommand,
    snapshot: DaemonSnapshot,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'schedule.update') {
      return commandError('invalid-command', 'Unexpected schedule update command.');
    }
    const current = snapshot.schedules.find((schedule) => schedule.id === command.payload.scheduleId);
    if (!current) return commandError('not-found', 'Schedule was not found.');
    const requestedEnabled = command.payload.enabled ?? current.enabled;
    if (requestedEnabled && !findActiveDaemonWorkspace(snapshot, current.workspaceId)) {
      return commandError('not-found', 'Active Workspace was not found.');
    }
    const provider = requestedEnabled
      ? snapshot.providers.find((candidate) => (
          candidate.id === current.providerId && candidate.enabled && candidate.health === 'ready'
        ))
      : undefined;
    if (requestedEnabled && !provider) {
      return commandError('provider-unavailable', 'The Schedule provider is not ready.', true);
    }
    if (command.payload.enabled === true && !automationEnabled(snapshot)) return this.requiresDaemon();
    try {
      const now = this.currentDate();
      const parsed = canonicalCron(
        command.payload.cron ?? current.cron,
        command.payload.timezone ?? current.timezone,
        now,
        current.id,
      );
      const expiresAt = canonicalExpiry(command.payload.expiresAt ?? current.expiresAt);
      const maxRuns = command.payload.maxRuns ?? current.maxRuns;
      let enabled = requestedEnabled;
      let nextRunAt = current.nextRunAt;
      const timingChanged = command.payload.cron !== undefined
        || command.payload.timezone !== undefined
        || (command.payload.enabled === true && !current.enabled);
      if (!enabled) nextRunAt = undefined;
      else if (timingChanged || !nextRunAt) nextRunAt = parsed.nextRunAt;
      const noRemainingRun = (maxRuns !== undefined && current.runCount >= maxRuns)
        || (expiresAt !== undefined && Date.parse(expiresAt) <= now.valueOf())
        || (expiresAt !== undefined && nextRunAt !== undefined && Date.parse(nextRunAt) > Date.parse(expiresAt));
      if (command.payload.enabled === true && noRemainingRun) {
        return commandError('invalid-state', 'The Schedule has no remaining occurrence before its limits.');
      }
      if (noRemainingRun) {
        enabled = false;
        nextRunAt = undefined;
      }
      const value = scheduleInput(current, {
        ...(command.payload.name === undefined ? {} : { name: command.payload.name }),
        ...(command.payload.prompt === undefined ? {} : { prompt: command.payload.prompt }),
        cron: parsed.cron,
        timezone: parsed.timezone,
        enabled,
        ...(maxRuns === undefined ? {} : { maxRuns }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        nextRunAt,
      });
      this.wakeSoon();
      return { ok: true, commit: { mutations: [{ kind: 'schedule.upsert', value }] } };
    } catch (error) {
      return this.invalidInput(error);
    }
  }

  private deleteSchedule(
    command: DaemonCommand,
    snapshot: DaemonSnapshot,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'schedule.delete') {
      return commandError('invalid-command', 'Unexpected schedule delete command.');
    }
    if (!snapshot.schedules.some((schedule) => schedule.id === command.payload.scheduleId)) {
      return commandError('not-found', 'Schedule was not found.');
    }
    this.wakeSoon();
    return {
      ok: true,
      commit: { mutations: [{ kind: 'schedule.delete', scheduleId: command.payload.scheduleId }] },
    };
  }

  private runScheduleNow(
    command: DaemonCommand,
    snapshot: DaemonSnapshot,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'schedule.run-now') {
      return commandError('invalid-command', 'Unexpected schedule run-now command.');
    }
    const schedule = snapshot.schedules.find((candidate) => candidate.id === command.payload.scheduleId);
    if (!schedule) return commandError('not-found', 'Schedule was not found.');
    if (!automationEnabled(snapshot)) return this.requiresDaemon();
    const now = this.currentDate();
    if (exhausted(schedule, now)) {
      return commandError('invalid-state', 'Schedule has reached its run or expiry limit.');
    }
    const owner = findActiveDaemonWorkspace(snapshot, schedule.workspaceId);
    const provider = snapshot.providers.find((candidate) => (
      candidate.id === schedule.providerId && candidate.enabled && candidate.health === 'ready'
    ));
    if (!owner) return commandError('not-found', 'Active Workspace was not found.');
    if (!provider) return commandError('provider-unavailable', 'The Schedule provider is not ready.', true);
    const scheduledFor = now.toISOString();
    const nextRunCount = schedule.runCount + 1;
    const reachedLimit = schedule.maxRuns !== undefined && nextRunCount >= schedule.maxRuns;
    const value = scheduleInput(schedule, reachedLimit
      ? { runCount: nextRunCount, enabled: false, nextRunAt: undefined }
      : { runCount: nextRunCount });
    const runId = this.idFactory();
    this.wakeSoon();
    return { ok: true, commit: { mutations: [
      { kind: 'schedule.upsert', value },
      { kind: 'schedule-run.upsert', value: {
        id: runId,
        scheduleId: schedule.id,
        state: 'queued',
        scheduledFor,
      } },
    ] } };
  }

  private configureHeartbeat(
    command: DaemonCommand,
    snapshot: DaemonSnapshot,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'heartbeat.configure') {
      return commandError('invalid-command', 'Unexpected heartbeat configure command.');
    }
    const target = findAgentSession(snapshot, command.payload.sessionId);
    if (!target) return commandError('not-found', 'Active Agent Session was not found.');
    if (['done', 'interrupted', 'error', 'archived'].includes(target.agent.state)) {
      return commandError('invalid-state', 'Heartbeat requires a resumable Agent Session.');
    }
    if (command.payload.enabled && !automationEnabled(snapshot)) return this.requiresDaemon();
    try {
      const parsed = canonicalCron(
        command.payload.cron,
        command.payload.timezone,
        this.currentDate(),
        command.payload.sessionId,
      );
      const current = snapshot.heartbeats.find((heartbeat) => heartbeat.sessionId === command.payload.sessionId);
      const timingChanged = !current
        || current.cron !== parsed.cron
        || current.timezone !== parsed.timezone
        || (!current.enabled && command.payload.enabled);
      const value = {
        sessionId: command.payload.sessionId,
        prompt: command.payload.prompt,
        cron: parsed.cron,
        timezone: parsed.timezone,
        enabled: command.payload.enabled,
        pending: command.payload.enabled && (current?.pending ?? false),
        ...(command.payload.enabled
          ? { nextRunAt: timingChanged && !current?.pending ? parsed.nextRunAt : current?.nextRunAt ?? parsed.nextRunAt }
          : {}),
      };
      this.wakeSoon();
      return { ok: true, commit: { mutations: [{ kind: 'heartbeat.upsert', value }] } };
    } catch (error) {
      return this.invalidInput(error);
    }
  }

  private triggerHeartbeat(
    command: DaemonCommand,
    snapshot: DaemonSnapshot,
  ): DaemonCommandExecutionResult {
    if (command.type !== 'heartbeat.trigger') {
      return commandError('invalid-command', 'Unexpected heartbeat trigger command.');
    }
    const heartbeat = snapshot.heartbeats.find((candidate) => candidate.sessionId === command.payload.sessionId);
    if (!heartbeat) return commandError('not-found', 'Heartbeat was not found.');
    if (!heartbeat.enabled) return commandError('invalid-state', 'Heartbeat is disabled.');
    if (!automationEnabled(snapshot)) return this.requiresDaemon();
    if (!findAgentSession(snapshot, heartbeat.sessionId)) {
      return commandError('not-found', 'Active Agent Session was not found.');
    }
    if (heartbeat.pending) {
      this.wakeSoon();
      return { ok: true };
    }
    this.wakeSoon();
    return { ok: true, commit: { mutations: [{
      kind: 'heartbeat.upsert',
      value: heartbeatInput(heartbeat, { pending: true }),
    }] } };
  }

  private requiresDaemon(): DaemonCommandExecutionResult {
    return commandError(
      'automation-requires-daemon',
      'Enable both Keep running and Start at login before enabling automation.',
    );
  }

  private invalidInput(error: unknown): DaemonCommandExecutionResult {
    if (error instanceof AutomationInputError) return commandError('invalid-command', error.message);
    throw error;
  }

  private async runCommand(
    action: () => DaemonCommandExecutionResult | Promise<DaemonCommandExecutionResult>,
  ): Promise<DaemonCommandExecutionResult> {
    if (this.disposed) return commandError('invalid-state', 'The automation runtime is shutting down.');
    const result = await action();
    return this.disposed
      ? commandError('invalid-state', 'The automation runtime is shutting down.')
      : result;
  }

  private applySystemTransition<T>(
    transition: (state: AutomationClaimState) => AutomationTransitionPlan<T> | undefined,
  ): Promise<AutomationTransitionReceipt<T> | undefined> {
    return this.options.applySystemTransition((state) => (
      this.disposed ? undefined : transition(state)
    ));
  }

  private currentDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new Error('Daemon automation clock returned an invalid Date.');
    }
    return new Date(value.valueOf());
  }

  private wakeSoon(): void {
    if (!this.started || this.disposed) return;
    this.armWakeTimer(0);
  }

  private requestTick(): Promise<void> {
    if (!this.started || this.disposed) return Promise.resolve();
    if (this.tickPromise) {
      this.tickAgain = true;
      return this.tickPromise;
    }
    this.tickPromise = (async () => {
      do {
        this.tickAgain = false;
        await this.tickOnce();
      } while (this.tickAgain && !this.disposed);
    })().catch((error) => {
      this.report('automation tick failed', error);
    }).finally(() => {
      this.tickPromise = null;
      if (!this.disposed) this.armNextWake();
    });
    return this.tickPromise;
  }

  private async tickOnce(): Promise<void> {
    if (this.disposed || !automationEnabled(this.options.getSnapshot())) return;
    const now = this.currentDate();
    await this.reconcileFinishedScheduleRuns(now);
    if (this.disposed) return;
    await this.claimDue(now);
    if (this.disposed) return;
    await this.dispatchQueuedSchedules();
    if (this.disposed) return;
    await this.dispatchPendingHeartbeats();
  }

  private async claimDue(now: Date): Promise<void> {
    await this.applySystemTransition((state) => {
      if (!automationEnabled(state.snapshot)) return undefined;
      const mutations: DaemonStoreMutation[] = [];
      for (const schedule of state.snapshot.schedules) {
        if (!schedule.enabled) continue;
        if (!findActiveDaemonWorkspace(state.snapshot, schedule.workspaceId)) {
          mutations.push(...inactiveScheduleMutations(
            schedule,
            state.scheduleRuns,
            now.toISOString(),
            'not-found',
          ));
          continue;
        }
        const provider = state.snapshot.providers.find((candidate) => (
          candidate.id === schedule.providerId && candidate.enabled && candidate.health === 'ready'
        ));
        if (!provider) {
          mutations.push(...inactiveScheduleMutations(
            schedule,
            state.scheduleRuns,
            now.toISOString(),
            'provider-unavailable',
          ));
          continue;
        }
        if (exhausted(schedule, now)) {
          mutations.push({ kind: 'schedule.upsert', value: scheduleInput(schedule, {
            enabled: false,
            nextRunAt: undefined,
          }) });
          continue;
        }
        let nextRunAt = schedule.nextRunAt;
        try {
          if (!nextRunAt || !Number.isFinite(Date.parse(nextRunAt))) {
            nextRunAt = canonicalCron(schedule.cron, schedule.timezone, now, schedule.id).nextRunAt;
            mutations.push({ kind: 'schedule.upsert', value: scheduleInput(schedule, { nextRunAt }) });
            continue;
          }
          if (Date.parse(nextRunAt) > now.valueOf()) continue;
          const runCount = schedule.runCount + 1;
          const parsed = canonicalCron(schedule.cron, schedule.timezone, now, schedule.id);
          const noMoreRuns = schedule.maxRuns !== undefined && runCount >= schedule.maxRuns;
          const afterExpiry = schedule.expiresAt !== undefined
            && Date.parse(parsed.nextRunAt) > Date.parse(schedule.expiresAt);
          mutations.push(
            { kind: 'schedule.upsert', value: scheduleInput(schedule, {
              runCount,
              enabled: !noMoreRuns && !afterExpiry,
              nextRunAt: noMoreRuns || afterExpiry ? undefined : parsed.nextRunAt,
            }) },
            { kind: 'schedule-run.upsert', value: {
              id: this.idFactory(),
              scheduleId: schedule.id,
              state: 'queued',
              scheduledFor: nextRunAt,
            } },
          );
        } catch (error) {
          this.report(`invalid persisted Schedule ${schedule.id}`, error);
          mutations.push({ kind: 'schedule.upsert', value: scheduleInput(schedule, {
            enabled: false,
            nextRunAt: undefined,
          }) });
        }
      }
      for (const heartbeat of state.snapshot.heartbeats) {
        if (!heartbeat.enabled || heartbeat.pending) continue;
        try {
          if (!heartbeat.nextRunAt || !Number.isFinite(Date.parse(heartbeat.nextRunAt))) {
            const nextRunAt = canonicalCron(
              heartbeat.cron,
              heartbeat.timezone,
              now,
              heartbeat.sessionId,
            ).nextRunAt;
            mutations.push({ kind: 'heartbeat.upsert', value: heartbeatInput(heartbeat, { nextRunAt }) });
          } else if (Date.parse(heartbeat.nextRunAt) <= now.valueOf()) {
            // Keep nextRunAt on the claimed occurrence. It is the durable
            // pending token until the authority accepts exactly one submit.
            mutations.push({ kind: 'heartbeat.upsert', value: heartbeatInput(heartbeat, { pending: true }) });
          }
        } catch (error) {
          this.report(`invalid persisted Heartbeat ${heartbeat.sessionId}`, error);
          mutations.push({ kind: 'heartbeat.upsert', value: heartbeatInput(heartbeat, {
            enabled: false,
            pending: false,
            nextRunAt: undefined,
          }) });
        }
      }
      return mutations.length === 0 ? undefined : { commit: { mutations }, value: undefined };
    });
  }

  private async dispatchQueuedSchedules(): Promise<void> {
    for (const queued of this.options.getScheduleRuns(['queued'])) {
      if (this.disposed) return;
      const run = this.options.getScheduleRuns(['queued']).find((candidate) => candidate.id === queued.id);
      if (!run) continue;
      const snapshot = this.options.getSnapshot();
      const schedule = snapshot.schedules.find((candidate) => candidate.id === run.scheduleId);
      if (!schedule) continue;
      const provider = snapshot.providers.find((candidate) => (
        candidate.id === schedule.providerId && candidate.enabled && candidate.health === 'ready'
      ));
      if (!provider) {
        await this.disableScheduleForUnavailableProvider(schedule.id, this.currentDate().toISOString());
        continue;
      }
      const sessionId = stableId('scheduled-agent', run.id);
      const existing = snapshot.sessions.find((session) => session.id === sessionId);
      if (existing) {
        await this.attachScheduleRun(run.id, sessionId, this.currentDate().toISOString());
        continue;
      }
      const expectedRevision = snapshot.revision;
      const commandId = stableId('automation-command', 'schedule', run.id, String(expectedRevision));
      const command = createDaemonCommand({
        commandId,
        idempotencyKey: `automation:schedule:${run.id}:${expectedRevision}`,
        expectedRevision,
        issuedAt: run.updatedAt,
        principal: { kind: 'cli', id: 'automation-runtime' },
        type: 'agent.create',
        payload: {
          sessionId,
          workspaceId: schedule.workspaceId,
          title: schedule.name,
          providerId: schedule.providerId,
          ...(schedule.model ? { model: schedule.model } : {}),
          permissionPreset: schedule.permissionPreset,
          initialPrompt: schedule.prompt,
        },
      });
      try {
        const receipt = await this.options.executeCommand(command);
        if (receipt.ok) {
          await this.attachScheduleRun(run.id, sessionId, this.currentDate().toISOString());
        } else if (receipt.error.code === 'provider-unavailable') {
          await this.disableScheduleForUnavailableProvider(schedule.id, this.currentDate().toISOString());
        } else if (receipt.error.code !== 'revision-conflict' && !receipt.error.retryable) {
          await this.markScheduleFailed(run.id, receipt.error.code, this.currentDate().toISOString());
        } else if (receipt.error.code === 'revision-conflict') {
          this.tickAgain = true;
        }
      } catch (error) {
        // A queued row is the recovery cursor. Leave it untouched so restart
        // can retry through the same authority without manufacturing a run.
        this.report(`Schedule ${run.scheduleId} dispatch failed`, error);
      }
    }
  }

  private async disableScheduleForUnavailableProvider(
    scheduleId: string,
    observedAt: string,
  ): Promise<void> {
    await this.applySystemTransition((state) => {
      const schedule = state.snapshot.schedules.find((candidate) => candidate.id === scheduleId);
      if (!schedule) return undefined;
      const provider = state.snapshot.providers.find((candidate) => (
        candidate.id === schedule.providerId && candidate.enabled && candidate.health === 'ready'
      ));
      if (provider) return undefined;
      return {
        commit: {
          mutations: inactiveScheduleMutations(
            schedule,
            state.scheduleRuns,
            observedAt,
            'provider-unavailable',
          ),
        },
        value: undefined,
      };
    });
  }

  private async dispatchPendingHeartbeats(): Promise<void> {
    const snapshot = this.options.getSnapshot();
    for (const heartbeat of snapshot.heartbeats) {
      if (!heartbeat.enabled || !heartbeat.pending || this.heartbeatDispatching.has(heartbeat.sessionId)) continue;
      const target = findAgentSession(snapshot, heartbeat.sessionId);
      if (!target || ['done', 'interrupted', 'error', 'archived'].includes(target?.agent.state ?? 'archived')) {
        await this.disableHeartbeat(heartbeat.sessionId, heartbeat.revision);
        continue;
      }
      if (ACTIVE_AGENT_STATES.has(target.agent.state) || target.agent.queuedTurnCount > 0) continue;
      this.heartbeatDispatching.add(heartbeat.sessionId);
      try {
        const authority = this.options.getSnapshot();
        const expectedRevision = authority.revision;
        const commandBase = stableId(
          'automation-heartbeat',
          heartbeat.sessionId,
          String(heartbeat.revision),
        );
        const commandId = `${commandBase}-r${expectedRevision}`;
        if (authority.turns.some((turn) => turn.commandId.startsWith(`${commandBase}-r`))) {
          await this.completeHeartbeat(heartbeat.sessionId, heartbeat.revision);
          continue;
        }
        const receipt = await this.options.executeCommand(createDaemonCommand({
          commandId,
          idempotencyKey: `automation:heartbeat:${heartbeat.sessionId}:${heartbeat.revision}:${expectedRevision}`,
          expectedRevision,
          issuedAt: heartbeat.updatedAt,
          principal: { kind: 'cli', id: 'automation-runtime' },
          type: 'agent.submit',
          payload: { sessionId: heartbeat.sessionId, prompt: heartbeat.prompt },
        }));
        if (receipt.ok) {
          await this.completeHeartbeat(heartbeat.sessionId, heartbeat.revision);
        } else if (receipt.error.code === 'revision-conflict') {
          this.tickAgain = true;
        } else if (!receipt.error.retryable) {
          await this.completeHeartbeat(heartbeat.sessionId, heartbeat.revision);
          this.report(`Heartbeat ${heartbeat.sessionId} was not delivered`, receipt.error);
        }
      } catch (error) {
        this.report(`Heartbeat ${heartbeat.sessionId} dispatch failed`, error);
      } finally {
        this.heartbeatDispatching.delete(heartbeat.sessionId);
      }
    }
  }

  private async completeHeartbeat(sessionId: string, claimedRevision: number): Promise<void> {
    const now = this.currentDate();
    await this.applySystemTransition((state) => {
      const heartbeat = state.snapshot.heartbeats.find((candidate) => candidate.sessionId === sessionId);
      if (!heartbeat?.pending || heartbeat.revision !== claimedRevision) return undefined;
      try {
        const parsed = canonicalCron(heartbeat.cron, heartbeat.timezone, now, heartbeat.sessionId);
        return {
          commit: { mutations: [{ kind: 'heartbeat.upsert', value: heartbeatInput(heartbeat, {
            pending: false,
            nextRunAt: parsed.nextRunAt,
          }) }] },
          value: undefined,
        };
      } catch (error) {
        this.report(`invalid persisted Heartbeat ${heartbeat.sessionId}`, error);
        return {
          commit: { mutations: [{ kind: 'heartbeat.upsert', value: heartbeatInput(heartbeat, {
            enabled: false,
            pending: false,
            nextRunAt: undefined,
          }) }] },
          value: undefined,
        };
      }
    });
  }

  private async disableHeartbeat(sessionId: string, claimedRevision: number): Promise<void> {
    await this.applySystemTransition((state) => {
      const heartbeat = state.snapshot.heartbeats.find((candidate) => candidate.sessionId === sessionId);
      if (!heartbeat || heartbeat.revision !== claimedRevision) return undefined;
      return {
        commit: { mutations: [{ kind: 'heartbeat.upsert', value: heartbeatInput(heartbeat, {
          enabled: false,
          pending: false,
          nextRunAt: undefined,
        }) }] },
        value: undefined,
      };
    });
  }

  private async attachScheduleRun(runId: string, sessionId: string, observedAt: string): Promise<void> {
    await this.applySystemTransition((state) => {
      const run = state.scheduleRuns.find((candidate) => candidate.id === runId);
      if (!run || run.state !== 'queued') return undefined;
      const schedule = state.snapshot.schedules.find((candidate) => candidate.id === run.scheduleId);
      const disposition = schedule
        ? scheduleSessionDisposition(state.snapshot, schedule, sessionId, observedAt)
        : {
            state: 'failed' as const,
            finishedAt: observedAt,
            errorCode: 'schedule-missing',
          };
      return {
        commit: { mutations: [{ kind: 'schedule-run.upsert', value: scheduleRunInput(run, {
          sessionId,
          state: disposition.state,
          ...(disposition.startedAt
            ? { startedAt: disposition.startedAt }
            : disposition.state === 'running' ? { startedAt: observedAt } : {}),
          ...(disposition.finishedAt ? { finishedAt: disposition.finishedAt } : {}),
          ...(disposition.errorCode ? { errorCode: disposition.errorCode } : {}),
        }) }] },
        value: undefined,
      };
    });
  }

  private async markScheduleFailed(runId: string, errorCode: string, finishedAt: string): Promise<void> {
    await this.applySystemTransition((state) => {
      const run = state.scheduleRuns.find((candidate) => candidate.id === runId);
      if (!run || run.state !== 'queued') return undefined;
      return {
        commit: { mutations: [{ kind: 'schedule-run.upsert', value: scheduleRunInput(run, {
          state: 'failed',
          finishedAt,
          errorCode,
        }) }] },
        value: undefined,
      };
    });
  }

  private async reconcileFinishedScheduleRuns(now: Date): Promise<void> {
    await this.applySystemTransition((state) => {
      const mutations: DaemonStoreMutation[] = [];
      for (const run of state.scheduleRuns) {
        if (run.state !== 'running' || !run.sessionId) continue;
        const schedule = state.snapshot.schedules.find((candidate) => candidate.id === run.scheduleId);
        const disposition = schedule
          ? scheduleSessionDisposition(state.snapshot, schedule, run.sessionId, now.toISOString())
          : {
              state: 'failed' as const,
              finishedAt: now.toISOString(),
              errorCode: 'schedule-missing',
            };
        if (disposition.state === 'running') continue;
        mutations.push({ kind: 'schedule-run.upsert', value: scheduleRunInput(run, {
          state: disposition.state,
          ...(disposition.startedAt ? { startedAt: disposition.startedAt } : {}),
          finishedAt: disposition.finishedAt ?? now.toISOString(),
          ...(disposition.errorCode ? { errorCode: disposition.errorCode } : {}),
        }) });
      }
      return mutations.length === 0 ? undefined : { commit: { mutations }, value: undefined };
    });
  }

  private armNextWake(): void {
    this.clearWakeTimer();
    if (!this.started || this.disposed) return;
    const snapshot = this.options.getSnapshot();
    if (!automationEnabled(snapshot)) return;
    const now = this.currentDate().valueOf();
    const candidates: number[] = [];
    for (const schedule of snapshot.schedules) {
      if (schedule.enabled && schedule.nextRunAt) candidates.push(Date.parse(schedule.nextRunAt));
    }
    for (const heartbeat of snapshot.heartbeats) {
      if (!heartbeat.enabled) continue;
      if (heartbeat.pending) candidates.push(now + this.pendingPollMs);
      else if (heartbeat.nextRunAt) candidates.push(Date.parse(heartbeat.nextRunAt));
    }
    if (this.options.getScheduleRuns(['queued']).length > 0) candidates.push(now + this.pendingPollMs);
    const finite = candidates.filter(Number.isFinite);
    if (finite.length === 0) return;
    const delay = Math.max(1, Math.min(MAX_TIMER_DELAY_MS, Math.min(...finite) - now));
    this.armWakeTimer(delay);
  }

  private armWakeTimer(delayMs: number): void {
    this.clearWakeTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.requestTick();
    }, Math.max(0, Math.min(MAX_TIMER_DELAY_MS, delayMs)));
  }

  private clearWakeTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private report(context: string, error: unknown): void {
    try {
      this.options.reportError?.(context, error);
    } catch {
      // Diagnostics cannot change automation semantics.
    }
  }
}
