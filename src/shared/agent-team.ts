import { z } from 'zod';

import {
  MAX_AGENT_PROMPT_BYTES,
  type AgentValidationCommand,
  isSafeAgentPromptText,
} from './agent-coordination';
import type {
  AgentLaunchPreparation,
  AgentLaunchTarget,
  AgentTeamLaunchReference,
} from './agent-history';

export const AGENT_TEAM_CATALOG_SCHEMA_VERSION = 1 as const;
export const AGENT_TEAM_RUN_SCHEMA_VERSION = 1 as const;
export const MAX_AGENT_PERSONAS = 64;
export const MAX_AGENT_TEAMS = 32;
export const MAX_AGENT_TEAM_MEMBERS = 8;
export const MAX_AGENT_TEAM_RUNS = 128;
export const MAX_AGENT_TEAM_GOAL_CRITERIA = 12;

function hasControlCharacter(value: string, allowed: ReadonlySet<number> = new Set()): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || allowed.has(codePoint)) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

const MultilineControls = new Set([0x09, 0x0a, 0x0d]);

const SafeSingleLine = (max: number) => z.string()
  .trim()
  .min(1)
  .max(max)
  .refine((value) => !hasControlCharacter(value), 'must not contain control characters');

const SafeMultiline = (max: number) => z.string()
  .trim()
  .min(1)
  .max(max)
  .refine(
    (value) => !hasControlCharacter(value, MultilineControls),
    'must not contain terminal control characters',
  );

const OpaqueIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().positive();

export const AGENT_PERSONA_ICONS = [
  'bot',
  'code',
  'search',
  'shield-check',
  'test-tube',
  'file-text',
] as const;

export type AgentPersonaIcon = (typeof AGENT_PERSONA_ICONS)[number];

export const AGENT_PERSONA_PRESETS = [
  'planner',
  'implementer',
  'reviewer',
  'tester',
  'custom',
] as const;

export type AgentPersonaPreset = (typeof AGENT_PERSONA_PRESETS)[number];

export interface AgentPersonaPresetDefinition {
  readonly icon: AgentPersonaIcon;
  readonly role: string;
  readonly instructions: string;
}

export const AGENT_PERSONA_PRESET_DEFINITIONS: Readonly<Record<
  AgentPersonaPreset,
  AgentPersonaPresetDefinition
>> = Object.freeze({
  planner: Object.freeze({
    icon: 'search',
    role: 'Planner',
    instructions: [
      'Turn the run goal into bounded assignments that can start from the same frozen commit.',
      'Cover scope, expected outcomes, completion criteria, and configured validations.',
      'Do not edit project files before the human approves the plan.',
    ].join(' '),
  }),
  implementer: Object.freeze({
    icon: 'code',
    role: 'Implementer',
    instructions: [
      'Implement only the approved assignment and preserve unrelated user changes.',
      'Validate the result with the assigned checks and report observed evidence and blockers.',
      'Do not perform destructive Git or worktree operations.',
    ].join(' '),
  }),
  reviewer: Object.freeze({
    icon: 'shield-check',
    role: 'Reviewer',
    instructions: [
      'Review the approved work for correctness, regressions, security, and missing validation.',
      'Ground findings in inspected code or observed command output and stay within the assigned scope.',
    ].join(' '),
  }),
  tester: Object.freeze({
    icon: 'test-tube',
    role: 'Tester',
    instructions: [
      'Run or add bounded tests for the approved assignment without expanding product scope.',
      'Report the exact commands, outcomes, and any unverified risk.',
    ].join(' '),
  }),
  custom: Object.freeze({
    icon: 'bot',
    role: 'Custom collaborator',
    instructions: [
      'Work only on the approved assignment, preserve unrelated user changes, and report validation evidence and blockers.',
    ].join(' '),
  }),
});

export const DEFAULT_AGENT_TEAM_INSTRUCTIONS = [
  'Keep assignments independently startable from the frozen target commit.',
  'Preserve unrelated user changes, surface scope overlap before merging, and report actual validation evidence.',
].join(' ');

const OptionalModelSchema = SafeSingleLine(128).optional();

export const AgentPersonaLaunchSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('codex'),
    model: OptionalModelSchema,
    sandbox: z.enum(['read-only', 'workspace-write']),
  }),
  z.strictObject({
    provider: z.literal('claude'),
    model: OptionalModelSchema,
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    permissionMode: z.enum(['plan', 'manual', 'acceptEdits']),
  }),
]);

export type AgentPersonaLaunch = z.infer<typeof AgentPersonaLaunchSchema>;

export function defaultAgentPersonaLaunch(
  preset: AgentPersonaPreset,
  provider: AgentPersonaLaunch['provider'],
): AgentPersonaLaunch {
  const mayWrite = preset === 'implementer' || preset === 'tester';
  return provider === 'codex'
    ? { provider, sandbox: mayWrite ? 'workspace-write' : 'read-only' }
    : { provider, permissionMode: mayWrite ? 'acceptEdits' : preset === 'custom' ? 'manual' : 'plan' };
}

export const AgentPersonaSchema = z.strictObject({
  personaId: OpaqueIdSchema,
  revision: RevisionSchema,
  name: SafeSingleLine(48),
  preset: z.enum(AGENT_PERSONA_PRESETS).optional(),
  icon: z.enum(AGENT_PERSONA_ICONS),
  role: SafeSingleLine(120),
  instructions: SafeMultiline(8_000),
  launch: AgentPersonaLaunchSchema,
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

export type AgentPersona = z.infer<typeof AgentPersonaSchema>;

export interface AgentPersonaInput {
  readonly personaId?: string;
  readonly expectedRevision?: number;
  readonly name: string;
  readonly preset?: AgentPersonaPreset;
  readonly icon: AgentPersonaIcon;
  readonly role: string;
  readonly instructions: string;
  readonly launch: AgentPersonaLaunch;
}

const AgentTeamAcceptanceCriteriaSchema = z.array(SafeMultiline(500))
  .min(1)
  .max(MAX_AGENT_TEAM_GOAL_CRITERIA)
  .refine(
    (criteria) => new Set(criteria.map((criterion) => criterion.toLocaleLowerCase('en-US'))).size
      === criteria.length,
    'completion criteria must be unique',
  );

export const AgentTeamGoalSchema = z.strictObject({
  outcome: SafeMultiline(2_000),
  acceptanceCriteria: AgentTeamAcceptanceCriteriaSchema,
});

export type AgentTeamGoal = z.infer<typeof AgentTeamGoalSchema>;

export const AgentTeamSchema = z.strictObject({
  teamId: OpaqueIdSchema,
  revision: RevisionSchema,
  name: SafeSingleLine(80),
  description: SafeMultiline(500).optional(),
  instructions: SafeMultiline(8_000),
  defaultGoal: AgentTeamGoalSchema.optional(),
  personaIds: z.array(OpaqueIdSchema).min(2).max(MAX_AGENT_TEAM_MEMBERS),
  plannerPersonaId: OpaqueIdSchema,
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
});

export type AgentTeam = z.infer<typeof AgentTeamSchema>;

export interface AgentTeamInput {
  readonly teamId?: string;
  readonly expectedRevision?: number;
  readonly name: string;
  readonly description?: string;
  readonly instructions: string;
  readonly defaultGoal?: AgentTeamGoal;
  readonly personaIds: readonly string[];
  readonly plannerPersonaId: string;
}

export interface AgentStarterTeamInput {
  readonly plannerProvider: AgentPersonaLaunch['provider'];
  readonly implementerProvider: AgentPersonaLaunch['provider'];
}

export interface AgentStarterTeam {
  readonly planner: AgentPersona;
  readonly implementer: AgentPersona;
  readonly team: AgentTeam;
}

export interface AgentLauncherCapabilities {
  readonly provider: 'codex' | 'claude';
  readonly available: boolean;
  readonly supportsModel: boolean;
  readonly effortValues: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  readonly permissionValues: readonly ('read-only' | 'workspace-write' | 'plan' | 'manual' | 'acceptEdits')[];
  readonly modelAvailability: 'provider-default' | 'launch-time';
}

export interface AgentTeamCatalogSnapshot {
  readonly revision: number;
  readonly personas: readonly AgentPersona[];
  readonly teams: readonly AgentTeam[];
  readonly capabilities: readonly AgentLauncherCapabilities[];
}

export const AgentTeamAssignmentSchema = z.strictObject({
  taskId: OpaqueIdSchema,
  personaId: OpaqueIdSchema,
  title: SafeSingleLine(120),
  outcome: SafeMultiline(1_000),
  scopeHints: z.array(SafeSingleLine(256)).max(12),
  validationIds: z.array(SafeSingleLine(128)).max(8),
  acceptanceCriteria: z.array(SafeMultiline(500)).min(1).max(12),
  brief: SafeMultiline(16_000),
});

export type AgentTeamAssignment = z.infer<typeof AgentTeamAssignmentSchema>;

export const AgentTeamExcludedMemberSchema = z.strictObject({
  personaId: OpaqueIdSchema,
  reason: SafeMultiline(500),
});

export type AgentTeamExcludedMember = z.infer<typeof AgentTeamExcludedMemberSchema>;

export const AgentTeamPlanProposalSchema = z.strictObject({
  summary: SafeMultiline(1_000),
  assignments: z.array(AgentTeamAssignmentSchema).min(1).max(MAX_AGENT_TEAM_MEMBERS),
  excludedMembers: z.array(AgentTeamExcludedMemberSchema).max(MAX_AGENT_TEAM_MEMBERS - 1),
}).superRefine((proposal, context) => {
  if (new TextEncoder().encode(JSON.stringify(proposal)).byteLength > MAX_AGENT_PROMPT_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'the complete plan must fit in one bounded Agent prompt',
    });
  }
});

export type AgentTeamPlanProposal = z.infer<typeof AgentTeamPlanProposalSchema>;

export type AgentTeamRunPhase =
  | 'preparing-planner'
  | 'planning'
  | 'awaiting-review'
  | 'launching'
  | 'active'
  | 'partial'
  | 'completed'
  | 'canceled'
  | 'failed';

export type AgentTeamMemberLaunchState =
  | 'planned'
  | 'preparing'
  | 'prepared'
  | 'launching'
  | 'active'
  | 'failed'
  | 'excluded';

export const AgentTeamMemberSlotSchema = z.strictObject({
  personaId: OpaqueIdSchema,
  taskId: OpaqueIdSchema.optional(),
  state: z.enum(['planned', 'preparing', 'prepared', 'launching', 'active', 'failed', 'excluded']),
  branch: SafeSingleLine(200).optional(),
  rootId: SafeSingleLine(128).optional(),
  workspaceId: SafeSingleLine(128).optional(),
  worktreeId: SafeSingleLine(128).optional(),
  worktreePath: SafeSingleLine(8_192).optional(),
  sessionId: SafeSingleLine(256).optional(),
  activityId: SafeSingleLine(256).optional(),
  participantId: SafeSingleLine(256).optional(),
  error: SafeMultiline(500).optional(),
  updatedAt: z.number().finite().nonnegative(),
});

export type AgentTeamMemberSlot = z.infer<typeof AgentTeamMemberSlotSchema>;

const ValidationCommandSchema: z.ZodType<AgentValidationCommand> = z.strictObject({
  id: SafeSingleLine(128),
  name: SafeSingleLine(120),
  command: SafeMultiline(8_192),
  timeoutMs: z.number().int().min(1_000).max(30 * 60_000),
});

export const AgentTeamRunSchema = z.strictObject({
  schemaVersion: z.literal(AGENT_TEAM_RUN_SCHEMA_VERSION),
  runId: OpaqueIdSchema,
  revision: RevisionSchema,
  projectId: SafeSingleLine(128),
  projectName: SafeSingleLine(80),
  projectGoal: SafeMultiline(2_000).optional(),
  goal: SafeMultiline(2_000),
  goalAcceptanceCriteria: AgentTeamAcceptanceCriteriaSchema.optional(),
  constraints: SafeMultiline(2_000).optional(),
  targetBranch: SafeSingleLine(200),
  validationConfigRevision: z.number().int().positive(),
  validationCommands: z.array(ValidationCommandSchema).max(8),
  team: AgentTeamSchema,
  personas: z.array(AgentPersonaSchema).min(2).max(MAX_AGENT_TEAM_MEMBERS),
  plannerPersonaId: OpaqueIdSchema,
  phase: z.enum([
    'preparing-planner', 'planning', 'awaiting-review', 'launching', 'active',
    'partial', 'completed', 'canceled', 'failed',
  ]),
  proposal: AgentTeamPlanProposalSchema.optional(),
  slots: z.array(AgentTeamMemberSlotSchema).min(2).max(MAX_AGENT_TEAM_MEMBERS),
  baseHead: SafeSingleLine(64).optional(),
  baseDirty: z.boolean().optional(),
  warningAcknowledged: z.boolean(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  approvedAt: z.number().finite().nonnegative().optional(),
  finishedAt: z.number().finite().nonnegative().optional(),
  message: SafeMultiline(500).optional(),
});

export type AgentTeamRun = z.infer<typeof AgentTeamRunSchema>;

export interface AgentTeamRunSnapshot {
  readonly revision: number;
  readonly runs: readonly AgentTeamRun[];
}

export interface AgentTeamDesktopSnapshot {
  readonly revision: number;
  readonly catalog: AgentTeamCatalogSnapshot;
  readonly runRevision: number;
  readonly runs: readonly AgentTeamRun[];
}

export const EMPTY_AGENT_TEAM_DESKTOP_SNAPSHOT: AgentTeamDesktopSnapshot = Object.freeze({
  revision: 0,
  catalog: Object.freeze({
    revision: 0,
    personas: Object.freeze([]),
    teams: Object.freeze([]),
    capabilities: Object.freeze([]),
  }),
  runRevision: 0,
  runs: Object.freeze([]),
});

export interface AgentTeamRunInput {
  readonly projectId: string;
  readonly teamId: string;
  readonly goal: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints?: string;
  readonly warningAcknowledged: boolean;
}

export interface AgentTeamPlanSubmission {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly proposal: AgentTeamPlanProposal;
}

export interface AgentTeamPlanApprovalInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly proposal: AgentTeamPlanProposal;
}

export interface AgentTeamMemberBinding {
  readonly branch?: string;
  readonly rootId?: string;
  readonly workspaceId?: string;
  readonly worktreeId?: string;
  readonly worktreePath?: string;
  readonly sessionId?: string;
  readonly activityId?: string;
  readonly participantId?: string;
}

export interface AgentTeamMemberLaunchInput extends AgentTeamLaunchReference {
  readonly expectedRevision: number;
  readonly target: AgentLaunchTarget;
  readonly binding: AgentTeamMemberBinding;
}

export type AgentTeamMemberLaunchResult = AgentTeamMutationResult<{
  readonly run: AgentTeamRun;
  readonly preparation: Extract<AgentLaunchPreparation, { readonly ok: true }>;
}>;

export interface AgentTeamMemberActivationInput extends AgentTeamLaunchReference {
  readonly sessionId: string;
}

export interface AgentTeamMemberFailureInput extends AgentTeamLaunchReference {
  readonly expectedRevision: number;
  readonly error: string;
  readonly binding?: AgentTeamMemberBinding;
}

export type AgentTeamMemberActivationResult = AgentTeamMutationResult<{
  readonly run: AgentTeamRun;
  readonly brief: string;
}>;

export interface AgentTeamRunDecisionInput {
  readonly runId: string;
  readonly expectedRevision: number;
  readonly decision: 'complete' | 'cancel';
}

export type AgentTeamMutationError =
  | 'invalid'
  | 'not-found'
  | 'stale'
  | 'conflict'
  | 'unavailable';

export type AgentTeamMutationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentTeamMutationError; readonly message: string };

export function isTerminalAgentTeamRunPhase(phase: AgentTeamRunPhase): boolean {
  return phase === 'completed' || phase === 'canceled' || phase === 'failed';
}

export function parseAgentTeamPlanProposalText(text: string): AgentTeamPlanProposal | null {
  if (!isSafeAgentPromptText(text)) return null;
  if (new TextEncoder().encode(text).byteLength > MAX_AGENT_PROMPT_BYTES) return null;
  try {
    const parsed = AgentTeamPlanProposalSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function validationSummary(commands: readonly AgentValidationCommand[]): string {
  return commands.length === 0
    ? '- No project validation commands are configured.'
    : commands.map((command) => `- ${command.id}: ${command.name}`).join('\n');
}

function personaLaunchSummary(persona: AgentPersona): string {
  return persona.launch.provider === 'codex'
    ? `codex, ${persona.launch.sandbox}`
    : `claude, ${persona.launch.permissionMode}`;
}

function runCriteriaSummary(run: AgentTeamRun): string {
  return run.goalAcceptanceCriteria?.map((criterion) => `- ${criterion}`).join('\n')
    ?? '- No run-level completion criteria were frozen for this legacy run.';
}

export function composeAgentTeamPlanningBrief(run: AgentTeamRun): string {
  const personas = run.personas.map((persona) => (
    `- ${persona.personaId}: ${persona.name} — ${persona.role} (${personaLaunchSummary(persona)})`
  )).join('\n');
  return [
    '# EZTerminal team planning job',
    `Run: ${run.runId}`,
    `Project: ${run.projectName}`,
    `Target branch: ${run.targetBranch}`,
    ...(run.baseHead ? [`Frozen base commit: ${run.baseHead}`] : []),
    '',
    ...(run.projectGoal ? ['## Project long-term context', run.projectGoal, ''] : []),
    '## Run desired outcome',
    run.goal,
    '',
    '## Run completion criteria',
    runCriteriaSummary(run),
    '',
    ...(run.constraints ? ['## Run constraints', run.constraints, ''] : []),
    '## Team instructions',
    run.team.instructions,
    '',
    '## Available personas',
    personas,
    '',
    '## Project validations',
    validationSummary(run.validationCommands),
    '',
    'Propose only work that can start in parallel from the same target commit. Do not edit files during this planning turn. Every assignment must respect its Persona permission; read-only or plan-only Personas may receive only non-editing work. It is valid to exclude members when the goal cannot be split safely. The planner persona must receive one assignment.',
    'Every validationIds entry must name one configured validation above. Use UUID strings for taskId values.',
    `Submit one strict JSON object with: ezterminal-agent team plan submit ${run.runId} --revision ${String(run.revision)} --stdin`,
    'That command remains open for human review. Do not start implementation until it returns; an approved response contains your exact assignment brief.',
    'Shape: {"summary":"...","assignments":[{"taskId":"uuid","personaId":"uuid","title":"...","outcome":"...","scopeHints":[],"validationIds":[],"acceptanceCriteria":["..."],"brief":"..."}],"excludedMembers":[{"personaId":"uuid","reason":"..."}]}',
  ].join('\n');
}

export function composeAgentTeamMemberBrief(
  run: AgentTeamRun,
  persona: AgentPersona,
  assignment: AgentTeamAssignment,
): string {
  const scope = assignment.scopeHints.length === 0
    ? '- No exclusive path scope was declared; coordinate before expanding the task.'
    : assignment.scopeHints.map((hint) => `- ${hint}`).join('\n');
  const acceptance = assignment.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  const validations = assignment.validationIds.length === 0
    ? '- No task-specific validation was assigned.'
    : assignment.validationIds.map((validationId) => {
        const command = run.validationCommands.find((candidate) => candidate.id === validationId);
        return command ? `- ${command.name}: ${command.command}` : `- ${validationId}`;
      }).join('\n');
  return [
    '# EZTerminal approved team assignment',
    `Run: ${run.runId}`,
    `Target branch: ${run.targetBranch}`,
    ...(run.baseHead ? [`Frozen base commit: ${run.baseHead}`] : []),
    '',
    ...(run.projectGoal ? ['## Project long-term context', run.projectGoal, ''] : []),
    '## Run desired outcome',
    run.goal,
    '',
    '## Run completion criteria',
    runCriteriaSummary(run),
    '',
    '## Team instructions',
    run.team.instructions,
    '',
    ...(run.constraints ? ['## Run constraints', run.constraints, ''] : []),
    `## Persona: ${persona.name}`,
    `Role: ${persona.role}`,
    persona.instructions,
    '',
    `## Task: ${assignment.title}`,
    `Expected outcome: ${assignment.outcome}`,
    assignment.brief,
    '',
    '## Scope hints',
    scope,
    '',
    '## Acceptance criteria',
    acceptance,
    '',
    '## Required validations',
    validations,
    '',
    'Use the existing EZTerminal collaboration commands for status-aware follow-up and managed merge. Scope hints are advisory in v1; report overlap or necessary expansion to the user before merging.',
  ].join('\n');
}
