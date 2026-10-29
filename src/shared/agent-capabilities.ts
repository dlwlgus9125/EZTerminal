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
  /** Project folder of a project- or local-scope install (PC user scope listing only). */
  readonly projectPath?: string;
  /** App workspace at {@link projectPath}; a project install is managed only through it. */
  readonly workspaceId?: string;
}

/** A plugin source the provider reads; listed only in the PC user scope. */
export interface AgentMarketplace {
  readonly name: string;
  /** Display-only origin: `owner/repo`, a Git URL or a PC path. */
  readonly source?: string;
  readonly actions: readonly ('marketplace-update' | 'marketplace-remove')[];
}

export interface ProviderCapabilityCatalog {
  /** Opaque native configuration digest, never configuration values. */
  readonly configurationRevision?: string;
  readonly models: readonly ProviderModel[];
  readonly items: readonly AgentCapabilityItem[];
  readonly actions: readonly AgentExtensionAction[];
  readonly issues: readonly { readonly section: 'models' | 'skills' | 'plugins' | 'mcp'; readonly message: string }[];
  /** Present only for the PC user scope ({@link AGENT_HOST_SCOPE_ID}). */
  readonly marketplaces?: readonly AgentMarketplace[];
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

/**
 * The PC user scope: settings that apply to every project on the PC. It is never a
 * real workspace id, so the workspace-bound requests above cannot reach it.
 */
export const AGENT_HOST_SCOPE_ID = '@pc-user';
const ProviderIdSchema = z.enum(['codex', 'claude']);
export const AgentHostRequestSchema = z.object({ providerId: ProviderIdSchema }).strict();
export type AgentHostRequest = z.infer<typeof AgentHostRequestSchema>;
/**
 * A change from the PC-wide screen. Claude plugins may also go into one project
 * (`project`: shared through the repository, `local`: this user only); that names the
 * app workspace whose folder receives it. Everything else stays PC-wide.
 */
export const AgentHostCommandSchema = AgentExtensionCommandSchema
  .omit({ workspaceId: true, sessionId: true })
  .extend({ workspaceId: text.optional() })
  .strict()
  .superRefine((command, context) => {
    if (command.scope === 'user') {
      if (command.workspaceId !== undefined) context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'A PC-wide change names no workspace.' });
      return;
    }
    if (command.providerId !== 'claude' || !command.action.startsWith('plugin-')) {
      context.addIssue({ code: 'custom', path: ['scope'], message: 'Only Claude plugins can be installed into a project.' });
    }
    if (command.workspaceId === undefined && command.recovery === undefined) {
      context.addIssue({ code: 'custom', path: ['workspaceId'], message: 'A project change names its workspace.' });
    }
  });
export type AgentHostCommand = z.infer<typeof AgentHostCommandSchema>;
export const AGENT_PLUGIN_BROWSE_PAGE_LIMIT = 50;
export const AgentPluginBrowseRequestSchema = z.object({
  providerId: ProviderIdSchema,
  marketplace: text.optional(),
  query: z.string().trim().max(200).optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(AGENT_PLUGIN_BROWSE_PAGE_LIMIT).default(30),
  /** Re-reads the provider's marketplace list instead of the cached one. */
  refresh: z.boolean().optional(),
}).strict();
export type AgentPluginBrowseRequest = z.input<typeof AgentPluginBrowseRequestSchema>;
export interface AgentPluginEntry {
  /** `name@marketplace`, the install target. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly marketplace: string;
  readonly version?: string;
  readonly installCount?: number;
  /** Installed in the PC user scope. */
  readonly installed: boolean;
}
export interface AgentPluginBrowsePage {
  readonly providerId: 'codex' | 'claude';
  readonly entries: readonly AgentPluginEntry[];
  /** Matches across all pages for this marketplace and query. */
  readonly total: number;
  readonly offset: number;
  /** Every marketplace with at least one plugin, for the filter. */
  readonly marketplaces: readonly string[];
  readonly observedAt: string;
}
export interface AgentHostExtensionsClient {
  list(request: AgentHostRequest): Promise<AgentCapabilityResult<AgentCapabilityCatalog>>;
  browse(request: AgentPluginBrowseRequest): Promise<AgentCapabilityResult<AgentPluginBrowsePage>>;
  manage(request: AgentHostCommand): Promise<AgentCapabilityResult<AgentExtensionReceipt>>;
  /** Fires after a change from any device; absent where the host cannot push. */
  onChanged?(listener: (providerId: 'codex' | 'claude') => void): () => void;
}

const ReceiptSchema = z.object({ commandId: text, action: AgentExtensionActionSchema, state: z.enum(['applied', 'uncertain']), application: z.literal('new-session'), observedAt: z.string().optional() });
const ModelSchema = z.object({ id: z.string(), displayName: z.string(), description: z.string().optional(), supportsReasoning: z.boolean(), reasoningEfforts: z.array(z.string()).optional(), resolvedModel: z.string().optional(), isDefault: z.boolean() });
export const AgentCapabilityCatalogSchema = z.object({
  providerId: z.enum(['codex', 'claude']), workspaceId: text, workspaceRoot: text, hostId: text,
  observedAt: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/u), canManage: z.boolean(), application: z.literal('new-session'),
  extensionReceipts: z.array(ReceiptSchema).max(100).optional(),
  configurationRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  models: z.array(ModelSchema).max(2_000),
  items: z.array(z.object({ id: z.string().min(1), kind: z.enum(['skill', 'plugin', 'mcp', 'app-skill']), name: z.string(), description: z.string().optional(), source: z.string().optional(), scope: z.string().optional(), version: z.string().optional(), enabled: z.boolean(), invocation: z.string().optional(), status: z.string().optional(), actions: z.array(AgentExtensionActionSchema), projectPath: z.string().optional(), workspaceId: z.string().optional() })).max(10_000),
  actions: z.array(AgentExtensionActionSchema),
  issues: z.array(z.object({ section: z.enum(['models', 'skills', 'plugins', 'mcp']), message: z.string() })),
  marketplaces: z.array(z.object({ name: z.string().min(1), source: z.string().optional(), actions: z.array(z.enum(['marketplace-update', 'marketplace-remove'])) })).max(500).optional(),
});
export const AgentPluginBrowsePageSchema = z.object({
  providerId: ProviderIdSchema,
  entries: z.array(z.object({ id: z.string().min(1), name: z.string(), description: z.string().optional(), marketplace: z.string(), version: z.string().optional(), installCount: z.number().optional(), installed: z.boolean() })).max(AGENT_PLUGIN_BROWSE_PAGE_LIMIT),
  total: z.number().int().min(0), offset: z.number().int().min(0),
  marketplaces: z.array(z.string()).max(500), observedAt: z.string(),
});
const FailureSchema = z.object({ ok: z.literal(false), code: z.enum(['invalid-input', 'forbidden', 'unavailable', 'stale', 'unsupported', 'uncertain']), message: z.string() });
export const AgentCapabilityListResultSchema = z.union([z.object({ ok: z.literal(true), value: AgentCapabilityCatalogSchema }), FailureSchema]);
export const AgentExtensionResultSchema = z.union([z.object({ ok: z.literal(true), value: ReceiptSchema }), FailureSchema]);
export const AgentPluginBrowseResultSchema = z.union([z.object({ ok: z.literal(true), value: AgentPluginBrowsePageSchema }), FailureSchema]);
