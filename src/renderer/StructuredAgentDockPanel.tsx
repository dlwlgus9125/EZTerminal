import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonEvent,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import type { DaemonProviderManagementResult, ProviderModel } from '../shared/daemon-provider';
import {
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentDraftInput,
  type StructuredAgentProviderOption,
  type StructuredAgentUiResult,
  type StructuredAgentWorkspaceOption,
} from './StructuredAgentSession';

export const STRUCTURED_AGENT_DRAFT_PREFIX = 'structured-draft-';
export const STRUCTURED_AGENT_SESSION_PREFIX = 'structured-session-';

export function isStructuredAgentDockHistoryId(historyId: string): boolean {
  return historyId.startsWith(STRUCTURED_AGENT_DRAFT_PREFIX)
    || historyId.startsWith(STRUCTURED_AGENT_SESSION_PREFIX);
}

export function structuredAgentSessionHistoryId(sessionId: string): string {
  return `${STRUCTURED_AGENT_SESSION_PREFIX}${sessionId}`;
}

export function structuredAgentSessionId(historyId: string): string | null {
  return historyId.startsWith(STRUCTURED_AGENT_SESSION_PREFIX)
    ? historyId.slice(STRUCTURED_AGENT_SESSION_PREFIX.length) || null
    : null;
}

interface RendererDaemonApi {
  getDaemonSnapshot(): Promise<DaemonSnapshot | null>;
  sendDaemonCommand(command: DaemonCommand): Promise<DaemonCommandReceipt>;
  onDaemonEvent(listener: (event: DaemonEvent) => void): () => void;
  setDaemonEventsSubscribed(subscribed: boolean): void;
  listDaemonProviderModels?(
    providerId: string,
  ): Promise<DaemonProviderManagementResult<readonly ProviderModel[]>>;
}

function rendererDaemonApi(): RendererDaemonApi | null {
  const candidate = window.ezterminal as typeof window.ezterminal & Partial<RendererDaemonApi>;
  return typeof candidate?.getDaemonSnapshot === 'function'
    && typeof candidate.sendDaemonCommand === 'function'
    ? candidate as RendererDaemonApi
    : null;
}

let fallbackId = 0;

function opaqueId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function modelOptions(
  capabilities: readonly string[],
  current?: string,
  catalog?: readonly { readonly id: string; readonly displayName: string }[],
) {
  const labels = new Map(catalog?.map((model) => [model.id, model.displayName]) ?? []);
  const capabilityIds = capabilities.flatMap((capability) => {
    const match = /^(?:model:|model=)(.+)$/u.exec(capability);
    return match?.[1] ? [match[1]] : [];
  });
  for (const id of capabilityIds) if (!labels.has(id)) labels.set(id, id);
  if (current && !labels.has(current)) labels.set(current, current);
  return [...labels].map(([id, label]) => ({ id, label }));
}

function providerOptions(
  snapshot: DaemonSnapshot | null,
  catalogs: Readonly<Record<string, readonly { readonly id: string; readonly displayName: string }[]>>,
): readonly StructuredAgentProviderOption[] {
  return (snapshot?.providers ?? [])
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      label: provider.displayName,
      models: modelOptions(provider.capabilities, undefined, catalogs[provider.id]),
      disabled: provider.health !== 'ready',
      description: provider.healthDetail,
    }));
}

function workspaceOptions(
  snapshot: DaemonSnapshot | null,
  projectId?: string,
): readonly StructuredAgentWorkspaceOption[] {
  return (snapshot?.workspaces ?? [])
    .filter((workspace) => workspace.archivedAt === undefined && (!projectId || workspace.projectId === projectId))
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

function resultOf(receipt: DaemonCommandReceipt): StructuredAgentUiResult {
  return receipt.ok ? { ok: true } : { ok: false, message: receipt.error.message };
}

function localUserItem(
  sessionId: string,
  commandId: string,
  sequence: number,
  text: string,
): DaemonTranscriptItem {
  return {
    id: `local-${commandId}`,
    sessionId,
    sequence,
    kind: 'user-message',
    text,
    isDelta: false,
    isSensitive: false,
    createdAt: new Date().toISOString(),
  };
}

function sessionTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/gu, ' ').trim();
  return oneLine.length <= 52 ? oneLine : `${oneLine.slice(0, 49)}…`;
}

interface CreatedDraftState extends StructuredAgentDraftInput {
  readonly sessionId: string;
  readonly title: string;
}

/**
 * Renderer-only adapter around the daemon bridge. The semantic surface remains
 * callback-driven; this component only translates Dockview params and v12
 * command receipts into those callbacks.
 */
export function StructuredAgentDockPanel(props: IDockviewPanelProps): JSX.Element {
  const historyId = typeof props.params?.historyId === 'string' ? props.params.historyId : '';
  const projectId = typeof props.params?.projectId === 'string' ? props.params.projectId : undefined;
  const rootId = typeof props.params?.rootId === 'string' ? props.params.rootId : undefined;
  const preferredWorkspaceId = typeof props.params?.workspaceId === 'string'
    ? props.params.workspaceId
    : undefined;
  const restoredSessionId = structuredAgentSessionId(historyId);
  const [sessionId, setSessionId] = useState<string | null>(restoredSessionId);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createdDraft, setCreatedDraft] = useState<CreatedDraftState | null>(null);
  const [localItems, setLocalItems] = useState<readonly DaemonTranscriptItem[]>([]);
  const [providerModelCatalogs, setProviderModelCatalogs] = useState<Readonly<Record<
    string,
    readonly { readonly id: string; readonly displayName: string }[]
  >>>({});
  const snapshotRef = useRef<DaemonSnapshot | null>(null);
  const refreshInFlight = useRef<Promise<DaemonSnapshot | null> | null>(null);
  const providerModelRevisionRef = useRef<Readonly<Record<string, number>>>({});

  const refresh = useCallback(async (): Promise<DaemonSnapshot | null> => {
    const api = rendererDaemonApi();
    if (!api) {
      setLoading(false);
      setLoadError('The Agent daemon bridge is unavailable.');
      return null;
    }
    if (refreshInFlight.current) return refreshInFlight.current;
    setLoading(true);
    const request = api.getDaemonSnapshot()
      .then((next) => {
        if (!next) {
          setLoadError('The Agent daemon did not return a project snapshot.');
          return null;
        }
        if (snapshotRef.current && next.revision < snapshotRef.current.revision) {
          setLoadError(null);
          return snapshotRef.current;
        }
        snapshotRef.current = next;
        setSnapshot(next);
        setLoadError(null);
        return next;
      })
      .catch(() => {
        setLoadError('The Agent daemon could not be reached.');
        return null;
      })
      .finally(() => {
        setLoading(false);
        refreshInFlight.current = null;
      });
    refreshInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const api = rendererDaemonApi();
    if (!snapshot || typeof api?.listDaemonProviderModels !== 'function') return undefined;
    let cancelled = false;
    const targets = snapshot.providers.filter((provider) => (
      provider.enabled
      && provider.health === 'ready'
      && providerModelRevisionRef.current[provider.id] !== provider.revision
    ));
    if (targets.length === 0) return undefined;
    void Promise.all(targets
      .map(async (provider) => {
        const result = await api.listDaemonProviderModels!(provider.id).catch(() => null);
        return [provider.id, provider.revision, result?.ok ? result.value : null] as const;
      }))
      .then((entries) => {
        if (cancelled) return;
        setProviderModelCatalogs((current) => {
          const next = { ...current };
          const revisions = { ...providerModelRevisionRef.current };
          for (const [providerId, providerRevision, models] of entries) {
            if (models) {
              next[providerId] = models;
              revisions[providerId] = providerRevision;
            }
          }
          providerModelRevisionRef.current = revisions;
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [snapshot]);

  useEffect(() => {
    const api = rendererDaemonApi();
    if (!api || typeof api.onDaemonEvent !== 'function' || typeof api.setDaemonEventsSubscribed !== 'function') {
      return undefined;
    }
    let queued = false;
    api.setDaemonEventsSubscribed(true);
    const unsubscribe = api.onDaemonEvent(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void refresh();
      });
    });
    return () => {
      unsubscribe();
      api.setDaemonEventsSubscribed(false);
    };
  }, [refresh]);

  useEffect(() => {
    const next = structuredAgentSessionId(historyId);
    if (next) setSessionId(next);
  }, [historyId]);

  const sendCommand = useCallback(async (command: DaemonCommand): Promise<DaemonCommandReceipt | null> => {
    const api = rendererDaemonApi();
    if (!api) return null;
    const receipt = await api.sendDaemonCommand(command).catch(() => null);
    if (receipt?.ok) {
      if (snapshotRef.current && receipt.revision >= snapshotRef.current.revision) {
        snapshotRef.current = {
          ...snapshotRef.current,
          revision: receipt.revision,
          eventSequence: receipt.eventSequence,
        };
        setSnapshot(snapshotRef.current);
      }
      void refresh();
    }
    return receipt;
  }, [refresh]);

  const latestSnapshot = useCallback(async (): Promise<DaemonSnapshot | null> => {
    return await refresh() ?? snapshotRef.current;
  }, [refresh]);

  const create = useCallback(async (input: StructuredAgentDraftInput): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const provider = authority.providers.find((candidate) => candidate.id === input.providerId);
    if (!provider || !provider.enabled || provider.health !== 'ready') {
      return { ok: false, message: 'The selected provider is not ready.' };
    }
    const workspace = authority.workspaces.find((candidate) => (
      candidate.id === input.workspaceId && candidate.archivedAt === undefined
    ));
    if (!workspace) return { ok: false, message: 'The selected workspace is no longer available.' };
    const nextSessionId = opaqueId('agent');
    const commandId = opaqueId('command');
    const title = sessionTitle(input.initialPrompt);
    const command = createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.create',
      payload: {
        sessionId: nextSessionId,
        workspaceId: input.workspaceId,
        title,
        providerId: input.providerId,
        ...(input.model ? { model: input.model } : {}),
        permissionPreset: input.permissionPreset,
        initialPrompt: input.initialPrompt,
      },
    });
    const receipt = await sendCommand(command);
    if (!receipt) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const result = resultOf(receipt);
    if (!result.ok) return result;
    const nextHistoryId = structuredAgentSessionHistoryId(nextSessionId);
    setCreatedDraft({ ...input, sessionId: nextSessionId, title });
    setSessionId(nextSessionId);
    setLocalItems([localUserItem(nextSessionId, commandId, 1, input.initialPrompt)]);
    props.api.updateParameters({
      ...(props.api.getParameters?.() ?? props.params ?? {}),
      historyId: nextHistoryId,
      ...(input.providerId === 'codex' || input.providerId === 'claude'
        ? { provider: input.providerId }
        : {}),
    });
    props.api.setTitle(title);
    return result;
  }, [latestSnapshot, props.api, props.params, sendCommand]);

  const providers = useMemo(
    () => providerOptions(snapshot, providerModelCatalogs),
    [providerModelCatalogs, snapshot],
  );
  const workspaces = useMemo(() => workspaceOptions(snapshot, projectId), [projectId, snapshot]);
  const initialWorkspaceId = useMemo(() => resolvePreferredDaemonWorkspaceId(
    workspaces,
    projectId,
    rootId,
    preferredWorkspaceId,
  ), [preferredWorkspaceId, projectId, rootId, workspaces]);

  if (!sessionId) {
    return (
      <StructuredAgentDraftPanel
        providers={providers}
        workspaces={workspaces}
        initialWorkspaceId={initialWorkspaceId}
        loading={loading}
        loadError={loadError}
        onRetry={() => void refresh()}
        onCreate={create}
      />
    );
  }

  const session = snapshot?.sessions.find((candidate) => candidate.id === sessionId);
  const agent = snapshot?.agents.find((candidate) => candidate.sessionId === sessionId);
  const workspace = snapshot?.workspaces.find((candidate) => candidate.id === session?.workspaceId)
    ?? snapshot?.workspaces.find((candidate) => candidate.id === createdDraft?.workspaceId);
  const providerId = agent?.providerId ?? createdDraft?.providerId ?? '';
  const provider = snapshot?.providers.find((candidate) => candidate.id === providerId);
  const currentModel = agent?.model ?? createdDraft?.model;
  const workspaceOption: StructuredAgentWorkspaceOption = workspace
    ? { id: workspace.id, label: workspace.name, kind: workspace.kind, path: workspace.rootPath }
    : { id: createdDraft?.workspaceId ?? '', label: 'Workspace unavailable', kind: 'local' };

  const runSessionCommand = async (
    type: 'agent.submit' | 'agent.interrupt-and-submit',
    prompt: string,
  ): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const commandId = opaqueId('command');
    const command = type === 'agent.submit'
      ? createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision: authority.revision,
          issuedAt: new Date().toISOString(),
          principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          type,
          payload: { sessionId, prompt },
        })
      : createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision: authority.revision,
          issuedAt: new Date().toISOString(),
          principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          type,
          payload: { sessionId, prompt },
        });
    const receipt = await sendCommand(command);
    if (!receipt) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const result = resultOf(receipt);
    if (result.ok) {
      setLocalItems((current) => current.some((item) => item.id === `local-${commandId}`)
        ? current
        : [...current, localUserItem(sessionId, commandId, current.length + 1, prompt)]);
    }
    return result;
  };

  const changeSettings = async (settings: {
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
  }): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'agent.set-settings',
      payload: {
        sessionId,
        permissionPreset: settings.permissionPreset,
        ...(settings.model ? { model: settings.model } : {}),
      },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const resolveApproval = async (
    approvalId: string,
    decision: 'allow' | 'deny',
  ): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'permission.resolve',
      payload: { approvalId, decision },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  return (
    <StructuredAgentSessionPanel
      sessionId={sessionId}
      title={session?.title ?? createdDraft?.title ?? 'Agent session'}
      providerId={providerId}
      providerLabel={provider?.displayName ?? (providerId || 'Agent')}
      workspace={workspaceOption}
      model={currentModel}
      modelOptions={modelOptions(
        provider?.capabilities ?? [],
        currentModel,
        providerModelCatalogs[providerId],
      )}
      permissionPreset={agent?.permissionPreset ?? createdDraft?.permissionPreset ?? 'standard'}
      state={agent?.state ?? (createdDraft || loading ? 'starting' : 'error')}
      queuedCount={agent?.queuedTurnCount ?? 0}
      items={localItems}
      approvals={(snapshot?.approvals ?? []).filter((approval) => approval.sessionId === sessionId)}
      transcriptLoading={loading && localItems.length === 0}
      transcriptError={loadError ?? (!createdDraft && !loading && snapshot && !session
        ? 'This Agent session is no longer available.'
        : null)}
      disabled={!rendererDaemonApi()}
      onRetryTranscript={() => void refresh()}
      onSend={(prompt) => runSessionCommand('agent.submit', prompt)}
      onInterruptAndSend={(prompt) => runSessionCommand('agent.interrupt-and-submit', prompt)}
      onChangeSettings={changeSettings}
      onResolveApproval={resolveApproval}
    />
  );
}
