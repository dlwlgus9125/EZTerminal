import {
  createDaemonCommand,
  type DaemonCommandEnvelope,
  type DaemonCommandReceipt,
  type DaemonPrincipal,
  type DaemonSnapshot,
} from '../shared/daemon-protocol';
import type {
  StructuredAgentDraftInput,
  StructuredAgentModelOption,
  StructuredAgentProviderOption,
  StructuredAgentWorkspaceOption,
} from './StructuredAgentSession';

export type StructuredAgentCreateCommand = DaemonCommandEnvelope<'agent.create'>;

export type StructuredAgentProviderModelCatalogs = Readonly<Record<
  string,
  readonly { readonly id: string; readonly displayName: string }[]
>>;

export interface StructuredAgentCreateAccess {
  readonly getSnapshot: () => Promise<DaemonSnapshot | null>;
  readonly sendCommand: (command: StructuredAgentCreateCommand) => Promise<DaemonCommandReceipt>;
}

export interface StructuredAgentCreateOptions {
  readonly access: StructuredAgentCreateAccess;
  readonly principal: DaemonPrincipal;
  /** Reuse the logical Session identity while reconciling an uncertain send. */
  readonly sessionId?: string;
  /** Durably register the exact envelope before crossing the delivery boundary. */
  readonly onCommandPrepared?: (
    command: StructuredAgentCreateCommand,
  ) => void | Promise<void>;
  readonly createId?: (prefix: 'agent' | 'command') => string;
  readonly now?: () => Date;
}

interface StructuredAgentCreateOutcomeBase {
  readonly sessionId: string;
  readonly title: string;
}

export type StructuredAgentCreateOutcome =
  | StructuredAgentCreateOutcomeBase & {
      readonly kind: 'created';
      readonly command: StructuredAgentCreateCommand;
      readonly receipt: Extract<DaemonCommandReceipt, { readonly ok: true }>;
    }
  | StructuredAgentCreateOutcomeBase & {
      readonly kind: 'delivery-uncertain';
      readonly command: StructuredAgentCreateCommand;
      readonly receipt?: Extract<DaemonCommandReceipt, { readonly ok: false }>;
      readonly message: string;
    }
  | StructuredAgentCreateOutcomeBase & {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-prompt'
        | 'daemon-unavailable'
        | 'recovery-unavailable'
        | 'provider-not-ready'
        | 'workspace-unavailable'
        | 'command-rejected';
      readonly command?: StructuredAgentCreateCommand;
      readonly receipt?: Extract<DaemonCommandReceipt, { readonly ok: false }>;
      readonly message: string;
    };

let fallbackId = 0;

function defaultCreateId(prefix: 'agent' | 'command'): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function structuredAgentSessionTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 52 ? oneLine : `${oneLine.slice(0, 49)}…`;
}

export function structuredAgentModelOptions(
  capabilities: readonly string[],
  current?: string,
  catalog?: readonly { readonly id: string; readonly displayName: string }[],
): readonly StructuredAgentModelOption[] {
  const labels = new Map(catalog?.map((model) => [model.id, model.displayName]) ?? []);
  const capabilityIds = capabilities.flatMap((capability) => {
    const match = /^(?:model:|model=)(.+)$/u.exec(capability);
    return match?.[1] ? [match[1]] : [];
  });
  for (const id of capabilityIds) if (!labels.has(id)) labels.set(id, id);
  if (current && !labels.has(current)) labels.set(current, current);
  return [...labels].map(([id, label]) => ({ id, label }));
}

export function structuredAgentProviderOptions(
  snapshot: DaemonSnapshot | null,
  catalogs: StructuredAgentProviderModelCatalogs = {},
): readonly StructuredAgentProviderOption[] {
  return (snapshot?.providers ?? [])
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      label: provider.displayName,
      models: structuredAgentModelOptions(
        provider.capabilities,
        undefined,
        catalogs[provider.id],
      ),
      disabled: provider.health !== 'ready',
      description: provider.healthDetail,
    }));
}

export function structuredAgentWorkspaceOptions(
  snapshot: DaemonSnapshot | null,
  projectId?: string,
): readonly StructuredAgentWorkspaceOption[] {
  const activeProjectIds = new Set((snapshot?.projects ?? [])
    .filter((project) => project.archivedAt === undefined)
    .map((project) => project.id));
  return (snapshot?.workspaces ?? [])
    .filter((workspace) => (
      workspace.archivedAt === undefined
      && activeProjectIds.has(workspace.projectId)
      && (!projectId || workspace.projectId === projectId)
    ))
    .map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      kind: workspace.kind,
      path: workspace.rootPath,
    }));
}

export function resolvePreferredDaemonWorkspaceId(
  workspaces: readonly StructuredAgentWorkspaceOption[],
  projectId?: string,
  rootId?: string,
  preferredWorkspaceId?: string,
): string | undefined {
  if (!preferredWorkspaceId) return undefined;
  if (rootId) {
    const fullyQualified = projectId
      ? `${projectId}.${rootId}.${preferredWorkspaceId}`
      : undefined;
    const namespaced = workspaces.find((workspace) => (
      workspace.id === fullyQualified
      || workspace.id.endsWith(`.${rootId}.${preferredWorkspaceId}`)
    ));
    if (namespaced) return namespaced.id;
  }
  return workspaces.some((workspace) => workspace.id === preferredWorkspaceId)
    ? preferredWorkspaceId
    : undefined;
}

/**
 * Transport-neutral first-Send authority. It keeps the logical Session stable
 * across optimistic-revision retries while assigning each definitively
 * rejected command a fresh idempotency identity.
 */
export async function createStructuredAgentSession(
  input: StructuredAgentDraftInput,
  options: StructuredAgentCreateOptions,
): Promise<StructuredAgentCreateOutcome> {
  const initialPrompt = input.initialPrompt.trim();
  const createId = options.createId ?? defaultCreateId;
  const sessionId = options.sessionId ?? createId('agent');
  const title = structuredAgentSessionTitle(initialPrompt);
  if (!initialPrompt) {
    return {
      kind: 'rejected',
      reason: 'invalid-prompt',
      sessionId,
      title,
      message: 'Enter a first prompt before creating the Agent session.',
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let snapshot: DaemonSnapshot | null;
    try {
      snapshot = await options.access.getSnapshot();
    } catch {
      snapshot = null;
    }
    if (!snapshot) {
      return {
        kind: 'rejected',
        reason: 'daemon-unavailable',
        sessionId,
        title,
        message: 'The Agent daemon is unavailable.',
      };
    }

    const provider = snapshot.providers.find((candidate) => candidate.id === input.providerId);
    if (!provider || !provider.enabled || provider.health !== 'ready') {
      return {
        kind: 'rejected',
        reason: 'provider-not-ready',
        sessionId,
        title,
        message: 'The selected provider is not ready.',
      };
    }
    const workspace = snapshot.workspaces.find((candidate) => (
      candidate.id === input.workspaceId && candidate.archivedAt === undefined
    ));
    const project = workspace
      ? snapshot.projects.find((candidate) => (
          candidate.id === workspace.projectId && candidate.archivedAt === undefined
        ))
      : undefined;
    if (!workspace || !project) {
      return {
        kind: 'rejected',
        reason: 'workspace-unavailable',
        sessionId,
        title,
        message: 'The selected workspace is no longer available.',
      };
    }

    const commandId = createId('command');
    const command = createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: snapshot.revision,
      issuedAt: (options.now ?? (() => new Date()))().toISOString(),
      principal: options.principal,
      type: 'agent.create',
      payload: {
        sessionId,
        workspaceId: input.workspaceId,
        title,
        providerId: input.providerId,
        ...(input.model ? { model: input.model } : {}),
        permissionPreset: input.permissionPreset,
        initialPrompt,
      },
    });
    try {
      await options.onCommandPrepared?.(command);
    } catch {
      return {
        kind: 'rejected',
        reason: 'recovery-unavailable',
        sessionId,
        title,
        command,
        message: 'The Agent recovery checkpoint could not be saved. No command was sent.',
      };
    }

    let receipt: DaemonCommandReceipt;
    try {
      receipt = await options.access.sendCommand(command);
    } catch {
      return {
        kind: 'delivery-uncertain',
        sessionId,
        title,
        command,
        message: 'The Agent command delivery could not be confirmed.',
      };
    }
    if (receipt.ok) return { kind: 'created', sessionId, title, command, receipt };
    if (receipt.status === 'delivery-uncertain' || receipt.error.code === 'delivery-uncertain') {
      return {
        kind: 'delivery-uncertain',
        sessionId,
        title,
        command,
        receipt,
        message: receipt.error.message,
      };
    }
    if (receipt.error.code === 'revision-conflict' && attempt < 2) continue;
    return {
      kind: 'rejected',
      reason: 'command-rejected',
      sessionId,
      title,
      command,
      receipt,
      message: receipt.error.message,
    };
  }

  throw new Error('Structured Agent create retry bound was exceeded.');
}
