import { z } from 'zod';
import type { ProviderModel } from './daemon-provider';

export const AgentExtensionActionSchema = z.enum([
  'plugin-install', 'plugin-remove', 'plugin-enable', 'plugin-disable', 'plugin-update',
  'marketplace-add', 'marketplace-remove', 'marketplace-update',
  'skill-enable', 'skill-disable', 'mcp-add', 'mcp-remove',
]);
export type AgentExtensionAction = z.infer<typeof AgentExtensionActionSchema>;
const text = z.string().trim().min(1).max(2_048).refine((value) => ![...value].some((character) => character.charCodeAt(0) < 32));
export const AgentCapabilitiesRequestSchema = z.object({
  providerId: z.enum(['codex', 'claude']), workspaceId: text, sessionId: text.optional(),
}).strict();
export type AgentCapabilitiesRequest = z.infer<typeof AgentCapabilitiesRequestSchema>;
export const AgentExtensionCommandSchema = AgentCapabilitiesRequestSchema.extend({
  commandId: text, expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  action: AgentExtensionActionSchema, target: text,
  scope: z.enum(['user', 'project', 'local']).default('user'),
  source: text.optional(),
  /** Reads or acknowledges an existing host receipt; never repeats native work. */
  recovery: z.enum(['inspect', 'acknowledge']).optional(),
  mcp: z.discriminatedUnion('type', [
    z.object({ type: z.literal('http'), url: z.string().url().max(2_048) }).strict(),
    z.object({ type: z.literal('stdio'), command: text, args: z.array(text).max(64) }).strict(),
  ]).optional(),
}).strict();
export type AgentExtensionCommand = z.infer<typeof AgentExtensionCommandSchema>;

export interface AgentCapabilityItem {
  readonly id: string;
  readonly kind: 'skill' | 'plugin' | 'mcp' | 'app-skill';
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly scope?: string;
  readonly version?: string;
  readonly enabled: boolean;
  /** Syntax inserted into the draft only; insertion never submits a turn. */
  readonly invocation?: string;
  readonly status?: string;
  readonly actions: readonly AgentExtensionAction[];
}

export interface ProviderCapabilityCatalog {
  /** Opaque native configuration digest, never configuration values. */
  readonly configurationRevision?: string;
  readonly models: readonly ProviderModel[];
  readonly items: readonly AgentCapabilityItem[];
  readonly actions: readonly AgentExtensionAction[];
  readonly issues: readonly { readonly section: 'models' | 'skills' | 'plugins' | 'mcp'; readonly message: string }[];
}
export interface AgentCapabilityCatalog extends ProviderCapabilityCatalog {
  readonly providerId: 'codex' | 'claude';
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly hostId: string;
  readonly observedAt: string;
  readonly revision: string;
  readonly canManage: boolean;
  readonly application: 'new-session';
  readonly extensionReceipts?: readonly AgentExtensionReceipt[];
}
export type AgentCapabilityResult<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly code: 'invalid-input' | 'forbidden' | 'unavailable' | 'stale' | 'unsupported' | 'uncertain';
  readonly message: string;
};
export interface AgentExtensionReceipt {
  readonly commandId: string;
  readonly action: AgentExtensionAction;
  readonly state: 'applied' | 'uncertain';
  readonly application: 'new-session';
  readonly observedAt?: string;
}
export interface AgentCapabilitiesClient {
  list(request: AgentCapabilitiesRequest): Promise<AgentCapabilityResult<AgentCapabilityCatalog>>;
  manage(request: AgentExtensionCommand): Promise<AgentCapabilityResult<AgentExtensionReceipt>>;
}

const ReceiptSchema = z.object({ commandId: text, action: AgentExtensionActionSchema, state: z.enum(['applied', 'uncertain']), application: z.literal('new-session'), observedAt: z.string().optional() });
const ModelSchema = z.object({ id: z.string(), displayName: z.string(), description: z.string().optional(), supportsReasoning: z.boolean(), reasoningEfforts: z.array(z.string()).optional(), resolvedModel: z.string().optional(), isDefault: z.boolean() });
export const AgentCapabilityCatalogSchema = z.object({
  providerId: z.enum(['codex', 'claude']), workspaceId: text, workspaceRoot: text, hostId: text,
  observedAt: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/u), canManage: z.boolean(), application: z.literal('new-session'),
  extensionReceipts: z.array(ReceiptSchema).max(100).optional(),
  configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  models: z.array(ModelSchema).max(2_000),
  items: z.array(z.object({ id: z.string().min(1), kind: z.enum(['skill', 'plugin', 'mcp', 'app-skill']), name: z.string(), description: z.string().optional(), source: z.string().optional(), scope: z.string().optional(), version: z.string().optional(), enabled: z.boolean(), invocation: z.string().optional(), status: z.string().optional(), actions: z.array(AgentExtensionActionSchema) })).max(10_000),
  actions: z.array(AgentExtensionActionSchema),
  issues: z.array(z.object({ section: z.enum(['models', 'skills', 'plugins', 'mcp']), message: z.string() })),
});
const FailureSchema = z.object({ ok: z.literal(false), code: z.enum(['invalid-input', 'forbidden', 'unavailable', 'stale', 'unsupported', 'uncertain']), message: z.string() });
export const AgentCapabilityListResultSchema = z.union([z.object({ ok: z.literal(true), value: AgentCapabilityCatalogSchema }), FailureSchema]);
export const AgentExtensionResultSchema = z.union([z.object({ ok: z.literal(true), value: ReceiptSchema }), FailureSchema]);
