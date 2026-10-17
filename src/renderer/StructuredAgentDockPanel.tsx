import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalResponse } from '../shared/approval-request';
import { PlanningNavigationContext } from './PlanningWorkspaceDockPanel';
import { WorkflowConversationContext, WorkflowConversationUnavailable, useWorkflowConversationScope } from './workflow/WorkflowConversationContext';
import type { IDockviewPanelProps } from 'dockview-react';
import type { AgentLaunchBootstrap } from '../shared/agent-history';
import type { ChatComposerDraft, ChatMessageContext } from '../shared/chat-message';
import type { ChatStateAccess } from './chat-recovery';
import { useChatRecovery } from './use-chat-recovery';
import { ChatRecoveryNotice } from './ChatRecoveryNotice';
import { NewSessionDraftPanel } from './NewSessionDraftPanel';

import { conversationQueue } from './conversation-queue';
import {
  createDaemonCommand,
  type DaemonCommand,
  type DaemonCommandReceipt,
  type DaemonSnapshot,
  type DaemonTranscriptItem,
  type ManagedAgentState,
  type PermissionPreset,
} from '../shared/daemon-protocol';
import { setStructuredAgentTabStatus, structuredTabStatus, tabProvider } from './structured-agent-tab-status';
import type { DaemonAuthorityAvailability } from '../shared/daemon-authority';
import { isDaemonSessionArchived } from '../shared/daemon-session-visibility';
import { parseTranscriptPayload } from '../shared/transcript-payload';
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
/** A reopened conversation loads its newest items first; older ones load on demand. */
const TRANSCRIPT_TAIL_WINDOW = 3 * TRANSCRIPT_PAGE_SIZE;
/** The tail is extended (bounded) until it shows this many prompts, for old delta-heavy sessions. */
const TRANSCRIPT_TAIL_MIN_PROMPTS = 2;
const TRANSCRIPT_TAIL_MAX_EXTENSIONS = 8;
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
  return receipt.ok ? { ok: true } : { ok: false, message: receipt.error.message, deliveryUncertain: false };
}

function localUserItem(
  sessionId: string,
  commandId: string,
  sequence: number,
  text: string,
  context?: ChatMessageContext,
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
    ...(context ? { context } : {}),
  };
}

/** Chat links open in the OS browser; main accepts only credential-free http(s). */
function openLink(url: string): void {
  if (/^https?:/iu.test(url)) void window.ezterminalDesktop?.openExternalHttpUrl(url);
}

/** Electron's File -> absolute path bridge, for files dropped on the composer. */
function pathForDrop(file: File): string | null {
  try {
    return window.ezterminalDesktop?.getPathForFile(file) ?? null;
  } catch {
    return null;
  }
}

let mentionSearchSequence = 0;
/** One stable function per root: the composer re-runs its search whenever the function changes. */
const mentionSearches = new Map<string, (query: string) => Promise<readonly string[]>>();

/** `@` mentions search the session's workspace with the Quick Open file index. */
function desktopFileSearch(root: string | undefined): ((query: string) => Promise<readonly string[]>) | undefined {
  const desktop = window.ezterminalDesktop;
  if (!root || typeof desktop?.searchWorkspaceFiles !== 'function') return undefined;
  const existing = mentionSearches.get(root);
  if (existing) return existing;
  const search = async (query: string): Promise<readonly string[]> => {
    if (!query.trim()) return [];
    mentionSearchSequence += 1;
    const result = await desktop.searchWorkspaceFiles({ requestId: `agent-mention-${mentionSearchSequence}`, root, query });
    return result.ok ? result.matches.map((match) => match.relativePath.replace(/\\/gu, '/')) : [];
  };
  mentionSearches.set(root, search);
  return search;
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
      ...(recovery.composerDraft ? { draftText: recovery.composerDraft.text, draftSkills: recovery.composerDraft.skills } : {}),
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
  input: StructuredAgentDraftInput,
): RendererRecoveryStructuredAgentCreate {
  return Object.freeze({
    panelId,
    historyId,
    sessionId: command.payload.sessionId,
    phase: 'sending',
    command,
    ...(input.draftText ? { composerDraft: { text: input.draftText, ...(input.draftSkills?.length ? { skills: input.draftSkills } : {}) } } : {}),
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
    readonly chatStateAccess?: ChatStateAccess;
    readonly createRecoveryRegistry?: StructuredAgentCreateRecoveryRegistry;
    /** Resolves true only after main has accepted the current memory-only checkpoint. */
    readonly persistCreateRecovery?: () => Promise<boolean>;
    readonly onOpenTerminal?: (workspaceId?: string, directory?: string) => Promise<StructuredAgentUiResult>;
    readonly onLaunchCli?: (bootstrap: AgentLaunchBootstrap) => Promise<void>;
    readonly onOpenSettings?: () => void;
    readonly onOpenHistory?: (projectId?: string) => void;
    readonly onOpenSession?: (input: {
      readonly sessionId: string;
      readonly title?: string;
      readonly providerLabel?: string;
    }) => void;
  },
): JSX.Element {
  const capabilities = props.capabilities ?? rendererCapabilities;
  const capabilityClient = useMemo(() => typeof window.ezterminal?.agentCapabilitiesList === 'function' ? {
    list: window.ezterminal.agentCapabilitiesList,
    manage: window.ezterminal.agentCapabilitiesManage,
  } : undefined, []);
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
  const earlyDraft = useRef<{ sessionId: string; draft: ChatComposerDraft } | null>(null);
  const authorizedProjectId = snapshot?.sessions.find((candidate) => candidate.id === sessionId)?.projectId;
  const workflowNavigation = useContext(PlanningNavigationContext);
  const workflowAccess = useMemo(() => typeof window.ezterminal?.getWorkflowSnapshot === 'function' ? { getWorkflowSnapshot: (id: string) => window.ezterminal.getWorkflowSnapshot(id), executeWorkflowCommand: window.ezterminal.executeWorkflowCommand.bind(window.ezterminal) } : undefined, []);
  const workflowContext = useWorkflowConversationScope(workflowAccess, authorizedProjectId, sessionId);
  const chatRecovery = useChatRecovery(authorizedProjectId, sessionId, props.chatStateAccess);
  const pendingSubmit = chatRecovery.view.pendingSubmit?.command ?? null;
  useEffect(() => {
    if (chatRecovery.controller && earlyDraft.current?.sessionId === sessionId) {
      chatRecovery.controller.updateDraft(earlyDraft.current.draft);
      earlyDraft.current = null;
    }
  }, [chatRecovery.controller, sessionId]);
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
  /** Sequence below the oldest loaded item; 0 once the whole transcript is loaded. */
  const transcriptFloorRef = useRef(0);
  const [transcriptFloor, setTranscriptFloor] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierInFlightRef = useRef(false);
  const tailExtensionsRef = useRef(0);

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
    if (transcriptCursorRef.current === 0 && authoritativeItemsRef.current.length === 0
      && transcriptTargetRef.current > TRANSCRIPT_TAIL_WINDOW) {
      const floor = transcriptTargetRef.current - TRANSCRIPT_TAIL_WINDOW;
      transcriptCursorRef.current = floor;
      transcriptFloorRef.current = floor;
      setTranscriptFloor(floor);
    }
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

  const loadEarlierTranscript = useCallback(async (): Promise<void> => {
    const targetSessionId = transcriptSessionRef.current;
    const floor = transcriptFloorRef.current;
    if (!targetSessionId || floor <= 0 || earlierInFlightRef.current) return;
    const generation = transcriptGenerationRef.current;
    earlierInFlightRef.current = true;
    setLoadingEarlier(true);
    try {
      const from = Math.max(0, floor - TRANSCRIPT_PAGE_SIZE);
      const page = await capabilities.daemon.getTranscript(targetSessionId, from, floor - from);
      if (transcriptGenerationRef.current !== generation || transcriptSessionRef.current !== targetSessionId) return;
      const validPage = page
        .filter((item) => item.sessionId === targetSessionId && Number.isSafeInteger(item.sequence) && item.sequence > from && item.sequence <= floor)
        .sort((left, right) => left.sequence - right.sequence);
      if (validPage.length !== floor - from || validPage.some((item, index) => item.sequence !== from + index + 1)) {
        throw new Error('The earlier Agent transcript page contains a sequence gap.');
      }
      const next = mergeAuthoritativeTranscript(authoritativeItemsRef.current, validPage);
      authoritativeItemsRef.current = next;
      setAuthoritativeItems(next);
      transcriptFloorRef.current = from;
      setTranscriptFloor(from);
    } catch {
      if (transcriptGenerationRef.current === generation) setTranscriptError('Earlier messages could not be loaded.');
    } finally {
      earlierInFlightRef.current = false;
      if (transcriptGenerationRef.current === generation) setLoadingEarlier(false);
    }
  }, [capabilities]);

  // A tail of streamed deltas can hold less than one exchange; extend it a few pages.
  useEffect(() => {
    // Judge the tail only once some of it has arrived.
    if (transcriptFloor <= 0 || loadingEarlier || authoritativeItems.length === 0
      || tailExtensionsRef.current >= TRANSCRIPT_TAIL_MAX_EXTENSIONS) return;
    const prompts = authoritativeItems.filter((item) => item.kind === 'user-message').length;
    if (prompts >= TRANSCRIPT_TAIL_MIN_PROMPTS) return;
    tailExtensionsRef.current += 1;
    void loadEarlierTranscript();
  }, [authoritativeItems, loadEarlierTranscript, loadingEarlier, transcriptFloor]);

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
    transcriptFloorRef.current = 0;
    setTranscriptFloor(0);
    tailExtensionsRef.current = 0;
    authoritativeItemsRef.current = [];
    setAuthoritativeItems([]);
    setLocalItems((current) => current.filter((item) => item.sessionId === sessionId));
    setTranscriptError(null);
    setTranscriptLoading(sessionId !== null);
    if (sessionId && availability !== undefined && availability?.state !== 'legacy-only-safe-mode') {
      // Without a snapshot the head is unknown; the snapshot effect starts the load at the tail.
      const head = snapshotRef.current?.transcriptHeads.find((candidate) => candidate.sessionId === sessionId);
      if (snapshotRef.current) void syncTranscript(sessionId, head?.lastSequence ?? 0);
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
      if (event.kind === 'transcript.appended') {
        if (event.payload.sessionId === transcriptSessionRef.current) void syncTranscript(event.payload.sessionId, event.payload.toSequence);
        // Appends (streamed deltas several times a second) do not change the snapshot.
        return;
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
    draftText?: string,
    draftSkills?: ChatComposerDraft['skills'],
  ): StructuredAgentUiResult => {
    const createdInput = outcome.command.payload;
    const nextHistoryId = structuredAgentSessionHistoryId(outcome.sessionId);
    if (draftText) earlyDraft.current = { sessionId: outcome.sessionId, draft: { text: draftText, ...(draftSkills?.length ? { skills: draftSkills } : {}) } };
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
    setLocalItems(createdInput.initialPrompt ? [localUserItem(
      outcome.sessionId,
      outcome.command.commandId,
      1,
      createdInput.initialPrompt,
    )] : []);
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
      if (!createRecoveryRegistry.register(recoveryRecord(props.api.id, historyId, command, input))) {
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
      if (alreadyCreated) return finishCreatedDraft(uncertainDraft.outcome, uncertainDraft.input.draftText, uncertainDraft.input.draftSkills);

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
        if (createdDespiteReceipt) return finishCreatedDraft(uncertainDraft.outcome, uncertainDraft.input.draftText, uncertainDraft.input.draftSkills);
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
    if (outcome.kind === 'created') return finishCreatedDraft(outcome, input.draftText, input.draftSkills);
    if (outcome.kind === 'delivery-uncertain') {
      createRecoveryRegistry?.markDeliveryUncertain(props.api.id, outcome.command.commandId);
      setUncertainDraft({ input, outcome });
      return {
        ok: false,
        message: 'Delivery could not be confirmed. This exact draft is locked; choose Create Agent again to verify or safely retry the same session.',
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

  // Tab dot: live state, plus "done" for a turn that finished while this tab was not in front.
  const tabAgent = snapshot?.agents.find((candidate) => candidate.sessionId === sessionId);
  const tabProviderLabel = snapshot?.providers.find((candidate) => candidate.id === tabAgent?.providerId)?.displayName;
  const [unseenDone, setUnseenDone] = useState(false);
  const previousAgentState = useRef<ManagedAgentState | undefined>(undefined);
  useEffect(() => {
    const previous = previousAgentState.current;
    previousAgentState.current = tabAgent?.state;
    const wasActive = previous === 'starting' || previous === 'queued' || previous === 'working' || previous === 'blocked';
    if (wasActive && (tabAgent?.state === 'idle' || tabAgent?.state === 'done') && props.api.isActive === false) setUnseenDone(true);
  }, [props.api, tabAgent?.state]);
  useEffect(() => {
    const disposable = props.api.onDidActiveChange?.((event) => { if (event.isActive) setUnseenDone(false); });
    return () => disposable?.dispose();
  }, [props.api]);
  const tabStatus = structuredTabStatus(tabAgent?.state, unseenDone);
  const tabProviderId = tabAgent?.providerId;
  useEffect(() => {
    setStructuredAgentTabStatus(props.api.id, tabStatus && tabProviderId ? {
      status: tabStatus, provider: tabProvider(tabProviderId), ...(tabProviderLabel ? { providerLabel: tabProviderLabel } : {}),
    } : undefined);
  }, [props.api.id, tabProviderId, tabProviderLabel, tabStatus]);
  useEffect(() => () => setStructuredAgentTabStatus(props.api.id, undefined), [props.api.id]);

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
          initialIntent={{ kind: 'agent' }}
        snapshot={snapshot}
        projectId={projectId}
        workspaceId={initialWorkspaceId ?? (preferredWorkspaceId ? `${projectId && rootId ? `${projectId}.${rootId}.` : ''}${preferredWorkspaceId}` : undefined)}
        access={window.ezterminal}
        onTerminal={props.onOpenTerminal}
        onLaunchCli={props.onLaunchCli}
        onSettings={props.onOpenSettings}
        agent={{
          capabilityClient,
          onOpenHistory: props.onOpenHistory ? () => props.onOpenHistory?.(projectId) : undefined,
          providers, workspaces,
          initialProviderId: uncertainDraft?.input.providerId,
          initialModel: uncertainDraft?.input.model,
          initialWorkspaceId: uncertainDraft?.input.workspaceId ?? initialWorkspaceId,
          initialPermissionPreset: uncertainDraft?.input.permissionPreset,
          initialPrompt: uncertainDraft?.input.initialPrompt,
          initialDraftText: uncertainDraft?.input.draftText,
          initialDraftSkills: uncertainDraft?.input.draftSkills,
          deliveryRecovery: uncertainDraft !== null,
          loading: loading || availability?.state === 'legacy-only-safe-mode',
          loadError, onRetry: () => void refresh(), onCreate: create,
        }}
      />;
    }
    return (
      <StructuredAgentDraftPanel
        capabilityClient={capabilityClient}
        onOpenHistory={props.onOpenHistory ? () => props.onOpenHistory?.(projectId) : undefined}
        providers={providers}
        workspaces={workspaces}
        initialProviderId={uncertainDraft?.input.providerId}
        initialModel={uncertainDraft?.input.model}
        initialWorkspaceId={uncertainDraft?.input.workspaceId ?? initialWorkspaceId}
        initialPermissionPreset={uncertainDraft?.input.permissionPreset}
        initialPrompt={uncertainDraft?.input.initialPrompt}
        initialDraftText={uncertainDraft?.input.draftText}
        initialDraftSkills={uncertainDraft?.input.draftSkills}
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
  const workspaceRoot = workspace?.rootPath;
  const fileSearch = desktopFileSearch(workspaceRoot);

  const runSessionCommand = async (
    type: 'agent.submit' | 'agent.interrupt-and-submit',
    prompt: string,
    context?: ChatMessageContext,
  ): Promise<StructuredAgentUiResult> => {
    const recovery = chatRecovery.controller;
    if (!recovery || recovery.getSnapshot().status !== 'ready') return { ok: false, message: 'Secure draft recovery must be ready before sending.' };
    if (recovery.getSnapshot().pendingSubmit) return { ok: false, message: 'Confirm the previous message delivery before sending again.', deliveryUncertain: true };
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
          payload: { sessionId, prompt, ...(context ? { context } : {}) },
        })
      : createDaemonCommand({
          commandId,
          idempotencyKey: commandId,
          expectedRevision: authority.revision,
          issuedAt: new Date().toISOString(),
          principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          type,
          payload: { sessionId, prompt, ...(context ? { context } : {}) },
        });
    const prepared = await recovery.prepare(command);
    if (!prepared.ok) return prepared;
    const receipt = await sendCommand(command);
    if (!receipt || (!receipt.ok && receipt.error.code === 'delivery-uncertain')) {
      return { ok: false, message: 'Message delivery could not be confirmed. Check delivery before sending again.', deliveryUncertain: true };
    }
    const stored = await recovery.complete(command.commandId, receipt.ok);
    const result = resultOf(receipt);
    if (result.ok) {
      setLocalItems((current) => current.some((item) => item.id === `local-${commandId}`)
        ? current
        : [...current, localUserItem(sessionId, commandId, current.length + 1, prompt, context)]);
      void syncTranscript(sessionId);
    }
    return stored.ok ? result : stored;
  };

  const reconcileSubmit = async (): Promise<StructuredAgentUiResult> => {
    const recovery = chatRecovery.controller;
    const pending = recovery?.getSnapshot().pendingSubmit?.command;
    if (!pending) return { ok: true };
    if (recovery?.getSnapshot().status !== 'ready') return { ok: false, message: 'Check stored recovery data before confirming delivery.', deliveryUncertain: true };
    const receipt = await sendCommand(pending);
    if (!receipt || (!receipt.ok && receipt.error.code === 'delivery-uncertain')) {
      return { ok: false, message: 'Message delivery is still unconfirmed.', deliveryUncertain: true };
    }
    if (receipt.ok) {
      const { commandId, payload } = pending;
      setLocalItems((current) => current.some((item) => item.id === `local-${commandId}`) ? current
        : [...current, localUserItem(sessionId, commandId, current.length + 1, payload.prompt, payload.context)]);
      void syncTranscript(sessionId);
    }
    const stored = await recovery.complete(pending.commandId, receipt.ok);
    return stored.ok ? resultOf(receipt) : stored;
  };

  const changeSettings = async (settings: {
    readonly model?: string;
    readonly permissionPreset: PermissionPreset;
    readonly reasoningEffort?: string;
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
        ...(settings.reasoningEffort && authority.capabilities?.includes('agent-effort-v1')
          ? { reasoningEffort: settings.reasoningEffort }
          : {}),
      },
    }));
    return receipt ? resultOf(receipt) : { ok: false, message: 'The Agent daemon is unavailable.' };
  };

  const resolveApproval = async (
    approvalId: string,
    decision: 'allow' | 'deny',
    response?: ApprovalResponse,
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
      // Older hosts validate this payload strictly and would reject the extra field.
      payload: { approvalId, decision, ...(response && authority.capabilities?.includes('approval-response-v1') ? { response } : {}) },
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

  // A provider-owned subagent leads back to its parent and says when the parent holds its approval.
  const parentSession = activeRelation
    ? snapshot?.sessions.find((candidate) => candidate.id === activeRelation.parentSessionId)
    : undefined;
  const subagentType = owner === 'provider-native'
    ? transcriptItems.flatMap((item) => {
        const payload = item.payload ? parseTranscriptPayload(item.payload) : undefined;
        return payload?.type === 'subagent' && payload.role === 'instruction' && payload.subagentType ? [payload.subagentType] : [];
      })[0]
    : undefined;
  const parentApprovalPending = owner === 'provider-native' && (snapshot?.approvals ?? []).some((approval) => (
    approval.state === 'pending' && approval.request?.subagent?.sessionId === sessionId
  ));

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
  const sessionTurns = (snapshot?.turns ?? []).filter((turn) => turn.sessionId === sessionId);
  const automationReady = snapshot?.runtime.keepRunning === true && snapshot.runtime.startAtLogin === true;
  const historyOnly = session !== undefined && isDaemonSessionArchived(session, agent) || workflowContext.scope?.readOnly === true;
  const heartbeatAvailable = owner === 'managed'
    && !historyOnly
    && session !== undefined
    && agent !== undefined
    && HEARTBEAT_SESSION_STATES.has(agent.state);

  return (
    <StructuredAgentSessionPanel
      onOpenProjectFiles={session && workflowNavigation ? () => workflowNavigation.openFiles(session.projectId) : undefined}
      viewStateKey={props.params?.conversationId ? `desktop:conversation:${props.params.conversationId}` : undefined}
      onOpenHistory={props.onOpenHistory ? () => props.onOpenHistory?.(session?.projectId ?? projectId) : undefined}
      capabilityClient={capabilityClient}
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
      awaitingFirstMessage={!historyOnly && (agent ? agent.state === 'idle' && !agent.providerSessionId && !snapshot?.turns.some((turn) => turn.sessionId === sessionId) : Boolean(createdDraft && !createdDraft.initialPrompt))}
      state={historyOnly ? 'archived' : agent?.state ?? (createdDraft ? createdDraft.initialPrompt ? 'starting' : 'idle' : loading ? 'starting' : 'error')}
      queuedCount={agent?.queuedTurnCount ?? 0}
      queueItems={conversationQueue(sessionId, snapshot?.turns ?? [], transcriptItems)}
      onQueueAction={!historyOnly && owner === 'managed' && snapshot?.capabilities?.includes('agent-queue') ? async (item, action) => {
        const authority = await latestSnapshot();
        if (!authority) return { ok: false, message: 'The Agent daemon is unavailable.' };
        const commandId = opaqueId('command');
        const receipt = await sendCommand(createDaemonCommand({ commandId, idempotencyKey: commandId,
          expectedRevision: authority.revision, issuedAt: new Date().toISOString(), principal: { kind: 'desktop', id: 'renderer-agent-ui' },
          type: 'agent.queue', payload: { sessionId, turnId: item.turnId, turnRevision: item.revision, action } }));
        return receipt ? resultOf(receipt) : { ok: false, message: 'Queue result unknown. Refresh before trying again.' };
      } : undefined}
      items={transcriptItems}
      turns={sessionTurns}
      approvals={(snapshot?.approvals ?? []).filter((approval) => approval.sessionId === sessionId)}
      approvalResponses={snapshot?.capabilities?.includes('approval-response-v1') === true}
      effortSupported={snapshot?.capabilities?.includes('agent-effort-v1') === true}
      {...(agent?.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {})}
      onOpenLink={openLink}
      {...(fileSearch ? { fileSearch } : {})}
      pathForDrop={pathForDrop}
      hasEarlier={transcriptFloor > 0}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={() => void loadEarlierTranscript()}
      transcriptLoading={transcriptLoading && transcriptItems.length === 0}
      transcriptError={transcriptError ?? loadError ?? (!createdDraft && !loading && snapshot && !session
        ? 'This Agent session is no longer available.'
        : null)}
      disabled={!snapshot && !loading}
      historyOnly={historyOnly}
      workflowContext={workflowContext.scope ? <WorkflowConversationContext scope={workflowContext.scope} onRefresh={workflowContext.refreshReferences} busy={workflowContext.loading} error={workflowContext.error} onReturn={workflowNavigation?.openWorkflow ? () => { const scope = workflowContext.scope!; workflowNavigation.openWorkflow!(scope.projectId, snapshot?.projects.find(project => project.id === scope.projectId)?.name ?? scope.projectId, scope.subprojectId, scope.nodeId); } : undefined} /> : workflowContext.error ? <WorkflowConversationUnavailable message={workflowContext.error} onRetry={workflowContext.retry} /> : undefined}
      owner={owner}
      {...(parentSession && props.onOpenSession ? { parent: { sessionId: parentSession.id, title: parentSession.title } } : {})}
      {...(subagentType ? { subagentType } : {})}
      parentApprovalPending={parentApprovalPending}
      childTrack={directChildren.length > 0 && props.onOpenSession ? (
        <StructuredAgentChildTrack items={directChildren} onSelectSession={openRelatedSession} />
      ) : undefined}
      heartbeatActive={heartbeatAvailable && heartbeat?.enabled === true}
      heartbeatControl={heartbeatAvailable ? (
        <StructuredAgentHeartbeat
          defaultOpen
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
      supportsMessageContext={provider?.protocol === 'codex-app-server' || provider?.protocol === 'claude-agent-sdk'}
      draftState={chatRecovery.controller ? chatRecovery.view.draft : undefined}
      onDraftChange={(draft) => {
        if (chatRecovery.controller) chatRecovery.controller.updateDraft(draft);
        else earlyDraft.current = { sessionId, draft };
      }}
      sendDisabled={chatRecovery.view.status !== 'ready' || workflowContext.loading}
      sendDisabledReason={chatRecovery.view.status === 'loading' ? 'Restoring secure draft…' : chatRecovery.view.message}
      recoveryControl={<ChatRecoveryNotice controller={chatRecovery.controller} view={chatRecovery.view} />}
      deliveryUncertain={pendingSubmit !== null}
      onReconcileDelivery={reconcileSubmit}
      onSend={(prompt, context) => runSessionCommand('agent.submit', prompt, context)}
      onInterruptAndSend={historyOnly ? undefined : (prompt, context) => runSessionCommand('agent.interrupt-and-submit', prompt, context)}
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
