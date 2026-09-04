import { z } from 'zod';

export const DAEMON_PROTOCOL_VERSION = 12 as const;

export const DAEMON_HARD_LIMITS = Object.freeze({
  concurrentManagedTurns: 4,
  nodesPerTree: 16,
  treeDepth: 4,
  childCreationsPerWindow: 12,
  childCreationWindowMs: 10 * 60 * 1_000,
  backgroundTurnMs: 2 * 60 * 60 * 1_000,
});

export type DaemonPrincipalKind = 'desktop' | 'android' | 'cli' | 'mcp' | 'provider';

export interface DaemonPrincipal {
  readonly kind: DaemonPrincipalKind;
  readonly id: string;
  readonly sessionId?: string;
}

export type PermissionPreset = 'plan' | 'standard' | 'full-access';
export type WorkspaceKind = 'local' | 'worktree';
export type SessionKind = 'agent' | 'terminal' | 'diff' | 'browser' | 'script' | 'service';
export type SessionLifecycleState =
  | 'draft'
  | 'starting'
  | 'running'
  | 'idle'
  | 'needs-attention'
  | 'stopping'
  | 'completed'
  | 'interrupted'
  | 'delivery-uncertain'
  | 'failed'
  | 'archived';
export type ManagedAgentState =
  | 'starting'
  | 'queued'
  | 'working'
  | 'blocked'
  | 'idle'
  | 'done'
  | 'interrupted'
  | 'delivery-uncertain'
  | 'error'
  | 'archived';
export type TurnState =
  | 'queued'
  | 'submitting'
  | 'working'
  | 'blocked'
  | 'completed'
  | 'interrupted'
  | 'delivery-uncertain'
  | 'failed';

export interface RevisionedRecord {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DaemonProject extends RevisionedRecord {
  readonly id: string;
  readonly name: string;
  readonly rootPath?: string;
  readonly source: 'native' | 'legacy-import';
  readonly archivedAt?: string;
}

export interface DaemonWorkspace extends RevisionedRecord {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly kind: WorkspaceKind;
  readonly rootPath: string;
  readonly sourceWorkspaceId?: string;
  readonly archivedAt?: string;
}

export interface DaemonSession extends RevisionedRecord {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly kind: SessionKind;
  readonly title: string;
  readonly state: SessionLifecycleState;
  readonly source: 'structured' | 'legacy-pty' | 'legacy-import';
  readonly archivedAt?: string;
}

export interface DaemonAgent extends RevisionedRecord {
  readonly sessionId: string;
  readonly providerId: string;
  readonly providerSessionId?: string;
  readonly model?: string;
  readonly permissionPreset: PermissionPreset;
  readonly state: ManagedAgentState;
  readonly currentTurnId?: string;
  readonly queuedTurnCount: number;
  readonly orchestrationEnabled: boolean;
}

export interface DaemonAgentRelation extends RevisionedRecord {
  readonly id: string;
  readonly treeId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly owner: 'managed' | 'provider-native';
  readonly depth: number;
  readonly detachedAt?: string;
}

export interface DaemonTurn extends RevisionedRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly commandId: string;
  /** Stable daemon-assigned FIFO position; preserved across lifecycle updates. */
  readonly enqueueSequence?: number;
  readonly state: TurnState;
  readonly providerTurnId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
}

export type TranscriptItemKind =
  | 'user-message'
  | 'assistant-message'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'approval'
  | 'child-summary'
  | 'notice'
  | 'error';

export interface DaemonTranscriptItem {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly sequence: number;
  readonly kind: TranscriptItemKind;
  readonly text: string;
  readonly isDelta: boolean;
  readonly isSensitive: boolean;
  readonly relatedSessionId?: string;
  readonly createdAt: string;
}

export interface DaemonTranscriptHead {
  readonly sessionId: string;
  readonly lastSequence: number;
  readonly itemCount: number;
}

export interface DaemonApproval extends RevisionedRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly providerRequestId: string;
  readonly risk: 'read' | 'write' | 'danger';
  readonly title: string;
  readonly detail?: string;
  readonly state: 'pending' | 'allowed' | 'denied' | 'expired';
  readonly resolvedAt?: string;
}

export type ProviderProtocol = 'codex-app-server' | 'claude-agent-sdk' | 'acp' | 'pi-rpc';

export interface DaemonProvider extends RevisionedRecord {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly argv: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly capabilities: readonly string[];
  readonly enabled: boolean;
  readonly health: 'unknown' | 'ready' | 'unavailable' | 'incompatible' | 'error';
  readonly healthDetail?: string;
}

export interface DaemonSchedule extends RevisionedRecord {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly providerId: string;
  readonly model?: string;
  readonly permissionPreset: PermissionPreset;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly maxRuns?: number;
  readonly runCount: number;
  readonly expiresAt?: string;
  readonly nextRunAt?: string;
}

export interface DaemonHeartbeat extends RevisionedRecord {
  readonly sessionId: string;
  readonly prompt: string;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly nextRunAt?: string;
}

export interface DaemonRuntimeSettings {
  readonly keepRunning: boolean;
  readonly startAtLogin: boolean;
  readonly orchestrationToolsEnabled: boolean;
  readonly browserEnabled: boolean;
}

export interface DaemonSnapshot {
  readonly protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly revision: number;
  readonly eventSequence: number;
  readonly generatedAt: string;
  readonly runtime: DaemonRuntimeSettings;
  readonly projects: readonly DaemonProject[];
  readonly workspaces: readonly DaemonWorkspace[];
  readonly sessions: readonly DaemonSession[];
  readonly agents: readonly DaemonAgent[];
  readonly agentRelations: readonly DaemonAgentRelation[];
  readonly turns: readonly DaemonTurn[];
  readonly transcriptHeads: readonly DaemonTranscriptHead[];
  readonly approvals: readonly DaemonApproval[];
  readonly providers: readonly DaemonProvider[];
  readonly schedules: readonly DaemonSchedule[];
  readonly heartbeats: readonly DaemonHeartbeat[];
}

export const DAEMON_COMMAND_TYPES = [
  'project.create',
  'project.update',
  'project.archive',
  'workspace.create',
  'workspace.update',
  'workspace.archive',
  'session.create',
  'session.update',
  'session.archive',
  'agent.create',
  'agent.resume',
  'agent.submit',
  'agent.interrupt-and-submit',
  'agent.interrupt',
  'agent.set-settings',
  'agent.cancel',
  'agent.archive',
  'agent.detach',
  'permission.resolve',
  'provider.enable',
  'provider.disable',
  'provider.update',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
  'schedule.run-now',
  'heartbeat.configure',
  'heartbeat.trigger',
  'browser.open',
  'browser.action',
  'browser.close',
  'script.run',
  'script.stop',
  'service.start',
  'service.stop',
  'runtime.set-settings',
] as const;

export type DaemonCommandType = (typeof DAEMON_COMMAND_TYPES)[number];

export interface ProviderEnableInput {
  readonly providerId: string;
  readonly displayName: string;
  readonly protocol: ProviderProtocol;
  readonly executablePath: string;
  readonly executableVersion: string;
  readonly argv: readonly string[];
  readonly environmentVariableNames: readonly string[];
  readonly capabilities: readonly string[];
  readonly reviewDigest: string;
}

export interface DaemonCommandPayloads {
  readonly 'project.create': { readonly projectId: string; readonly name: string; readonly rootPath?: string };
  readonly 'project.update': { readonly projectId: string; readonly name?: string; readonly rootPath?: string };
  readonly 'project.archive': { readonly projectId: string };
  readonly 'workspace.create': {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly name: string;
    readonly kind: WorkspaceKind;
    readonly rootPath: string;
    readonly sourceWorkspaceId?: string;
  };
  readonly 'workspace.update': { readonly workspaceId: string; readonly name?: string; readonly rootPath?: string };
  readonly 'workspace.archive': { readonly workspaceId: string };
  readonly 'session.create': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly kind: Exclude<SessionKind, 'agent'>;
    readonly title: string;
  };
  readonly 'session.update': { readonly sessionId: string; readonly title?: string };
  readonly 'session.archive': { readonly sessionId: string };
  readonly 'agent.create': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly providerId: string;
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly initialPrompt: string;
    readonly parentSessionId?: string;
  };
  readonly 'agent.resume': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly providerId: string;
    readonly providerSessionId: string;
    readonly title: string;
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly parentSessionId?: string;
  };
  readonly 'agent.submit': { readonly sessionId: string; readonly prompt: string };
  readonly 'agent.interrupt-and-submit': { readonly sessionId: string; readonly prompt: string };
  readonly 'agent.interrupt': { readonly sessionId: string };
  readonly 'agent.set-settings': {
    readonly sessionId: string;
    readonly model?: string;
    readonly permissionPreset?: PermissionPreset;
  };
  readonly 'agent.cancel': { readonly sessionId: string };
  readonly 'agent.archive': { readonly sessionId: string };
  readonly 'agent.detach': { readonly sessionId: string };
  readonly 'permission.resolve': { readonly approvalId: string; readonly decision: 'allow' | 'deny' };
  readonly 'provider.enable': ProviderEnableInput;
  readonly 'provider.disable': { readonly providerId: string };
  readonly 'provider.update': ProviderEnableInput;
  readonly 'schedule.create': {
    readonly scheduleId: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly providerId: string;
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly prompt: string;
    readonly cron: string;
    readonly timezone: string;
    readonly maxRuns?: number;
    readonly expiresAt?: string;
    readonly enabled: boolean;
  };
  readonly 'schedule.update': {
    readonly scheduleId: string;
    readonly name?: string;
    readonly prompt?: string;
    readonly cron?: string;
    readonly timezone?: string;
    readonly maxRuns?: number;
    readonly expiresAt?: string;
    readonly enabled?: boolean;
  };
  readonly 'schedule.delete': { readonly scheduleId: string };
  readonly 'schedule.run-now': { readonly scheduleId: string };
  readonly 'heartbeat.configure': {
    readonly sessionId: string;
    readonly prompt: string;
    readonly cron: string;
    readonly timezone: string;
    readonly enabled: boolean;
  };
  readonly 'heartbeat.trigger': { readonly sessionId: string };
  readonly 'browser.open': { readonly sessionId: string; readonly workspaceId: string; readonly url: string };
  readonly 'browser.action': {
    readonly sessionId: string;
    readonly action: 'navigate' | 'click' | 'type' | 'snapshot' | 'upload';
    readonly target?: string;
    readonly value?: string;
    readonly filePath?: string;
  };
  readonly 'browser.close': { readonly sessionId: string };
  readonly 'script.run': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly command: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environmentVariableNames: readonly string[];
  };
  readonly 'script.stop': { readonly sessionId: string };
  readonly 'service.start': {
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly command: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environmentVariableNames: readonly string[];
    readonly restartPolicy: 'never' | 'on-failure' | 'always';
  };
  readonly 'service.stop': { readonly sessionId: string };
  readonly 'runtime.set-settings': Partial<DaemonRuntimeSettings>;
}

export interface DaemonCommandEnvelope<T extends DaemonCommandType> {
  readonly protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly issuedAt: string;
  readonly principal: DaemonPrincipal;
  readonly type: T;
  readonly payload: DaemonCommandPayloads[T];
}

export type DaemonCommand = {
  readonly [T in DaemonCommandType]: DaemonCommandEnvelope<T>;
}[DaemonCommandType];

export type DaemonCommandErrorCode =
  | 'invalid-command'
  | 'unauthorized'
  | 'not-found'
  | 'revision-conflict'
  | 'invalid-state'
  | 'provider-unavailable'
  | 'provider-incompatible'
  | 'tree-depth-limit'
  | 'tree-node-limit'
  | 'child-rate-limit'
  | 'background-turn-timeout'
  | 'automation-requires-daemon'
  | 'delivery-uncertain'
  | 'internal-error';

export interface DaemonCommandError {
  readonly code: DaemonCommandErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentRevision?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DaemonCommandReceipt =
  | {
      readonly ok: true;
      readonly status: 'applied' | 'queued' | 'replayed';
      readonly commandId: string;
      readonly revision: number;
      readonly eventSequence: number;
    }
  | {
      readonly ok: false;
      readonly status: 'rejected' | 'delivery-uncertain';
      readonly commandId: string;
      readonly revision: number;
      readonly error: DaemonCommandError;
    };

export interface DaemonEventPayloads {
  readonly 'entity.upserted': {
    readonly entityType: 'project' | 'workspace' | 'session' | 'agent' | 'relation' | 'turn' | 'approval' | 'provider' | 'schedule' | 'heartbeat';
    readonly entityId: string;
  };
  readonly 'entity.archived': { readonly entityType: 'project' | 'workspace' | 'session'; readonly entityId: string };
  readonly 'transcript.appended': { readonly sessionId: string; readonly fromSequence: number; readonly toSequence: number };
  readonly 'command.changed': { readonly commandId: string; readonly state: 'pending' | 'sent' | 'applied' | 'delivery-uncertain' | 'failed' };
  readonly 'approval.changed': { readonly approvalId: string; readonly sessionId: string };
  readonly 'runtime.changed': { readonly settings: DaemonRuntimeSettings };
  readonly 'runtime.recovery': { readonly mode: 'normal' | 'legacy-read-only'; readonly detail?: string };
}

export type DaemonEventKind = keyof DaemonEventPayloads;

export interface DaemonEventEnvelope<T extends DaemonEventKind> {
  readonly protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly revision: number;
  readonly occurredAt: string;
  readonly kind: T;
  readonly payload: DaemonEventPayloads[T];
}

export type DaemonEvent = {
  readonly [T in DaemonEventKind]: DaemonEventEnvelope<T>;
}[DaemonEventKind];

export type DaemonEventContinuity = 'next' | 'duplicate' | 'gap' | 'revision-regression';

export function classifyDaemonEvent(
  cursor: Pick<DaemonSnapshot, 'revision' | 'eventSequence'>,
  event: DaemonEvent,
): DaemonEventContinuity {
  if (event.revision < cursor.revision) {
    return 'revision-regression';
  }
  if (event.sequence <= cursor.eventSequence) {
    return 'duplicate';
  }
  if (event.sequence !== cursor.eventSequence + 1) {
    return 'gap';
  }
  return 'next';
}

const NonEmptyStringSchema = z.string().trim().min(1);
const IdentifierSchema = NonEmptyStringSchema.max(256);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();
const StringArraySchema = z.array(z.string());
const PermissionPresetSchema = z.enum(['plan', 'standard', 'full-access']);
const WorkspaceKindSchema = z.enum(['local', 'worktree']);
const ProviderProtocolSchema = z.enum(['codex-app-server', 'claude-agent-sdk', 'acp', 'pi-rpc']);
const SessionKindWithoutAgentSchema = z.enum(['terminal', 'diff', 'browser', 'script', 'service']);

export const DaemonPrincipalSchema = z.object({
  kind: z.enum(['desktop', 'android', 'cli', 'mcp', 'provider']),
  id: IdentifierSchema,
  sessionId: IdentifierSchema.optional(),
}).strict().superRefine((principal, context) => {
  if ((principal.kind === 'mcp' || principal.kind === 'provider') && principal.sessionId === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['sessionId'],
      message: `${principal.kind} principals require a sessionId`,
    });
  }
});

const ProviderEnableSchema = z.object({
  providerId: IdentifierSchema,
  displayName: NonEmptyStringSchema,
  protocol: ProviderProtocolSchema,
  executablePath: NonEmptyStringSchema,
  executableVersion: NonEmptyStringSchema,
  argv: StringArraySchema,
  environmentVariableNames: StringArraySchema,
  capabilities: StringArraySchema,
  reviewDigest: NonEmptyStringSchema,
}).strict();

const SessionIdSchema = z.object({ sessionId: IdentifierSchema }).strict();
const ScheduleIdSchema = z.object({ scheduleId: IdentifierSchema }).strict();

const DaemonCommandPayloadSchemas: Record<DaemonCommandType, z.ZodType> = {
  'project.create': z.object({ projectId: IdentifierSchema, name: NonEmptyStringSchema, rootPath: NonEmptyStringSchema.optional() }).strict(),
  'project.update': z.object({ projectId: IdentifierSchema, name: NonEmptyStringSchema.optional(), rootPath: NonEmptyStringSchema.optional() }).strict(),
  'project.archive': z.object({ projectId: IdentifierSchema }).strict(),
  'workspace.create': z.object({
    workspaceId: IdentifierSchema,
    projectId: IdentifierSchema,
    name: NonEmptyStringSchema,
    kind: WorkspaceKindSchema,
    rootPath: NonEmptyStringSchema,
    sourceWorkspaceId: IdentifierSchema.optional(),
  }).strict(),
  'workspace.update': z.object({ workspaceId: IdentifierSchema, name: NonEmptyStringSchema.optional(), rootPath: NonEmptyStringSchema.optional() }).strict(),
  'workspace.archive': z.object({ workspaceId: IdentifierSchema }).strict(),
  'session.create': z.object({ sessionId: IdentifierSchema, workspaceId: IdentifierSchema, kind: SessionKindWithoutAgentSchema, title: NonEmptyStringSchema }).strict(),
  'session.update': z.object({ sessionId: IdentifierSchema, title: NonEmptyStringSchema.optional() }).strict(),
  'session.archive': SessionIdSchema,
  'agent.create': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    title: NonEmptyStringSchema,
    providerId: IdentifierSchema,
    model: NonEmptyStringSchema.optional(),
    permissionPreset: PermissionPresetSchema,
    initialPrompt: NonEmptyStringSchema,
    parentSessionId: IdentifierSchema.optional(),
  }).strict(),
  'agent.resume': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    providerId: IdentifierSchema,
    providerSessionId: IdentifierSchema,
    title: NonEmptyStringSchema,
    model: NonEmptyStringSchema.optional(),
    permissionPreset: PermissionPresetSchema,
    parentSessionId: IdentifierSchema.optional(),
  }).strict(),
  'agent.submit': z.object({ sessionId: IdentifierSchema, prompt: NonEmptyStringSchema }).strict(),
  'agent.interrupt-and-submit': z.object({ sessionId: IdentifierSchema, prompt: NonEmptyStringSchema }).strict(),
  'agent.interrupt': SessionIdSchema,
  'agent.set-settings': z.object({ sessionId: IdentifierSchema, model: NonEmptyStringSchema.optional(), permissionPreset: PermissionPresetSchema.optional() }).strict(),
  'agent.cancel': SessionIdSchema,
  'agent.archive': SessionIdSchema,
  'agent.detach': SessionIdSchema,
  'permission.resolve': z.object({ approvalId: IdentifierSchema, decision: z.enum(['allow', 'deny']) }).strict(),
  'provider.enable': ProviderEnableSchema,
  'provider.disable': z.object({ providerId: IdentifierSchema }).strict(),
  'provider.update': ProviderEnableSchema,
  'schedule.create': z.object({
    scheduleId: IdentifierSchema,
    name: NonEmptyStringSchema,
    workspaceId: IdentifierSchema,
    providerId: IdentifierSchema,
    model: NonEmptyStringSchema.optional(),
    permissionPreset: PermissionPresetSchema,
    prompt: NonEmptyStringSchema,
    cron: NonEmptyStringSchema,
    timezone: NonEmptyStringSchema,
    maxRuns: PositiveIntegerSchema.optional(),
    expiresAt: NonEmptyStringSchema.optional(),
    enabled: z.boolean(),
  }).strict(),
  'schedule.update': z.object({
    scheduleId: IdentifierSchema,
    name: NonEmptyStringSchema.optional(),
    prompt: NonEmptyStringSchema.optional(),
    cron: NonEmptyStringSchema.optional(),
    timezone: NonEmptyStringSchema.optional(),
    maxRuns: PositiveIntegerSchema.optional(),
    expiresAt: NonEmptyStringSchema.optional(),
    enabled: z.boolean().optional(),
  }).strict(),
  'schedule.delete': ScheduleIdSchema,
  'schedule.run-now': ScheduleIdSchema,
  'heartbeat.configure': z.object({
    sessionId: IdentifierSchema,
    prompt: NonEmptyStringSchema,
    cron: NonEmptyStringSchema,
    timezone: NonEmptyStringSchema,
    enabled: z.boolean(),
  }).strict(),
  'heartbeat.trigger': SessionIdSchema,
  'browser.open': z.object({ sessionId: IdentifierSchema, workspaceId: IdentifierSchema, url: z.url() }).strict(),
  'browser.action': z.object({
    sessionId: IdentifierSchema,
    action: z.enum(['navigate', 'click', 'type', 'snapshot', 'upload']),
    target: NonEmptyStringSchema.optional(),
    value: z.string().optional(),
    filePath: NonEmptyStringSchema.optional(),
  }).strict(),
  'browser.close': SessionIdSchema,
  'script.run': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    command: NonEmptyStringSchema,
    argv: StringArraySchema,
    cwd: NonEmptyStringSchema,
    environmentVariableNames: StringArraySchema,
  }).strict(),
  'script.stop': SessionIdSchema,
  'service.start': z.object({
    sessionId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    command: NonEmptyStringSchema,
    argv: StringArraySchema,
    cwd: NonEmptyStringSchema,
    environmentVariableNames: StringArraySchema,
    restartPolicy: z.enum(['never', 'on-failure', 'always']),
  }).strict(),
  'service.stop': SessionIdSchema,
  'runtime.set-settings': z.object({
    keepRunning: z.boolean().optional(),
    startAtLogin: z.boolean().optional(),
    orchestrationToolsEnabled: z.boolean().optional(),
    browserEnabled: z.boolean().optional(),
  }).strict(),
};

const DaemonCommandEnvelopeSchema = z.object({
  protocolVersion: z.literal(DAEMON_PROTOCOL_VERSION),
  commandId: IdentifierSchema,
  idempotencyKey: IdentifierSchema,
  expectedRevision: NonNegativeIntegerSchema,
  issuedAt: NonEmptyStringSchema,
  principal: DaemonPrincipalSchema,
  type: z.enum(DAEMON_COMMAND_TYPES),
  payload: z.unknown(),
}).strict();

export function parseDaemonCommand(value: unknown): DaemonCommand {
  const envelope = DaemonCommandEnvelopeSchema.parse(value);
  const payload = DaemonCommandPayloadSchemas[envelope.type].parse(envelope.payload);
  return { ...envelope, payload } as DaemonCommand;
}

export function safeParseDaemonCommand(value: unknown): z.ZodSafeParseResult<DaemonCommand> {
  try {
    return { success: true, data: parseDaemonCommand(value) };
  } catch (error) {
    return { success: false, error: error as z.ZodError<DaemonCommand> };
  }
}

export function createDaemonCommand<T extends DaemonCommandType>(input: Omit<DaemonCommandEnvelope<T>, 'protocolVersion'>): DaemonCommandEnvelope<T> {
  return {
    ...input,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
  };
}
