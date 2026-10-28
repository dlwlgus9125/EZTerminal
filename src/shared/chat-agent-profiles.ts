import { z } from 'zod';

/**
 * A saved way to start an app conversation: provider, model, reasoning effort
 * and permission, plus a note on when to use it. People pick one when they
 * start or hand off a conversation; orchestrating agents read the note to
 * choose a profile for a child. Desktop owns the list (main-process JSON).
 */
const Short = z.string().trim().min(1).max(200);

export const ChatAgentProfileSchema = z.object({
  id: z.string().min(1).max(100),
  name: Short,
  providerId: z.string().min(1).max(100),
  model: z.string().max(200).optional(),
  reasoningEffort: z.string().max(40).optional(),
  permissionPreset: z.enum(['plan', 'standard', 'full-access']),
  whenToUse: z.string().max(1_000).optional(),
}).strict();

export type ChatAgentProfile = z.infer<typeof ChatAgentProfileSchema>;

export const ChatAgentProfileListSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ChatAgentProfileSchema).max(50),
}).strict();

export type ChatAgentProfileList = z.infer<typeof ChatAgentProfileListSchema>;

/** Tolerant read: a malformed file is an empty list, never a crash. */
export function parseChatAgentProfiles(value: unknown): readonly ChatAgentProfile[] {
  const parsed = ChatAgentProfileListSchema.safeParse(value);
  return parsed.success ? parsed.data.profiles : [];
}

export type ChatAgentProfileResult =
  | { readonly ok: true; readonly profiles: readonly ChatAgentProfile[] }
  | { readonly ok: false; readonly error: string };

/** A conversation phase an agent can be linked to (Settings › AI › 단계 연결). */
export type ChatAgentPhaseName = 'plan' | 'implement' | 'review';
/**
 * Which agent applies in each phase. Plan and implement are per AI: a conversation switches only to an agent
 * of its own AI (same session). Review is shared: it runs as a new conversation, so any AI can review.
 * A separate file from the profiles (an older build reads a changed profile file strictly and would
 * overwrite it). `switchModel` off: only effort and permission change at a switch.
 */
export interface ChatAgentPhaseMap {
  readonly byProvider: Readonly<Record<string, { readonly plan?: { readonly profileId: string }; readonly implement?: { readonly profileId: string } }>>;
  readonly review?: { readonly profileId: string };
  readonly switchModel: boolean;
}

const PhaseRefSchema = z.object({ profileId: z.string().min(1).max(100) }).strict();

export const ChatAgentPhaseFileSchema = z.object({
  version: z.literal(1),
  byProvider: z.record(z.string().min(1).max(100), z.object({ plan: PhaseRefSchema.optional(), implement: PhaseRefSchema.optional() }).strict())
    .refine((value) => Object.keys(value).length <= 20),
  review: PhaseRefSchema.optional(),
  switchModel: z.boolean(),
}).strict();

export const EMPTY_CHAT_AGENT_PHASES: ChatAgentPhaseMap = { byProvider: {}, switchModel: false };

/**
 * The linked agent of a conversation phase for a session of `providerId`, or nothing: a deleted profile or
 * one of another AI (a conversation keeps its AI) is no link. Its model only when `switchModel` is on.
 */
export function linkedPhaseSettings(
  phases: ChatAgentPhaseMap,
  profiles: readonly ChatAgentProfile[],
  providerId: string,
  phase: 'plan' | 'implement',
): { readonly profile: ChatAgentProfile; readonly model?: string; readonly reasoningEffort?: string } | undefined {
  const profileId = phases.byProvider[providerId]?.[phase]?.profileId;
  const profile = profileId ? profiles.find((entry) => entry.id === profileId) : undefined;
  if (!profile || profile.providerId !== providerId) return undefined;
  return {
    profile,
    ...(phases.switchModel && profile.model ? { model: profile.model } : {}),
    ...(profile.reasoningEffort ? { reasoningEffort: profile.reasoningEffort } : {}),
  };
}

/** Desktop only: the renderer's view of the saved profiles. */
export interface ChatAgentProfileAccess {
  list(): Promise<readonly ChatAgentProfile[]>;
  save(profile: ChatAgentProfile): Promise<ChatAgentProfileResult>;
  remove(id: string): Promise<ChatAgentProfileResult>;
  /** 단계 연결, on hosts that keep it (absent: the section is not shown). */
  phases?(): Promise<ChatAgentPhaseMap>;
  savePhases?(phases: ChatAgentPhaseMap): Promise<{ readonly ok: true; readonly phases: ChatAgentPhaseMap } | { readonly ok: false; readonly error: string }>;
}
