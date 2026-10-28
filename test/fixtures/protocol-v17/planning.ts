// FROZEN COPY of src/shared/planning.ts at c74ac76 (remote protocol v17). Do not edit:
// tests use it to prove what an already-installed v17 reader accepts.
import { z } from 'zod';

/** Portable planning data only. Live sessions, attempts and evidence remain in the host database. */
export const PLANNING_SCHEMA_VERSION = 1 as const;
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(200_000);
const title = z.string().trim().min(1).max(300);
const ids = z.array(id).max(2_000);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const relativePath = z.string().min(1).max(1_024).refine((value) => (
  !/^(?:[A-Za-z]:|[/\\])/u.test(value)
  && !value.replaceAll('\\', '/').split('/').some((part) => part === '..' || part === '')
  && ![...value].some((character) => character.charCodeAt(0) < 32)
), 'A project-relative path without traversal is required.');

export const PlanningReferenceSchema = z.object({
  id,
  kind: z.enum(['item', 'scene', 'component', 'profile', 'task', 'file', 'asset']),
  revision,
  baselineId: id.optional(),
  sourcePath: relativePath.optional(),
  hash: sha256.optional(),
}).strict();
export type PlanningReference = z.infer<typeof PlanningReferenceSchema>;

export const PlanningItemSchema = z.object({
  id, revision, title,
  kind: z.enum(['requirement', 'feature', 'information', 'flow', 'decision']),
  flowStep: z.object({ kind: z.enum(['action', 'condition', 'end']) }).strict().optional(),
  body: text,
  status: z.enum(['draft', 'review-needed', 'ready']),
  acceptance: z.array(z.string().min(1).max(4_000)).max(200),
}).strict();
export type PlanningItem = z.infer<typeof PlanningItemSchema>;

export const PlanningLinkSchema = z.object({
  id, revision,
  fromId: id,
  toId: id,
  kind: z.enum(['depends-on', 'implements', 'describes', 'navigates-to', 'references', 'contains']),
  note: text,
}).strict();
export type PlanningLink = z.infer<typeof PlanningLinkSchema>;

export const SceneLayoutSchema = z.object({
  direction: z.enum(['row', 'column', 'grid']),
  width: z.enum(['fill', 'hug', 'fixed']),
  height: z.enum(['fill', 'hug', 'fixed']),
  fixedWidth: z.number().positive().max(20_000).optional(),
  fixedHeight: z.number().positive().max(20_000).optional(),
  minWidth: z.number().nonnegative().max(20_000).optional(),
  maxWidth: z.number().positive().max(20_000).optional(),
  gap: z.number().nonnegative().max(1_000),
  padding: z.number().nonnegative().max(1_000),
  overflow: z.enum(['visible', 'scroll', 'hidden']),
}).strict();
const sceneProperties = z.object({
  text: text.optional(),
  placeholder: z.string().max(1_000).optional(),
  disabled: z.boolean().optional(),
  required: z.boolean().optional(),
  variant: z.string().max(100).optional(),
  assetId: id.optional(),
  accessibleName: z.string().max(1_000).optional(),
}).strict();
export const SceneElementSchema = z.object({
  id,
  kind: z.enum(['frame', 'text', 'input', 'button', 'list', 'table', 'tabs', 'dialog']),
  parentId: id.nullable(),
  order: z.number().int().nonnegative(),
  layout: SceneLayoutSchema,
  properties: sceneProperties,
  component: z.object({ componentId: id, version: revision, overrides: sceneProperties }).strict().optional(),
  stateIds: ids,
}).strict();
export type SceneElement = z.infer<typeof SceneElementSchema>;
export const ScreenSceneSchema = z.object({
  id, revision, title,
  platform: z.enum(['windows', 'android']),
  width: z.number().int().min(240).max(8_192),
  height: z.number().int().min(240).max(8_192),
  featureIds: ids,
  elements: z.array(SceneElementSchema).max(2_000),
  states: z.array(z.object({ id, title, kind: z.enum(['default', 'loading', 'empty', 'validation', 'disabled', 'error', 'success', 'offline']) }).strict()).max(100),
  transitions: z.array(z.object({
    id, elementId: id, fromStateId: id,
    trigger: z.enum(['activate', 'submit', 'back', 'load', 'error']),
    toStateId: id.optional(), toSceneId: id.optional(),
  }).strict()).max(500),
  status: z.enum(['draft', 'review-needed', 'ready']),
}).strict();
export type ScreenScene = z.infer<typeof ScreenSceneSchema>;
export const PlanningComponentSchema = z.object({
  id, revision, title,
  elements: z.array(SceneElementSchema).max(500),
  allowedOverrides: z.array(z.enum(['text', 'placeholder', 'disabled', 'required', 'variant', 'assetId', 'accessibleName'])).max(7),
}).strict();
export type PlanningComponent = z.infer<typeof PlanningComponentSchema>;
export const PlanningAssetSchema = z.object({
  id, revision, title,
  relativePath,
  hash: sha256,
  mimeType: z.string().min(1).max(100),
  byteLength: z.number().int().nonnegative(),
}).strict();
export type PlanningAsset = z.infer<typeof PlanningAssetSchema>;

export const PlanningRoleProfileSchema = z.object({
  id, revision, title,
  role: z.enum(['planning', 'design', 'implementation', 'review', 'integration']),
  instructions: text,
  parentProfileId: id.optional(),
  /** PC-local binding reference; authentication and provider secrets are never portable. */
  modelBindingId: id.optional(),
  contextRefs: z.array(PlanningReferenceSchema).max(200),
  allowedTools: z.array(z.enum(['planning.read', 'planning.patch', 'project.read', 'project.write', 'terminal.execute', 'review.read'])).max(6),
  retryLimit: z.number().int().min(0).max(20),
}).strict();
export type PlanningRoleProfile = z.infer<typeof PlanningRoleProfileSchema>;

export const PlanningExecutionEnvironmentSchema = z.object({
  mode: z.enum(['serial', 'namespaced']), portCount: z.number().int().min(0).max(4),
}).strict();

export const PlanningTaskSchema = z.object({
  id, revision, title,
  objective: text,
  featureIds: ids,
  screenIds: ids,
  inputRefs: z.array(PlanningReferenceSchema).max(200),
  dependencyIds: ids,
  allowedPaths: z.array(relativePath).max(200),
  interfaceRefs: z.array(PlanningReferenceSchema).max(200),
  profileId: id.optional(),
  executionEnvironment: PlanningExecutionEnvironmentSchema.optional(),
  acceptance: z.array(z.object({ id, description: z.string().min(1).max(4_000) }).strict()).max(200),
  validationPlan: z.array(z.object({
    id, acceptanceIds: ids, description: z.string().min(1).max(4_000),
    method: z.enum(['command', 'inspection', 'device']), command: z.string().max(4_000).optional(),
    environment: z.string().min(1).max(1_000),
  }).strict()).max(200),
  status: z.enum(['draft', 'review-needed', 'ready']),
}).strict();
export type TaskDefinition = z.infer<typeof PlanningTaskSchema>;

export const PlanningDraftSchema = z.object({
  id,
  basedOnBaselineId: id.optional(),
  items: z.array(PlanningItemSchema).max(2_000),
  links: z.array(PlanningLinkSchema).max(4_000),
  scenes: z.array(ScreenSceneSchema).max(500),
  components: z.array(PlanningComponentSchema).max(500),
  profiles: z.array(PlanningRoleProfileSchema).max(100),
  tasks: z.array(PlanningTaskSchema).max(2_000),
  assets: z.array(PlanningAssetSchema).max(2_000),
}).strict();
export type PlanningDraft = z.infer<typeof PlanningDraftSchema>;
export const PlanningActorSchema = z.object({ kind: z.enum(['user', 'ai']), id }).strict();
export type PlanningActor = z.infer<typeof PlanningActorSchema>;
export const PlanningBaselineSchema = z.object({
  id, title, sourceRevision: revision, createdAt: z.string().datetime(),
  purpose: z.enum(['planning', 'quick-task']).optional(),
  createdBy: PlanningActorSchema,
  hash: sha256, draft: PlanningDraftSchema,
}).strict();
export type PlanningBaseline = z.infer<typeof PlanningBaselineSchema>;
export const PlanningHistoryEntrySchema = z.object({
  id, commandId: id, revision, type: z.string().max(100),
  actor: PlanningActorSchema, createdAt: z.string().datetime(), summary: z.string().max(1_000),
  changedIds: ids, undoOf: id.optional(), before: PlanningDraftSchema,
}).strict();
export type PlanningHistoryEntry = z.infer<typeof PlanningHistoryEntrySchema>;
export const ProfilePatchProposalSchema = z.object({
  id, profileId: id, baseVersion: revision,
  proposed: PlanningRoleProfileSchema,
  reason: z.string().min(1).max(4_000),
  status: z.enum(['pending', 'applied', 'stale']),
  createdAt: z.string().datetime(),
}).strict();
export type ProfilePatchProposal = z.infer<typeof ProfilePatchProposalSchema>;
export const PlanningSnapshotSchema = z.object({
  schemaVersion: z.literal(PLANNING_SCHEMA_VERSION), projectId: id, revision,
  draft: PlanningDraftSchema,
  baselines: z.array(PlanningBaselineSchema),
  history: z.array(PlanningHistoryEntrySchema),
  profileProposals: z.array(ProfilePatchProposalSchema),
}).strict();
export type PlanningSnapshot = z.infer<typeof PlanningSnapshotSchema>;

export const PlanningOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('item.put'), value: PlanningItemSchema }).strict(),
  z.object({ op: z.literal('link.put'), value: PlanningLinkSchema }).strict(),
  z.object({ op: z.literal('scene.put'), value: ScreenSceneSchema }).strict(),
  z.object({ op: z.literal('component.put'), value: PlanningComponentSchema }).strict(),
  z.object({ op: z.literal('profile.put'), value: PlanningRoleProfileSchema }).strict(),
  z.object({ op: z.literal('task.put'), value: PlanningTaskSchema }).strict(),
  z.object({ op: z.literal('asset.put'), value: PlanningAssetSchema }).strict(),
  z.object({ op: z.literal('entity.delete'), kind: z.enum(['item', 'link', 'scene', 'component', 'profile', 'task', 'asset']), id }).strict(),
]);
export type PlanningOperation = z.infer<typeof PlanningOperationSchema>;
const envelope = { commandId: id, projectId: id, subprojectId: id.optional(), expectedRevision: revision, actor: PlanningActorSchema };
export const PlanningCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('planning.patch'), payload: z.object({ operations: z.array(PlanningOperationSchema).min(1).max(500), summary: z.string().min(1).max(1_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('planning.freeze'), payload: z.object({ baselineId: id, title, taskIds: ids.min(1).optional() }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('planning.quick-freeze'), payload: z.object({ baselineId: id, title, task: PlanningTaskSchema, profileIds: ids }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('planning.branch'), payload: z.object({ baselineId: id, draftId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('planning.undo'), payload: z.object({ changeId: id }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('profile.propose'), payload: z.object({ proposalId: id, profileId: id, baseVersion: revision, proposed: PlanningRoleProfileSchema, reason: z.string().min(1).max(4_000) }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('profile.apply'), payload: z.object({ proposalId: id }).strict() }).strict(),
]);
export type PlanningCommand = z.infer<typeof PlanningCommandSchema>;
export type PlanningErrorCode = 'invalid' | 'not-found' | 'stale' | 'conflict' | 'forbidden' | 'unavailable' | 'corrupt' | 'external-change';
export interface PlanningError {
  readonly ok: false;
  readonly error: PlanningErrorCode;
  readonly message: string;
  readonly revision?: number;
  readonly issues?: readonly string[];
}
export type PlanningReadResult = { readonly ok: true; readonly snapshot: PlanningSnapshot } | PlanningError;
export type PlanningMutationResult = {
  readonly ok: true;
  readonly commandId: string;
  readonly revision: number;
  readonly changeId: string;
  readonly snapshot: PlanningSnapshot;
  readonly duplicate: boolean;
} | PlanningError;

export const PlanningErrorSchema = z.object({
  ok: z.literal(false),
  error: z.enum(['invalid', 'not-found', 'stale', 'conflict', 'forbidden', 'unavailable', 'corrupt', 'external-change']),
  message: z.string(), revision: revision.optional(), issues: z.array(z.string()).optional(),
}).strict();
export const PlanningReadResultSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: PlanningSnapshotSchema }).strict(), PlanningErrorSchema,
]);
export const PlanningMutationResultSchema = z.union([
  z.object({ ok: z.literal(true), commandId: id, revision, changeId: id, snapshot: PlanningSnapshotSchema, duplicate: z.boolean() }).strict(), PlanningErrorSchema,
]);

/** SQLite runtime contracts have one owner and never enter PlanningDraft or project.json. */
export type { ExecutionAttempt, ReviewEvidence, RunDefinition, EnvironmentLease } from './planning-execution';

export interface PlanningTeamPreset {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly mode: 'single' | 'division' | 'candidates' | 'independent-review';
  readonly roleProfileIds: readonly string[];
  readonly progressionPolicy: 'stage-review' | 'autonomous';
  readonly concurrency: number;
}
export interface RepairSeries {
  readonly id: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly originalAttemptId: string;
  readonly retryLimit: number;
  readonly retriesUsed: number;
  readonly attemptIds: readonly string[];
  readonly failureEvidenceIds: readonly string[];
  readonly stoppedReason?: 'exhausted' | 'cancelled' | 'provider-unavailable' | 'reconciling';
}
export interface ReplanProposal {
  readonly id: string;
  readonly oldBaselineId: string;
  readonly proposedBaselineId: string;
  readonly expectedRunRevision: number;
  readonly affectedTaskIds: readonly string[];
  readonly downstreamTaskIds: readonly string[];
  readonly unaffectedTaskIds: readonly string[];
  readonly reusableResults: readonly { readonly taskId: string; readonly artifactRevision: string }[];
  readonly rework: readonly { readonly taskId: string; readonly reason: string }[];
  readonly changedValidationIds: readonly string[];
  readonly status: 'pending' | 'applied' | 'stale' | 'cancelled';
}
export interface PlanningDecisionGate {
  readonly id: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly reason: 'question' | 'retry-exhausted' | 'provider-unavailable' | 'replan' | 'review';
  readonly question: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly status: 'pending' | 'resolved' | 'stale';
  readonly answerRevision?: number;
}
export interface ReviewDecision {
  readonly decisionId: string;
  readonly reviewerSessionId: string;
  readonly baselineId: string;
  readonly artifactRevision: string;
  readonly evidenceIds: readonly string[];
  readonly decision: 'reviewed' | 'changes-requested' | 'blocked' | 'stale';
  readonly notes: string;
}
export interface IntegrationResult {
  readonly integrationId: string;
  readonly baseRevision: string;
  readonly orderedInputs: readonly { readonly taskId: string; readonly artifactRevision: string; readonly decisionId: string }[];
  readonly candidateRevision?: string;
  readonly lastSuccessfulRevision: string;
  readonly validationRefs: readonly string[];
  readonly status: 'prepared' | 'integrating' | 'validating' | 'accepted' | 'failed' | 'stale';
}
export interface PlanningPackageManifest {
  readonly schemaVersion: 1;
  readonly sourceProjectId: string;
  readonly sourceRevision: number;
  readonly capturedAt: string;
  readonly items: readonly {
    readonly id: string;
    readonly relativePath: string;
    readonly hash: string;
    readonly byteLength: number;
    readonly kind: 'planning' | 'asset' | 'conversation' | 'attempt' | 'evidence' | 'patch';
  }[];
  readonly excluded: readonly { readonly id: string; readonly reason: string }[];
  readonly credentialsIncluded: false;
}

/** Semantic validation is shared by editors and the host; the host always repeats it. */
export function validatePlanningDraft(draft: PlanningDraft, forFreeze = false): readonly string[] {
  const issues: string[] = [];
  const collections = {
    item: draft.items, link: draft.links, scene: draft.scenes, component: draft.components,
    profile: draft.profiles, task: draft.tasks, asset: draft.assets,
  };
  const allIds = Object.values(collections).flatMap((entries) => entries.map((entry) => entry.id));
  if (new Set(allIds).size !== allIds.length) issues.push('Planning entity IDs must be unique.');
  const known = new Set(allIds);
  const requireId = (value: string, values: readonly { id: string }[], label: string) => {
    if (!values.some((entry) => entry.id === value)) issues.push(`${label}: missing ${value}.`);
  };
  const checkReference = (ref: PlanningReference, label: string) => {
    if (ref.kind === 'file') {
      if (!ref.sourcePath) issues.push(`${label}: file references require a source path.`);
      return;
    }
    // Frozen references are resolved against their immutable baseline by the host.
    if (ref.baselineId) return;
    const entity = collections[ref.kind].find((entry) => entry.id === ref.id);
    if (!entity) issues.push(`${label}: missing ${ref.kind} ${ref.id}.`);
    else if (ref.revision > entity.revision || (forFreeze && entity.revision !== ref.revision)) issues.push(`${label}: stale reference ${ref.id}.`);
  };
  const acyclic = (nodes: readonly { id: string; dependencies: readonly string[] }[], label: string) => {
    const byId = new Map(nodes.map((entry) => [entry.id, entry]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (nodeId: string): boolean => {
      if (visited.has(nodeId)) return true;
      if (visiting.has(nodeId)) return false;
      visiting.add(nodeId);
      const node = byId.get(nodeId);
      if (!node || !node.dependencies.every(visit)) return false;
      visiting.delete(nodeId);
      visited.add(nodeId);
      return true;
    };
    if (!nodes.every((entry) => visit(entry.id))) issues.push(`${label}: missing dependency or cycle.`);
  };
  for (const link of draft.links) {
    if (!known.has(link.fromId) || !known.has(link.toId)) issues.push(`Link ${link.id}: missing endpoint.`);
    if (link.fromId === link.toId) issues.push(`Link ${link.id}: cannot link an entity to itself.`);
    if (link.kind === 'contains' && [link.fromId, link.toId].some((id) => !draft.items.some((item) => item.id === id && item.kind === 'information'))) {
      issues.push(`Link ${link.id}: hierarchy endpoints must be information pages.`);
    }
  }
  const pages = draft.items.filter((item) => item.kind === 'information');
  acyclic(pages.map((item) => ({ id: item.id, dependencies: draft.links.filter((link) => link.kind === 'contains' && link.toId === item.id).map((link) => link.fromId) })), 'Information hierarchy');
  for (const page of pages) if (draft.links.filter((link) => link.kind === 'contains' && link.toId === page.id).length > 1) {
    issues.push(`Information page ${page.id}: a page can have only one parent.`);
  }
  for (const item of draft.items) {
    if (item.flowStep && item.kind !== 'flow') issues.push(`Item ${item.id}: flow step metadata belongs to a flow item.`);
    if (forFreeze && item.kind === 'flow' && item.flowStep) {
      const outgoing = draft.links.filter((link) => link.kind === 'navigates-to' && link.fromId === item.id);
      if (item.flowStep.kind !== 'end' && outgoing.length === 0) issues.push(`Flow ${item.id}: choose a next step or mark an end result.`);
      if (item.flowStep.kind === 'condition' && (outgoing.length < 2 || outgoing.some((link) => !link.note.trim()))) issues.push(`Flow ${item.id}: a condition needs at least two labelled outcomes.`);
    }
  }
  const checkElements = (elements: readonly SceneElement[], label: string) => {
    if (new Set(elements.map((entry) => entry.id)).size !== elements.length) issues.push(`${label}: duplicate element ID.`);
    acyclic(elements.map((entry) => ({ id: entry.id, dependencies: entry.parentId ? [entry.parentId] : [] })), label);
    for (const element of elements) {
      if (element.properties.assetId) requireId(element.properties.assetId, draft.assets, label);
      if (element.layout.width === 'fixed' && element.layout.fixedWidth === undefined) issues.push(`${label}: fixed width is missing.`);
      if (element.layout.height === 'fixed' && element.layout.fixedHeight === undefined) issues.push(`${label}: fixed height is missing.`);
      if (element.layout.minWidth !== undefined && element.layout.maxWidth !== undefined
        && element.layout.minWidth > element.layout.maxWidth) issues.push(`${label}: invalid width bounds.`);
      if (element.component) {
        const component = draft.components.find((entry) => entry.id === element.component!.componentId);
        if (!component) issues.push(`${label}: missing component ${element.component.componentId}.`);
        else {
          if (component.revision !== element.component.version) issues.push(`${label}: stale component version.`);
          for (const key of Object.keys(element.component.overrides)) {
            if (!component.allowedOverrides.includes(key as keyof SceneElement['properties'])) issues.push(`${label}: unsupported override ${key}.`);
          }
        }
      }
    }
  };
  for (const component of draft.components) checkElements(component.elements, `Component ${component.id}`);
  acyclic(draft.components.map((component) => ({
    id: component.id,
    dependencies: component.elements.flatMap((entry) => entry.component ? [entry.component.componentId] : []),
  })), 'Components');
  for (const scene of draft.scenes) {
    const label = `Scene ${scene.id}`;
    checkElements(scene.elements, label);
    for (const featureId of scene.featureIds) requireId(featureId, draft.items, label);
    if (new Set(scene.states.map((entry) => entry.id)).size !== scene.states.length) issues.push(`${label}: duplicate state ID.`);
    if (new Set(scene.transitions.map((entry) => entry.id)).size !== scene.transitions.length) issues.push(`${label}: duplicate transition ID.`);
    for (const element of scene.elements) for (const stateId of element.stateIds) requireId(stateId, scene.states, label);
    for (const transition of scene.transitions) {
      requireId(transition.elementId, scene.elements, label);
      requireId(transition.fromStateId, scene.states, label);
      if (transition.toStateId) requireId(transition.toStateId,
        transition.toSceneId ? draft.scenes.find((target) => target.id === transition.toSceneId)?.states ?? [] : scene.states, label);
      if (transition.toSceneId) requireId(transition.toSceneId, draft.scenes, label);
      if (!transition.toStateId && !transition.toSceneId) issues.push(`${label}: transition target is missing.`);
    }
  }
  for (const profile of draft.profiles) {
    if (profile.role === 'planning' && profile.allowedTools.some((tool) => tool === 'project.write' || tool === 'terminal.execute')) {
      issues.push(`Profile ${profile.id}: planning roles cannot write product files or execute terminals.`);
    }
    for (const ref of profile.contextRefs) checkReference(ref, `Profile ${profile.id}`);
  }
  acyclic(draft.profiles.map((profile) => ({ id: profile.id, dependencies: profile.parentProfileId ? [profile.parentProfileId] : [] })), 'Profiles');
  acyclic(draft.tasks.map((task) => ({ id: task.id, dependencies: task.dependencyIds })), 'Tasks');
  for (const task of draft.tasks) {
    const label = `Task ${task.id}`;
    for (const featureId of task.featureIds) requireId(featureId, draft.items, label);
    for (const sceneId of task.screenIds) requireId(sceneId, draft.scenes, label);
    if (task.profileId) requireId(task.profileId, draft.profiles, label);
    for (const ref of [...task.inputRefs, ...task.interfaceRefs]) checkReference(ref, label);
    if (new Set(task.acceptance.map((entry) => entry.id)).size !== task.acceptance.length) issues.push(`${label}: duplicate acceptance ID.`);
    if (new Set(task.validationPlan.map((entry) => entry.id)).size !== task.validationPlan.length) issues.push(`${label}: duplicate validation ID.`);
    for (const validation of task.validationPlan) {
      for (const acceptanceId of validation.acceptanceIds) requireId(acceptanceId, task.acceptance, label);
      if (validation.method === 'command' && !validation.command?.trim()) issues.push(`${label}: validation command is missing.`);
    }
    if (task.status === 'ready') {
      if (task.acceptance.length === 0 || task.validationPlan.length === 0) issues.push(`${label}: ready tasks require acceptance and validation.`);
      for (const acceptance of task.acceptance) {
        if (!task.validationPlan.some((entry) => entry.acceptanceIds.includes(acceptance.id))) issues.push(`${label}: acceptance ${acceptance.id} has no validation.`);
      }
    }
  }
  return [...new Set(issues)];
}
