import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { AgentLaunchBootstrap } from '../shared/agent-history';
import { NewSessionDraftPanel } from './NewSessionDraftPanel';

import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';
import { isDaemonSessionArchived } from '../shared/daemon-session-visibility';
import type { RendererRecoveryStructuredAgentCreate } from '../shared/renderer-recovery';
import { rendererCapabilities, type CapabilityAccess } from './capability-access';
import { DaemonSafeModeNotice } from './DaemonSafeModeNotice';
import {
  StructuredAgentHeartbeat,
  type StructuredAgentHeartbeatInput,
} from './StructuredAgentHeartbeat';
import {
  StructuredAgentChildTrack,
  StructuredAgentDraftPanel,
  StructuredAgentSessionPanel,
  type StructuredAgentChildTrackItem,
  type StructuredAgentDraftInput,
  type StructuredAgentUiResult,
  type StructuredAgentWorkspaceOption,
} from './StructuredAgentSession';
import {
  createStructuredAgentSession,
  resolvePreferredDaemonWorkspaceId,
  structuredAgentModelOptions,
  structuredAgentProviderOptions,
  structuredAgentWorkspaceOptions,
  type StructuredAgentCreateOutcome,
  type StructuredAgentCreateCommand,
} from './structured-agent-create';
import { type StructuredAgentCreateRecoveryRegistry } from './structured-agent-create-recovery';
import {
  consumeRendererRecoveryStructuredAgentCreate,
  peekRendererRecoveryStructuredAgentCreate,
} from './renderer-recovery-state';

export { resolvePreferredDaemonWorkspaceId } from './structured-agent-create';

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

let fallbackId = 0;

const TRANSCRIPT_PAGE_SIZE = 500;
const TRANSCRIPT_PAGES_PER_YIELD = 10;
const HEARTBEAT_SESSION_STATES = new Set([
  'starting',
  'queued',
  'working',
  'blocked',
  'idle',
  'delivery-uncertain',
]);

function opaqueId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
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

export function mergeAuthoritativeTranscript(
  current: readonly DaemonTranscriptItem[],
  incoming: readonly DaemonTranscriptItem[],
): readonly DaemonTranscriptItem[] {
  const bySequence = new Map<number, DaemonTranscriptItem>();
  for (const item of current) bySequence.set(item.sequence, item);
  for (const item of incoming) bySequence.set(item.sequence, item);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function optimisticCommandId(item: DaemonTranscriptItem): string | null {
  return item.id.startsWith('local-') ? item.id.slice('local-'.length) || null : null;
}

export function mergeOptimisticTranscript(
  authoritative: readonly DaemonTranscriptItem[],
  optimistic: readonly DaemonTranscriptItem[],
  snapshot: DaemonSnapshot | null,
): readonly DaemonTranscriptItem[] {
  const representedTurnIds = new Set(authoritative.flatMap((item) => item.turnId ? [item.turnId] : []));
  const representedCommandIds = new Set((snapshot?.turns ?? []).flatMap((turn) => (
    representedTurnIds.has(turn.id) ? [turn.commandId] : []
  )));
  const authoritativeIds = new Set(authoritative.map((item) => item.id));
  const pending = optimistic.filter((item) => {
    const commandId = optimisticCommandId(item);
    return !authoritativeIds.has(item.id) && (!commandId || !representedCommandIds.has(commandId));
  });
  const lastSequence = authoritative.at(-1)?.sequence ?? 0;
  return [
    ...authoritative,
    ...pending.map((item, index) => ({ ...item, sequence: lastSequence + index + 1 })),
  ];
}

interface CreatedDraftState extends StructuredAgentDraftInput {
  readonly sessionId: string;
  readonly title: string;
}

interface UncertainDraftState {
  readonly input: StructuredAgentDraftInput;
  readonly outcome: Extract<StructuredAgentCreateOutcome, { readonly kind: 'delivery-uncertain' }>;
}

function recoveryDraftState(
  recovery: RendererRecoveryStructuredAgentCreate,
): UncertainDraftState {
  const payload = recovery.command.payload;
  return {
    input: {
      providerId: payload.providerId,
      ...(payload.model ? { model: payload.model } : {}),
      workspaceId: payload.workspaceId,
      permissionPreset: payload.permissionPreset,
      initialPrompt: payload.initialPrompt,
    },
    outcome: {
      kind: 'delivery-uncertain',
      sessionId: recovery.sessionId,
      title: payload.title,
      command: recovery.command,
      message: recovery.phase === 'sending'
        ? 'The Agent command was still being delivered when this panel was restored.'
        : 'The Agent command delivery could not be confirmed.',
    },
  };
}

function recoveryRecord(
  panelId: string,
  historyId: string,
  command: StructuredAgentCreateCommand,
): RendererRecoveryStructuredAgentCreate {
  return Object.freeze({
    panelId,
    historyId,
    sessionId: command.payload.sessionId,
    phase: 'sending',
    command,
  });
}

/**
 * Renderer-only adapter around the daemon bridge. The semantic surface remains
 * callback-driven; this component only translates Dockview params and v12
 * command receipts into those callbacks.
 */
export function StructuredAgentDockPanel(
  props: IDockviewPanelProps & {
    readonly capabilities?: CapabilityAccess;
    readonly createRecoveryRegistry?: StructuredAgentCreateRecoveryRegistry;
    /** Resolves true only after main has accepted the current memory-only checkpoint. */
    readonly persistCreateRecovery?: () => Promise<boolean>;
    readonly onOpenTerminal?: (workspaceId?: string, directory?: string) => Promise<StructuredAgentUiResult>;
    readonly onLaunchCli?: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
    readonly onOpenSettings?: () => void;
    readonly onOpenSession?: (input: {
      readonly sessionId: string;
      readonly title?: string;
      readonly providerLabel?: string;
    }) => void;
  },
): JSX.Element {
  const capabilities = props.capabilities ?? rendererCapabilities;
  const createRecoveryRegistry = props.createRecoveryRegistry;
  const persistCreateRecovery = props.persistCreateRecovery;
  const historyId = typeof props.params?.historyId === 'string' ? props.params.historyId : '';
  const projectId = typeof props.params?.projectId === 'string' ? props.params.projectId : undefined;
  const rootId = typeof props.params?.rootId === 'string' ? props.params.rootId : undefined;
  const preferredWorkspaceId = typeof props.params?.workspaceId === 'string'
    ? props.params.workspaceId
    : undefined;
  const restoredSessionId = structuredAgentSessionId(historyId);
  const [sessionId, setSessionId] = useState<string | null>(restoredSessionId);
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null);
  const [availability, setAvailability] = useState<DaemonAuthorityAvailability | null>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createdDraft, setCreatedDraft] = useState<CreatedDraftState | null>(null);
  const recoveredCreateRef = useRef<RendererRecoveryStructuredAgentCreate | undefined>(undefined);
  const checkpointCreateRef = useRef<RendererRecoveryStructuredAgentCreate | undefined>(undefined);
  const [uncertainDraft, setUncertainDraft] = useState<UncertainDraftState | null>(() => {
    const registered = createRecoveryRegistry?.get(props.api.id);
    const checkpoint = registered
      ? undefined
      : peekRendererRecoveryStructuredAgentCreate(props.api.id);
    const recovery = registered ?? checkpoint;
    recoveredCreateRef.current = recovery;
    checkpointCreateRef.current = checkpoint;
    return recovery ? recoveryDraftState(recovery) : null;
  });
  const [localItems, setLocalItems] = useState<readonly DaemonTranscriptItem[]>([]);
  const [authoritativeItems, setAuthoritativeItems] = useState<readonly DaemonTranscriptItem[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(restoredSessionId !== null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [providerModelCatalogs, setProviderModelCatalogs] = useState<Readonly<Record<
    string,
    readonly { readonly id: string; readonly displayName: string }[]
  >>>({});
  const snapshotRef = useRef<DaemonSnapshot | null>(null);
  const refreshInFlight = useRef<Promise<DaemonSnapshot | null> | null>(null);
  const providerModelRevisionRef = useRef<Readonly<Record<string, number>>>({});
  const authoritativeItemsRef = useRef<readonly DaemonTranscriptItem[]>([]);
  const transcriptCursorRef = useRef(0);
  const transcriptTargetRef = useRef(0);
  const transcriptSessionRef = useRef<string | null>(restoredSessionId);
  const transcriptGenerationRef = useRef(0);
  const transcriptInFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const recovery = recoveredCreateRef.current;
    if (recovery) createRecoveryRegistry?.register(recovery);
    const checkpoint = checkpointCreateRef.current;
    if (checkpoint) {
      consumeRendererRecoveryStructuredAgentCreate(
        checkpoint.panelId,
        checkpoint.command.commandId,
      );
      checkpointCreateRef.current = undefined;
    }
  }, [createRecoveryRegistry]);

  const refresh = useCallback(async (): Promise<DaemonSnapshot | null> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    setLoading(true);
    const request = Promise.resolve()
      .then(() => capabilities.daemon.getSnapshot())
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
  }, [capabilities]);

  const syncTranscript = useCallback((
    targetSessionId: string,
    targetSequence = 0,
  ): Promise<void> => {
    if (transcriptSessionRef.current !== targetSessionId) return Promise.resolve();
    transcriptTargetRef.current = Math.max(transcriptTargetRef.current, targetSequence);
    if (
      targetSequence > 0
      && transcriptCursorRef.current >= transcriptTargetRef.current
    ) return Promise.resolve();
    if (transcriptInFlightRef.current) return transcriptInFlightRef.current;
    const generation = transcriptGenerationRef.current;
    let shouldContinue = false;
    let failed = false;
    const run = async (): Promise<void> => {
      setTranscriptLoading(authoritativeItemsRef.current.length === 0);
      setTranscriptError(null);
      try {
        for (let pageIndex = 0; pageIndex < TRANSCRIPT_PAGES_PER_YIELD; pageIndex += 1) {
          if (
            transcriptGenerationRef.current !== generation
            || transcriptSessionRef.current !== targetSessionId
          ) return;
          const afterSequence = transcriptCursorRef.current;
          const page = await capabilities.daemon.getTranscript(
            targetSessionId,
            afterSequence,
            TRANSCRIPT_PAGE_SIZE,
          );
          if (
            transcriptGenerationRef.current !== generation
            || transcriptSessionRef.current !== targetSessionId
          ) return;
          const validPage = page
            .filter((item) => (
              item.sessionId === targetSessionId
              && Number.isSafeInteger(item.sequence)
              && item.sequence > afterSequence
            ))
            .sort((left, right) => left.sequence - right.sequence);
          if (validPage.some((item, index) => item.sequence !== afterSequence + index + 1)) {
            throw new Error('The Agent transcript page contains a sequence gap.');
          }
          if (validPage.length > 0) {
            const next = mergeAuthoritativeTranscript(authoritativeItemsRef.current, validPage);
            authoritativeItemsRef.current = next;
            transcriptCursorRef.current = next.at(-1)?.sequence ?? afterSequence;
            setAuthoritativeItems(next);
          }
          const target = transcriptTargetRef.current;
          if (validPage.length === 0) {
            if (target > transcriptCursorRef.current) {
              throw new Error('The Agent transcript is temporarily incomplete.');
            }
            shouldContinue = false;
            return;
          }
          if (transcriptCursorRef.current >= target && page.length < TRANSCRIPT_PAGE_SIZE) {
            shouldContinue = false;
            return;
          }
          if (transcriptCursorRef.current <= afterSequence) {
            throw new Error('The Agent transcript did not advance.');
          }
          shouldContinue = true;
        }
      } catch {
        shouldContinue = false;
        failed = true;
        if (
          transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) {
          setTranscriptError('The Agent transcript could not be loaded.');
        }
      } finally {
        if (
          transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) setTranscriptLoading(false);
      }
    };
    const promise = run().finally(() => {
      if (transcriptInFlightRef.current === promise) {
        transcriptInFlightRef.current = null;
        if (
          !failed
          && (shouldContinue || transcriptTargetRef.current > transcriptCursorRef.current)
          && transcriptGenerationRef.current === generation
          && transcriptSessionRef.current === targetSessionId
        ) queueMicrotask(() => { void syncTranscript(targetSessionId, transcriptTargetRef.current); });
      }
    });
    transcriptInFlightRef.current = promise;
    return promise;
  }, [capabilities]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => capabilities.daemon.getAvailability())
      .then((next) => {
        if (!cancelled) setAvailability(next);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => { cancelled = true; };
  }, [capabilities]);

  useEffect(() => {
    if (availability === undefined || availability?.state === 'legacy-only-safe-mode') return;
    void refresh();
  }, [availability, refresh]);

  useEffect(() => {
    transcriptGenerationRef.current += 1;
    transcriptSessionRef.current = sessionId;
    transcriptTargetRef.current = 0;
    transcriptCursorRef.current = 0;
    transcriptInFlightRef.current = null;
    authoritativeItemsRef.current = [];
    setAuthoritativeItems([]);
    setLocalItems((current) => current.filter((item) => item.sessionId === sessionId));
    setTranscriptError(null);
    setTranscriptLoading(sessionId !== null);
    if (sessionId && availability !== undefined && availability?.state !== 'legacy-only-safe-mode') {
      void syncTranscript(sessionId);
    } else if (availability?.state === 'legacy-only-safe-mode') {
      setTranscriptLoading(false);
    }
    return () => {
      transcriptGenerationRef.current += 1;
    };
  }, [availability, sessionId, syncTranscript]);

  useEffect(() => {
    if (!sessionId || !snapshot) return;
    const head = snapshot.transcriptHeads.find((candidate) => candidate.sessionId === sessionId);
    void syncTranscript(sessionId, head?.lastSequence ?? 0);
  }, [sessionId, snapshot, syncTranscript]);

  useEffect(() => {
    if (!snapshot) return undefined;
    let cancelled = false;
    const targets = snapshot.providers.filter((provider) => (
      provider.enabled
      && provider.health === 'ready'
      && providerModelRevisionRef.current[provider.id] !== provider.revision
    ));
    if (targets.length === 0) return undefined;
    void Promise.all(targets
      .map(async (provider) => {
        const result = await Promise.resolve()
          .then(() => capabilities.structuredProviders.listModels(provider.id))
          .catch(() => null);
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
  }, [capabilities, snapshot]);

  useEffect(() => {
    if (availability === undefined || availability?.state === 'legacy-only-safe-mode') return undefined;
    let queued = false;
    return capabilities.daemon.observeEvents((event) => {
      if (event.kind === 'transcript.appended' && event.payload.sessionId === transcriptSessionRef.current) {
        void syncTranscript(event.payload.sessionId, event.payload.toSequence);
      }
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        void refresh();
      });
    }, () => {
      setLoadError('The Agent daemon event stream is unavailable.');
    });
  }, [availability, capabilities, refresh, syncTranscript]);

  useEffect(() => {
    const next = structuredAgentSessionId(historyId);
    if (next) setSessionId(next);
  }, [historyId]);

  const sendCommand = useCallback(async (command: DaemonCommand): Promise<DaemonCommandReceipt | null> => {
    const receipt = await Promise.resolve()
      .then(() => capabilities.daemon.sendCommand(command))
      .catch(() => null);
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
  }, [capabilities, refresh]);

  const latestSnapshot = useCallback(async (): Promise<DaemonSnapshot | null> => {
    return await refresh();
  }, [refresh]);

  const finishCreatedDraft = useCallback((
    outcome: Extract<StructuredAgentCreateOutcome, { readonly kind: 'created' | 'delivery-uncertain' }>,
  ): StructuredAgentUiResult => {
    const createdInput = outcome.command.payload;
    const nextHistoryId = structuredAgentSessionHistoryId(outcome.sessionId);
    setCreatedDraft({
      providerId: createdInput.providerId,
      ...(createdInput.model ? { model: createdInput.model } : {}),
      workspaceId: createdInput.workspaceId,
      permissionPreset: createdInput.permissionPreset,
      initialPrompt: createdInput.initialPrompt,
      sessionId: outcome.sessionId,
      title: outcome.title,
    });
    setSessionId(outcome.sessionId);
    setLocalItems([localUserItem(
      outcome.sessionId,
      outcome.command.commandId,
      1,
      createdInput.initialPrompt,
    )]);
    setUncertainDraft(null);
    props.api.updateParameters({
      ...(props.api.getParameters?.() ?? props.params ?? {}),
      historyId: nextHistoryId,
      ...(createdInput.providerId === 'codex' || createdInput.providerId === 'claude'
        ? { provider: createdInput.providerId }
        : {}),
    });
    props.api.setTitle(outcome.title);
    // Clear escrow only after Dockview carries the durable Session identity, so
    // the immediate prompt-free checkpoint cannot regress to a blank draft.
    createRecoveryRegistry?.clear(props.api.id, outcome.command.commandId);
    return { ok: true };
  }, [createRecoveryRegistry, props.api, props.params]);

  const create = useCallback(async (input: StructuredAgentDraftInput): Promise<StructuredAgentUiResult> => {
    let registeredCommandId = uncertainDraft?.outcome.command.commandId;
    const registerPreparedCommand = async (command: StructuredAgentCreateCommand): Promise<void> => {
      if (!createRecoveryRegistry || !persistCreateRecovery) {
        throw new Error('Desktop Agent recovery escrow is unavailable.');
      }
      registeredCommandId = command.commandId;
      if (!createRecoveryRegistry.register(recoveryRecord(props.api.id, historyId, command))) {
        throw new Error('Desktop Agent recovery escrow is at capacity.');
      }
      if (!(await persistCreateRecovery())) {
        throw new Error('Desktop Agent recovery escrow could not be confirmed.');
      }
    };
    const access = {
      getSnapshot: latestSnapshot,
      sendCommand: async (command: Extract<DaemonCommand, { readonly type: 'agent.create' }>) => {
        const receipt = await sendCommand(command);
        if (!receipt) throw new Error('The Agent daemon is unavailable.');
        return receipt;
      },
    };
    let outcome: StructuredAgentCreateOutcome;
    if (uncertainDraft) {
      const authority = await latestSnapshot();
      if (!authority) {
        return {
          ok: false,
          message: 'The Agent daemon is unavailable. Delivery was not retried.',
        };
      }
      const alreadyCreated = authority.sessions.some((candidate) => (
        candidate.id === uncertainDraft.outcome.sessionId
        && candidate.kind === 'agent'
        && candidate.source === 'structured'
      ));
      if (alreadyCreated) return finishCreatedDraft(uncertainDraft.outcome);

      const replay = await sendCommand(uncertainDraft.outcome.command);
      if (!replay || (!replay.ok && replay.status === 'delivery-uncertain')) {
        createRecoveryRegistry?.markDeliveryUncertain(
          props.api.id,
          uncertainDraft.outcome.command.commandId,
        );
        if (replay && !replay.ok) {
          setUncertainDraft({
            input,
            outcome: {
              ...uncertainDraft.outcome,
              receipt: replay,
              message: replay.error.message,
            },
          });
        }
        return {
          ok: false,
          message: 'Delivery is still unconfirmed. Send this locked draft again after the connection recovers.',
        };
      }
      if (replay.ok) {
        outcome = {
          kind: 'created',
          sessionId: uncertainDraft.outcome.sessionId,
          title: uncertainDraft.outcome.title,
          command: uncertainDraft.outcome.command,
          receipt: replay,
        };
      } else if (replay.error.code === 'revision-conflict') {
        outcome = await createStructuredAgentSession(input, {
          access,
          principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          createId: opaqueId,
          sessionId: uncertainDraft.outcome.sessionId,
          onCommandPrepared: registerPreparedCommand,
        });
      } else {
        const confirmation = await latestSnapshot();
        const createdDespiteReceipt = confirmation?.sessions.some((candidate) => (
          candidate.id === uncertainDraft.outcome.sessionId
          && candidate.kind === 'agent'
          && candidate.source === 'structured'
        ));
        if (createdDespiteReceipt) return finishCreatedDraft(uncertainDraft.outcome);
        setUncertainDraft(null);
        createRecoveryRegistry?.clear(props.api.id, uncertainDraft.outcome.command.commandId);
        return { ok: false, message: replay.error.message };
      }
    } else {
      outcome = await createStructuredAgentSession(input, {
        access,
        principal: { kind: 'desktop', id: 'renderer-agent-ui' },
        createId: opaqueId,
        onCommandPrepared: registerPreparedCommand,
      });
    }
    if (outcome.kind === 'created') return finishCreatedDraft(outcome);
    if (outcome.kind === 'delivery-uncertain') {
      createRecoveryRegistry?.markDeliveryUncertain(props.api.id, outcome.command.commandId);
      setUncertainDraft({ input, outcome });
      return {
        ok: false,
        message: 'Delivery could not be confirmed. This exact draft is locked; Send again to verify or safely retry the same session.',
      };
    }
    setUncertainDraft(null);
    if (registeredCommandId) createRecoveryRegistry?.clear(props.api.id, registeredCommandId);
    return { ok: false, message: outcome.message };
  }, [
    createRecoveryRegistry,
    finishCreatedDraft,
    historyId,
    latestSnapshot,
    persistCreateRecovery,
    props.api.id,
    sendCommand,
    uncertainDraft,
  ]);

  const providers = useMemo(
    () => structuredAgentProviderOptions(snapshot, providerModelCatalogs),
    [providerModelCatalogs, snapshot],
  );
  const workspaces = useMemo(
    () => structuredAgentWorkspaceOptions(snapshot, projectId),
    [projectId, snapshot],
  );
  const initialWorkspaceId = useMemo(() => resolvePreferredDaemonWorkspaceId(
    workspaces,
    projectId,
    rootId,
    preferredWorkspaceId,
  ), [preferredWorkspaceId, projectId, rootId, workspaces]);
  const transcriptItems = useMemo(
    () => mergeOptimisticTranscript(authoritativeItems, localItems, snapshot),
    [authoritativeItems, localItems, snapshot],
  );

  useEffect(() => {
    const visibleLocalIds = new Set(transcriptItems.flatMap((item) => (
      item.id.startsWith('local-') ? [item.id] : []
    )));
    setLocalItems((current) => {
      const next = current.filter((item) => visibleLocalIds.has(item.id));
      return next.length === current.length ? current : next;
    });
  }, [transcriptItems]);

  if (availability?.state === 'legacy-only-safe-mode' && (sessionId || !props.onOpenTerminal)) {
    return (
      <div className="structured-agent-safe-mode" data-testid="structured-agent-safe-mode">
        <DaemonSafeModeNotice availability={availability} showRecoveryPath />
      </div>
    );
  }

  if (!sessionId) {
    if (props.onOpenTerminal && props.onLaunchCli) {
      return <NewSessionDraftPanel
        snapshot={snapshot}
        projectId={projectId}
        workspaceId={initialWorkspaceId ?? (preferredWorkspaceId ? `${projectId && rootId ? `${projectId}.${rootId}.` : ''}${preferredWorkspaceId}` : undefined)}
        access={window.ezterminal}
        onTerminal={props.onOpenTerminal}
        onLaunchCli={props.onLaunchCli}
        onSettings={props.onOpenSettings}
        agent={{
          providers, workspaces,
          initialProviderId: uncertainDraft?.input.providerId,
          initialModel: uncertainDraft?.input.model,
          initialWorkspaceId: uncertainDraft?.input.workspaceId ?? initialWorkspaceId,
          initialPermissionPreset: uncertainDraft?.input.permissionPreset,
          initialPrompt: uncertainDraft?.input.initialPrompt,
          deliveryRecovery: uncertainDraft !== null,
          loading: loading || availability?.state === 'legacy-only-safe-mode',
          loadError, onRetry: () => void refresh(), onCreate: create,
        }}
      />;
    }
    return (
      <StructuredAgentDraftPanel
        providers={providers}
        workspaces={workspaces}
        initialProviderId={uncertainDraft?.input.providerId}
        initialModel={uncertainDraft?.input.model}
        initialWorkspaceId={uncertainDraft?.input.workspaceId ?? initialWorkspaceId}
        initialPermissionPreset={uncertainDraft?.input.permissionPreset}
        initialPrompt={uncertainDraft?.input.initialPrompt}
        deliveryRecovery={uncertainDraft !== null}
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
      void syncTranscript(sessionId);
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

  const activeRelation = snapshot?.agentRelations.find((relation) => (
    relation.childSessionId === sessionId && relation.detachedAt === undefined
  ));
  const owner = activeRelation?.owner ?? 'managed';
  const directChildren = (snapshot?.agentRelations ?? [])
    .filter((relation) => relation.parentSessionId === sessionId && relation.detachedAt === undefined)
    .flatMap((relation): StructuredAgentChildTrackItem[] => {
      const childSession = snapshot?.sessions.find((candidate) => candidate.id === relation.childSessionId);
      const childAgent = snapshot?.agents.find((candidate) => candidate.sessionId === relation.childSessionId);
      if (!childSession || !childAgent) return [];
      const childProvider = snapshot?.providers.find((candidate) => candidate.id === childAgent.providerId);
      return [{
        sessionId: childSession.id,
        title: childSession.title,
        providerLabel: childProvider?.displayName ?? childAgent.providerId,
        state: childAgent.state,
        owner: relation.owner,
      }];
    });

  const openRelatedSession = (targetSessionId: string): void => {
    const targetSession = snapshot?.sessions.find((candidate) => candidate.id === targetSessionId);
    const targetAgent = snapshot?.agents.find((candidate) => candidate.sessionId === targetSessionId);
    const targetProvider = snapshot?.providers.find((candidate) => candidate.id === targetAgent?.providerId);
    props.onOpenSession?.({
      sessionId: targetSessionId,
      ...(targetSession ? { title: targetSession.title } : {}),
      ...(targetProvider ? { providerLabel: targetProvider.displayName } : {}),
    });
  };

  const runLifecycleCommand = async (
    type: 'agent.cancel' | 'agent.archive' | 'agent.detach',
  ): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const currentSession = authority.sessions.find((candidate) => candidate.id === sessionId);
    const currentAgent = authority.agents.find((candidate) => candidate.sessionId === sessionId);
    const currentRelation = authority.agentRelations.find((relation) => (
      relation.childSessionId === sessionId && relation.detachedAt === undefined
    ));
    if (!currentSession || !currentAgent) {
      return { ok: false, message: 'This Agent session is no longer available.' };
    }
    if (currentRelation?.owner === 'provider-native') {
      return { ok: false, message: 'This provider-owned subagent is read-only.' };
    }
    if (type === 'agent.detach' && !currentRelation) {
      return { ok: false, message: 'This Agent is already a top-level session.' };
    }
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type,
      payload: { sessionId },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const configureHeartbeat = async (
    input: StructuredAgentHeartbeatInput,
  ): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const currentAgent = authority.agents.find((candidate) => candidate.sessionId === sessionId);
    const currentSession = authority.sessions.find((candidate) => candidate.id === sessionId);
    if (!currentAgent || !currentSession) {
      return { ok: false, message: 'This Agent session is no longer available.' };
    }
    const relation = authority.agentRelations.find((candidate) => (
      candidate.childSessionId === sessionId && candidate.detachedAt === undefined
    ));
    if (relation?.owner === 'provider-native') {
      return { ok: false, message: 'This provider-owned subagent is read-only.' };
    }
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'heartbeat.configure',
      payload: { sessionId, ...input },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const runHeartbeatNow = async (): Promise<StructuredAgentUiResult> => {
    const authority = await latestSnapshot();
    if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
    const heartbeat = authority.heartbeats.find((candidate) => candidate.sessionId === sessionId);
    if (!heartbeat?.enabled) return { ok: false, message: 'This heartbeat is no longer active.' };
    const commandId = opaqueId('command');
    const receipt = await sendCommand(createDaemonCommand({
      commandId,
      idempotencyKey: commandId,
      expectedRevision: authority.revision,
      issuedAt: new Date().toISOString(),
      principal: { kind: 'desktop', id: 'renderer-agent-ui' },
      type: 'heartbeat.trigger',
      payload: { sessionId },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const enableAutomationHost = async (): Promise<StructuredAgentUiResult> => {
    const lifecycle = await capabilities.daemon
      .setLifecycleSettings({ keepRunning: true, startAtLogin: true })
      .catch(() => null);
    if (!lifecycle?.keepRunning || !lifecycle.startAtLogin) {
      return { ok: false, message: 'Keep running and Start at login could not be enabled.' };
    }
    await refresh();
    return { ok: true };
  };

  const heartbeat = snapshot?.heartbeats.find((candidate) => candidate.sessionId === sessionId);
  const automationReady = snapshot?.runtime.keepRunning === true && snapshot.runtime.startAtLogin === true;
  const historyOnly = session !== undefined && isDaemonSessionArchived(session, agent);
  const heartbeatAvailable = owner === 'managed'
    && !historyOnly
    && session !== undefined
    && agent !== undefined
    && HEARTBEAT_SESSION_STATES.has(agent.state);

  return (
    <StructuredAgentSessionPanel
      sessionId={sessionId}
      title={session?.title ?? createdDraft?.title ?? 'Agent session'}
      providerId={providerId}
      providerLabel={provider?.displayName ?? (providerId || 'Agent')}
      workspace={workspaceOption}
      model={currentModel}
      modelOptions={structuredAgentModelOptions(
        provider?.capabilities ?? [],
        currentModel,
        providerModelCatalogs[providerId],
      )}
      permissionPreset={agent?.permissionPreset ?? createdDraft?.permissionPreset ?? 'standard'}
      state={historyOnly ? 'archived' : agent?.state ?? (createdDraft || loading ? 'starting' : 'error')}
      queuedCount={agent?.queuedTurnCount ?? 0}
      items={transcriptItems}
      approvals={(snapshot?.approvals ?? []).filter((approval) => approval.sessionId === sessionId)}
      transcriptLoading={transcriptLoading && transcriptItems.length === 0}
      transcriptError={transcriptError ?? loadError ?? (!createdDraft && !loading && snapshot && !session
        ? 'This Agent session is no longer available.'
        : null)}
      disabled={!snapshot && !loading}
      historyOnly={historyOnly}
      owner={owner}
      childTrack={directChildren.length > 0 && props.onOpenSession ? (
        <StructuredAgentChildTrack items={directChildren} onSelectSession={openRelatedSession} />
      ) : undefined}
      heartbeatControl={heartbeatAvailable ? (
        <StructuredAgentHeartbeat
          sessionId={sessionId}
          value={heartbeat}
          automationReady={automationReady}
          disabled={!snapshot || loading}
          onSave={configureHeartbeat}
          onRunNow={runHeartbeatNow}
          onEnableHost={enableAutomationHost}
        />
      ) : undefined}
      onRetryTranscript={() => {
        void refresh();
        if (sessionId) void syncTranscript(sessionId, transcriptTargetRef.current);
      }}
      onSend={(prompt) => runSessionCommand('agent.submit', prompt)}
      onInterruptAndSend={historyOnly ? undefined : (prompt) => runSessionCommand('agent.interrupt-and-submit', prompt)}
      onChangeSettings={historyOnly ? undefined : changeSettings}
      onResolveApproval={historyOnly ? undefined : resolveApproval}
      onOpenRelatedSession={props.onOpenSession ? openRelatedSession : undefined}
      onCancel={!historyOnly && owner === 'managed' && session && agent ? () => runLifecycleCommand('agent.cancel') : undefined}
      onArchive={!historyOnly && owner === 'managed' && session && agent ? () => runLifecycleCommand('agent.archive') : undefined}
      onDetach={!historyOnly && owner === 'managed' && session && agent && activeRelation
        ? () => runLifecycleCommand('agent.detach')
        : undefined}
    />
  );
}
