import { z } from 'zod';
import { PlanningMutationResultSchema, PlanningOperationSchema, PlanningReferenceSchema, PlanningRoleProfileSchema,
  PlanningItemSchema, PlanningTaskSchema, ScreenSceneSchema, PlanningComponentSchema, PlanningAssetSchema,
  type PlanningMutationResult, type PlanningRoleProfile, type PlanningSnapshot } from './planning';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const PlanningAiTargetSchema = z.object({
  kind: z.enum(['item', 'task', 'scene', 'component', 'profile']), id,
  revision: z.number().int().nonnegative(),
  /** When supplied, only these existing elements' properties/layout may change. */
  elementIds: z.array(id).min(1).max(100).optional(),
  itemKind: z.enum(['requirement', 'feature', 'information', 'flow', 'decision']).optional(),
}).strict();
export type PlanningAiTarget = z.infer<typeof PlanningAiTargetSchema>;
export const PlanningAiStartSchema = z.object({
  requestId: id, projectId: id, subprojectId: id.optional(), expectedRevision: z.number().int().nonnegative(),
  target: PlanningAiTargetSchema, instruction: z.string().trim().min(1).max(20_000),
  providerId: id, model: z.string().min(1).max(200), reasoningEffort: z.string().max(100).optional(),
  contextIds: z.array(id).max(100).default([]),
  profileId: id.optional(), profileVersion: z.number().int().nonnegative().optional(),
}).strict().refine(value => (value.profileId === undefined) === (value.profileVersion === undefined), 'Select both a role profile and its version.');
export type PlanningAiStart = z.input<typeof PlanningAiStartSchema>;
export const PlanningAiProposalSchema = z.object({
  summary: z.string().min(1).max(1_000), operation: PlanningOperationSchema,
}).strict();
export type PlanningAiProposal = z.infer<typeof PlanningAiProposalSchema>;
export const PlanningAiContextSnapshotSchema = z.object({
  reference: PlanningReferenceSchema,
  content: z.union([PlanningItemSchema, PlanningTaskSchema, ScreenSceneSchema, PlanningComponentSchema, PlanningRoleProfileSchema, PlanningAssetSchema, z.string().max(500_000)]),
}).strict();
export type PlanningAiContextSnapshot = z.infer<typeof PlanningAiContextSnapshotSchema>;
export const PlanningAiJobSchema = z.object({
  request: PlanningAiStartSchema, sessionId: id, turnId: id.optional(),
  state: z.enum(['prepared', 'generating', 'ready', 'failed', 'uncertain', 'applied']),
  before: PlanningOperationSchema, proposal: PlanningAiProposalSchema.optional(),
  message: z.string().max(4_000).optional(), createdAt: z.string().datetime(),
  /** Exact parent-to-leaf configuration and reference values used at generation time. */
  profileSnapshots: z.array(PlanningRoleProfileSchema).max(100).optional(),
  contextSnapshots: z.array(PlanningAiContextSnapshotSchema).max(1_000).optional(),
}).strict();
export type PlanningAiJob = z.infer<typeof PlanningAiJobSchema>;
export const PlanningAiRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), request: PlanningAiStartSchema }).strict(),
  z.object({ type: z.literal('read'), projectId: id, subprojectId: id.optional(), requestId: id.optional() }).strict(),
  z.object({ type: z.literal('apply'), projectId: id, subprojectId: id.optional(), requestId: id }).strict(),
]);
export type PlanningAiRequest = z.input<typeof PlanningAiRequestSchema>;
export const PlanningAiResultSchema = z.union([
  z.object({ ok: z.literal(true), jobs: z.array(PlanningAiJobSchema), mutation: PlanningMutationResultSchema.optional() }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);
export type PlanningAiResult = { readonly ok: true; readonly jobs: readonly PlanningAiJob[]; readonly mutation?: PlanningMutationResult }
  | { readonly ok: false; readonly message: string };
export interface PlanningAiApi { planningAiRequest(request: PlanningAiRequest): Promise<PlanningAiResult>; }

export function planningAiProviderSupported(protocol: string): boolean { return protocol === 'claude-agent-sdk'; }

export function planningAiRole(target?: PlanningAiTarget): 'planning' | 'design' {
  return target?.kind === 'scene' || target?.kind === 'component' ? 'design' : 'planning';
}

/** Shared preview and host validation use the same inheritance order; the host freezes its own snapshot. */
export function planningAiProfileChain(snapshot: PlanningSnapshot, target: PlanningAiTarget, profileId?: string, profileVersion?: number): PlanningRoleProfile[] {
  if (!profileId) return [];
  const chain: PlanningRoleProfile[] = []; const seen = new Set<string>(); let next: string | undefined = profileId;
  while (next) {
    if (seen.has(next)) throw new Error('Role profile inheritance contains a cycle.');
    seen.add(next);
    const profile = snapshot.draft.profiles.find(value => value.id === next);
    if (!profile) throw new Error('A selected or inherited role profile is unavailable.');
    chain.unshift(profile); next = profile.parentProfileId;
  }
  const leaf = chain.at(-1)!;
  if (leaf.revision !== profileVersion) throw new Error('The selected role profile changed. Select its current version.');
  if (leaf.role !== planningAiRole(target)) throw new Error('Select a role profile for the current planning or design stage.');
  return chain;
}
